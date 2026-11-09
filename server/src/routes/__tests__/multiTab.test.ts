// Multi-tab isolation regression tests. One browser (a shared cookie jar) is
// represented by several per-tab bearer tokens, which is exactly how the SPA
// authenticates after moving off the shared ct_session cookie.
import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import request from 'supertest';
import { Server as IOServer } from 'socket.io';
import { io as createClient, type Socket as ClientSocket } from 'socket.io-client';
import { app } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { attachCollaboration, shutdownCollaboration } from '../../collab/index.js';
import { csrfClient, registerTestUser, type TestSession } from './authTestUtils.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const integration = hasDatabase ? describe : describe.skip;

interface JoinAck {
  ok: boolean;
  error?: { code: string; message: string };
}

integration('multi-tab authentication isolation (requires MySQL)', () => {
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];
  const sockets: ClientSocket[] = [];

  let httpServer: HttpServer;
  let ioServer: IOServer;
  let port = 0;

  beforeAll(async () => {
    httpServer = createServer(app);
    ioServer = new IOServer(httpServer, { maxHttpBufferSize: 2e6 });
    attachCollaboration(ioServer);
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Failed to bind the test server.');
    port = address.port;
  });

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    await shutdownCollaboration();
    await new Promise<void>((resolve) => ioServer.close(() => resolve()));
    if (createdProjectIds.length > 0) {
      await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await prisma.$disconnect();
  });

  async function session(prefix: string): Promise<TestSession> {
    const created = await registerTestUser(prefix);
    createdUserIds.push(created.user.id);
    return created;
  }

  async function createProject(owner: TestSession, label: string) {
    const response = await csrfClient(owner)
      .post('/api/projects')
      .send({ name: `multitab-${label}-${Date.now()}`, description: 'Multi-tab test' });
    expect(response.status).toBe(201);
    createdProjectIds.push(response.body.data.id);
    return response.body.data.id as string;
  }

  async function createFile(owner: TestSession, projectId: string, name: string) {
    const response = await csrfClient(owner)
      .post(`/api/projects/${projectId}/files`)
      .send({ name, path: name, language: 'typescript', content: `// ${name}` });
    expect(response.status).toBe(201);
    return response.body.data.id as string;
  }

  function connect(token: string): Promise<ClientSocket> {
    const socket = createClient(`http://127.0.0.1:${port}`, {
      transports: ['websocket'],
      reconnection: false,
      timeout: 5_000,
      forceNew: true,
      auth: { token },
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
        reject(error);
      });
    });
  }

  function join(socket: ClientSocket, projectId: string, fileId: string): Promise<JoinAck> {
    return new Promise((resolve) => {
      socket.emit('collab:join', { projectId, fileId }, (ack: JoinAck) => resolve(ack));
    });
  }

  it('keeps every tab authenticated as its own account across all nine scenarios', async () => {
    // Two tabs in the same browser, each with its own token.
    const tabA = await session('tab-a');
    const tabB = await session('tab-b');
    const tabC = await session('tab-c');
    expect(tabA.token).not.toBe(tabB.token);

    // 1. Simultaneous identities.
    const meA = await csrfClient(tabA).get('/api/auth/me');
    const meB = await csrfClient(tabB).get('/api/auth/me');
    expect(meA.body.data.user.id).toBe(tabA.user.id);
    expect(meB.body.data.user.id).toBe(tabB.user.id);

    // 2. Project visibility is scoped to the tab's account.
    const projectA = await createProject(tabA, 'a');
    const projectB = await createProject(tabB, 'b');
    const listA = await csrfClient(tabA).get('/api/projects');
    const listB = await csrfClient(tabB).get('/api/projects');
    expect(listA.body.data.some((project: { id: string }) => project.id === projectA)).toBe(true);
    expect(listA.body.data.some((project: { id: string }) => project.id === projectB)).toBe(false);
    expect(listB.body.data.some((project: { id: string }) => project.id === projectB)).toBe(true);
    expect(listB.body.data.some((project: { id: string }) => project.id === projectA)).toBe(false);

    // 3. File reads do not cross tabs.
    const fileA = await createFile(tabA, projectA, 'a.ts');
    expect((await csrfClient(tabA).get(`/api/projects/${projectA}/files/${fileA}`)).status).toBe(200);
    expect((await csrfClient(tabB).get(`/api/projects/${projectA}/files/${fileA}`)).status).toBe(404);

    // 4. Writes and permission checks are per tab.
    const writeA = await csrfClient(tabA)
      .post(`/api/projects/${projectA}/files`)
      .send({ name: 'a2.ts', path: 'a2.ts', content: 'ok' });
    expect(writeA.status).toBe(201);
    const writeB = await csrfClient(tabB)
      .post(`/api/projects/${projectA}/files`)
      .send({ name: 'evil.ts', path: 'evil.ts', content: 'nope' });
    expect(writeB.status).toBe(404);

    // 5. Refresh-equivalent revalidation uses each tab's stored token.
    const refreshedA = await csrfClient(tabA).get('/api/auth/me');
    const refreshedB = await csrfClient(tabB).get('/api/auth/me');
    expect(refreshedA.body.data.user.id).toBe(tabA.user.id);
    expect(refreshedB.body.data.user.id).toBe(tabB.user.id);

    // 6. An invalid token fails alone; the other tab stays authenticated.
    const forgedA = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer invalid-token-for-tab-a`);
    expect(forgedA.status).toBe(401);
    expect(forgedA.body.error.code).toBe('SESSION_EXPIRED');
    expect((await csrfClient(tabB).get('/api/auth/me')).status).toBe(200);

    // 7. Logging out tab A revokes only tab A's session.
    const logout = await csrfClient(tabA).post('/api/auth/logout');
    expect(logout.status).toBe(204);
    expect((await csrfClient(tabA).get('/api/auth/me')).status).toBe(401);
    expect((await csrfClient(tabB).get('/api/auth/me')).status).toBe(200);
    const sessionsA = await prisma.session.count({ where: { userId: tabA.user.id } });
    expect(sessionsA).toBe(0);

    // 8. Collaboration sockets authenticate each tab independently and reject
    // cross-project joins.
    const fileB = await createFile(tabB, projectB, 'b.ts');
    const memberSocket = await connect(tabB.token);
    const nonMemberSocket = await connect(tabC.token);
    const deniedJoin = await join(nonMemberSocket, projectB, fileB);
    expect(deniedJoin.ok).toBe(false);
    expect(deniedJoin.error?.code).toBe('NOT_FOUND');
    const ownJoin = await join(memberSocket, projectB, fileB);
    expect(ownJoin.ok).toBe(true);

    // 9. Invitations and chat history are resolved for the current tab's account.
    const invitation = await csrfClient(tabB)
      .post(`/api/projects/${projectB}/invitations`)
      .send({ email: tabC.user.email, role: 'VIEWER', expiresInDays: 7 });
    expect(invitation.status).toBe(201);
    const inboxB = await csrfClient(tabB).get('/api/invitations/mine');
    const inboxC = await csrfClient(tabC).get('/api/invitations/mine');
    expect(inboxB.body.data.some((item: { project: { id: string } }) => item.project.id === projectB)).toBe(false);
    expect(inboxC.body.data.some((item: { project: { id: string } }) => item.project.id === projectB)).toBe(true);

    const historyB = await csrfClient(tabB).get(`/api/projects/${projectB}/chat/messages`);
    const historyA = await csrfClient(tabB).get(`/api/projects/${projectA}/chat/messages`);
    expect(historyB.status).toBe(200);
    expect(Array.isArray(historyB.body.data.messages)).toBe(true);
    expect(historyA.status).toBe(404);
  });
});
