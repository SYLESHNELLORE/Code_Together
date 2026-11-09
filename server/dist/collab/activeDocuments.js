/**
 * Process-wide registry of files that currently have a live collaboration
 * document. Kept separate from the Socket.IO server so HTTP routes can reject
 * conflicting REST content writes without importing the socket layer.
 */
const activeDocumentIds = new Set();
export function isDocumentActive(fileId) {
    return activeDocumentIds.has(fileId);
}
export function markDocumentActive(fileId) {
    activeDocumentIds.add(fileId);
}
export function markDocumentInactive(fileId) {
    activeDocumentIds.delete(fileId);
}
export function activeDocumentCount() {
    return activeDocumentIds.size;
}
