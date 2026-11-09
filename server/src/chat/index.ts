import type { Server, Socket } from 'socket.io';
import { Prisma, type ProjectRole } from '@prisma/client';
import { applySocketAuthentication, socketAuthData } from '../auth/socket.js';
import { prisma } from '../db/prisma.js';
import { ROLE_RANK, resolveProjectAccess } from '../middleware/projectAccess.js';
import { getOrCreateChatRoom } from './room.js';
import { toChatMessageView, type ChatMessageWithSender } from './messages.js';
import type {
  ChatDeleteAck,
  ChatJoinAck,
  ChatMessageDeletedEvent,
  ChatMessageEvent,
  ChatPresenceEvent,
  ChatPresenceUser,
  ChatSendAck,
  ChatSocketError,
  ChatTypingEvent,
} from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const MAX_MESSAGE_LENGTH = 2_000;
const TYPING_TIMEOUT_MS = 6_000;
const ROLE_RECHECK_MS = 15_000;
const MESSAGE_RATE_WINDOW_MS = 10_000;
const MAX_MESSAGES_PER_WINDOW = 10;
const TYPING_RATE_WINDOW_MS = 10_000;
const MAX_TYPING_EVENTS_PER_WINDOW = 40;

interface ChatMembership {
  roomId: string;
  projectId: string;
  role: ProjectRole;
  checkedAt: number;
}

interface PresenceEntry {
  userId: string;
  username: string;
}

interface TypingEntry {
  userId: string;
  username: string;
  timer: NodeJS.Timeout | null;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

const membershipsBySocket = new WeakMap<Socket, Map<string, ChatMembership>>();
const presenceByRoom = new Map<string, Map<string, PresenceEntry>>();
const typingByRoom = new Map<string, Map<string, TypingEntry>>();
const messageBuckets = new Map<string, RateBucket>();
const typingBuckets = new Map<string, RateBucket>();
const configuredServers = new WeakSet<Server>();

let attachedServer: Server | null = null;

const senderSelect = {
  select: { id: true, username: true, avatarUrl: true },
} as const;

function chatRoomName(roomId: string): string {
  return `chat:${roomId}`;
}

function membershipsFor(socket: Socket): Map<string, ChatMembership> {
  let map = membershipsBySocket.get(socket);
  if (!map) {
    map = new Map();
    membershipsBySocket.set(socket, map);
  }
  return map;
}

function respond(ack: unknown, payload: unknown): void {
  if (typeof ack === 'function') (ack as (value: unknown) => void)(payload);
}

function fail(code: string, message: string): { ok: false; error: ChatSocketError } {
  return { ok: false, error: { code, message } };
}

function expireSocket(socket: Socket): boolean {
  const auth = socketAuthData(socket);
  if (!auth) {
    socket.emit('chat:error', { code: 'UNAUTHENTICATED', message: 'Please sign in to use project chat.' });
    socket.disconnect(true);
    return true;
  }
  if (auth.sessionExpiresAt <= Date.now()) {
    socket.emit('chat:error', { code: 'SESSION_EXPIRED', message: 'Your session expired. Please sign in again.' });
    socket.disconnect(true);
    return true;
  }
  return false;
}

function uniqueUsers(entries: Iterable<PresenceEntry>): ChatPresenceUser[] {
  const users = new Map<string, ChatPresenceUser>();
  for (const entry of entries) {
    if (!users.has(entry.userId)) users.set(entry.userId, { id: entry.userId, username: entry.username });
  }
  return [...users.values()].sort((left, right) => left.username.localeCompare(right.username));
}

function presenceFor(roomId: string): ChatPresenceUser[] {
  return uniqueUsers(presenceByRoom.get(roomId)?.values() ?? []);
}

function typingFor(roomId: string): ChatPresenceUser[] {
  return uniqueUsers(typingByRoom.get(roomId)?.values() ?? []);
}

function emitPresence(io: Server, projectId: string, roomId: string): void {
  const payload: ChatPresenceEvent = {
    projectId,
    roomId,
    users: presenceFor(roomId),
  };
  io.to(chatRoomName(roomId)).emit('chat:presence', payload);
}

function emitTyping(io: Server, projectId: string, roomId: string): void {
  const payload: ChatTypingEvent = {
    projectId,
    roomId,
    users: typingFor(roomId),
  };
  io.to(chatRoomName(roomId)).emit('chat:typing', payload);
}

function takeBudget(
  buckets: Map<string, RateBucket>,
  key: string,
  windowMs: number,
  max: number,
): boolean {
  const now = Date.now();
  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (current.count >= max) return false;
  current.count += 1;
  return true;
}

function pruneBuckets(): void {
  if (messageBuckets.size + typingBuckets.size < 5_000) return;
  const now = Date.now();
  for (const [key, bucket] of messageBuckets) {
    if (bucket.resetAt <= now) messageBuckets.delete(key);
  }
  for (const [key, bucket] of typingBuckets) {
    if (bucket.resetAt <= now) typingBuckets.delete(key);
  }
}

function clearTyping(roomId: string, socketId: string): boolean {
  const room = typingByRoom.get(roomId);
  const entry = room?.get(socketId);
  if (!entry) return false;
  if (entry.timer) clearTimeout(entry.timer);
  room!.delete(socketId);
  if (room!.size === 0) typingByRoom.delete(roomId);
  return true;
}

function scheduleTypingExpiry(
  io: Server,
  projectId: string,
  roomId: string,
  socketId: string,
): void {
  const room = typingByRoom.get(roomId);
  const entry = room?.get(socketId);
  if (!entry) return;

  if (entry.timer) clearTimeout(entry.timer);
  const timer = setTimeout(() => {
    const currentRoom = typingByRoom.get(roomId);
    const current = currentRoom?.get(socketId);
    if (!current || current.timer !== timer) return;
    current.timer = null;
    currentRoom!.delete(socketId);
    if (currentRoom!.size === 0) typingByRoom.delete(roomId);
    emitTyping(io, projectId, roomId);
  }, TYPING_TIMEOUT_MS);
  timer.unref?.();
  entry.timer = timer;
}

async function validateMembership(socket: Socket, projectId: string): Promise<ChatMembership | null> {
  if (expireSocket(socket)) return null;

  const membership = membershipsFor(socket).get(projectId);
  if (!membership) return null;

  const auth = socketAuthData(socket);
  if (!auth) return null;

  const access = await resolveProjectAccess(auth.user.id, projectId);
  if (!access) {
    await removeMembership(socket, projectId);
    return null;
  }

  membership.role = access.role;
  membership.checkedAt = Date.now();
  return membership;
}

async function removeMembership(socket: Socket, projectId: string): Promise<boolean> {
  const memberships = membershipsFor(socket);
  const membership = memberships.get(projectId);
  if (!membership) return false;

  memberships.delete(projectId);
  const roomName = chatRoomName(membership.roomId);

  const presence = presenceByRoom.get(membership.roomId);
  presence?.delete(socket.id);
  if (presence && presence.size === 0) presenceByRoom.delete(membership.roomId);

  clearTyping(membership.roomId, socket.id);
  await socket.leave(roomName);

  const io = attachedServer;
  if (io) {
    emitPresence(io, projectId, membership.roomId);
    emitTyping(io, projectId, membership.roomId);
  }
  return true;
}

async function handleJoin(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
  if (expireSocket(socket)) return;

  const data = payload as { projectId?: unknown } | null;
  const projectId = typeof data?.projectId === 'string' ? data.projectId : '';
  if (!UUID_PATTERN.test(projectId)) {
    respond(ack, fail('VALIDATION_ERROR', 'Invalid project ID.') satisfies ChatJoinAck);
    return;
  }

  const auth = socketAuthData(socket);
  if (!auth) return;

  // Membership is always resolved from the authenticated session; a project ID
  // from the client is only a lookup key, never an authorization claim.
  const access = await resolveProjectAccess(auth.user.id, projectId);
  if (!access) {
    respond(ack, fail('NOT_FOUND', 'Project not found.') satisfies ChatJoinAck);
    return;
  }

  const room = await getOrCreateChatRoom(projectId, auth.user.id);
  const existing = membershipsFor(socket).get(projectId);
  if (existing && existing.roomId !== room.id) {
    await removeMembership(socket, projectId);
  }

  await socket.join(chatRoomName(room.id));
  membershipsFor(socket).set(projectId, {
    roomId: room.id,
    projectId,
    role: access.role,
    checkedAt: Date.now(),
  });

  let presence = presenceByRoom.get(room.id);
  if (!presence) {
    presence = new Map();
    presenceByRoom.set(room.id, presence);
  }
  presence.set(socket.id, { userId: auth.user.id, username: auth.user.username });

  const io = attachedServer;
  if (io) {
    emitPresence(io, projectId, room.id);
    emitTyping(io, projectId, room.id);
  }

  respond(ack, {
    ok: true,
    projectId,
    roomId: room.id,
    role: access.role,
    presence: presenceFor(room.id),
  } satisfies ChatJoinAck);
}

async function handleLeave(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
  const data = payload as { projectId?: unknown } | null;
  const projectId = typeof data?.projectId === 'string' ? data.projectId : '';
  if (!UUID_PATTERN.test(projectId)) {
    respond(ack, fail('VALIDATION_ERROR', 'Invalid project ID.'));
    return;
  }
  const removed = await removeMembership(socket, projectId);
  respond(ack, { ok: true, removed });
}

function normalizeContent(value: unknown): { content: string; error?: string } {
  if (typeof value !== 'string') return { content: '', error: 'Message content is required.' };
  const content = value.replace(/\r\n?/g, '\n').trim();
  if (!content) return { content: '', error: 'Message cannot be empty.' };
  if (content.length > MAX_MESSAGE_LENGTH) {
    return { content: '', error: `Messages must be ${MAX_MESSAGE_LENGTH} characters or fewer.` };
  }
  // Reject NUL and C0 controls other than tab/newline so the composer cannot
  // smuggle terminal-style control sequences into the transcript.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) {
    return { content: '', error: 'Message contains unsupported control characters.' };
  }
  return { content };
}

function parseClientMessageId(value: unknown): { id: string | null; error?: string } {
  if (value === undefined || value === null) return { id: null };
  if (typeof value !== 'string' || !CLIENT_MESSAGE_ID_PATTERN.test(value)) {
    return { id: null, error: 'Invalid client message ID.' };
  }
  return { id: value };
}

async function handleSend(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
  if (expireSocket(socket)) return;

  const data = payload as {
    projectId?: unknown;
    content?: unknown;
    clientMessageId?: unknown;
  } | null;
  const projectId = typeof data?.projectId === 'string' ? data.projectId : '';
  if (!UUID_PATTERN.test(projectId)) {
    respond(ack, fail('VALIDATION_ERROR', 'Invalid project ID.') satisfies ChatSendAck);
    return;
  }
  if (!membershipsFor(socket).has(projectId)) {
    respond(ack, fail('NOT_JOINED', 'Join the project chat before sending messages.') satisfies ChatSendAck);
    return;
  }

  const auth = socketAuthData(socket);
  if (!auth) return;

  // Sending is a write, so re-check membership every time rather than relying
  // on a cached role from join.
  const access = await resolveProjectAccess(auth.user.id, projectId);
  if (!access) {
    await removeMembership(socket, projectId);
    respond(ack, fail('NOT_FOUND', 'Project not found.') satisfies ChatSendAck);
    return;
  }

  const normalized = normalizeContent(data?.content);
  if (normalized.error) {
    respond(ack, fail('VALIDATION_ERROR', normalized.error) satisfies ChatSendAck);
    return;
  }

  const clientId = parseClientMessageId(data?.clientMessageId);
  if (clientId.error) {
    respond(ack, fail('VALIDATION_ERROR', clientId.error) satisfies ChatSendAck);
    return;
  }

  pruneBuckets();
  if (!takeBudget(
    messageBuckets,
    `message:${auth.user.id}:${projectId}`,
    MESSAGE_RATE_WINDOW_MS,
    MAX_MESSAGES_PER_WINDOW,
  )) {
    socket.emit('chat:error', {
      code: 'RATE_LIMITED',
      message: 'You are sending messages too quickly. Please slow down.',
    });
    respond(ack, fail('RATE_LIMITED', 'Too many messages. Please wait a moment.') satisfies ChatSendAck);
    return;
  }

  const membership = membershipsFor(socket).get(projectId)!;
  let message: ChatMessageWithSender | null = null;
  let created = false;

  try {
    message = await prisma.chatMessage.create({
      data: {
        roomId: membership.roomId,
        senderId: auth.user.id,
        content: normalized.content,
        clientMessageId: clientId.id,
      },
      include: { sender: senderSelect },
    });
    created = true;
  } catch (error) {
    // A retry with the same clientMessageId is idempotent: return the original
    // row instead of duplicating it after a reconnect.
    if (
      clientId.id
      && error instanceof Prisma.PrismaClientKnownRequestError
      && error.code === 'P2002'
    ) {
      message = await prisma.chatMessage.findUnique({
        where: {
          roomId_clientMessageId: {
            roomId: membership.roomId,
            clientMessageId: clientId.id,
          },
        },
        include: { sender: senderSelect },
      });
      if (message && message.senderId !== auth.user.id) {
        respond(ack, fail('CONFLICT', 'That client message ID is already in use.') satisfies ChatSendAck);
        return;
      }
    } else {
      throw error;
    }
  }

  if (!message) {
    respond(ack, fail('CONFLICT', 'Unable to store the message.') satisfies ChatSendAck);
    return;
  }

  const view = toChatMessageView(message, projectId);

  if (created) {
    const io = attachedServer;
    if (io) {
      const event: ChatMessageEvent = {
        projectId,
        roomId: membership.roomId,
        message: view,
      };
      io.to(chatRoomName(membership.roomId)).emit('chat:message', event);
    }
  }

  if (clearTyping(membership.roomId, socket.id)) {
    const io = attachedServer;
    if (io) emitTyping(io, projectId, membership.roomId);
  }

  respond(ack, { ok: true, message: view } satisfies ChatSendAck);
}

async function handleDelete(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
  if (expireSocket(socket)) return;

  const data = payload as { projectId?: unknown; messageId?: unknown } | null;
  const projectId = typeof data?.projectId === 'string' ? data.projectId : '';
  const messageId = typeof data?.messageId === 'string' ? data.messageId : '';
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(messageId)) {
    respond(ack, fail('VALIDATION_ERROR', 'Invalid project or message ID.') satisfies ChatDeleteAck);
    return;
  }

  const membership = membershipsFor(socket).get(projectId);
  if (!membership) {
    respond(ack, fail('NOT_JOINED', 'Join the project chat first.') satisfies ChatDeleteAck);
    return;
  }

  const auth = socketAuthData(socket);
  if (!auth) return;

  const access = await resolveProjectAccess(auth.user.id, projectId);
  if (!access) {
    await removeMembership(socket, projectId);
    respond(ack, fail('NOT_FOUND', 'Project not found.') satisfies ChatDeleteAck);
    return;
  }

  const message = await prisma.chatMessage.findFirst({
    where: { id: messageId, roomId: membership.roomId },
    select: { id: true, senderId: true, deletedAt: true },
  });
  if (!message) {
    respond(ack, fail('NOT_FOUND', 'Message not found.') satisfies ChatDeleteAck);
    return;
  }

  const isAuthor = message.senderId === auth.user.id;
  const isModerator = ROLE_RANK[access.role] >= ROLE_RANK.ADMIN;
  if (!isAuthor && !isModerator) {
    respond(ack, fail('FORBIDDEN', 'You can only delete your own messages.') satisfies ChatDeleteAck);
    return;
  }

  if (message.deletedAt) {
    respond(ack, { ok: true, messageId } satisfies ChatDeleteAck);
    return;
  }

  const deletedAt = new Date();
  await prisma.chatMessage.update({
    where: { id: message.id },
    data: { deletedAt, deletedById: auth.user.id },
  });

  const io = attachedServer;
  if (io) {
    const event: ChatMessageDeletedEvent = {
      projectId,
      roomId: membership.roomId,
      messageId,
      deletedAt: deletedAt.toISOString(),
      deletedById: auth.user.id,
    };
    io.to(chatRoomName(membership.roomId)).emit('chat:message-deleted', event);
  }

  respond(ack, { ok: true, messageId } satisfies ChatDeleteAck);
}

async function handleTyping(socket: Socket, payload: unknown): Promise<void> {
  if (expireSocket(socket)) return;

  const data = payload as { projectId?: unknown; typing?: unknown } | null;
  const projectId = typeof data?.projectId === 'string' ? data.projectId : '';
  if (!UUID_PATTERN.test(projectId) || typeof data?.typing !== 'boolean') return;

  const memberships = membershipsFor(socket);
  const membership = memberships.get(projectId);
  if (!membership) return;

  const auth = socketAuthData(socket);
  if (!auth) return;

  // Revalidate periodically so removed members stop broadcasting presence.
  if (Date.now() - membership.checkedAt > ROLE_RECHECK_MS) {
    const access = await resolveProjectAccess(auth.user.id, projectId);
    if (!access) {
      await removeMembership(socket, projectId);
      return;
    }
    membership.role = access.role;
    membership.checkedAt = Date.now();
  }

  pruneBuckets();
  if (!takeBudget(
    typingBuckets,
    `typing:${auth.user.id}:${projectId}`,
    TYPING_RATE_WINDOW_MS,
    MAX_TYPING_EVENTS_PER_WINDOW,
  )) {
    return;
  }

  const io = attachedServer;
  if (!io) return;
  const roomId = membership.roomId;

  if (data.typing) {
    let room = typingByRoom.get(roomId);
    if (!room) {
      room = new Map();
      typingByRoom.set(roomId, room);
    }
    const existing = room.get(socket.id);
    if (existing) {
      existing.userId = auth.user.id;
      existing.username = auth.user.username;
    } else {
      room.set(socket.id, { userId: auth.user.id, username: auth.user.username, timer: null });
    }
    scheduleTypingExpiry(io, projectId, roomId, socket.id);
    emitTyping(io, projectId, roomId);
  } else if (clearTyping(roomId, socket.id)) {
    emitTyping(io, projectId, roomId);
  }
}

/**
 * Attach project chat and presence handlers to an authenticated Socket.IO
 * server. The shared session middleware is installed once by whichever realtime
 * module attaches first.
 */
export function attachChat(io: Server): void {
  if (configuredServers.has(io)) return;
  configuredServers.add(io);
  attachedServer = io;

  applySocketAuthentication(io);

  io.on('connection', (socket) => {
    socket.on('chat:join', (payload: unknown, ack: unknown) => {
      void handleJoin(socket, payload, ack).catch(() => {
        respond(ack, fail('SERVER_ERROR', 'Unable to join project chat.') satisfies ChatJoinAck);
      });
    });

    socket.on('chat:leave', (payload: unknown, ack: unknown) => {
      void handleLeave(socket, payload, ack).catch(() => {
        respond(ack, fail('SERVER_ERROR', 'Unable to leave project chat.'));
      });
    });

    socket.on('chat:send', (payload: unknown, ack: unknown) => {
      void handleSend(socket, payload, ack).catch(() => {
        respond(ack, fail('SERVER_ERROR', 'Unable to send the message.') satisfies ChatSendAck);
      });
    });

    socket.on('chat:delete', (payload: unknown, ack: unknown) => {
      void handleDelete(socket, payload, ack).catch(() => {
        respond(ack, fail('SERVER_ERROR', 'Unable to delete the message.') satisfies ChatDeleteAck);
      });
    });

    socket.on('chat:typing', (payload: unknown) => {
      void handleTyping(socket, payload).catch(() => undefined);
    });

    socket.on('disconnect', () => {
      const projectIds = [...membershipsFor(socket).keys()];
      void Promise.all(projectIds.map((projectId) => removeMembership(socket, projectId)));
    });
  });
}

/** Clear timers and room state, e.g. before a process restart or in tests. */
export function shutdownChat(): void {
  for (const room of typingByRoom.values()) {
    for (const entry of room.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
  }
  typingByRoom.clear();
  presenceByRoom.clear();
  messageBuckets.clear();
  typingBuckets.clear();
  attachedServer = null;
}
