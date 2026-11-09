import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireProjectRole } from '../middleware/projectAccess.js';
import { asyncHandler } from './asyncHandler.js';
import { isDocumentActive } from '../collab/activeDocuments.js';
import { createContentSnapshot } from '../collab/documentPersistence.js';
export const projectFilesRouter = Router();
/**
 * Files are stored as UTF-8 text in MySQL LONGTEXT. The API keeps the limit
 * deliberately below the JSON body limit so a single file cannot exhaust the
 * server, and clients get a clear validation error instead of a dropped socket.
 */
const MAX_FILE_CONTENT_BYTES = 1_000_000;
const MAX_PATH_LENGTH = 700;
const fileIdParamSchema = z.object({
    id: z.string().uuid({ message: 'Invalid file ID format.' }),
});
const controlCharacters = /[\u0000-\u001f\u007f]/;
const entryNameSchema = z
    .string()
    .trim()
    .min(1, 'Name is required.')
    .max(255, 'Name must be 255 characters or fewer.')
    .refine((value) => !/[\\/]/.test(value), 'Names cannot contain slashes.')
    .refine((value) => value !== '.' && value !== '..', 'Invalid name.')
    .refine((value) => !controlCharacters.test(value), 'Names cannot contain control characters.');
/**
 * Paths are logical project paths (never filesystem paths). They must be
 * relative, use forward slashes, and must not contain "." or ".." segments.
 */
const entryPathSchema = z
    .string()
    .trim()
    .min(1, 'Path is required.')
    .max(MAX_PATH_LENGTH, `Path must be ${MAX_PATH_LENGTH} characters or fewer.`)
    .refine((value) => {
    if (value.includes('\\') || value.startsWith('/'))
        return false;
    if (controlCharacters.test(value))
        return false;
    return value.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}, 'Path must be relative and must not contain empty, "." or ".." segments.');
const languageSchema = z
    .string()
    .trim()
    .min(1, 'Language is required.')
    .max(40, 'Language must be 40 characters or fewer.')
    .regex(/^[A-Za-z0-9+#._-]+$/, 'Language may only contain letters, numbers, +, #, dots, dashes and underscores.');
const contentSchema = z
    .string()
    .refine((value) => Buffer.byteLength(value, 'utf8') <= MAX_FILE_CONTENT_BYTES, `File content must be ${MAX_FILE_CONTENT_BYTES} bytes or fewer.`);
const listQuerySchema = z.object({
    search: z.string().trim().max(100, 'Search text must be 100 characters or fewer.').optional(),
});
const createEntrySchema = z
    .object({
    name: entryNameSchema,
    path: entryPathSchema,
    parentId: z.string().uuid({ message: 'Invalid parent folder ID.' }).nullable().optional(),
    isFolder: z.boolean().default(false),
    language: languageSchema.default('plaintext'),
    content: contentSchema.default(''),
})
    .refine((data) => data.path.split('/').pop() === data.name, {
    message: 'Path must end with the entry name.',
    path: ['path'],
});
const updateEntrySchema = z.object({
    name: entryNameSchema.optional(),
    path: entryPathSchema.optional(),
    // Destination folder for a move. `null` means the project root. Omitting it
    // keeps the current parent. Paths are always recomputed on the server.
    parentId: z.string().uuid({ message: 'Invalid parent folder ID.' }).nullable().optional(),
    language: languageSchema.optional(),
    content: contentSchema.optional(),
    // Epoch milliseconds of the revision the client loaded.
    version: z.number().int().nonnegative().optional(),
});
const entrySummarySelect = {
    id: true,
    projectId: true,
    parentId: true,
    name: true,
    path: true,
    isFolder: true,
    language: true,
    createdAt: true,
    updatedAt: true,
};
const entrySelect = {
    ...entrySummarySelect,
    content: true,
};
async function findParentFolder(projectId, parentId) {
    const parent = await prisma.projectFile.findFirst({ where: { id: parentId, projectId } });
    if (!parent || !parent.isFolder)
        return null;
    return parent;
}
function replyValidation(res, message) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });
}
projectFilesRouter.get('/projects/:id/files', requireProjectRole('VIEWER'), asyncHandler(async (req, res) => {
    const query = listQuerySchema.safeParse(req.query);
    if (!query.success) {
        return replyValidation(res, query.error.errors.map((error) => error.message).join(' '));
    }
    const search = query.data.search;
    const entries = await prisma.projectFile.findMany({
        where: {
            projectId: req.projectAccess.projectId,
            ...(search
                ? { OR: [{ name: { contains: search } }, { path: { contains: search } }] }
                : {}),
        },
        orderBy: [{ isFolder: 'desc' }, { name: 'asc' }],
        // Folder listings intentionally omit file content. Large files are only
        // loaded by the single-entry endpoint when an editor tab opens them.
        select: entrySummarySelect,
    });
    res.json({ data: entries });
}));
projectFilesRouter.post('/projects/:id/files', requireProjectRole('EDITOR'), asyncHandler(async (req, res) => {
    const parsed = createEntrySchema.safeParse(req.body);
    if (!parsed.success) {
        return replyValidation(res, parsed.error.errors.map((e) => e.message).join(' '));
    }
    const projectId = req.projectAccess.projectId;
    let parent = null;
    if (parsed.data.parentId) {
        parent = await findParentFolder(projectId, parsed.data.parentId);
        if (!parent) {
            return replyValidation(res, 'Parent must be an existing folder in this project.');
        }
    }
    // Enforce that the path is exactly the parent path plus the entry name.
    const expectedPath = parent ? `${parent.path}/${parsed.data.name}` : parsed.data.name;
    if (parsed.data.path !== expectedPath) {
        return replyValidation(res, `Path must be "${expectedPath}" for this parent folder.`);
    }
    const existingEntry = await prisma.projectFile.findUnique({
        where: { projectId_path: { projectId, path: parsed.data.path } },
        select: { id: true },
    });
    if (existingEntry) {
        return res.status(409).json({ error: { code: 'CONFLICT', message: 'An item with this path already exists.' } });
    }
    const entry = await prisma.projectFile.create({
        data: {
            projectId,
            name: parsed.data.name,
            path: parsed.data.path,
            isFolder: parsed.data.isFolder,
            language: parsed.data.isFolder ? 'plaintext' : parsed.data.language,
            content: parsed.data.isFolder ? '' : parsed.data.content,
            parentId: parent?.id ?? null,
        },
        select: entrySelect,
    });
    return res.status(201).json({ data: entry });
}));
projectFilesRouter.get('/projects/:projectId/files/:fileId', requireProjectRole('VIEWER'), asyncHandler(async (req, res) => {
    const fileParamValidation = fileIdParamSchema.safeParse({ id: req.params.fileId });
    if (!fileParamValidation.success) {
        return replyValidation(res, 'Invalid item ID.');
    }
    const entry = await prisma.projectFile.findFirst({
        where: { id: fileParamValidation.data.id, projectId: req.projectAccess.projectId },
        select: entrySelect,
    });
    if (!entry) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Item not found.' } });
    }
    res.json({ data: entry });
}));
projectFilesRouter.patch('/projects/:projectId/files/:fileId', requireProjectRole('EDITOR'), asyncHandler(async (req, res) => {
    const fileParamValidation = fileIdParamSchema.safeParse({ id: req.params.fileId });
    if (!fileParamValidation.success) {
        return replyValidation(res, 'Invalid item ID.');
    }
    const projectId = req.projectAccess.projectId;
    const parsed = updateEntrySchema.safeParse(req.body);
    if (!parsed.success) {
        return replyValidation(res, parsed.error.errors.map((e) => e.message).join(' '));
    }
    const existingEntry = await prisma.projectFile.findFirst({
        where: { id: fileParamValidation.data.id, projectId },
    });
    if (!existingEntry) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Item not found.' } });
    }
    const { version, ...requestedUpdates } = parsed.data;
    // A live collaboration room owns the authoritative CRDT for this file. A
    // REST write would update `content` without the matching Yjs history, so it
    // must be rejected while collaborators are connected.
    if (requestedUpdates.content !== undefined && isDocumentActive(existingEntry.id)) {
        return res.status(409).json({
            error: {
                code: 'DOCUMENT_ACTIVE',
                message: 'This file is open in a live collaboration session. Edits must be made in the editor.',
            },
        });
    }
    // Optimistic concurrency control for file content. The client sends the
    // `updatedAt` timestamp of the revision it loaded; a mismatch means another
    // writer changed the row, so we refuse to silently overwrite it.
    if (version !== undefined && version !== existingEntry.updatedAt.getTime()) {
        return res.status(409).json({
            error: {
                code: 'CONFLICT',
                message: 'This file changed since you loaded it. Reload the file before saving.',
            },
        });
    }
    if (Object.keys(requestedUpdates).length === 0) {
        return replyValidation(res, 'Provide at least one field to update.');
    }
    if (existingEntry.isFolder && (requestedUpdates.content !== undefined || requestedUpdates.language !== undefined)) {
        return replyValidation(res, 'Folders cannot store content or a language.');
    }
    // Resolve the destination parent. Omitting parentId keeps the current folder;
    // null explicitly moves the entry to the project root.
    let parent = null;
    if (requestedUpdates.parentId !== undefined) {
        if (requestedUpdates.parentId !== null) {
            if (requestedUpdates.parentId === existingEntry.id) {
                return replyValidation(res, 'An item cannot be moved inside itself.');
            }
            parent = await findParentFolder(projectId, requestedUpdates.parentId);
            if (!parent) {
                return replyValidation(res, 'Destination must be an existing folder in this project.');
            }
        }
    }
    else if (existingEntry.parentId) {
        parent = await findParentFolder(projectId, existingEntry.parentId);
        if (!parent) {
            return res.status(409).json({
                error: { code: 'CONFLICT', message: 'The current parent folder no longer exists. Reload the project.' },
            });
        }
    }
    const nextName = requestedUpdates.name ?? existingEntry.name;
    // Paths are authoritative server-side values. If a client sends one, it must
    // match the path derived from the destination folder and name.
    const computedPath = parent ? `${parent.path}/${nextName}` : nextName;
    if (requestedUpdates.path !== undefined && requestedUpdates.path !== computedPath) {
        return replyValidation(res, `Path must be "${computedPath}" for this destination and name.`);
    }
    if (existingEntry.isFolder && parent) {
        if (parent.path === existingEntry.path || parent.path.startsWith(`${existingEntry.path}/`)) {
            return replyValidation(res, 'A folder cannot be moved inside itself or one of its descendants.');
        }
    }
    const pathChanged = computedPath !== existingEntry.path;
    if (computedPath.length > MAX_PATH_LENGTH) {
        return replyValidation(res, `Path must be ${MAX_PATH_LENGTH} characters or fewer.`);
    }
    const { path: _clientPath, parentId: _clientParentId, ...restUpdates } = requestedUpdates;
    const updateData = {
        ...restUpdates,
        name: nextName,
        path: computedPath,
        parentId: parent?.id ?? null,
    };
    if (!pathChanged) {
        const updated = await prisma.$transaction(async (tx) => {
            const result = await tx.projectFile.update({
                where: { id: existingEntry.id },
                data: updateData,
                select: entrySelect,
            });
            // Keep the Yjs checkpoint in the same transaction as the text content so
            // a later collaboration session restores exactly what was stored.
            if (requestedUpdates.content !== undefined) {
                await createContentSnapshot(tx, existingEntry.id, requestedUpdates.content, req.auth.user.id);
            }
            return result;
        });
        return res.json({ data: updated });
    }
    // Moving or renaming a folder rewrites every descendant path. Build the full
    // set first so conflicts and over-long paths are rejected before any write.
    const descendants = existingEntry.isFolder
        ? await prisma.projectFile.findMany({
            where: { projectId, path: { startsWith: `${existingEntry.path}/` } },
            select: { id: true, path: true },
        })
        : [];
    const affectedIds = [existingEntry.id, ...descendants.map((entry) => entry.id)];
    const descendantPaths = descendants.map((entry) => `${computedPath}${entry.path.slice(existingEntry.path.length)}`);
    if (descendantPaths.some((path) => path.length > MAX_PATH_LENGTH)) {
        return replyValidation(res, `Moved paths must be ${MAX_PATH_LENGTH} characters or fewer.`);
    }
    const candidatePaths = [computedPath, ...descendantPaths];
    const conflict = await prisma.projectFile.findFirst({
        where: {
            projectId,
            path: { in: candidatePaths },
            id: { notIn: affectedIds },
        },
        select: { path: true },
    });
    if (conflict) {
        return res.status(409).json({
            error: { code: 'CONFLICT', message: `Another item already uses the path "${conflict.path}".` },
        });
    }
    const updated = await prisma.$transaction(async (tx) => {
        for (let index = 0; index < descendants.length; index += 1) {
            const descendant = descendants[index];
            await tx.projectFile.update({
                where: { id: descendant.id },
                data: { path: descendantPaths[index] },
            });
        }
        const result = await tx.projectFile.update({
            where: { id: existingEntry.id },
            data: updateData,
            select: entrySelect,
        });
        if (requestedUpdates.content !== undefined) {
            await createContentSnapshot(tx, existingEntry.id, requestedUpdates.content, req.auth.user.id);
        }
        return result;
    });
    return res.json({ data: updated });
}));
projectFilesRouter.delete('/projects/:projectId/files/:fileId', requireProjectRole('EDITOR'), asyncHandler(async (req, res) => {
    const fileParamValidation = fileIdParamSchema.safeParse({ id: req.params.fileId });
    if (!fileParamValidation.success) {
        return replyValidation(res, 'Invalid item ID.');
    }
    const projectId = req.projectAccess.projectId;
    const existingEntry = await prisma.projectFile.findFirst({
        where: { id: fileParamValidation.data.id, projectId },
        select: { id: true },
    });
    if (!existingEntry) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Item not found.' } });
    }
    if (isDocumentActive(existingEntry.id)) {
        return res.status(409).json({
            error: {
                code: 'DOCUMENT_ACTIVE',
                message: 'This file is open in a live collaboration session. Close it before deleting.',
            },
        });
    }
    // Children are removed by the self-referencing ON DELETE CASCADE relation.
    await prisma.projectFile.delete({ where: { id: existingEntry.id } });
    return res.status(204).end();
}));
