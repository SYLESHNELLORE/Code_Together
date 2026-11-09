// Load server/.env before env-dependent modules are constructed.
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { app } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { attachChat, shutdownChat } from '../index.js';
import { csrfClient, registerTestUser, type TestSession } from '../../routes/__tests__/authTestUtils.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const integration = hasDatabase ? describe : describe.skip;

interface ChatMessageBody {
  id: string;
  projectId: string;
  content: string;
  createdAt: string;
  deletedAt: string | null;
  sender: { id: string; username: string; avatarUrl: string | null };
}

interface JoinAck {
  ok: boolean;
  error?: { code: string; message: string };
  presence?: Array<{ id: string; username: string }>;
}

interface SendAck {
  ok: boolean;
  error?: { code: string; message: string };
  message?: ChatMessageBody;
}

interface DeleteAck {
  ok: boolean;
  error?: { code: string; message: string };
  messageId?: string;
}

interface HistoryBody {
  roomId: string;
  messages: ChatMessageBody[];
  hasMore: boolean;
  nextCursor: string | null;
}

integration('persistent project chat (requires MySQL)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];

  let httpServer: HttpServer;
  let ioServer: IOServer;
  let port = 0;
  const sockets: ClientSocket[] = [];

  beforeAll(async () => {
    httpServer = createServer(app);
    ioServer = new IOServer(httpServer, { maxHttpBufferSize: 2e6 });
    attachChat(ioServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind the test server.');
    port = address.port;
  });

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    shutdownChat();
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
    if (createdProjectIds.length > 0) {
      await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  });

  async function newSession(prefix: string): Promise<TestSession> {
    const session = await registerTestUser(prefix);
    createdUserIds.push(session.user.id);
    return session;
  }

  async function createProject(owner: TestSession, label: string): Promise<string> {
    const response = await csrfClient(owner)
      .post('/api/projects')
      .send({ name: `chat-${label}-${Date.now()}`, description: 'Phase 6 chat test' });
    expect(response.status).toBe(201);
    createdProjectIds.push(response.body.data.id);
    return response.body.data.id as string;
  }

  async function addMember(
    owner: TestSession,
    projectId: string,
    member: TestSession,
    role: 'ADMIN' | 'EDITOR' | 'VIEWER',
  ): Promise<void> {
    const invitation = await csrfClient(owner)
      .post(`/api/projects/${projectId}/invitations`)
      .send({ email: member.user.email, role, expiresInDays: 7 });
    expect(invitation.status).toBe(201);

    const accepted = await csrfClient(member)
      .post('/api/invitations/accept')
      .send({ token: invitation.body.data.token });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data.role).toBe(role);
  }

  function connectClient(token?: string): Promise<ClientSocket> {
    const socket = createClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 5_000,
      forceNew: true,
      ...(token ? { auth: { token } } : {}),
    });
    sockets.push(socket);

    return new Promise<ClientSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.disconnect();
        reject(new Error('Socket connection timed out.'));
      }, 5_000);

      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timer);
        socket.disconnect();
        reject(error);
      });
    });
  }

  function emitAck<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${event}.`)), 5_000);
      socket.emit(event, payload, (response: T) => {
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  function nextEvent<T>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(event, handler);
        reject(new Error(`Timed out waiting for ${event}.`));
      }, 5_000);
      const handler = (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      };
      socket.once(event, handler);
    });
  }

  function joinChat(socket: ClientSocket, projectId: string): Promise<JoinAck> {
    return emitAck<JoinAck>(socket, 'chat:join', { projectId });
  }

  function sendMessage(
    socket: ClientSocket,
    projectId: string,
    content: string,
    clientMessageId?: string,
    extra?: Record<string, unknown>,
  ): Promise<SendAck> {
    return emitAck<SendAck>(socket, 'chat:send', {
      projectId,
      content,
      clientMessageId,
      ...extra,
    });
  }

  function history(session: TestSession, projectId: string, query = ''): Promise<{
    status: number;
    body: { data?: HistoryBody; error?: { code: string } };
  }> {
    return csrfClient(session).get(`/api/projects/${projectId}/chat/messages${query}`)
      .then((response) => ({ status: response.status, body: response.body }));
  }

  it('delivers messages live, derives the sender from the session and paginates history', async () => {
    const owner = await newSession('chat_owner');
    const editor = await newSession('chat_editor');
    const projectId = await createProject(owner, 'live');
    await addMember(owner, projectId, editor, 'EDITOR');

    const ownerSocket = await connectClient(owner.token);
    const editorSocket = await connectClient(editor.token);

    const ownerJoin = await joinChat(ownerSocket, projectId);
    expect(ownerJoin.ok).toBe(true);
    const editorJoin = await joinChat(editorSocket, projectId);
    expect(editorJoin.ok).toBe(true);

    const liveEvent = nextEvent<{ projectId: string; message: ChatMessageBody }>(ownerSocket, 'chat:message');
    const ack = await sendMessage(editorSocket, projectId, '  hello team  ', 'live-message-0001', {
      senderId: owner.user.id,
    });
    expect(ack.ok).toBe(true);
    expect(ack.message?.content).toBe('hello team');
    expect(ack.message?.sender.id).toBe(editor.user.id);

    const event = await liveEvent;
    expect(event.projectId).toBe(projectId);
    expect(event.message.id).toBe(ack.message?.id);
    expect(event.message.sender.username).toBe(editor.user.username);

    const stored = await prisma.chatMessage.findUnique({ where: { id: ack.message!.id } });
    expect(stored?.senderId).toBe(editor.user.id);
    expect(stored?.content).toBe('hello team');

    const second = await sendMessage(editorSocket, projectId, 'second message', 'live-message-0002');
    const third = await sendMessage(editorSocket, projectId, 'third message', 'live-message-0003');
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);

    const latest = await history(editor, projectId, '?limit=2');
    expect(latest.status).toBe(200);
    expect(latest.body.data?.messages.map((message) => message.content))
      .toEqual(['second message', 'third message']);
    expect(latest.body.data?.hasMore).toBe(true);
    expect(latest.body.data?.nextCursor).toBe(second.message?.id);

    const older = await history(editor, projectId, `?limit=2&cursor=${latest.body.data?.nextCursor}`);
    expect(older.status).toBe(200);
    expect(older.body.data?.messages.map((message) => message.content)).toEqual(['hello team']);
    expect(older.body.data?.hasMore).toBe(false);

    const tooLong = await sendMessage(editorSocket, projectId, 'x'.repeat(2_001), 'live-message-0004');
    expect(tooLong.ok).toBe(false);
    expect(tooLong.error?.code).toBe('VALIDATION_ERROR');

    const empty = await sendMessage(editorSocket, projectId, '   ', 'live-message-0005');
    expect(empty.ok).toBe(false);
    expect(empty.error?.code).toBe('VALIDATION_ERROR');
  }, 40_000);

  it('tracks presence and typing cleanup, and retries safely after reconnect', async () => {
    const owner = await newSession('chat_presence_owner');
    const editor = await newSession('chat_presence_editor');
    const projectId = await createProject(owner, 'presence');
    await addMember(owner, projectId, editor, 'EDITOR');

    const ownerSocket = await connectClient(owner.token);
    const ownerJoin = await joinChat(ownerSocket, projectId);
    expect(ownerJoin.ok).toBe(true);
    expect(ownerJoin.presence?.map((user) => user.id)).toEqual([owner.user.id]);

    const editorSocket = await connectClient(editor.token);
    const presenceUpdate = nextEvent<{ users: Array<{ id: string }> }>(ownerSocket, 'chat:presence');
    const editorJoin = await joinChat(editorSocket, projectId);
    expect(editorJoin.ok).toBe(true);
    expect(editorJoin.presence?.map((user) => user.id).sort())
      .toEqual([owner.user.id, editor.user.id].sort());
    const joinedPresence = await presenceUpdate;
    expect(joinedPresence.users.map((user) => user.id).sort())
      .toEqual([owner.user.id, editor.user.id].sort());

    const typingEvent = nextEvent<{ users: Array<{ id: string }> }>(ownerSocket, 'chat:typing');
    editorSocket.emit('chat:typing', { projectId, typing: true });
    const typing = await typingEvent;
    expect(typing.users.map((user) => user.id)).toEqual([editor.user.id]);

    const stoppedTyping = nextEvent<{ users: Array<{ id: string }> }>(ownerSocket, 'chat:typing');
    editorSocket.emit('chat:typing', { projectId, typing: false });
    expect((await stoppedTyping).users).toEqual([]);

    const clientMessageId = `reconnect-${Date.now()}`;
    const firstSend = await sendMessage(editorSocket, projectId, 'sent before reconnect', clientMessageId);
    expect(firstSend.ok).toBe(true);
    const originalId = firstSend.message!.id;

    const disconnectedPresence = nextEvent<{ users: Array<{ id: string }> }>(ownerSocket, 'chat:presence');
    editorSocket.disconnect();
    const afterDisconnect = await disconnectedPresence;
    expect(afterDisconnect.users.map((user) => user.id)).toEqual([owner.user.id]);

    const reconnectedSocket = await connectClient(editor.token);
    const rejoin = await joinChat(reconnectedSocket, projectId);
    expect(rejoin.ok).toBe(true);

    const retry = await sendMessage(reconnectedSocket, projectId, 'sent before reconnect', clientMessageId);
    expect(retry.ok).toBe(true);
    expect(retry.message?.id).toBe(originalId);

    const rows = await prisma.chatMessage.findMany({
      where: { room: { projectId }, clientMessageId },
    });
    expect(rows).toHaveLength(1);

    const cleanupTyping = nextEvent<{ users: Array<{ id: string }> }>(ownerSocket, 'chat:typing');
    reconnectedSocket.emit('chat:typing', { projectId, typing: true });
    await cleanupTyping;

    const typingAfterDisconnect = nextEvent<{ users: Array<{ id: string }> }>(ownerSocket, 'chat:typing');
    reconnectedSocket.disconnect();
    expect((await typingAfterDisconnect).users).toEqual([]);
  }, 40_000);

  it('rejects outsiders, enforces join-before-send, rate limits and audits deletions', async () => {
    const owner = await newSession('chat_guard_owner');
    const admin = await newSession('chat_guard_admin');
    const editor = await newSession('chat_guard_editor');
    const viewer = await newSession('chat_guard_viewer');
    const outsider = await newSession('chat_guard_outsider');
    const projectId = await createProject(owner, 'guard');
    await addMember(owner, projectId, admin, 'ADMIN');
    await addMember(owner, projectId, editor, 'EDITOR');
    await addMember(owner, projectId, viewer, 'VIEWER');

    const outsiderSocket = await connectClient(outsider.token);
    const outsiderJoin = await joinChat(outsiderSocket, projectId);
    expect(outsiderJoin.ok).toBe(false);
    expect(outsiderJoin.error?.code).toBe('NOT_FOUND');

    const outsiderHistory = await history(outsider, projectId);
    expect(outsiderHistory.status).toBe(404);

    const unjoinedSocket = await connectClient(editor.token);
    const unjoinedSend = await sendMessage(unjoinedSocket, projectId, 'should not send');
    expect(unjoinedSend.ok).toBe(false);
    expect(unjoinedSend.error?.code).toBe('NOT_JOINED');

    const ownerSocket = await connectClient(owner.token);
    const editorSocket = await connectClient(editor.token);
    const viewerSocket = await connectClient(viewer.token);
    await joinChat(ownerSocket, projectId);
    await joinChat(editorSocket, projectId);
    await joinChat(viewerSocket, projectId);

    const first = await sendMessage(editorSocket, projectId, 'delete me please', 'guard-message-0001');
    expect(first.ok).toBe(true);

    const viewerDelete = await emitAck<DeleteAck>(viewerSocket, 'chat:delete', {
      projectId,
      messageId: first.message!.id,
    });
    expect(viewerDelete.ok).toBe(false);
    expect(viewerDelete.error?.code).toBe('FORBIDDEN');

    const deletionEvent = nextEvent<{ messageId: string }>(ownerSocket, 'chat:message-deleted');
    const ownerDelete = await emitAck<DeleteAck>(ownerSocket, 'chat:delete', {
      projectId,
      messageId: first.message!.id,
    });
    expect(ownerDelete.ok).toBe(true);
    expect((await deletionEvent).messageId).toBe(first.message!.id);

    const afterDelete = await history(viewer, projectId, '?limit=10');
    const deleted = afterDelete.body.data?.messages.find((message) => message.id === first.message!.id);
    expect(deleted?.content).toBe('');
    expect(deleted?.deletedAt).not.toBeNull();

    const auditRow = await prisma.chatMessage.findUnique({ where: { id: first.message!.id } });
    expect(auditRow?.content).toBe('delete me please');
    expect(auditRow?.deletedById).toBe(owner.user.id);
    expect(auditRow?.deletedAt).not.toBeNull();

    const second = await sendMessage(editorSocket, projectId, 'author can delete', 'guard-message-0002');
    const authorDelete = await emitAck<DeleteAck>(editorSocket, 'chat:delete', {
      projectId,
      messageId: second.message!.id,
    });
    expect(authorDelete.ok).toBe(true);

    const adminSocket = await connectClient(admin.token);
    await joinChat(adminSocket, projectId);
    for (let index = 0; index < 10; index += 1) {
      const sent = await sendMessage(adminSocket, projectId, `rate message ${index}`, `rate-message-${index}`);
      expect(sent.ok).toBe(true);
    }
    const limited = await sendMessage(adminSocket, projectId, 'one too many', 'rate-message-over');
    expect(limited.ok).toBe(false);
    expect(limited.error?.code).toBe('RATE_LIMITED');

    const removed = await csrfClient(owner)
      .delete(`/api/projects/${projectId}/members/${editor.user.id}`);
    expect(removed.status).toBe(204);

    const afterRemoval = await sendMessage(editorSocket, projectId, 'should now fail', 'guard-message-0003');
    expect(afterRemoval.ok).toBe(false);
    expect(afterRemoval.error?.code).toBe('NOT_FOUND');
  }, 40_000);
});
