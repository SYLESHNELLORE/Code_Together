import type { ExecutionJob } from '@prisma/client';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { capOutput } from './output.js';
import { getExecutionRunner } from './runner.js';
import { EXECUTION_LANGUAGES, EXECUTION_LANGUAGE_LABELS } from './types.js';
import type {
  ExecutionCapabilities,
  ExecutionEntryFile,
  ExecutionJobStatus,
  ExecutionJobView,
  ExecutionLanguage,
  SandboxResult,
} from './types.js';

const TERMINAL_STATUSES = new Set<ExecutionJobStatus>([
  'COMPLETED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
]);

const MAX_ERROR_MESSAGE_LENGTH = 500;

export function isTerminalExecutionStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status as ExecutionJobStatus);
}

export function executionLimits(): ExecutionCapabilities['limits'] {
  return {
    timeoutMs: env.EXECUTION_TIMEOUT_MS,
    memoryMb: env.EXECUTION_MEMORY_MB,
    cpus: env.EXECUTION_CPUS,
    pidsLimit: env.EXECUTION_PIDS_LIMIT,
    maxCodeBytes: env.EXECUTION_MAX_CODE_BYTES,
    maxOutputBytes: env.EXECUTION_MAX_OUTPUT_BYTES,
  };
}

export async function executionCapabilities(): Promise<ExecutionCapabilities> {
  const availability = await getExecutionRunner().isAvailable();
  return {
    enabled: availability.available,
    reason: availability.reason,
    runner: availability.runner,
    languages: EXECUTION_LANGUAGES.map((id) => ({ id, label: EXECUTION_LANGUAGE_LABELS[id] })),
    limits: executionLimits(),
  };
}

export function toExecutionJobView(job: ExecutionJob): ExecutionJobView {
  return {
    id: job.id,
    projectId: job.projectId,
    fileId: job.fileId,
    language: job.language as ExecutionLanguage,
    status: job.status as ExecutionJobStatus,
    stdout: job.stdout,
    stderr: job.stderr,
    exitCode: job.exitCode,
    signal: job.signal,
    durationMs: job.durationMs,
    timedOut: job.timedOut,
    cancelled: job.cancelled,
    outputTruncated: job.outputTruncated,
    error: job.errorCode
      ? { code: job.errorCode, message: job.errorMessage ?? 'Execution failed.' }
      : null,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt ? job.startedAt.toISOString() : null,
    completedAt: job.completedAt ? job.completedAt.toISOString() : null,
  };
}

export interface StartExecutionInput {
  projectId: string;
  fileId: string;
  userId: string;
  language: ExecutionLanguage;
  entryFile: ExecutionEntryFile;
  code: string;
}

/**
 * Persist the job, reserve the single-active-job slot, and hand it to the
 * configured isolation backend. The HTTP response never waits for execution.
 */
export async function startExecution(input: StartExecutionInput): Promise<ExecutionJobView> {
  const job = await prisma.executionJob.create({
    data: {
      projectId: input.projectId,
      fileId: input.fileId,
      userId: input.userId,
      language: input.language,
      status: 'QUEUED',
      activeKey: `${input.userId}:${input.projectId}`,
    },
  });

  void executeJob(job.id, input).catch((error) => {
    console.error('[execution] job task failed', job.id, error instanceof Error ? error.message : error);
  });

  return toExecutionJobView(job);
}

function resultToStatus(result: SandboxResult): ExecutionJobStatus {
  if (result.cancelled) return 'CANCELLED';
  if (result.timedOut) return 'TIMED_OUT';
  return result.exitCode === 0 ? 'COMPLETED' : 'FAILED';
}

function resultError(
  status: ExecutionJobStatus,
  result: SandboxResult,
): { code: string; message: string } | null {
  if (status === 'TIMED_OUT') {
    return {
      code: 'TIMED_OUT',
      message: `Execution exceeded the ${env.EXECUTION_TIMEOUT_MS / 1000}s time limit.`,
    };
  }
  if (status === 'CANCELLED') {
    return { code: 'CANCELLED', message: 'Execution was cancelled.' };
  }
  if (status === 'FAILED') {
    if (result.exitCode === null) {
      return {
        code: 'SANDBOX_ERROR',
        message: 'The sandbox did not return an exit code. Check that the execution image is available.',
      };
    }
    return {
      code: 'NONZERO_EXIT',
      message: `Process exited with code ${result.exitCode}.`,
    };
  }
  return null;
}

async function executeJob(jobId: string, input: StartExecutionInput): Promise<void> {
  const claimed = await prisma.executionJob.updateMany({
    where: { id: jobId, status: 'QUEUED' },
    data: { status: 'RUNNING', startedAt: new Date() },
  });
  if (claimed.count === 0) return;

  let result: SandboxResult;
  try {
    result = await getExecutionRunner().run({
      jobId,
      language: input.language,
      entryFile: input.entryFile,
      code: input.code,
    });
  } catch (error) {
    const completedAt = new Date();
    const message = (error instanceof Error ? error.message : 'The sandbox failed to start.')
      .slice(0, MAX_ERROR_MESSAGE_LENGTH);
    await prisma.executionJob.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: {
        status: 'FAILED',
        activeKey: null,
        completedAt,
        errorCode: 'SANDBOX_ERROR',
        errorMessage: message,
      },
    });
    return;
  }

  const status = resultToStatus(result);
  const stdout = capOutput(result.stdout, env.EXECUTION_MAX_OUTPUT_BYTES);
  const stderr = capOutput(result.stderr, env.EXECUTION_MAX_OUTPUT_BYTES);
  const error = resultError(status, result);

  await prisma.executionJob.updateMany({
    where: { id: jobId, status: 'RUNNING' },
    data: {
      status,
      activeKey: null,
      stdout: stdout.text,
      stderr: stderr.text,
      exitCode: result.exitCode,
      signal: result.signal ? result.signal.slice(0, 32) : null,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      outputTruncated: result.outputTruncated || stdout.truncated || stderr.truncated,
      errorCode: error?.code ?? null,
      errorMessage: error?.message ?? null,
      durationMs: Math.max(0, Math.round(result.durationMs)),
      completedAt: new Date(),
    },
  });
}

/**
 * Mark a queued/running job cancelled immediately, then ask the runner to kill
 * its container. The runner's later result is ignored because the status guard
 * in `executeJob` only updates RUNNING rows.
 */
export async function cancelExecution(jobId: string): Promise<ExecutionJob | null> {
  const job = await prisma.executionJob.findUnique({ where: { id: jobId } });
  if (!job) return null;
  if (isTerminalExecutionStatus(job.status)) return job;

  const completedAt = new Date();
  await prisma.executionJob.updateMany({
    where: { id: jobId, status: { in: ['QUEUED', 'RUNNING'] } },
    data: {
      status: 'CANCELLED',
      cancelled: true,
      activeKey: null,
      completedAt,
      durationMs: job.startedAt ? Math.max(0, completedAt.getTime() - job.startedAt.getTime()) : null,
      errorCode: 'CANCELLED',
      errorMessage: 'Execution was cancelled by the user.',
    },
  });

  getExecutionRunner().cancel(jobId);
  return prisma.executionJob.findUnique({ where: { id: jobId } });
}

/**
 * Jobs cannot survive a process restart because their in-memory runner handle
 * is gone. Fail them and release the unique active-job slot at startup.
 */
export async function recoverInterruptedExecutions(): Promise<void> {
  await prisma.executionJob.updateMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: {
      status: 'FAILED',
      activeKey: null,
      completedAt: new Date(),
      errorCode: 'SERVER_RESTART',
      errorMessage: 'Execution was interrupted by a server restart.',
    },
  });
}

/** Stop active sandboxes and fail their jobs during graceful shutdown. */
export async function shutdownExecutions(): Promise<void> {
  getExecutionRunner().shutdown();
  await prisma.executionJob.updateMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] } },
    data: {
      status: 'FAILED',
      activeKey: null,
      completedAt: new Date(),
      errorCode: 'SERVER_SHUTDOWN',
      errorMessage: 'Execution was interrupted by a server shutdown.',
    },
  });
}
