import type { ProjectRole } from '@prisma/client';

export interface ChatPresenceUser {
  id: string;
  username: string;
}

export interface ChatMessageView {
  id: string;
  projectId: string;
  content: string;
  createdAt: string;
  deletedAt: string | null;
  sender: {
    id: string;
    username: string;
    avatarUrl: string | null;
  };
}

export interface ChatSocketError {
  code: string;
  message: string;
}

export interface ChatJoinAck {
  ok: boolean;
  error?: ChatSocketError;
  projectId?: string;
  roomId?: string;
  role?: ProjectRole;
  presence?: ChatPresenceUser[];
}

export interface ChatSendAck {
  ok: boolean;
  error?: ChatSocketError;
  message?: ChatMessageView;
}

export interface ChatDeleteAck {
  ok: boolean;
  error?: ChatSocketError;
  messageId?: string;
}

export interface ChatPresenceEvent {
  projectId: string;
  roomId: string;
  users: ChatPresenceUser[];
}

export interface ChatTypingEvent {
  projectId: string;
  roomId: string;
  users: ChatPresenceUser[];
}

export interface ChatMessageEvent {
  projectId: string;
  roomId: string;
  message: ChatMessageView;
}

export interface ChatMessageDeletedEvent {
  projectId: string;
  roomId: string;
  messageId: string;
  deletedAt: string;
  deletedById: string;
}
