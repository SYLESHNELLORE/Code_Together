/** Languages the sandbox image is built to run. */
export const EXECUTION_LANGUAGES = [
  'python',
  'javascript',
  'typescript',
  'c',
  'cpp',
  'java',
] as const;

export type ExecutionLanguage = (typeof EXECUTION_LANGUAGES)[number];

export const EXECUTION_LANGUAGE_LABELS: Record<ExecutionLanguage, string> = {
  python: 'Python 3',
  javascript: 'JavaScript (Node.js)',
  typescript: 'TypeScript',
  c: 'C (GCC)',
  cpp: 'C++ (G++)',
  java: 'Java (OpenJDK)',
};

/** Fixed entry names prevent client-controlled paths inside the container. */
export const EXECUTION_ENTRY_FILES = {
  python: 'main.py',
  javascript: 'main.js',
  typescript: 'main.ts',
  typescriptTsx: 'main.tsx',
  c: 'main.c',
  cpp: 'main.cpp',
  java: 'main.java',
} as const;

export type ExecutionEntryFile =
  (typeof EXECUTION_ENTRY_FILES)[keyof typeof EXECUTION_ENTRY_FILES];

export interface SandboxRequest {
  jobId: string;
  language: ExecutionLanguage;
  entryFile: ExecutionEntryFile;
  code: string;
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  durationMs: number;
}

export interface SandboxAvailability {
  available: boolean;
  reason: string | null;
  runner: string | null;
}

export interface SandboxRunner {
  readonly name: string;
  /** Check the configured isolation backend without starting user code. */
  isAvailable(): Promise<SandboxAvailability>;
  /** Run one job. Implementations must enforce time and output limits. */
  run(request: SandboxRequest): Promise<SandboxResult>;
  /** Best-effort cancellation. Returns true when an active job was signalled. */
  cancel(jobId: string): boolean;
  /** Cancel anything still running during process shutdown. */
  shutdown(): void;
}

export type ExecutionJobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED';

export interface ExecutionJobError {
  code: string;
  message: string;
}

export interface ExecutionJobView {
  id: string;
  projectId: string;
  fileId: string | null;
  language: ExecutionLanguage;
  status: ExecutionJobStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  error: ExecutionJobError | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ExecutionLimitsView {
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  maxCodeBytes: number;
  maxOutputBytes: number;
}

export interface ExecutionCapabilities {
  enabled: boolean;
  reason: string | null;
  runner: string | null;
  languages: Array<{ id: ExecutionLanguage; label: string }>;
  limits: ExecutionLimitsView;
}
