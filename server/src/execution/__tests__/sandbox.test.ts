import 'dotenv/config';
import { describe, expect, it } from 'vitest';
import {
  buildDockerRunArgs,
  DisabledSandboxRunner,
  sandboxContainerName,
} from '../dockerRunner.js';
import { BoundedOutput, capOutput } from '../output.js';
import { entryFileFor, isExecutionLanguage } from '../targets.js';

const baseOptions = {
  jobId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  language: 'python' as const,
  entryFile: 'main.py' as const,
  image: 'codetogether-executor:test',
  memoryMb: 128,
  cpus: 0.5,
  pidsLimit: 32,
};

describe('hardened docker sandbox arguments', () => {
  it('enables the mandatory isolation flags without mounting the host', () => {
    const args = buildDockerRunArgs(baseOptions);
    const joined = args.join(' ');

    expect(args[0]).toBe('run');
    expect(joined).toContain('--rm');
    expect(joined).toContain('--network none');
    expect(joined).toContain('--read-only');
    expect(joined).toContain('--user 10001:10001');
    expect(joined).toContain('--cap-drop ALL');
    expect(joined).toContain('--security-opt no-new-privileges');
    expect(joined).toContain('--pids-limit 32');
    expect(joined).toContain('--memory 128m');
    expect(joined).toContain('--memory-swap 128m');
    expect(joined).toContain('--cpus 0.5');
    expect(joined).toContain('--ulimit core=0:0');
    expect(joined).toContain('--ulimit nofile=64:64');
    expect(joined).toContain('--ulimit fsize=16777216:16777216');
    expect(joined).toContain('--tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777');
    expect(joined).toContain('--tmpfs /work:rw,exec,nosuid,nodev,size=16m,mode=1777');
    expect(joined).toContain('--workdir /tmp');
    expect(joined).toContain('--pull never');
    expect(joined).toContain('--log-driver none');

    // No host filesystem, device, environment or Docker socket access.
    expect(joined).not.toMatch(/(^| )-v( |$)/);
    expect(joined).not.toContain('--volume');
    expect(joined).not.toContain('--mount');
    expect(joined).not.toContain('--env');
    expect(joined).not.toContain('docker.sock');
    expect(joined).not.toContain('--privileged');
    expect(joined).not.toContain('--network host');
  });

  it('passes only the fixed image, language and entry name as container arguments', () => {
    const args = buildDockerRunArgs(baseOptions);
    expect(args.slice(-3)).toEqual(['codetogether-executor:test', 'python', 'main.py']);
  });

  it('sanitizes container names derived from job IDs', () => {
    expect(sandboxContainerName('abc-123')).toBe('ct-exec-abc-123');
    expect(sandboxContainerName('../../evil name')).toBe('ct-exec-....evilname');
    expect(sandboxContainerName('!!!')).toBe('ct-exec-job');
  });
});

describe('execution targets', () => {
  it('accepts only supported languages', () => {
    expect(isExecutionLanguage('python')).toBe(true);
    expect(isExecutionLanguage('cpp')).toBe(true);
    expect(isExecutionLanguage('java')).toBe(true);
    expect(isExecutionLanguage('ruby')).toBe(false);
    expect(isExecutionLanguage(null)).toBe(false);
  });

  it('maps TypeScript and TSX files to fixed trusted entry names', () => {
    expect(entryFileFor('typescript', 'app.ts')).toBe('main.ts');
    expect(entryFileFor('typescript', 'App.TSX')).toBe('main.tsx');
    expect(entryFileFor('python', 'anything.py')).toBe('main.py');
    expect(entryFileFor('cpp', 'solution.cpp')).toBe('main.cpp');
    expect(entryFileFor('java', 'Solution.java')).toBe('main.java');
  });
});

describe('bounded output collection', () => {
  it('keeps at most the configured number of bytes', () => {
    const output = new BoundedOutput(8);
    output.push(Buffer.from('12345'));
    output.push(Buffer.from('67890'));
    expect(output.isTruncated).toBe(true);
    expect(output.length).toBe(8);
    expect(output.toString()).toBe('12345678');
  });

  it('does not flag output that fits exactly', () => {
    const output = new BoundedOutput(5);
    output.push('hello');
    expect(output.isTruncated).toBe(false);
    expect(output.toString()).toBe('hello');
  });

  it('caps strings defensively and reports truncation', () => {
    const capped = capOutput('abcdef', 3);
    expect(capped).toEqual({ text: 'abc', truncated: true });
    expect(capOutput('abc', 3)).toEqual({ text: 'abc', truncated: false });
  });
});

describe('disabled sandbox runner', () => {
  it('reports why execution is unavailable and refuses to run', async () => {
    const runner = new DisabledSandboxRunner('Docker is not installed.');
    await expect(runner.isAvailable()).resolves.toMatchObject({
      available: false,
      reason: 'Docker is not installed.',
    });
    await expect(
      runner.run({
        jobId: 'job',
        language: 'python',
        entryFile: 'main.py',
        code: 'print(1)',
      }),
    ).rejects.toThrow('Docker is not installed.');
    expect(runner.cancel('job')).toBe(false);
  });
});
