import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { canAssignRole, canManageRole, requireProjectRole } from '../middleware/projectAccess.js';
import { asyncHandler } from './asyncHandler.js';
export const projectMembersRouter = Router();
const userIdParamSchema = z.object({
    userId: z.string().uuid({ message: 'Invalid user ID.' }),
});
const updateMemberSchema = z.object({
    // Ownership transfer is not supported in this phase, so OWNER can never be
    // granted through the member API.
    role: z.enum(['ADMIN', 'EDITOR', 'VIEWER']),
});
const memberSelect = {
    userId: true,
    role: true,
    joinedAt: true,
    user: { select: { id: true, username: true, avatarUrl: true } },
};
projectMembersRouter.get('/:id/members', requireProjectRole('VIEWER'), asyncHandler(async (req, res) => {
    const members = await prisma.projectMember.findMany({
        where: { projectId: req.projectAccess.projectId },
        orderBy: [{ joinedAt: 'asc' }],
        select: memberSelect,
    });
    res.json({ data: members });
}));
projectMembersRouter.patch('/:id/members/:userId', requireProjectRole('ADMIN'), asyncHandler(async (req, res) => {
    const paramValidation = userIdParamSchema.safeParse(req.params);
    if (!paramValidation.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid user ID.' } });
    }
    const parsed = updateMemberSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({
            error: {
                code: 'VALIDATION_ERROR',
                message: 'Role must be ADMIN, EDITOR or VIEWER. Ownership cannot be transferred here.',
            },
        });
    }
    const access = req.projectAccess;
    if (paramValidation.data.userId === access.ownerId) {
        return res.status(403).json({ error: { code: 'OWNER_IMMUTABLE', message: 'The project owner cannot be changed.' } });
    }
    const target = await prisma.projectMember.findUnique({
        where: {
            projectId_userId: {
                projectId: access.projectId,
                userId: paramValidation.data.userId,
            },
        },
        select: { userId: true, role: true },
    });
    if (!target) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project member not found.' } });
    }
    if (target.role === 'OWNER' || !canManageRole(access.role, target.role)) {
        return res.status(403).json({
            error: { code: 'FORBIDDEN', message: 'You cannot change this member\'s role.' },
        });
    }
    if (!canAssignRole(access.role, parsed.data.role)) {
        return res.status(403).json({
            error: { code: 'FORBIDDEN', message: 'You cannot grant a role equal to or above your own.' },
        });
    }
    const updated = await prisma.projectMember.update({
        where: {
            projectId_userId: {
                projectId: access.projectId,
                userId: paramValidation.data.userId,
            },
        },
        data: { role: parsed.data.role },
        select: memberSelect,
    });
    return res.json({ data: updated });
}));
projectMembersRouter.delete('/:id/members/:userId', requireProjectRole('VIEWER'), asyncHandler(async (req, res) => {
    const paramValidation = userIdParamSchema.safeParse(req.params);
    if (!paramValidation.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid user ID.' } });
    }
    const access = req.projectAccess;
    const targetUserId = paramValidation.data.userId;
    if (targetUserId === access.ownerId) {
        return res.status(403).json({ error: { code: 'OWNER_IMMUTABLE', message: 'The project owner cannot be removed.' } });
    }
    const target = await prisma.projectMember.findUnique({
        where: {
            projectId_userId: { projectId: access.projectId, userId: targetUserId },
        },
        select: { userId: true, role: true },
    });
    if (!target) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project member not found.' } });
    }
    // Any non-owner member may leave on their own. Removing someone else requires
    // a role strictly above the target role.
    const isSelf = targetUserId === req.auth.user.id;
    if (!isSelf && !canManageRole(access.role, target.role)) {
        return res.status(403).json({
            error: { code: 'FORBIDDEN', message: 'You cannot remove this member.' },
        });
    }
    await prisma.projectMember.delete({
        where: {
            projectId_userId: { projectId: access.projectId, userId: targetUserId },
        },
    });
    return res.status(204).end();
}));
