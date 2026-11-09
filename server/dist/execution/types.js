/** Languages the sandbox image is built to run. */
export const EXECUTION_LANGUAGES = [
    'python',
    'javascript',
    'typescript',
    'c',
    'cpp',
    'java',
];
export const EXECUTION_LANGUAGE_LABELS = {
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
};
