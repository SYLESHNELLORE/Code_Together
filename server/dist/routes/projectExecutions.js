import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireProjectRole, ROLE_RANK } from '../middleware/projectAccess.js';
import { asyncHandler } from './asyncHandler.js';
import { cancelExecution, executionCapabilities, startExecution, toExecutionJobView, } from '../execution/service.js';
import { entryFileFor, isExecutionLanguage } from '../execution/targets.js';
export const projectExecutionsRouter = Router();
const jobIdParamSchema = z.object({
    jobId: z.string().uuid({ message: 'Invalid execution ID format.' }),
});
const startSchema = z.object({
    fileId: z.string().uuid({ message: 'Invalid file ID format.' }),
    // The client states the language it believes the file uses; the server
    // independently derives it from the file name and rejects a mismatch.
    language: z.string().trim().min(1).max(40),
});
const historyQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
});
/**
 * Only these extensions are executable. The stored `language` column is not
 * trusted as the source of truth because it is a mutable display hint.
 */
const EXTENSION_LANGUAGES = [
    ['.py', 'python'],
    ['.pyw', 'python'],
    ['.js', 'javascript'],
    ['.mjs', 'javascript'],
    ['.cjs', 'javascript'],
    ['.ts', 'typescript'],
    ['.mts', 'typescript'],
    ['.cts', 'typescript'],
    ['.tsx', 'typescript'],
    ['.c', 'c'],
    ['.cpp', 'cpp'],
    ['.cc', 'cpp'],
    ['.cxx', 'cpp'],
    ['.java', 'java'],
];
function languageFromFileName(fileName) {
    const lower = fileName.toLowerCase();
    for (const [extension, language] of EXTENSION_LANGUAGES) {
        if (lower.endsWith(extension))
            return language;
    }
    return null;
}
function replyValidation(res, message) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message } });
}
/**
 * The capabilities endpoint tells the client whether a hardened sandbox is
 * actually available. It never attempts to run code, so it is safe to expose
 * to every project member (including viewers).
 */
projectExecutionsRouter.get('/projects/:id/executions/capabilities', requireProjectRole('VIEWER'), asyncHandler(async (_req, res) => {
    const capabilities = await executionCapabilities();
    return res.json({ data: capabilities });
}));
/** Recent executions. Non-admins only see their own job history. */
projectExecutionsRouter.get('/projects/:id/executions', requireProjectRole('VIEWER'), asyncHandler(async (req, res) => {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        return replyValidation(res, parsed.error.errors[0]?.message ?? 'Invalid query.');
    }
    const access = req.projectAccess;
    const canSeeAll = ROLE_RANK[access.role] >= ROLE_RANK.ADMIN;
    const jobs = await prisma.executionJob.findMany({
        where: {
            projectId: access.projectId,
            ...(canSeeAll ? {} : { userId: req.auth.user.id }),
        },
        orderBy: { createdAt: 'desc' },
        take: parsed.data.limit,
    });
    return res.json({ data: { jobs: jobs.map(toExecutionJobView) } });
}));
/** Read a single job, polled by the client while it is queued or running. */
projectExecutionsRouter.get('/projects/:id/executions/:jobId', requireProjectRole('VIEWER'), asyncHandler(async (req, res) => {
    const parsed = jobIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
        return replyValidation(res, parsed.error.errors[0]?.message ?? 'Invalid execution ID.');
    }
    const access = req.projectAccess;
    const job = await prisma.executionJob.findFirst({
        where: { id: parsed.data.jobId, projectId: access.projectId },
    });
    if (!job) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Execution not found.' } });
    }
    const canSeeAll = ROLE_RANK[access.role] >= ROLE_RANK.ADMIN;
    if (!canSeeAll && job.userId !== req.auth.user.id) {
        // Do not reveal whether another member's job exists.
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Execution not found.' } });
    }
    return res.json({ data: toExecutionJobView(job) });
}));
/**
 * Queue an execution of a stored project file. The server reads the file from
 * MySQL rather than accepting code in the request body, so execution always
 * targets a file the caller is authorized to see and the size limit applies to
 * what was persisted.
 */
projectExecutionsRouter.post('/projects/:id/executions', requireProjectRole('EDITOR'), rateLimit({
    keyPrefix: 'execution-start',
    windowMs: 60_000,
    max: 10,
    key: (req) => `${req.auth?.user.id ?? 'anonymous'}:${req.params.id ?? ''}`,
}), asyncHandler(async (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) {
        return replyValidation(res, parsed.error.errors[0]?.message ?? 'Invalid execution request.');
    }
    if (!isExecutionLanguage(parsed.data.language)) {
        return replyValidation(res, 'That language is not supported for execution.');
    }
    const access = req.projectAccess;
    const file = await prisma.projectFile.findFirst({
        where: { id: parsed.data.fileId, projectId: access.projectId },
        select: { id: true, name: true, isFolder: true, content: true, language: true },
    });
    if (!file) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found.' } });
    }
    if (file.isFolder) {
        return replyValidation(res, 'Folders cannot be executed.');
    }
    const derivedLanguage = languageFromFileName(file.name);
    if (!derivedLanguage) {
        return replyValidation(res, 'This file type is not supported for execution.');
    }
    if (derivedLanguage !== parsed.data.language) {
        return replyValidation(res, `The requested language does not match this file (expected ${derivedLanguage}).`);
    }
    if (file.content.trim().length === 0) {
        return replyValidation(res, 'The file is empty. Add some code before running it.');
    }
    const codeBytes = Buffer.byteLength(file.content, 'utf8');
    if (codeBytes > env.EXECUTION_MAX_CODE_BYTES) {
        return res.status(413).json({
            error: {
                code: 'CODE_TOO_LARGE',
                message: `Code must be ${Math.floor(env.EXECUTION_MAX_CODE_BYTES / 1024)} KB or smaller to run.`,
            },
        });
    }
    // Refuse to create a job when the sandbox backend is not actually ready.
    // This keeps the UI honest and prevents jobs that can never complete.
    const capabilities = await executionCapabilities();
    if (!capabilities.enabled) {
        return res.status(503).json({
            error: {
                code: 'EXECUTION_UNAVAILABLE',
                message: capabilities.reason ?? 'Secure code execution is not available.',
            },
        });
    }
    try {
        const job = await startExecution({
            projectId: access.projectId,
            fileId: file.id,
            userId: req.auth.user.id,
            language: derivedLanguage,
            entryFile: entryFileFor(derivedLanguage, file.name),
            code: file.content,
        });
        return res.status(202).json({ data: job });
    }
    catch (error) {
        // The unique nullable `active_key` index is the cross-instance guard
        // against duplicate submissions from double clicks or multiple tabs.
        if (error instanceof Error &&
            'code' in error &&
            error.code === 'P2002') {
            return res.status(409).json({
                error: {
                    code: 'EXECUTION_ALREADY_RUNNING',
                    message: 'An execution is already queued or running for this project. Wait for it to finish or cancel it.',
                },
            });
        }
        throw error;
    }
}));
/** Cancel a queued/running job. Job owners and project admins may cancel. */
projectExecutionsRouter.post('/projects/:id/executions/:jobId/cancel', requireProjectRole('EDITOR'), asyncHandler(async (req, res) => {
    const parsed = jobIdParamSchema.safeParse(req.params);
    if (!parsed.success) {
        return replyValidation(res, parsed.error.errors[0]?.message ?? 'Invalid execution ID.');
    }
    const access = req.projectAccess;
    const job = await prisma.executionJob.findFirst({
        where: { id: parsed.data.jobId, projectId: access.projectId },
        select: { id: true, userId: true },
    });
    if (!job) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Execution not found.' } });
    }
    const canCancelAny = ROLE_RANK[access.role] >= ROLE_RANK.ADMIN;
    if (!canCancelAny && job.userId !== req.auth.user.id) {
        return res.status(403).json({
            error: { code: 'FORBIDDEN', message: 'You can only cancel your own executions.' },
        });
    }
    const updated = await cancelExecution(job.id);
    if (!updated) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Execution not found.' } });
    }
    return res.json({ data: toExecutionJobView(updated) });
}));
