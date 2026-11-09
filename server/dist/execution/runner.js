import { env } from '../config/env.js';
import { DisabledSandboxRunner, DockerSandboxRunner } from './dockerRunner.js';
const defaultRunner = env.EXECUTION_RUNNER === 'docker'
    ? new DockerSandboxRunner()
    : new DisabledSandboxRunner('Secure code execution is not configured. Build the sandbox image and set EXECUTION_RUNNER=docker.');
let override = null;
export function getExecutionRunner() {
    return override ?? defaultRunner;
}
/**
 * Inject a sandbox implementation in tests. Production selection comes only
 * from EXECUTION_RUNNER and deliberately has no host-process fallback.
 */
export function setExecutionRunnerForTests(runner) {
    override = runner;
}
