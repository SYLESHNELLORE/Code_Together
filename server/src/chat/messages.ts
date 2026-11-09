import type { Prisma } from '@prisma/client';
import type { ChatMessageView } from './types.js';

export type ChatMessageWithSender = Prisma.ChatMessageGetPayload<{
  include: {
    sender: { select: { id: true; username: true; avatarUrl: true } };
  };
}>;

/** Public message shape. Soft-deleted content is never returned to clients. */
export function toChatMessageView(
  message: ChatMessageWithSender,
  projectId: string,
): ChatMessageView {
  return {
    id: message.id,
    projectId,
    content: message.deletedAt ? '' : message.content,
    createdAt: message.createdAt.toISOString(),
    deletedAt: message.deletedAt ? message.deletedAt.toISOString() : null,
    sender: {
      id: message.sender.id,
      username: message.sender.username,
      avatarUrl: message.sender.avatarUrl,
    },
  };
}
