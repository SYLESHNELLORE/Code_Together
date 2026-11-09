import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { requireProjectRole } from '../middleware/projectAccess.js';
import { asyncHandler } from './asyncHandler.js';

export const projectRouter = Router();

const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'Project name is required.').max(80, 'Project name must be 80 characters or fewer.'),
  description: z.string().trim().max(500, 'Description must be 500 characters or fewer.').default(''),
});

const updateProjectSchema = createProjectSchema.partial().extend({
  visibility: z.enum(['PRIVATE', 'INVITE_ONLY']).optional(),
});

const projectSummarySelect = {
  id: true,
  name: true,
  description: true,
  visibility: true,
  createdAt: true,
  updatedAt: true,
  ownerId: true,
  owner: { select: { id: true, username: true } },
  _count: {
    select: {
      files: { where: { isFolder: false } },
      members: true,
      rooms: true,
    },
  },
} as const;

projectRouter.get('/', asyncHandler(async (req, res) => {
  const userId = req.auth!.user.id;
  const rows = await prisma.project.findMany({
    where: {
      OR: [{ ownerId: userId }, { members: { some: { userId } } }],
    },
    orderBy: { updatedAt: 'desc' },
    select: {
      ...projectSummarySelect,
      members: { where: { userId }, select: { role: true }, take: 1 },
    },
  });

  const projects = rows.map(({ members, ownerId, ...project }) => ({
    ...project,
    role: ownerId === userId ? 'OWNER' : members[0]?.role ?? 'VIEWER',
  }));

  res.json({ data: projects });
}));

projectRouter.post('/', asyncHandler(async (req, res) => {
  const parsed = createProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: parsed.error.errors.map((e) => e.message).join(' ') },
    });
  }

  const userId = req.auth!.user.id;

  // The owner is also persisted as a roster member so team listings and role
  // checks use one consistent source for membership.
  const projectId = await prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        name: parsed.data.name,
        description: parsed.data.description,
        // Identity always comes from the verified session, never the request body.
        ownerId: userId,
      },
      select: { id: true },
    });

    await tx.projectMember.create({
      data: { projectId: project.id, userId, role: 'OWNER' },
    });

    return project.id;
  });

  const { ownerId, ...project } = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: projectSummarySelect,
  });

  return res.status(201).json({
    data: {
      ...project,
      role: ownerId === userId ? 'OWNER' : 'VIEWER',
    },
  });
}));

projectRouter.get('/:id', requireProjectRole('VIEWER'), asyncHandler(async (req, res) => {
  const { ownerId, ...project } = await prisma.project.findUniqueOrThrow({
    where: { id: req.projectAccess!.projectId },
    select: projectSummarySelect,
  });

  return res.json({
    data: {
      ...project,
      role: req.projectAccess!.role,
      isOwner: ownerId === req.auth!.user.id,
    },
  });
}));

projectRouter.patch('/:id', requireProjectRole('ADMIN'), asyncHandler(async (req, res) => {
  const parsed = updateProjectSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: { code: 'VALIDATION_ERROR', message: parsed.error.errors.map((e) => e.message).join(' ') },
    });
  }

  if (Object.keys(parsed.data).length === 0) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Provide at least one field to update.' } });
  }

  try {
    const { ownerId, ...project } = await prisma.project.update({
      where: { id: req.projectAccess!.projectId },
      data: parsed.data,
      select: projectSummarySelect,
    });

    return res.json({
      data: {
        ...project,
        role: req.projectAccess!.role,
        isOwner: ownerId === req.auth!.user.id,
      },
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found.' } });
    }
    throw error;
  }
}));

projectRouter.delete('/:id', requireProjectRole('OWNER'), asyncHandler(async (req, res) => {
  try {
    await prisma.project.delete({ where: { id: req.projectAccess!.projectId } });
    return res.status(204).end();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2025') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Project not found.' } });
    }
    throw error;
  }
}));
