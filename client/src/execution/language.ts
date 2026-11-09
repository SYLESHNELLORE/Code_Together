import type { ExecutionLanguage } from '../api';

/**
 * Client-side mirror of the server's executable-extension list. The server is
 * still authoritative; this only decides whether to offer a Run action.
 */
const EXTENSION_LANGUAGES: Array<[string, ExecutionLanguage]> = [
  ['.py', 'python'],
  ['.pyw', 'python'],
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.ts', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.c', 'c'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.cxx', 'cpp'],
  ['.java', 'java'],
];

export const EXECUTION_LANGUAGE_LABELS: Record<ExecutionLanguage, string> = {
  python: 'Python 3',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  c: 'C',
  cpp: 'C++',
  java: 'Java',
};

export const EXECUTION_STATUS_LABELS = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  TIMED_OUT: 'Timed out',
  CANCELLED: 'Cancelled',
} as const;

export function executionLanguageForFile(fileName: string): ExecutionLanguage | null {
  const lower = fileName.toLowerCase();
  for (const [extension, language] of EXTENSION_LANGUAGES) {
    if (lower.endsWith(extension)) return language;
  }
  return null;
}

export function isTerminalExecutionStatus(status: string): boolean {
  return status === 'COMPLETED'
    || status === 'FAILED'
    || status === 'TIMED_OUT'
    || status === 'CANCELLED';
}

/** Check if a file is an HTML file that can be previewed. */
export function isHtmlFile(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

export function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return '—';
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1_000).toFixed(2)} s`;
}
