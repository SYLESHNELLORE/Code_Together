import { afterAll, afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { prisma } from '../../db/prisma.js';
import { resetRateLimits } from '../../middleware/rateLimit.js';
import {
  csrfClient,
  registerTestUser,
  uniqueIdentity,
  type TestSession,
} from './authTestUtils.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const integration = hasDatabase ? describe : describe.skip;

integration('authentication and authorization (requires MySQL)', () => {
  const createdUserIds: string[] = [];

  afterEach(() => {
    // Keep the fixed-window limiter from leaking between test cases.
    resetRateLimits();
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    resetRateLimits();
    await prisma.$disconnect();
  });

  async function register(prefix = 'auth'): Promise<TestSession> {
    const session = await registerTestUser(prefix);
    createdUserIds.push(session.user.id);
    return session;
  }

  async function login(email: string, password: string) {
    const agent = request.agent(app);
    const csrfResponse = await agent.get('/api/auth/csrf');
    const csrfToken = csrfResponse.body.data.csrfToken as string;
    const response = await agent
      .post('/api/auth/login')
      .set('X-CSRF-Token', csrfToken)
      .send({ email, password });
    const token = response.body?.data?.token as string | undefined;
    return { agent, csrfToken, response, token };
  }

  it('registers a user, hashes the password with Argon2id and stores only a hashed session token', async () => {
    const agent = request.agent(app);
    const csrfResponse = await agent.get('/api/auth/csrf');
    const csrfToken = csrfResponse.body.data.csrfToken as string;
    const identity = uniqueIdentity('register');

    const initialCsrfCookie = (csrfResponse.headers['set-cookie'] as unknown as string[] | undefined)
      ?.find((cookie) => cookie.startsWith('ct_csrf='));
    expect(initialCsrfCookie).toBeDefined();
    expect(initialCsrfCookie).not.toMatch(/HttpOnly/i);

    const response = await agent
      .post('/api/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send(identity);

    expect(response.status).toBe(201);
    const user = response.body.data.user as { id: string; username: string; email: string };
    createdUserIds.push(user.id);
    expect(user.username).toBe(identity.username);
    expect(user.email).toBe(identity.email);
    expect(response.body.data.user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(response.body)).not.toContain(identity.password);

    // The session token is returned to this tab and is never placed in a cookie,
    // because a cookie would be shared by every tab on the origin.
    const sessionToken = response.body.data.token as string;
    expect(typeof sessionToken).toBe('string');
    expect(sessionToken.length).toBeGreaterThanOrEqual(40);
    expect(response.body.data.expiresAt).toEqual(expect.any(String));

    const setCookie = response.headers['set-cookie'] as unknown as string[] | undefined;
    const sessionCookie = setCookie?.find((cookie) => cookie.startsWith('ct_session='));
    expect(sessionCookie ?? '').not.toContain(sessionToken);

    const storedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(storedUser.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(storedUser.passwordHash).not.toContain(identity.password);

    const storedSession = await prisma.session.findFirstOrThrow({ where: { userId: user.id } });
    expect(storedSession.tokenHash).not.toBe(sessionToken);
    expect(storedSession.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedSession.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const me = await agent
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${sessionToken}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.id).toBe(user.id);
    expect(me.body.data.user).not.toHaveProperty('passwordHash');
  });

  it('rejects duplicate email addresses and usernames with specific friendly errors', async () => {
    const first = await register('dup');

    const duplicateEmailAgent = request.agent(app);
    const duplicateEmailCsrf = (await duplicateEmailAgent.get('/api/auth/csrf')).body.data.csrfToken as string;
    const duplicateEmail = await duplicateEmailAgent
      .post('/api/auth/register')
      .set('X-CSRF-Token', duplicateEmailCsrf)
      .send({ ...uniqueIdentity('other'), email: first.identity.email });

    expect(duplicateEmail.status).toBe(409);
    expect(duplicateEmail.body.error.code).toBe('EMAIL_TAKEN');
    expect(duplicateEmail.body.error.message).toMatch(/email/i);

    const duplicateNameAgent = request.agent(app);
    const duplicateNameCsrf = (await duplicateNameAgent.get('/api/auth/csrf')).body.data.csrfToken as string;
    const duplicateName = await duplicateNameAgent
      .post('/api/auth/register')
      .set('X-CSRF-Token', duplicateNameCsrf)
      .send({ ...uniqueIdentity('other'), username: first.identity.username });

    expect(duplicateName.status).toBe(409);
    expect(duplicateName.body.error.code).toBe('USERNAME_TAKEN');
  });

  it('validates registration input', async () => {
    const agent = request.agent(app);
    const csrfToken = (await agent.get('/api/auth/csrf')).body.data.csrfToken as string;

    const weak = await agent
      .post('/api/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ username: 'ab', email: 'not-an-email', password: 'short' });

    expect(weak.status).toBe(400);
    expect(weak.body.error.code).toBe('VALIDATION_ERROR');
    expect(weak.body.error.message).toMatch(/Username/i);
    expect(weak.body.error.message).toMatch(/email/i);
    expect(weak.body.error.message).toMatch(/Password/i);

    const invalidUsername = await agent
      .post('/api/auth/register')
      .set('X-CSRF-Token', csrfToken)
      .send({ ...uniqueIdentity('invalid'), username: 'bad name!' });
    expect(invalidUsername.status).toBe(400);
  });

  it('logs in with valid credentials and rejects invalid credentials generically', async () => {
    const session = await register('login');

    const success = await login(session.identity.email.toUpperCase(), session.identity.password);
    expect(success.response.status).toBe(200);
    expect(success.response.body.data.user.id).toBe(session.user.id);
    expect(success.token).toEqual(expect.any(String));
    expect(success.response.body.data.token).toBe(success.token);

    const me = await success.agent
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${success.token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.username).toBe(session.identity.username);

    const wrongPassword = await login(session.identity.email, 'definitely-not-the-password');
    expect(wrongPassword.response.status).toBe(401);
    expect(wrongPassword.response.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.response.body.error.message).toMatch(/Incorrect email or password/i);

    const unknownEmail = await login(`missing-${Date.now()}@example.test`, 'definitely-not-the-password');
    expect(unknownEmail.response.status).toBe(401);
    expect(unknownEmail.response.body.error.code).toBe('INVALID_CREDENTIALS');
    // The same message is returned so the API does not reveal which emails exist.
    expect(unknownEmail.response.body.error.message).toBe(wrongPassword.response.body.error.message);
  });

  it('logs out only the current tab session and invalidates its token', async () => {
    const session = await register('logout');

    // A second tab signs in as the same account. It must keep working after the
    // first tab signs out.
    const otherTab = await login(session.identity.email, session.identity.password);
    expect(otherTab.response.status).toBe(200);
    const otherToken = otherTab.token!;

    const before = await session.agent
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${session.token}`);
    expect(before.status).toBe(200);

    const response = await session.agent
      .post('/api/auth/logout')
      .set('Authorization', `Bearer ${session.token}`)
      .set('X-CSRF-Token', session.csrfToken);
    expect(response.status).toBe(204);

    // Only the caller's bearer session is gone; the other tab's session remains.
    const after = await session.agent
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${session.token}`);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('SESSION_EXPIRED');

    const otherMe = await otherTab.agent
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${otherToken}`);
    expect(otherMe.status).toBe(200);
    expect(otherMe.body.data.user.id).toBe(session.user.id);

    const remaining = await prisma.session.count({ where: { userId: session.user.id } });
    expect(remaining).toBe(1);

    // Without any bearer token the response is a plain authentication failure.
    const anonymous = await session.agent.get('/api/auth/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

    // Logout is idempotent for an already-signed-out browser that still has a
    // valid CSRF cookie: there is nothing to revoke, and the response is 204.
    const retryAgent = request.agent(app);
    const retryCsrf = (await retryAgent.get('/api/auth/csrf')).body.data.csrfToken as string;
    const again = await retryAgent.post('/api/auth/logout').set('X-CSRF-Token', retryCsrf);
    expect(again.status).toBe(204);
  });

  it('rejects expired sessions and removes them from the database', async () => {
    const session = await register('expired');

    await prisma.session.updateMany({
      where: { userId: session.user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const response = await session.agent
      .get('/api/projects')
      .set('Authorization', `Bearer ${session.token}`);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('SESSION_EXPIRED');

    const remaining = await prisma.session.count({ where: { userId: session.user.id } });
    expect(remaining).toBe(0);
  });

  it('blocks unauthenticated, forged-cookie and forged-token access to projects and files', async () => {
    const anonymous = await request(app).get('/api/projects');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

    const anonymousFiles = await request(app).get('/api/projects/11111111-1111-4111-8111-111111111111/files');
    expect(anonymousFiles.status).toBe(401);

    // A CSRF token alone is not authentication.
    const csrfOnlyAgent = request.agent(app);
    const csrfToken = (await csrfOnlyAgent.get('/api/auth/csrf')).body.data.csrfToken as string;
    const csrfOnly = await csrfOnlyAgent
      .post('/api/projects')
      .set('X-CSRF-Token', csrfToken)
      .send({ name: 'should-not-exist' });
    expect(csrfOnly.status).toBe(401);
    expect(csrfOnly.body.error.code).toBe('UNAUTHENTICATED');

    // A shared legacy session cookie is ignored entirely.
    const forgedCookie = await request(app)
      .get('/api/projects')
      .set('Cookie', 'ct_session=forged-session-token');
    expect(forgedCookie.status).toBe(401);
    expect(forgedCookie.body.error.code).toBe('UNAUTHENTICATED');

    const forgedToken = await request(app)
      .get('/api/projects')
      .set('Authorization', 'Bearer forged-session-token');
    expect(forgedToken.status).toBe(401);
    expect(forgedToken.body.error.code).toBe('SESSION_EXPIRED');
  });

  it('enforces CSRF tokens and same-origin checks on authenticated mutations', async () => {
    const session = await register('csrf');
    const authHeader = `Bearer ${session.token}`;
    const csrfCookie = `ct_csrf=${session.csrfToken}`;

    const missingHeader = await request(app)
      .post('/api/projects')
      .set('Authorization', authHeader)
      .set('Cookie', csrfCookie)
      .send({ name: 'csrf-missing' });
    expect(missingHeader.status).toBe(403);
    expect(missingHeader.body.error.code).toBe('CSRF_INVALID');

    const wrongHeader = await request(app)
      .post('/api/projects')
      .set('Authorization', authHeader)
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', 'not-the-csrf-token')
      .send({ name: 'csrf-wrong' });
    expect(wrongHeader.status).toBe(403);
    expect(wrongHeader.body.error.code).toBe('CSRF_INVALID');

    const badOrigin = await request(app)
      .post('/api/projects')
      .set('Authorization', authHeader)
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', session.csrfToken)
      .set('Origin', 'https://evil.example')
      .send({ name: 'csrf-origin' });
    expect(badOrigin.status).toBe(403);
    expect(badOrigin.body.error.code).toBe('INVALID_ORIGIN');

    // The same request from the configured client origin succeeds.
    const allowed = await request(app)
      .post('/api/projects')
      .set('Authorization', authHeader)
      .set('Cookie', csrfCookie)
      .set('X-CSRF-Token', session.csrfToken)
      .set('Origin', 'http://localhost:5173')
      .send({ name: `csrf-allowed-${Date.now()}` });
    expect(allowed.status).toBe(201);
  });

  it('isolates projects and files between users', async () => {
    const owner = await register('owner');
    const intruder = await register('intruder');

    const projectResponse = await csrfClient(owner)
      .post('/api/projects')
      .send({ name: `private-${Date.now()}`, description: 'Owner only' });
    expect(projectResponse.status).toBe(201);
    const projectId = projectResponse.body.data.id as string;

    const fileResponse = await csrfClient(owner)
      .post(`/api/projects/${projectId}/files`)
      .send({ name: 'secret.ts', path: 'secret.ts', content: 'private' });
    expect(fileResponse.status).toBe(201);
    const fileId = fileResponse.body.data.id as string;

    const list = await intruder.agent
      .get('/api/projects')
      .set('Authorization', `Bearer ${intruder.token}`);
    expect(list.status).toBe(200);
    expect(list.body.data.some((project: { id: string }) => project.id === projectId)).toBe(false);

    expect((await intruder.agent
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${intruder.token}`)).status).toBe(404);
    expect((await intruder.agent
      .get(`/api/projects/${projectId}/files`)
      .set('Authorization', `Bearer ${intruder.token}`)).status).toBe(404);
    expect((await intruder.agent
      .get(`/api/projects/${projectId}/files/${fileId}`)
      .set('Authorization', `Bearer ${intruder.token}`)).status).toBe(404);

    const patch = await csrfClient(intruder)
      .patch(`/api/projects/${projectId}`)
      .send({ name: 'stolen' });
    expect(patch.status).toBe(404);

    const writeFile = await csrfClient(intruder)
      .post(`/api/projects/${projectId}/files`)
      .send({ name: 'evil.ts', path: 'evil.ts', content: 'nope' });
    expect(writeFile.status).toBe(404);

    const deleteFile = await csrfClient(intruder)
      .delete(`/api/projects/${projectId}/files/${fileId}`);
    expect(deleteFile.status).toBe(404);

    const deleteProject = await csrfClient(intruder)
      .delete(`/api/projects/${projectId}`);
    expect(deleteProject.status).toBe(404);

    // The legitimate owner still sees the untouched project and file.
    const stillThere = await owner.agent
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.data.name).toMatch(/^private-/);
    const stillFile = await owner.agent
      .get(`/api/projects/${projectId}/files/${fileId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(stillFile.status).toBe(200);
    expect(stillFile.body.data.content).toBe('private');
  });

  it('keeps two accounts in the same browser isolated by per-tab bearer tokens', async () => {
    // One cookie jar represents one browser. Two tabs sign in as different
    // accounts and each request carries only its own tab's token.
    const browser = request.agent(app);
    const csrfToken = (await browser.get('/api/auth/csrf')).body.data.csrfToken as string;

    const registerTab = async (prefix: string) => {
      const identity = uniqueIdentity(prefix);
      const response = await browser
        .post('/api/auth/register')
        .set('X-CSRF-Token', csrfToken)
        .send(identity);
      expect(response.status).toBe(201);
      const user = response.body.data.user as TestSession['user'];
      createdUserIds.push(user.id);
      return { identity, token: response.body.data.token as string, user };
    };

    const tabA = await registerTab('taba');
    const tabB = await registerTab('tabb');
    expect(tabA.token).not.toBe(tabB.token);

    const meA = await browser
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tabA.token}`);
    expect(meA.status).toBe(200);
    expect(meA.body.data.user.id).toBe(tabA.user.id);

    const meB = await browser
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${tabB.token}`);
    expect(meB.status).toBe(200);
    expect(meB.body.data.user.id).toBe(tabB.user.id);

    // Tab A creates a private project. Tab B must not see or open it even
    // though both tabs share the same cookies.
    const created = await browser
      .post('/api/projects')
      .set('Authorization', `Bearer ${tabA.token}`)
      .set('X-CSRF-Token', csrfToken)
      .send({ name: `tab-a-project-${Date.now()}` });
    expect(created.status).toBe(201);
    const projectId = created.body.data.id as string;

    const listB = await browser
      .get('/api/projects')
      .set('Authorization', `Bearer ${tabB.token}`);
    expect(listB.status).toBe(200);
    expect(listB.body.data.some((project: { id: string }) => project.id === projectId)).toBe(false);

    const openB = await browser
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${tabB.token}`);
    expect(openB.status).toBe(404);

    // Switching back in tab A still sees its own project.
    const listA = await browser
      .get('/api/projects')
      .set('Authorization', `Bearer ${tabA.token}`);
    expect(listA.status).toBe(200);
    expect(listA.body.data.some((project: { id: string }) => project.id === projectId)).toBe(true);
  });

  it('rate-limits repeated login attempts', async () => {
    resetRateLimits();
    const email = `rate-limit-${Date.now()}@example.test`;

    let lastStatus = 0;
    let lastBody: { error?: { code?: string; message?: string } } = {};
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await login(email, 'wrong-password-for-rate-limit');
      lastStatus = response.response.status;
      lastBody = response.response.body;
      if (attempt < 10) expect(response.response.status).toBe(401);
    }

    expect(lastStatus).toBe(429);
    expect(lastBody.error?.code).toBe('RATE_LIMITED');
    expect(lastBody.error?.message).toMatch(/Too many attempts/i);
  });
});
