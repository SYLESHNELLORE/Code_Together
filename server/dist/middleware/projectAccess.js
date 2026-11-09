import { z } from 'zod';
import { prisma } from '../db/prisma.js';
const projectIdSchema = z.string().uuid({ message: 'Invalid project ID format.' });
/**
 * Permission hierarchy. A role may always perform actions available to roles
 * below it. OWNER is the only role that can manage ADMINs or delete a project.
 */
export const ROLE_RANK = {
    VIEWER: 1,
    EDITOR: 2,
    ADMIN: 3,
    OWNER: 4,
};
function projectIdFromRequest(params) {
    const raw = params.projectId ?? params.id;
    return typeof raw === 'string' ? raw : null;
}
/**
 * Resolve a user's role on one project. Returns null when the project does not
 * exist or the caller is not a member. Shared by HTTP middleware and the
 * authenticated Socket.IO collaboration layer.
 */
export async function resolveProjectAccess(userId, projectId) {
    const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
            id: true,
            ownerId: true,
            members: {
                where: { userId },
                select: { role: true },
                take: 1,
            },
        },
    });
    if (!project)
        return null;
    const membershipRole = project.members[0]?.role ?? null;
    // OWNER is derived from projects.owner_id. A stray OWNER membership row
    // must never grant owner powers to a different user.
    const role = project.ownerId === userId
        ? 'OWNER'
        : membershipRole === 'OWNER'
            ? null
            : membershipRole;
    if (!role)
        return null;
    return { projectId: project.id, ownerId: project.ownerId, role };
}
/**
 * Resolve the caller's role on the project identified by `:id` or `:projectId`
 * and reject the request unless they meet the minimum role.
 *
 * Non-members receive 404 rather than 403 so private project IDs cannot be
 * enumerated. Authenticated members who lack a specific capability receive 403.
 */
export function requireProjectRole(minRole) {
    return (req, res, next) => {
        void (async () => {
            if (!req.auth) {
                res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in to continue.' } });
                return;
            }
            const rawProjectId = projectIdFromRequest(req.params);
            const parsed = projectIdSchema.safeParse(rawProjectId);
            if (!parsed.success) {
                res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid project ID.' } });
                return;
            }
            const access = await resolveProjectAccess(req.auth.user.id, parsed.data);
            if (!access) {
                res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found.' } });
                return;
            }
            if (ROLE_RANK[access.role] < ROLE_RANK[minRole]) {
                res.status(403).json({
                    error: {
                        code: 'FORBIDDEN',
                        message: 'You do not have permission to perform this action on this project.',
                    },
                });
                return;
            }
            req.projectAccess = access;
            next();
        })().catch(next);
    };
}
/** Owners manage everyone except themselves; admins manage editors/viewers. */
export function canManageRole(actorRole, targetRole) {
    if (targetRole === 'OWNER')
        return false;
    if (actorRole === 'OWNER')
        return true;
    if (actorRole === 'ADMIN')
        return targetRole === 'EDITOR' || targetRole === 'VIEWER';
    return false;
}
/** Whether `actorRole` may grant `requestedRole` through an invitation or edit. */
export function canAssignRole(actorRole, requestedRole) {
    if (requestedRole === 'OWNER')
        return false;
    return canManageRole(actorRole, requestedRole);
}
