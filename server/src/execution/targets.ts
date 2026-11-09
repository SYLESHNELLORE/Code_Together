import {
  EXECUTION_ENTRY_FILES,
  EXECUTION_LANGUAGES,
  type ExecutionEntryFile,
  type ExecutionLanguage,
} from './types.js';

const LANGUAGE_SET = new Set<string>(EXECUTION_LANGUAGES);

export function isExecutionLanguage(value: unknown): value is ExecutionLanguage {
  return typeof value === 'string' && LANGUAGE_SET.has(value);
}

/**
 * Map a stored project file to a fixed container entry name. The original file
 * name is never used as a filesystem path; only its TSX extension influences
 * which trusted entry name the sandbox receives.
 */
export function entryFileFor(
  language: ExecutionLanguage,
  fileName: string,
): ExecutionEntryFile {
  if (language === 'typescript' && fileName.toLowerCase().endsWith('.tsx')) {
    return EXECUTION_ENTRY_FILES.typescriptTsx;
  }
  return EXECUTION_ENTRY_FILES[language];
}
