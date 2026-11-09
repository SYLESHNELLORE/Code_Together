/**
 * End-to-end self-test for the hardened Docker execution sandbox.
 *
 * Run after `npm run sandbox:build` and with Docker running:
 *
 *   npm run sandbox:selftest
 *
 * It uses the exact same argument builder as the API (buildDockerRunArgs), so
 * it verifies the real isolation flags, image, entrypoint, language runtimes,
 * timeout enforcement and cleanup — not a parallel copy of the setup.
 *
 * Exit code 0 means every check passed; 1 means at least one failed.
 */
import 'dotenv/config';
import { spawn } from 'node:child_process';
import { env } from '../config/env.js';
import { buildDockerRunArgs } from '../execution/dockerRunner.js';
const MARKER = 'Hello from CodeTogether';
const OUTPUT_CAP = 8_192;
function runDocker(args, timeoutMs = 10_000) {
    return new Promise((resolve) => {
        const startedAt = Date.now();
        let settled = false;
        let timedOut = false;
        let stdout = '';
        let stderr = '';
        const child = spawn('docker', args, {
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const finish = (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, code, timedOut, durationMs: Date.now() - startedAt });
        };
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout.on('data', (chunk) => {
            if (stdout.length < OUTPUT_CAP)
                stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length < OUTPUT_CAP)
                stderr += chunk.toString();
        });
        child.once('error', (error) => {
            stderr += error.message;
            finish(null);
        });
        child.once('close', (code) => finish(code));
    });
}
/** Run one job through the production argument list, mirroring the API runner. */
function runSandbox(jobId, language, entryFile, code, timeoutMs) {
    const args = buildDockerRunArgs({
        jobId,
        language,
        entryFile,
        image: env.EXECUTION_SANDBOX_IMAGE,
        memoryMb: env.EXECUTION_MEMORY_MB,
        cpus: env.EXECUTION_CPUS,
        pidsLimit: env.EXECUTION_PIDS_LIMIT,
    });
    const nameIndex = args.indexOf('--name');
    const containerName = nameIndex >= 0 ? args[nameIndex + 1] ?? '' : '';
    return new Promise((resolve) => {
        const startedAt = Date.now();
        let settled = false;
        let timedOut = false;
        let stdout = '';
        let stderr = '';
        let hardStop = null;
        const child = spawn('docker', args, {
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        const finish = (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeoutTimer);
            if (hardStop)
                clearTimeout(hardStop);
            resolve({ stdout, stderr, code, timedOut, durationMs: Date.now() - startedAt });
        };
        const timeoutTimer = setTimeout(() => {
            timedOut = true;
            // Same best-effort cancellation as the API: kill the container, then
            // give the CLI a grace period before resolving the result.
            void runDocker(['kill', containerName]);
            hardStop = setTimeout(() => finish(null), 5_000);
        }, timeoutMs);
        child.stdout.on('data', (chunk) => {
            if (stdout.length < OUTPUT_CAP)
                stdout += chunk.toString();
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length < OUTPUT_CAP)
                stderr += chunk.toString();
        });
        child.once('error', (error) => {
            stderr += error.message;
            finish(null);
        });
        child.once('close', (code) => finish(code));
        child.stdin.once('error', () => undefined);
        child.stdin.end(code, 'utf8');
    });
}
const CASES = [
    {
        name: 'Python hello world',
        jobId: 'verify-python',
        language: 'python',
        entry: 'main.py',
        code: 'print("Hello from CodeTogether")',
        expect: 'marker',
    },
    {
        name: 'Runtime isolation (non-root, read-only root, no app env)',
        jobId: 'verify-isolation',
        language: 'python',
        entry: 'main.py',
        code: [
            'import os',
            'assert os.geteuid() == 10001, f"unexpected uid {os.geteuid()}"',
            'assert "DATABASE_URL" not in os.environ, "database URL leaked into the sandbox"',
            'assert not any(k.startswith("EXECUTION_") for k in os.environ), "app env leaked into the sandbox"',
            'try:',
            '    open("/etc/codetogether-write-test", "w").close()',
            'except OSError:',
            '    pass',
            'else:',
            '    raise SystemExit("root filesystem is writable")',
            'print("Hello from CodeTogether")',
        ].join('\n'),
        expect: 'marker',
    },
    {
        name: 'JavaScript hello world',
        jobId: 'verify-javascript',
        language: 'javascript',
        entry: 'main.js',
        code: 'console.log("Hello from CodeTogether");',
        expect: 'marker',
    },
    {
        name: 'TypeScript hello world',
        jobId: 'verify-typescript',
        language: 'typescript',
        entry: 'main.ts',
        code: 'const message: string = "Hello from CodeTogether";\nconsole.log(message);',
        expect: 'marker',
    },
    {
        name: 'C hello world',
        jobId: 'verify-c',
        language: 'c',
        entry: 'main.c',
        code: '#include <stdio.h>\nint main(void) {\n    printf("Hello from CodeTogether\\n");\n    return 0;\n}',
        expect: 'marker',
    },
    {
        name: 'C++ hello world',
        jobId: 'verify-cpp',
        language: 'cpp',
        entry: 'main.cpp',
        code: '#include <iostream>\nint main() {\n    std::cout << "Hello from CodeTogether" << std::endl;\n    return 0;\n}',
        expect: 'marker',
    },
    {
        name: 'Java hello world',
        jobId: 'verify-java',
        language: 'java',
        entry: 'main.java',
        code: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello from CodeTogether");\n    }\n}',
        expect: 'marker',
    },
    {
        name: 'Infinite loop is stopped by the timeout',
        jobId: 'verify-timeout',
        language: 'python',
        entry: 'main.py',
        code: 'while True:\n    pass',
        expect: 'timeout',
    },
    {
        name: 'Network access is blocked',
        jobId: 'verify-network',
        language: 'python',
        entry: 'main.py',
        code: 'import socket\nsocket.create_connection(("example.com", 80), timeout=3)\nprint("network reachable")',
        expect: 'failure',
    },
    {
        name: 'Excessive memory is blocked',
        jobId: 'verify-memory',
        language: 'python',
        entry: 'main.py',
        code: 'buffer = bytearray(1024 * 1024 * 1024)\nprint(len(buffer))',
        expect: 'failure',
    },
];
function summarize(result) {
    const status = result.timedOut
        ? 'timeout'
        : result.code === null
            ? 'no exit code'
            : `exit ${result.code}`;
    return `${status}, ${result.durationMs} ms`;
}
async function main() {
    console.log('CodeTogether sandbox self-test');
    console.log(`  image:  ${env.EXECUTION_SANDBOX_IMAGE}`);
    console.log(`  limits: ${env.EXECUTION_TIMEOUT_MS} ms · ${env.EXECUTION_MEMORY_MB} MB · ${env.EXECUTION_CPUS} CPU · ${env.EXECUTION_PIDS_LIMIT} PIDs`);
    console.log('');
    const version = await runDocker(['version', '--format', '{{.Server.Version}}']);
    if (version.code !== 0) {
        console.error('FAIL  Docker is not available.');
        console.error('      Install Docker Desktop or Docker Engine, start it, and run this again.');
        if (version.stderr.trim())
            console.error(`      ${version.stderr.trim()}`);
        return 1;
    }
    console.log(`PASS  Docker daemon reachable (server ${version.stdout.trim()})`);
    const inspect = await runDocker(['image', 'inspect', '--format', '{{.Id}}', env.EXECUTION_SANDBOX_IMAGE]);
    if (inspect.code !== 0) {
        console.error(`FAIL  Sandbox image "${env.EXECUTION_SANDBOX_IMAGE}" is missing.`);
        console.error(`      Build it with: npm run sandbox:build`);
        if (inspect.stderr.trim())
            console.error(`      ${inspect.stderr.trim()}`);
        return 1;
    }
    console.log(`PASS  Sandbox image present (${inspect.stdout.trim().slice(0, 19)})`);
    console.log('');
    let failures = 0;
    for (const testCase of CASES) {
        process.stdout.write(`....  ${testCase.name} ... `);
        const result = await runSandbox(testCase.jobId, testCase.language, testCase.entry, testCase.code, env.EXECUTION_TIMEOUT_MS);
        const output = `${result.stdout}\n${result.stderr}`;
        const passed = testCase.expect === 'marker'
            ? result.code === 0 && result.stdout.includes(MARKER)
            : testCase.expect === 'timeout'
                ? result.timedOut
                : result.code !== 0 && !output.includes(MARKER);
        if (passed) {
            console.log(`PASS  (${summarize(result)})`);
        }
        else {
            failures += 1;
            console.log(`FAIL  (${summarize(result)})`);
            const detail = output.trim().split(/\r?\n/).slice(0, 12).join('\n        ');
            if (detail)
                console.log(`        ${detail}`);
        }
    }
    const leftovers = await runDocker(['ps', '-a', '--filter', 'name=ct-exec-', '--format', '{{.Names}}']);
    const stale = leftovers.stdout.trim();
    if (stale) {
        failures += 1;
        console.log(`FAIL  Containers were left behind:\n        ${stale.split(/\r?\n/).join('\n        ')}`);
        console.log('      Remove them with: docker rm -f <name>');
    }
    else {
        console.log('PASS  No sandbox containers were left behind');
    }
    console.log('');
    if (failures === 0) {
        console.log('All sandbox checks passed. Secure execution is ready.');
        return 0;
    }
    console.log(`${failures} sandbox check(s) failed.`);
    return 1;
}
main()
    .then((code) => process.exit(code))
    .catch((error) => {
    console.error('Self-test crashed:', error);
    process.exit(1);
});
