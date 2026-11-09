import { spawn } from 'node:child_process';
import { env } from '../config/env.js';
import { BoundedOutput } from './output.js';
const DOCKER_TIMEOUT_MS = 3_000;
const HARD_STOP_GRACE_MS = 5_000;
const AVAILABILITY_CACHE_MS = 15_000;
const CONTAINER_PREFIX = 'ct-exec-';
/**
 * Only the environment variables needed to locate and talk to the local Docker
 * daemon are passed to the Docker CLI. Application secrets and the database URL
 * never leave the API process, and the container itself inherits no host env.
 */
function dockerCliEnv() {
    const allowed = [
        'PATH',
        'HOME',
        'USERPROFILE',
        'SystemRoot',
        'SYSTEMROOT',
        'TEMP',
        'TMP',
        'DOCKER_HOST',
        'DOCKER_CONTEXT',
        'DOCKER_CONFIG',
    ];
    const result = {};
    for (const key of allowed) {
        const value = process.env[key];
        if (value !== undefined)
            result[key] = value;
    }
    return result;
}
export function sandboxContainerName(jobId) {
    const safe = jobId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48);
    return `${CONTAINER_PREFIX}${safe || 'job'}`;
}
/**
 * Build the fixed argument list for a sandbox container. No shell is involved,
 * no host filesystem is mounted, and no environment variable is forwarded.
 */
export function buildDockerRunArgs(options) {
    const containerName = sandboxContainerName(options.jobId);
    return [
        'run',
        '--rm',
        '--init',
        '--interactive',
        '--name', containerName,
        '--network', 'none',
        '--read-only',
        '--user', '10001:10001',
        '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges',
        '--pids-limit', String(options.pidsLimit),
        '--memory', `${options.memoryMb}m`,
        '--memory-swap', `${options.memoryMb}m`,
        '--cpus', String(options.cpus),
        '--ulimit', 'core=0:0',
        '--ulimit', 'nofile=64:64',
        // Bound file writes inside the writable tmpfs as well as its total size.
        '--ulimit', 'fsize=16777216:16777216',
        '--ipc', 'none',
        '--log-driver', 'none',
        // /tmp holds source and scratch files and is never executable. /work is a
        // separate, size-limited executable mount used only for compiled C/C++
        // binaries. Explicit `exec` is required because recent Docker versions
        // mount tmpfs with noexec by default.
        '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777',
        '--tmpfs', '/work:rw,exec,nosuid,nodev,size=16m,mode=1777',
        '--workdir', '/tmp',
        '--pull', 'never',
        options.image,
        options.language,
        options.entryFile,
    ];
}
function runDockerCommand(args, timeoutMs = DOCKER_TIMEOUT_MS) {
    return new Promise((resolve) => {
        let settled = false;
        let timedOut = false;
        const stdout = new BoundedOutput(4_096);
        const stderr = new BoundedOutput(4_096);
        const child = spawn('docker', args, {
            shell: false,
            windowsHide: true,
            env: dockerCliEnv(),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const finish = (code, error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({
                code,
                stdout: stdout.toString(),
                stderr: stderr.toString(),
                timedOut,
                error,
            });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', (chunk) => stdout.push(chunk));
        child.stderr.on('data', (chunk) => stderr.push(chunk));
        child.once('error', (error) => finish(null, error.message));
        child.once('close', (code) => finish(code, null));
    });
}
export class DockerSandboxRunner {
    name = 'docker';
    active = new Map();
    availability = null;
    async checkAvailability() {
        if (env.EXECUTION_RUNNER !== 'docker') {
            return {
                available: false,
                reason: 'Secure execution is disabled. Set EXECUTION_RUNNER=docker after building the sandbox image.',
                runner: null,
            };
        }
        const inspect = await runDockerCommand([
            'image', 'inspect', '--format', '{{.Id}}', env.EXECUTION_SANDBOX_IMAGE,
        ]);
        if (inspect.code === 0) {
            return { available: true, reason: null, runner: this.name };
        }
        let reason;
        const buildCommand = `docker build -t ${env.EXECUTION_SANDBOX_IMAGE} execution-sandbox`;
        if (inspect.timedOut) {
            reason = 'Docker did not respond while checking the sandbox image. Execution is disabled.';
        }
        else if (inspect.error) {
            // spawn failed: the docker CLI is not installed or not on PATH.
            reason = `Docker CLI could not be started (${inspect.error}). Install Docker Desktop or Docker Engine, start it, then run: ${buildCommand}`;
        }
        else {
            const detail = (inspect.stderr || inspect.stdout).trim().slice(0, 180);
            // A stopped daemon is a different problem from a missing image; report
            // them separately so the fix is obvious.
            const daemonDown = /cannot connect|error during connect|is the docker daemon running|docker daemon|pipe\/docker/i.test(detail);
            if (daemonDown) {
                reason = `Docker is installed but its daemon is not reachable. Start Docker Desktop (or the docker service) and retry. ${detail}`;
            }
            else if (detail) {
                reason = `Sandbox image "${env.EXECUTION_SANDBOX_IMAGE}" is unavailable: ${detail}. Build it with: ${buildCommand}`;
            }
            else {
                reason = `Sandbox image "${env.EXECUTION_SANDBOX_IMAGE}" is unavailable. Build it with: ${buildCommand}`;
            }
        }
        return { available: false, reason, runner: this.name };
    }
    async isAvailable() {
        const now = Date.now();
        // Cache only a working sandbox. An unavailable result is re-diagnosed on
        // every request so fixing Docker or building the image takes effect as
        // soon as the user retries instead of waiting for a stale TTL.
        if (this.availability?.result.available
            && now - this.availability.checkedAt < AVAILABILITY_CACHE_MS) {
            return this.availability.result;
        }
        const result = await this.checkAvailability();
        this.availability = { checkedAt: now, result };
        return result;
    }
    async terminateContainer(containerName) {
        await runDockerCommand(['kill', containerName]);
        // `docker run` may still be creating the container when cancel arrives.
        // A delayed force-remove closes that race and also reaps a stopped container.
        const timer = setTimeout(() => {
            void runDockerCommand(['rm', '--force', containerName]);
        }, 1_000);
        timer.unref?.();
    }
    run(request) {
        return new Promise((resolve, reject) => {
            const startedAt = Date.now();
            const containerName = sandboxContainerName(request.jobId);
            const stdout = new BoundedOutput(env.EXECUTION_MAX_OUTPUT_BYTES);
            const stderr = new BoundedOutput(env.EXECUTION_MAX_OUTPUT_BYTES);
            const args = buildDockerRunArgs({
                jobId: request.jobId,
                language: request.language,
                entryFile: request.entryFile,
                image: env.EXECUTION_SANDBOX_IMAGE,
                memoryMb: env.EXECUTION_MEMORY_MB,
                cpus: env.EXECUTION_CPUS,
                pidsLimit: env.EXECUTION_PIDS_LIMIT,
            });
            let child;
            try {
                child = spawn('docker', args, {
                    shell: false,
                    windowsHide: true,
                    env: dockerCliEnv(),
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            }
            catch (error) {
                reject(error instanceof Error ? error : new Error('Failed to start the sandbox.'));
                return;
            }
            let settled = false;
            let stopping = false;
            let timedOut = false;
            let cancelled = false;
            let outputTruncated = false;
            let hardStopTimer = null;
            const finish = (exitCode, signal) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timeoutTimer);
                if (hardStopTimer)
                    clearTimeout(hardStopTimer);
                this.active.delete(request.jobId);
                resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode,
                    signal,
                    timedOut,
                    cancelled,
                    outputTruncated,
                    durationMs: Math.max(0, Date.now() - startedAt),
                });
            };
            const stop = (reason) => {
                if (settled)
                    return;
                if (reason === 'cancel')
                    cancelled = true;
                if (reason === 'timeout')
                    timedOut = true;
                if (!stopping) {
                    stopping = true;
                    void this.terminateContainer(containerName).catch(() => undefined);
                    child.kill('SIGTERM');
                    hardStopTimer = setTimeout(() => finish(null, 'SIGKILL'), HARD_STOP_GRACE_MS);
                    hardStopTimer.unref?.();
                }
            };
            const timeoutTimer = setTimeout(() => stop('timeout'), env.EXECUTION_TIMEOUT_MS);
            timeoutTimer.unref?.();
            this.active.set(request.jobId, { cancel: () => stop('cancel') });
            child.stdout.on('data', (chunk) => {
                stdout.push(chunk);
                if (stdout.isTruncated) {
                    outputTruncated = true;
                    stop('output');
                }
            });
            child.stderr.on('data', (chunk) => {
                stderr.push(chunk);
                if (stderr.isTruncated) {
                    outputTruncated = true;
                    stop('output');
                }
            });
            child.once('error', (error) => {
                if (settled)
                    return;
                stderr.push(`Sandbox error: ${error.message}`);
                finish(null, null);
            });
            child.once('close', (code, signal) => finish(code, signal));
            child.stdin.once('error', () => undefined);
            child.stdin.end(request.code, 'utf8');
        });
    }
    cancel(jobId) {
        const active = this.active.get(jobId);
        if (!active)
            return false;
        active.cancel();
        return true;
    }
    shutdown() {
        for (const active of this.active.values())
            active.cancel();
        this.active.clear();
    }
}
export class DisabledSandboxRunner {
    reason;
    name = 'disabled';
    constructor(reason) {
        this.reason = reason;
    }
    async isAvailable() {
        return { available: false, reason: this.reason, runner: null };
    }
    async run(_request) {
        throw new Error(this.reason);
    }
    cancel(_jobId) {
        return false;
    }
    shutdown() {
        // Nothing can be running.
    }
}
