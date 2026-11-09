import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireProjectRole } from '../middleware/projectAccess.js';
import { getOrCreateChatRoom } from '../chat/room.js';
import { toChatMessageView } from '../chat/messages.js';
import { asyncHandler } from './asyncHandler.js';
export const projectChatRouter = Router();
const historyQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(30),
    cursor: z.string().uuid({ message: 'Invalid history cursor.' }).optional(),
    after: z.string().uuid({ message: 'Invalid catch-up cursor.' }).optional(),
}).refine((value) => !(value.cursor && value.after), {
    message: 'Use either cursor or after, not both.',
});
const senderSelect = {
    select: { id: true, username: true, avatarUrl: true },
};
/**
 * Cursor-paginated project chat history. The project and room are resolved
 * server-side; non-members receive 404 from requireProjectRole before any
 * message rows are read.
 *
 * - `cursor=<messageId>` loads older messages (scrollback)
 * - `after=<messageId>` loads newer messages (reconnect catch-up)
 *
 * Results are always ascending by (createdAt, id) for straightforward rendering.
 */
projectChatRouter.get('/projects/:id/chat/messages', requireProjectRole('VIEWER'), rateLimit({
    keyPrefix: 'chat-history',
    windowMs: 60_000,
    max: 120,
    key: (req) => req.auth?.user.id ?? 'anonymous',
}), asyncHandler(async (req, res) => {
    const parsed = historyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({
            error: { code: 'VALIDATION_ERROR', message: parsed.error.errors[0]?.message ?? 'Invalid query.' },
        });
    }
    const projectId = req.projectAccess.projectId;
    const room = await getOrCreateChatRoom(projectId, req.auth.user.id);
    let anchor = null;
    const anchorId = parsed.data.cursor ?? parsed.data.after;
    if (anchorId) {
        const found = await prisma.chatMessage.findFirst({
            where: { id: anchorId, roomId: room.id },
            select: { id: true, createdAt: true },
        });
        if (!found) {
            return res.status(400).json({
                error: { code: 'INVALID_CURSOR', message: 'The history cursor no longer exists in this room.' },
            });
        }
        anchor = found;
    }
    let where = { roomId: room.id };
    if (anchor && parsed.data.cursor) {
        where = {
            roomId: room.id,
            OR: [
                { createdAt: { lt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { lt: anchor.id } },
            ],
        };
    }
    else if (anchor && parsed.data.after) {
        where = {
            roomId: room.id,
            OR: [
                { createdAt: { gt: anchor.createdAt } },
                { createdAt: anchor.createdAt, id: { gt: anchor.id } },
            ],
        };
    }
    // The initial page and cursor scrollback both load newest-first (then
    // reverse for display), while `after` catch-up reads forward in time.
    const descending = !parsed.data.after;
    const rows = await prisma.chatMessage.findMany({
        where,
        orderBy: descending
            ? [{ createdAt: 'desc' }, { id: 'desc' }]
            : [{ createdAt: 'asc' }, { id: 'asc' }],
        take: parsed.data.limit + 1,
        include: { sender: senderSelect },
    });
    const hasMore = rows.length > parsed.data.limit;
    const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    const ordered = descending ? [...page].reverse() : page;
    const messages = ordered.map((message) => toChatMessageView(message, projectId));
    const nextCursor = hasMore
        ? descending
            ? messages[0]?.id ?? null
            : messages[messages.length - 1]?.id ?? null
        : null;
    return res.json({
        data: {
            roomId: room.id,
            messages,
            hasMore,
            nextCursor,
        },
    });
}));
