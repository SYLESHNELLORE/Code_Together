import request from 'supertest';
import { app } from '../../app.js';

export type TestAgent = ReturnType<typeof request.agent>;

export interface TestUser {
  id: string;
  username: string;
  email: string;
  createdAt: string;
}

export interface TestSession {
  agent: TestAgent;
  csrfToken: string;
  /** Per-tab bearer token returned by register/login. */
  token: string;
  user: TestUser;
  identity: { username: string; email: string; password: string };
}

let counter = 0;

export function uniqueIdentity(prefix = 'user') {
  counter += 1;
  const stamp = `${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    username: `${prefix}_${stamp}`.slice(0, 40),
    email: `${prefix}-${stamp}@example.test`,
    password: 'correct-horse-battery-staple',
  };
}

/**
 * Register a fresh user through the public API. The agent keeps the CSRF cookie
 * jar, while authentication travels as the per-tab bearer token, exactly like
 * the browser client.
 */
export async function registerTestUser(prefix = 'user'): Promise<TestSession> {
  const agent = request.agent(app);
  const csrfResponse = await agent.get('/api/auth/csrf');
  const csrfToken = csrfResponse.body?.data?.csrfToken as string | undefined;
  if (!csrfToken) throw new Error('Failed to obtain a CSRF token for the test session.');

  const identity = uniqueIdentity(prefix);
  const response = await agent
    .post('/api/auth/register')
    .set('X-CSRF-Token', csrfToken)
    .send(identity);

  if (response.status !== 201) {
    throw new Error(`Test registration failed (${response.status}): ${JSON.stringify(response.body)}`);
  }

  const token = response.body?.data?.token as string | undefined;
  if (!token) throw new Error('Registration did not return a session token.');

  return {
    agent,
    csrfToken,
    token,
    user: response.body.data.user as TestUser,
    identity,
  };
}

/**
 * Convenience wrappers that attach the per-tab bearer token to every request and
 * the CSRF header to mutations. The agent jar supplies the CSRF cookie.
 */
export function csrfClient(session: Pick<TestSession, 'agent' | 'csrfToken' | 'token'>) {
  const auth = <T extends request.Test>(req: T): T =>
    req.set('Authorization', `Bearer ${session.token}`);
  return {
    get: (path: string) => auth(session.agent.get(path)),
    post: (path: string) => auth(session.agent.post(path)).set('X-CSRF-Token', session.csrfToken),
    patch: (path: string) => auth(session.agent.patch(path)).set('X-CSRF-Token', session.csrfToken),
    delete: (path: string) => auth(session.agent.delete(path)).set('X-CSRF-Token', session.csrfToken),
  };
}
