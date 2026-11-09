import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';
/**
 * Resolve the single project chat room, creating it on first use. The unique
 * `rooms.project_id` index makes this race-safe even with concurrent joins.
 */
export async function getOrCreateChatRoom(projectId, createdById) {
    try {
        return await prisma.room.upsert({
            where: { projectId },
            update: {},
            create: { projectId, createdById },
            select: { id: true, projectId: true },
        });
    }
    catch (error) {
        // Two joins may race to create the room. The loser reads the winner's row.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            const room = await prisma.room.findUnique({
                where: { projectId },
                select: { id: true, projectId: true },
            });
            if (room)
                return room;
        }
        throw error;
    }
}
