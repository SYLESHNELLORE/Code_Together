import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().url().default('http://localhost:5173'),
  // Opaque sessions are stored in MySQL, so no signing secret is needed.
  SESSION_TTL_DAYS: z.coerce.number().int().positive().max(90).default(7),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // Code execution is opt-in. The only enabled runner is a hardened Docker
  // container; there is deliberately no in-process or host fallback.
  EXECUTION_RUNNER: z.enum(['disabled', 'docker']).default('disabled'),
  EXECUTION_SANDBOX_IMAGE: z.string().trim().min(1).max(200).default('codetogether-executor:latest'),
  EXECUTION_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5_000),
  EXECUTION_MEMORY_MB: z.coerce.number().int().min(64).max(1_024).default(256),
  EXECUTION_CPUS: z.coerce.number().min(0.1).max(2).default(0.5),
  EXECUTION_PIDS_LIMIT: z.coerce.number().int().min(16).max(512).default(64),
  EXECUTION_MAX_CODE_BYTES: z.coerce.number().int().min(1_000).max(1_000_000).default(100_000),
  // Per-stream cap. Both stdout and stderr are bounded independently.
  EXECUTION_MAX_OUTPUT_BYTES: z.coerce.number().int().min(1_024).max(262_144).default(16_384),
});

export const env = envSchema.parse(process.env);
