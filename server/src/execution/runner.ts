import { env } from '../config/env.js';
import { DisabledSandboxRunner, DockerSandboxRunner } from './dockerRunner.js';
import type { SandboxRunner } from './types.js';

const defaultRunner: SandboxRunner = env.EXECUTION_RUNNER === 'docker'
  ? new DockerSandboxRunner()
  : new DisabledSandboxRunner(
    'Secure code execution is not configured. Build the sandbox image and set EXECUTION_RUNNER=docker.',
  );

let override: SandboxRunner | null = null;

export function getExecutionRunner(): SandboxRunner {
  return override ?? defaultRunner;
}

/**
 * Inject a sandbox implementation in tests. Production selection comes only
 * from EXECUTION_RUNNER and deliberately has no host-process fallback.
 */
export function setExecutionRunnerForTests(runner: SandboxRunner | null): void {
  override = runner;
}
