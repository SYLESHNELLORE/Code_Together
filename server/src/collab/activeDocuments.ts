/**
 * Process-wide registry of files that currently have a live collaboration
 * document. Kept separate from the Socket.IO server so HTTP routes can reject
 * conflicting REST content writes without importing the socket layer.
 */
const activeDocumentIds = new Set<string>();

export function isDocumentActive(fileId: string): boolean {
  return activeDocumentIds.has(fileId);
}

export function markDocumentActive(fileId: string): void {
  activeDocumentIds.add(fileId);
}

export function markDocumentInactive(fileId: string): void {
  activeDocumentIds.delete(fileId);
}

export function activeDocumentCount(): number {
  return activeDocumentIds.size;
}
