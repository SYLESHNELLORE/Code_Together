// Load server/.env before Prisma and env-dependent modules are constructed so
// `npm test` works without exporting DATABASE_URL in the shell.
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as IOServer } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import * as Y from 'yjs';
import { app } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { attachCollaboration, shutdownCollaboration } from '../../collab/index.js';
import { csrfClient, registerTestUser, type TestSession } from './authTestUtils.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const integration = hasDatabase ? describe : describe.skip;
const TEXT_KEY = 'content';

interface JoinAck {
  ok: boolean;
  error?: { code: string; message: string };
  role?: string;
  syncUpdate?: unknown;
  stateVector?: unknown;
  presence?: Array<{ socketId: string; user: { id: string; username: string }; colorIndex: number }>;
}

interface SaveAck {
  ok: boolean;
  error?: string;
  updatedAt?: string;
  version?: number;
}

interface FilePayload {
  id: string;
  content?: string;
  updatedAt: string;
}

integration('real-time collaboration (requires MySQL)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];

  let httpServer: HttpServer;
  let ioServer: IOServer;
  let port = 0;
  let sockets: ClientSocket[] = [];

  function bytes(value: unknown): Uint8Array {
    if (value instanceof Uint8Array) return new Uint8Array(value);
    if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
      return Uint8Array.from(value);
    }
    throw new Error('Expected binary collaboration payload.');
  }

  async function startSocketServer(): Promise<void> {
    httpServer = createServer(app);
    ioServer = new IOServer(httpServer, { maxHttpBufferSize: 2e6 });
    attachCollaboration(ioServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind the test server.');
    port = address.port;
  }

  async function closeSocketServer(): Promise<void> {
    for (const socket of sockets.splice(0)) socket.disconnect();
    await shutdownCollaboration();
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
  }

  async function restartSocketServer(): Promise<void> {
    await closeSocketServer();
    await startSocketServer();
  }

  beforeAll(async () => {
    await startSocketServer();
  });

  afterAll(async () => {
    await closeSocketServer();
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
      .send({ name: `collab-${label}-${Date.now()}`, description: 'Phase 5 collaboration test' });
    expect(response.status).toBe(201);
    createdProjectIds.push(response.body.data.id);
    return response.body.data.id as string;
  }

  async function createFile(
    owner: TestSession,
    projectId: string,
    name: string,
    content: string,
  ): Promise<FilePayload> {
    const response = await csrfClient(owner)
      .post(`/api/projects/${projectId}/files`)
      .send({ name, path: name, language: 'typescript', content });
    expect(response.status).toBe(201);
    return response.body.data as FilePayload;
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

  async function join(socket: ClientSocket, projectId: string, fileId: string): Promise<JoinAck> {
    return emitAck<JoinAck>(socket, 'collab:join', { projectId, fileId });
  }

  function docFrom(ack: JoinAck): Y.Doc {
    expect(ack.ok).toBe(true);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, bytes(ack.syncUpdate));
    return doc;
  }

  async function leave(socket: ClientSocket, fileId: string): Promise<void> {
    const ack = await emitAck<{ ok: boolean }>(socket, 'collab:leave', { fileId });
    expect(ack.ok).toBe(true);
    socket.disconnect();
  }

  it('synchronizes two clients, applies duplicate updates once and rejoins cleanly', async () => {
    const owner = await newSession('collab_owner');
    const editor = await newSession('collab_editor');
    const projectId = await createProject(owner, 'sync');
    await addMember(owner, projectId, editor, 'EDITOR');
    const file = await createFile(owner, projectId, 'shared.ts', 'const value = 1;\n');

    const ownerSocket = await connectClient(owner.token);
    const editorSocket = await connectClient(editor.token);

    const ownerJoin = await join(ownerSocket, projectId, file.id);
    expect(ownerJoin.role).toBe('OWNER');
    const ownerDoc = docFrom(ownerJoin);
    expect(ownerDoc.getText(TEXT_KEY).toString()).toBe('const value = 1;\n');

    const editorJoin = await join(editorSocket, projectId, file.id);
    expect(editorJoin.role).toBe('EDITOR');
    expect(editorJoin.presence).toHaveLength(2);
    expect(editorJoin.presence?.map((entry) => entry.user.id).sort())
      .toEqual([owner.user.id, editor.user.id].sort());
    const editorDoc = docFrom(editorJoin);

    const expected = 'const value = 1;\n// owner wrote this\n';
    const firstUpdate = nextEvent<{ fileId: string; update: unknown }>(editorSocket, 'collab:update');
    ownerDoc.getText(TEXT_KEY).insert('const value = 1;\n'.length, '// owner wrote this\n');
    const update = Y.encodeStateAsUpdate(ownerDoc);

    const firstAck = await emitAck<{ ok: boolean }>(ownerSocket, 'collab:update', { fileId: file.id, update });
    expect(firstAck.ok).toBe(true);
    const firstEvent = await firstUpdate;
    expect(firstEvent.fileId).toBe(file.id);
    Y.applyUpdate(editorDoc, bytes(firstEvent.update));
    expect(editorDoc.getText(TEXT_KEY).toString()).toBe(expected);

    // Replaying the exact same Yjs update must be idempotent on both sides.
    const duplicateUpdate = nextEvent<{ fileId: string; update: unknown }>(editorSocket, 'collab:update');
    const duplicateAck = await emitAck<{ ok: boolean }>(ownerSocket, 'collab:update', { fileId: file.id, update });
    expect(duplicateAck.ok).toBe(true);
    const duplicateEvent = await duplicateUpdate;
    Y.applyUpdate(editorDoc, bytes(duplicateEvent.update));
    expect(editorDoc.getText(TEXT_KEY).toString()).toBe(expected);

    // A reconnect re-applies the full server state; it must not duplicate text.
    const rejoined = await join(editorSocket, projectId, file.id);
    const reconnectedDoc = docFrom(rejoined);
    expect(reconnectedDoc.getText(TEXT_KEY).toString()).toBe(expected);

    await leave(ownerSocket, file.id);
    await leave(editorSocket, file.id);
  }, 30_000);

  it('persists content with a snapshot, blocks REST writes while live and reloads after restart', async () => {
    const owner = await newSession('collab_persist_owner');
    const projectId = await createProject(owner, 'persist');
    const initial = 'const value = 1;\n';
    const file = await createFile(owner, projectId, 'persist.ts', initial);

    const ownerSocket = await connectClient(owner.token);
    const ownerJoin = await join(ownerSocket, projectId, file.id);
    const ownerDoc = docFrom(ownerJoin);

    const liveContent = `${initial}// persisted through collaboration\n`;
    ownerDoc.getText(TEXT_KEY).insert(initial.length, '// persisted through collaboration\n');
    const updateAck = await emitAck<{ ok: boolean }>(ownerSocket, 'collab:update', {
      fileId: file.id,
      update: Y.encodeStateAsUpdate(ownerDoc),
    });
    expect(updateAck.ok).toBe(true);

    const saved = await emitAck<SaveAck>(ownerSocket, 'collab:flush', { fileId: file.id });
    expect(saved.ok).toBe(true);
    expect(saved.version).toBeGreaterThan(0);

    const afterFlush = await csrfClient(owner).get(`/api/projects/${projectId}/files/${file.id}`);
    expect(afterFlush.status).toBe(200);
    expect(afterFlush.body.data.content).toBe(liveContent);

    // REST content writes are rejected while the collaboration room owns the file.
    const blocked = await csrfClient(owner)
      .patch(`/api/projects/${projectId}/files/${file.id}`)
      .send({ content: 'stale rest write\n', version: Date.parse(afterFlush.body.data.updatedAt) });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('DOCUMENT_ACTIVE');

    // Explicit leave flushes, disposes the room and releases the REST lock.
    const leaveAck = await emitAck<{ ok: boolean }>(ownerSocket, 'collab:leave', { fileId: file.id });
    expect(leaveAck.ok).toBe(true);
    ownerSocket.disconnect();

    const restContent = 'const value = 42;\n';
    const restWrite = await csrfClient(owner)
      .patch(`/api/projects/${projectId}/files/${file.id}`)
      .send({ content: restContent, version: Date.parse(afterFlush.body.data.updatedAt) });
    expect(restWrite.status).toBe(200);
    expect(restWrite.body.data.content).toBe(restContent);

    // A fresh server reads the latest REST snapshot and exposes the same text.
    await restartSocketServer();
    const restoredSocket = await connectClient(owner.token);
    const restoredJoin = await join(restoredSocket, projectId, file.id);
    const restoredDoc = docFrom(restoredJoin);
    expect(restoredDoc.getText(TEXT_KEY).toString()).toBe(restContent);

    await leave(restoredSocket, file.id);
  }, 40_000);

  it('rejects unauthenticated sockets, non-members and viewer writes', async () => {
    const owner = await newSession('collab_guard_owner');
    const viewer = await newSession('collab_guard_viewer');
    const outsider = await newSession('collab_guard_outsider');
    const projectId = await createProject(owner, 'guard');
    await addMember(owner, projectId, viewer, 'VIEWER');
    const file = await createFile(owner, projectId, 'private.ts', 'private content\n');

    await expect(connectClient()).rejects.toThrow('UNAUTHENTICATED');

    const ownerSocket = await connectClient(owner.token);
    await join(ownerSocket, projectId, file.id);

    const viewerSocket = await connectClient(viewer.token);
    const viewerJoin = await join(viewerSocket, projectId, file.id);
    expect(viewerJoin.ok).toBe(true);
    expect(viewerJoin.role).toBe('VIEWER');

    const viewerDoc = docFrom(viewerJoin);
    viewerDoc.getText(TEXT_KEY).insert(0, 'viewer edit\n');
    const viewerWrite = await emitAck<{ ok: boolean; error?: { code: string } }>(
      viewerSocket,
      'collab:update',
      { fileId: file.id, update: Y.encodeStateAsUpdate(viewerDoc) },
    );
    expect(viewerWrite.ok).toBe(false);
    expect(viewerWrite.error?.code).toBe('FORBIDDEN');

    const outsiderSocket = await connectClient(outsider.token);
    const outsiderJoin = await join(outsiderSocket, projectId, file.id);
    expect(outsiderJoin.ok).toBe(false);
    expect(outsiderJoin.error?.code).toBe('NOT_FOUND');
    outsiderSocket.disconnect();

    const stored = await csrfClient(owner).get(`/api/projects/${projectId}/files/${file.id}`);
    expect(stored.body.data.content).toBe('private content\n');

    await leave(ownerSocket, file.id);
    await leave(viewerSocket, file.id);
  }, 30_000);
});
