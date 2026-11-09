import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { createInvitationToken, hashInvitationToken } from '../auth/invitationTokens.js';
import { canAssignRole, canManageRole, requireProjectRole } from '../middleware/projectAccess.js';
import { asyncHandler } from './asyncHandler.js';

export const projectInvitationsRouter = Router();

const optionalEmailSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().toLowerCase().max(254, 'Email must be 254 characters or fewer.').email('Enter a valid email address.').optional(),
);

const createInvitationSchema = z.object({
  email: optionalEmailSchema,
  role: z.enum(['ADMIN', 'EDITOR', 'VIEWER']).default('EDITOR'),
  expiresInDays: z.number().int().min(1).max(30).default(7),
});

const invitationIdParamSchema = z.object({
  invitationId: z.string().uuid({ message: 'Invalid invitation ID.' }),
});

const invitationSelect = {
  id: true,
  email: true,
  role: true,
  expiresAt: true,
  usedAt: true,
  revokedAt: true,
  createdAt: true,
  invitedBy: { select: { id: true, username: true } },
  acceptedBy: { select: { id: true, username: true } },
} as const;

type InvitationRow = {
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
};

export function invitationStatus(invitation: InvitationRow): 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED' {
  if (invitation.revokedAt) return 'REVOKED';
  if (invitation.usedAt) return 'ACCEPTED';
  if (invitation.expiresAt.getTime() <= Date.now()) return 'EXPIRED';
  return 'PENDING';
}

export function toPublicInvitation<T extends InvitationRow>(invitation: T) {
  return { ...invitation, status: invitationStatus(invitation) };
}

projectInvitationsRouter.get('/:id/invitations', requireProjectRole('ADMIN'), asyncHandler(async (req, res) => {
  const invitations = await prisma.projectInvitation.findMany({
    where: { projectId: req.projectAccess!.projectId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    select: invitationSelect,
  });

  res.json({ data: invitations.map(toPublicInvitation) });
}));

projectInvitationsRouter.post('/:id/invitations', requireProjectRole('ADMIN'), asyncHandler(async (req, res) => {
  const parsed = createInvitationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: parsed.error.errors.map((error) => error.message).join(' ') },
    });
  }

  const access = req.projectAccess!;
  if (!canAssignRole(access.role, parsed.data.role)) {
    return res.status(403).json({
      error: { code: 'FORBIDDEN', message: 'You cannot invite a member with a role equal to or above your own.' },
    });
  }

  if (parsed.data.email) {
    const existingUser = await prisma.user.findUnique({
      where: { email: parsed.data.email },
      select: { id: true },
    });

    if (existingUser) {
      if (existingUser.id === access.ownerId) {
        return res.status(409).json({ error: { code: 'ALREADY_MEMBER', message: 'That user is already the project owner.' } });
      }

      const membership = await prisma.projectMember.findUnique({
        where: {
          projectId_userId: { projectId: access.projectId, userId: existingUser.id },
        },
        select: { userId: true },
      });
      if (membership) {
        return res.status(409).json({ error: { code: 'ALREADY_MEMBER', message: 'That user is already a member of this project.' } });
      }
    }

    const pending = await prisma.projectInvitation.findFirst({
      where: {
        projectId: access.projectId,
        email: parsed.data.email,
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    if (pending) {
      return res.status(409).json({
        error: { code: 'INVITATION_EXISTS', message: 'A pending invitation already exists for that email. Revoke it first to replace it.' },
      });
    }
  }

  const token = createInvitationToken();
  const expiresAt = new Date(Date.now() + parsed.data.expiresInDays * 24 * 60 * 60 * 1000);

  const invitation = await prisma.projectInvitation.create({
    data: {
      projectId: access.projectId,
      invitedById: req.auth!.user.id,
      email: parsed.data.email ?? null,
      role: parsed.data.role,
      tokenHash: hashInvitationToken(token),
      expiresAt,
    },
    select: invitationSelect,
  });

  // The plaintext bearer token is returned exactly once. Only its SHA-256 hash
  // is stored, and it must never be written to logs.
  return res.status(201).json({
    data: {
      invitation: toPublicInvitation(invitation),
      token,
      expiresAt,
    },
  });
}));

projectInvitationsRouter.delete('/:id/invitations/:invitationId', requireProjectRole('ADMIN'), asyncHandler(async (req, res) => {
  const paramValidation = invitationIdParamSchema.safeParse(req.params);
  if (!paramValidation.success) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Invalid invitation ID.' } });
  }

  const invitation = await prisma.projectInvitation.findFirst({
    where: {
      id: paramValidation.data.invitationId,
      projectId: req.projectAccess!.projectId,
    },
    select: { id: true, role: true, usedAt: true, revokedAt: true },
  });

  if (!invitation) {
    return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitation not found.' } });
  }

  if (!canManageRole(req.projectAccess!.role, invitation.role)) {
    return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You cannot revoke this invitation.' } });
  }

  if (invitation.usedAt) {
    return res.status(409).json({ error: { code: 'INVITATION_USED', message: 'This invitation has already been accepted.' } });
  }

  if (!invitation.revokedAt) {
    await prisma.projectInvitation.update({
      where: { id: invitation.id },
      data: { revokedAt: new Date() },
    });
  }

  return res.status(204).end();
}));
