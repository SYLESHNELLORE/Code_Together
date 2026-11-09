import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { hashInvitationToken } from '../auth/invitationTokens.js';
import { asyncHandler } from './asyncHandler.js';
export const invitationRouter = Router();
const tokenSchema = z.object({
    token: z.string().min(20, 'Invitation token is required.').max(256, 'Invitation token is invalid.'),
});
const invitationIdSchema = z.object({
    id: z.string().uuid({ message: 'Invalid invitation ID.' }),
});
function invitationProblem(invitation, user) {
    if (!invitation)
        return 'invalid';
    if (invitation.usedAt || invitation.revokedAt || invitation.expiresAt.getTime() <= Date.now()) {
        return 'invalid';
    }
    if (invitation.email && invitation.email.toLowerCase() !== user.email.toLowerCase()) {
        return 'forbidden';
    }
    return null;
}
function invalidInvitationResponse(res) {
    return res.status(404).json({
        error: {
            code: 'INVITATION_INVALID',
            message: 'This invitation is invalid, expired or has already been used.',
        },
    });
}
/**
 * Accept an invitation atomically. The conditional update is the claim: only
 * one concurrent request can turn a pending invitation into an accepted one.
 */
async function acceptInvitation(lookup, user, requireEmailBound) {
    const where = lookup.kind === 'token'
        ? { tokenHash: hashInvitationToken(lookup.token) }
        : { id: lookup.id };
    return prisma.$transaction(async (tx) => {
        const invitation = await tx.projectInvitation.findUnique({
            where,
            select: {
                id: true,
                projectId: true,
                email: true,
                role: true,
                expiresAt: true,
                usedAt: true,
                revokedAt: true,
                project: { select: { id: true, name: true, description: true, ownerId: true } },
            },
        });
        const problem = invitationProblem(invitation, user);
        if (problem)
            return { kind: problem };
        if (requireEmailBound && !invitation.email) {
            return { kind: 'forbidden' };
        }
        const now = new Date();
        const project = invitation.project;
        if (project.ownerId === user.id) {
            await tx.projectInvitation.update({
                where: { id: invitation.id },
                data: { usedAt: now, acceptedById: user.id },
            });
            return { kind: 'accepted', project, role: 'OWNER', alreadyMember: true };
        }
        const existing = await tx.projectMember.findUnique({
            where: { projectId_userId: { projectId: invitation.projectId, userId: user.id } },
            select: { role: true },
        });
        if (existing) {
            await tx.projectInvitation.update({
                where: { id: invitation.id },
                data: { usedAt: now, acceptedById: user.id },
            });
            return { kind: 'accepted', project, role: existing.role, alreadyMember: true };
        }
        const claimed = await tx.projectInvitation.updateMany({
            where: {
                id: invitation.id,
                usedAt: null,
                revokedAt: null,
                expiresAt: { gt: now },
            },
            data: { usedAt: now, acceptedById: user.id },
        });
        if (claimed.count !== 1) {
            return { kind: 'invalid' };
        }
        await tx.projectMember.create({
            data: {
                projectId: invitation.projectId,
                userId: user.id,
                role: invitation.role,
            },
        });
        return { kind: 'accepted', project, role: invitation.role, alreadyMember: false };
    });
}
invitationRouter.post('/preview', asyncHandler(async (req, res) => {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
        return invalidInvitationResponse(res);
    }
    const invitation = await prisma.projectInvitation.findUnique({
        where: { tokenHash: hashInvitationToken(parsed.data.token) },
        select: {
            id: true,
            projectId: true,
            email: true,
            role: true,
            expiresAt: true,
            usedAt: true,
            revokedAt: true,
            invitedBy: { select: { id: true, username: true } },
            project: {
                select: {
                    id: true,
                    name: true,
                    description: true,
                    ownerId: true,
                    owner: { select: { id: true, username: true } },
                },
            },
        },
    });
    const user = req.auth.user;
    const problem = invitationProblem(invitation, user);
    if (problem === 'invalid' || !invitation) {
        return invalidInvitationResponse(res);
    }
    if (problem === 'forbidden') {
        return res.status(403).json({
            error: { code: 'INVITATION_FORBIDDEN', message: 'This invitation was issued to a different account.' },
        });
    }
    const membership = await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: invitation.projectId, userId: user.id } },
        select: { role: true },
    });
    const role = invitation.project.ownerId === user.id ? 'OWNER' : membership?.role ?? null;
    return res.json({
        data: {
            project: {
                id: invitation.project.id,
                name: invitation.project.name,
                description: invitation.project.description,
                owner: invitation.project.owner,
            },
            role: invitation.role,
            expiresAt: invitation.expiresAt,
            invitedBy: invitation.invitedBy,
            alreadyMember: role !== null,
            currentRole: role,
        },
    });
}));
invitationRouter.post('/accept', asyncHandler(async (req, res) => {
    const parsed = tokenSchema.safeParse(req.body);
    if (!parsed.success) {
        return invalidInvitationResponse(res);
    }
    const result = await acceptInvitation({ kind: 'token', token: parsed.data.token }, req.auth.user, false);
    if (result.kind === 'invalid') {
        return invalidInvitationResponse(res);
    }
    if (result.kind === 'forbidden') {
        return res.status(403).json({
            error: { code: 'INVITATION_FORBIDDEN', message: 'This invitation was issued to a different account.' },
        });
    }
    return res.json({
        data: {
            project: result.project,
            role: result.role,
            alreadyMember: result.alreadyMember,
        },
    });
}));
/** Accept an email-bound invitation from the signed-in user's dashboard. */
invitationRouter.post('/:id/accept', asyncHandler(async (req, res) => {
    const parsed = invitationIdSchema.safeParse(req.params);
    if (!parsed.success) {
        return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid invitation ID.' } });
    }
    const result = await acceptInvitation({ kind: 'id', id: parsed.data.id }, req.auth.user, true);
    if (result.kind === 'invalid') {
        return invalidInvitationResponse(res);
    }
    if (result.kind === 'forbidden') {
        return res.status(403).json({
            error: { code: 'INVITATION_FORBIDDEN', message: 'This invitation was issued to a different account.' },
        });
    }
    return res.json({
        data: {
            project: result.project,
            role: result.role,
            alreadyMember: result.alreadyMember,
        },
    });
}));
/** Pending email invitations addressed to the signed-in user. */
invitationRouter.get('/mine', asyncHandler(async (req, res) => {
    const user = req.auth.user;
    const invitations = await prisma.projectInvitation.findMany({
        where: {
            email: user.email,
            usedAt: null,
            revokedAt: null,
            expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
            id: true,
            role: true,
            expiresAt: true,
            createdAt: true,
            invitedBy: { select: { id: true, username: true } },
            project: {
                select: {
                    id: true,
                    name: true,
                    description: true,
                    ownerId: true,
                    members: { where: { userId: user.id }, select: { role: true }, take: 1 },
                },
            },
        },
    });
    const data = invitations.map(({ project, ...invitation }) => ({
        ...invitation,
        project: {
            id: project.id,
            name: project.name,
            description: project.description,
        },
        alreadyMember: project.ownerId === user.id || project.members.length > 0,
    }));
    res.json({ data });
}));
