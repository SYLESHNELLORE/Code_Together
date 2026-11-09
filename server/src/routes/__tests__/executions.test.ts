import 'dotenv/config';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { app } from '../../app.js';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { setExecutionRunnerForTests } from '../../execution/runner.js';
import type {
  SandboxAvailability,
  SandboxRequest,
  SandboxResult,
  SandboxRunner,
} from '../../execution/types.js';
import { csrfClient, registerTestUser, type TestSession } from './authTestUtils.js';

const hasDatabase = Boolean(process.env.DATABASE_URL);
const integration = hasDatabase ? describe : describe.skip;

interface PendingRun {
  request: SandboxRequest;
  resolve: (result: SandboxResult) => void;
}

const baseResult: SandboxResult = {
  stdout: '',
  stderr: '',
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
  outputTruncated: false,
  durationMs: 5,
};

/**
 * Test double for the isolated backend. It never spawns a process: each job
 * waits until the test supplies a result, which makes timeouts, output capping
 * and cancellation deterministic while still exercising the real job service.
 */
class FakeSandboxRunner implements SandboxRunner {
  readonly name = 'fake';
  available = true;
  pending = new Map<string, PendingRun>();
  cancelled: string[] = [];

  async isAvailable(): Promise<SandboxAvailability> {
    return {
      available: this.available,
      reason: this.available ? null : 'Fake sandbox is disabled for this test.',
      runner: this.name,
    };
  }

  run(sandboxRequest: SandboxRequest): Promise<SandboxResult> {
    return new Promise<SandboxResult>((resolve) => {
      this.pending.set(sandboxRequest.jobId, { request: sandboxRequest, resolve });
    });
  }

  cancel(jobId: string): boolean {
    this.cancelled.push(jobId);
    return this.pending.has(jobId);
  }

  shutdown(): void {
    this.flushPending();
  }

  async waitForRun(): Promise<PendingRun> {
    return waitFor(() => this.pending.values().next().value as PendingRun | undefined);
  }

  complete(jobId: string, result: Partial<SandboxResult> = {}): void {
    const pending = this.pending.get(jobId);
    if (!pending) throw new Error(`No pending sandbox run for job ${jobId}`);
    this.pending.delete(jobId);
    pending.resolve({ ...baseResult, ...result });
  }

  flushPending(): void {
    for (const [jobId, pending] of this.pending) {
      pending.resolve({ ...baseResult, exitCode: null, cancelled: true, timedOut: false, durationMs: 0 });
      this.pending.delete(jobId);
    }
  }
}

async function waitFor<T>(
  probe: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for the expected state.');
}

interface ExecutionBody {
  id: string;
  projectId: string;
  fileId: string | null;
  language: string;
  status: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number | null;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  error: { code: string; message: string } | null;
}

integration('secure code execution (requires MySQL)', () => {
  const fake = new FakeSandboxRunner();
  const createdProjectIds: string[] = [];
  const createdUserIds: string[] = [];

  beforeAll(() => {
    setExecutionRunnerForTests(fake);
  });

  afterEach(() => {
    fake.available = true;
    fake.cancelled = [];
    // Never leak a pending job into the next test if an assertion fails early.
    fake.flushPending();
  });

  afterAll(async () => {
    setExecutionRunnerForTests(null);
    fake.flushPending();
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
      .send({ name: `exec-${label}-${Date.now()}`.slice(0, 80), description: 'Phase 7 execution test' });
    expect(response.status).toBe(201);
    createdProjectIds.push(response.body.data.id);
    return response.body.data.id as string;
  }

  async function createFile(
    session: TestSession,
    projectId: string,
    name: string,
    content: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await csrfClient(session)
      .post(`/api/projects/${projectId}/files`)
      .send({ name, path: name, content, ...extra });
    expect(response.status).toBe(201);
    return response.body.data.id as string;
  }

  async function addMember(projectId: string, userId: string, role: 'ADMIN' | 'EDITOR' | 'VIEWER') {
    await prisma.projectMember.create({ data: { projectId, userId, role } });
  }

  async function waitForRunning(jobId: string): Promise<PendingRun> {
    const pending = await fake.waitForRun();
    expect(pending.request.jobId).toBe(jobId);
    return pending;
  }

  async function readJob(session: TestSession, projectId: string, jobId: string): Promise<ExecutionBody> {
    const response = await csrfClient(session).get(`/api/projects/${projectId}/executions/${jobId}`);
    expect(response.status).toBe(200);
    return response.body.data as ExecutionBody;
  }

  async function waitForTerminal(
    session: TestSession,
    projectId: string,
    jobId: string,
  ): Promise<ExecutionBody> {
    return waitFor<ExecutionBody>(async () => {
      const job = await readJob(session, projectId, jobId);
      return job.status === 'QUEUED' || job.status === 'RUNNING' ? undefined : job;
    });
  }

  it('reports capabilities and supported languages', async () => {
    const owner = await newSession('exec_caps');
    const projectId = await createProject(owner, 'caps');

    const response = await csrfClient(owner).get(`/api/projects/${projectId}/executions/capabilities`);
    expect(response.status).toBe(200);
    expect(response.body.data.enabled).toBe(true);
    expect(response.body.data.runner).toBe('fake');
    const languageIds = response.body.data.languages.map((item: { id: string }) => item.id);
    expect(languageIds).toEqual(expect.arrayContaining(['python', 'javascript', 'typescript', 'c', 'cpp']));
    expect(response.body.data.limits).toMatchObject({
      timeoutMs: env.EXECUTION_TIMEOUT_MS,
      memoryMb: env.EXECUTION_MEMORY_MB,
      maxOutputBytes: env.EXECUTION_MAX_OUTPUT_BYTES,
    });
  });

  it('runs a stored project file and returns bounded output', async () => {
    const owner = await newSession('exec_ok');
    const projectId = await createProject(owner, 'ok');
    const fileId = await createFile(owner, projectId, 'main.py', 'print("hello")\n');

    const started = await csrfClient(owner)
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId, language: 'python' });
    expect(started.status).toBe(202);
    expect(started.body.data).toMatchObject({ status: 'QUEUED', language: 'python', fileId });
    const jobId = started.body.data.id as string;

    const pending = await waitForRunning(jobId);
    expect(pending.request.code).toBe('print("hello")\n');
    expect(pending.request.entryFile).toBe('main.py');

    fake.complete(jobId, { stdout: 'hello\n', durationMs: 42 });
    const job = await waitForTerminal(owner, projectId, jobId);
    expect(job).toMatchObject({
      status: 'COMPLETED',
      exitCode: 0,
      stdout: 'hello\n',
      stderr: '',
      durationMs: 42,
      outputTruncated: false,
      timedOut: false,
      cancelled: false,
      error: null,
    });
  });

  it('reports compilation and runtime failures with their stderr', async () => {
    const owner = await newSession('exec_syntax');
    const projectId = await createProject(owner, 'syntax');
    const fileId = await createFile(owner, projectId, 'main.ts', 'const x: = 1;\n');

    const started = await csrfClient(owner)
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId, language: 'typescript' });
    expect(started.status).toBe(202);
    const jobId = started.body.data.id as string;

    const pending = await waitForRunning(jobId);
    expect(pending.request.entryFile).toBe('main.ts');
    fake.complete(jobId, { exitCode: 1, stderr: 'main.ts(1,10): error TS1110: Type expected.\n' });

    const job = await waitForTerminal(owner, projectId, jobId);
    expect(job.status).toBe('FAILED');
    expect(job.exitCode).toBe(1);
    expect(job.stderr).toContain('TS1110');
    expect(job.error?.code).toBe('NONZERO_EXIT');
  });

  it('marks jobs that exceed the time limit', async () => {
    const owner = await newSession('exec_timeout');
    const projectId = await createProject(owner, 'timeout');
    const fileId = await createFile(owner, projectId, 'main.c', 'int main(void) { for (;;); }\n');

    const started = await csrfClient(owner)
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId, language: 'c' });
    const jobId = started.body.data.id as string;

    const pending = await waitForRunning(jobId);
    expect(pending.request.entryFile).toBe('main.c');
    fake.complete(jobId, { exitCode: null, timedOut: true, durationMs: env.EXECUTION_TIMEOUT_MS });

    const job = await waitForTerminal(owner, projectId, jobId);
    expect(job.status).toBe('TIMED_OUT');
    expect(job.timedOut).toBe(true);
    expect(job.error?.code).toBe('TIMED_OUT');
  });

  it('caps oversized output before it reaches the database or the client', async () => {
    const owner = await newSession('exec_output');
    const projectId = await createProject(owner, 'output');
    const fileId = await createFile(owner, projectId, 'main.js', 'for (;;) console.log("spam");\n');

    const started = await csrfClient(owner)
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId, language: 'javascript' });
    const jobId = started.body.data.id as string;

    await waitForRunning(jobId);
    fake.complete(jobId, { stdout: 'x'.repeat(env.EXECUTION_MAX_OUTPUT_BYTES + 5_000) });

    const job = await waitForTerminal(owner, projectId, jobId);
    expect(job.status).toBe('COMPLETED');
    expect(job.outputTruncated).toBe(true);
    expect(Buffer.byteLength(job.stdout, 'utf8')).toBeLessThanOrEqual(env.EXECUTION_MAX_OUTPUT_BYTES);
  });

  it('cancels a running job and ignores the runner result afterwards', async () => {
    const owner = await newSession('exec_cancel');
    const projectId = await createProject(owner, 'cancel');
    const fileId = await createFile(owner, projectId, 'main.py', 'while True: pass\n');

    const started = await csrfClient(owner)
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId, language: 'python' });
    const jobId = started.body.data.id as string;

    await waitForRunning(jobId);
    const cancelled = await csrfClient(owner).post(`/api/projects/${projectId}/executions/${jobId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(cancelled.body.data.cancelled).toBe(true);
    expect(fake.cancelled).toContain(jobId);

    fake.complete(jobId, { stdout: 'too late\n' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const job = await readJob(owner, projectId, jobId);
    expect(job.status).toBe('CANCELLED');
    expect(job.stdout).toBe('');
  });

  it('rejects duplicate submissions while a job is active', async () => {
    const owner = await newSession('exec_duplicate');
    const projectId = await createProject(owner, 'duplicate');
    const fileId = await createFile(owner, projectId, 'main.py', 'print(1)\n');

    const first = await csrfClient(owner)
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId, language: 'python' });
    expect(first.status).toBe(202);
    const firstId = first.body.data.id as string;
    await waitForRunning(firstId);

    const duplicate = await csrfClient(owner)
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId, language: 'python' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('EXECUTION_ALREADY_RUNNING');

    fake.complete(firstId, { stdout: '1\n' });
    await waitForTerminal(owner, projectId, firstId);

    const again = await csrfClient(owner)
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId, language: 'python' });
    expect(again.status).toBe(202);
    await waitForRunning(again.body.data.id);
    fake.complete(again.body.data.id, { stdout: '1\n' });
    await waitForTerminal(owner, projectId, again.body.data.id);
  });

  it('validates language, file type, size and empty code', async () => {
    const owner = await newSession('exec_invalid');
    const projectId = await createProject(owner, 'invalid');
    const client = csrfClient(owner);

    const pythonFile = await createFile(owner, projectId, 'main.py', 'print(1)\n');
    const emptyFile = await createFile(owner, projectId, 'empty.py', '   \n');
    const markdownFile = await createFile(owner, projectId, 'notes.md', '# notes\n');
    const folder = await createFile(owner, projectId, 'src', '', { isFolder: true });
    const hugeFile = await createFile(owner, projectId, 'huge.py', `# ${'x'.repeat(env.EXECUTION_MAX_CODE_BYTES)}\n`);
    const jobId = '11111111-1111-4111-8111-111111111111';

    const missingFile = await client.post(`/api/projects/${projectId}/executions`).send({ language: 'python' });
    expect(missingFile.status).toBe(400);
    expect(missingFile.body.error.code).toBe('VALIDATION_ERROR');

    const badLanguage = await client
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId: pythonFile, language: 'ruby' });
    expect(badLanguage.status).toBe(400);

    const mismatch = await client
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId: pythonFile, language: 'javascript' });
    expect(mismatch.status).toBe(400);

    const unsupported = await client
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId: markdownFile, language: 'python' });
    expect(unsupported.status).toBe(400);

    const empty = await client
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId: emptyFile, language: 'python' });
    expect(empty.status).toBe(400);

    const folderRun = await client
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId: folder, language: 'python' });
    expect(folderRun.status).toBe(400);

    const oversized = await client
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId: hugeFile, language: 'python' });
    expect(oversized.status).toBe(413);
    expect(oversized.body.error.code).toBe('CODE_TOO_LARGE');

    const missingFileId = await client
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId: jobId, language: 'python' });
    expect(missingFileId.status).toBe(404);
  });

  it('enforces project roles for running, reading and cancelling', async () => {
    const owner = await newSession('exec_owner');
    const viewer = await newSession('exec_viewer');
    const editor = await newSession('exec_editor');
    const admin = await newSession('exec_admin');
    const outsider = await newSession('exec_outsider');
    const projectId = await createProject(owner, 'roles');
    await addMember(projectId, viewer.user.id, 'VIEWER');
    await addMember(projectId, editor.user.id, 'EDITOR');
    await addMember(projectId, admin.user.id, 'ADMIN');

    const fileId = await createFile(owner, projectId, 'main.py', 'print("owner")\n');

    const viewerRun = await csrfClient(viewer)
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId, language: 'python' });
    expect(viewerRun.status).toBe(403);

    const outsiderCaps = await csrfClient(outsider).get(`/api/projects/${projectId}/executions/capabilities`);
    expect(outsiderCaps.status).toBe(404);
    const outsiderRun = await csrfClient(outsider)
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId, language: 'python' });
    expect(outsiderRun.status).toBe(404);

    const started = await csrfClient(owner)
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId, language: 'python' });
    expect(started.status).toBe(202);
    const jobId = started.body.data.id as string;
    await waitForRunning(jobId);

    // Viewers cannot read another member's job or cancel it.
    const viewerRead = await csrfClient(viewer).get(`/api/projects/${projectId}/executions/${jobId}`);
    expect(viewerRead.status).toBe(404);
    const viewerCancel = await csrfClient(viewer).post(
      `/api/projects/${projectId}/executions/${jobId}/cancel`,
    );
    expect(viewerCancel.status).toBe(403);

    // Editors may cancel their own jobs, not the owner's.
    const editorCancel = await csrfClient(editor).post(
      `/api/projects/${projectId}/executions/${jobId}/cancel`,
    );
    expect(editorCancel.status).toBe(403);

    // Admins can read and cancel any job in the project.
    const adminRead = await csrfClient(admin).get(`/api/projects/${projectId}/executions/${jobId}`);
    expect(adminRead.status).toBe(200);
    const adminCancel = await csrfClient(admin).post(
      `/api/projects/${projectId}/executions/${jobId}/cancel`,
    );
    expect(adminCancel.status).toBe(200);
    expect(adminCancel.body.data.status).toBe('CANCELLED');

    // Let the fake sandbox finish so the service task can settle. The late
    // result is ignored because the job is already terminal.
    fake.complete(jobId, { cancelled: true });

    const viewerHistory = await csrfClient(viewer).get(`/api/projects/${projectId}/executions`);
    expect(viewerHistory.status).toBe(200);
    expect(viewerHistory.body.data.jobs).toEqual([]);

    const adminHistory = await csrfClient(admin).get(`/api/projects/${projectId}/executions`);
    expect(adminHistory.body.data.jobs.map((job: ExecutionBody) => job.id)).toContain(jobId);
  });

  it('fails safely when no sandbox is available', async () => {
    const owner = await newSession('exec_disabled');
    const projectId = await createProject(owner, 'disabled');
    const fileId = await createFile(owner, projectId, 'main.py', 'print(1)\n');
    fake.available = false;

    const capabilities = await csrfClient(owner).get(`/api/projects/${projectId}/executions/capabilities`);
    expect(capabilities.status).toBe(200);
    expect(capabilities.body.data.enabled).toBe(false);
    expect(capabilities.body.data.reason).toContain('disabled');

    const started = await csrfClient(owner)
      .post(`/api/projects/${projectId}/executions`)
      .send({ fileId, language: 'python' });
    expect(started.status).toBe(503);
    expect(started.body.error.code).toBe('EXECUTION_UNAVAILABLE');
    expect(fake.pending.size).toBe(0);
    expect(await prisma.executionJob.count({ where: { projectId } })).toBe(0);
  });

  it('requires authentication for every execution endpoint', async () => {
    const anonymous = request.agent(app);
    const csrfToken = (await anonymous.get('/api/auth/csrf')).body.data.csrfToken as string;
    const projectId = '11111111-1111-4111-8111-111111111111';

    expect((await anonymous.get(`/api/projects/${projectId}/executions/capabilities`)).status).toBe(401);
    expect((await anonymous.get(`/api/projects/${projectId}/executions`)).status).toBe(401);
    const start = await anonymous
      .post(`/api/projects/${projectId}/executions`)
      .set('X-CSRF-Token', csrfToken)
      .send({});
    expect(start.status).toBe(401);
    expect(start.body.error.code).toBe('UNAUTHENTICATED');
  });
});
