import * as Y from 'yjs';
import { MAX_FILE_CONTENT_BYTES, persistCollaborativeDocument, } from './documentPersistence.js';
export const DOCUMENT_TEXT_KEY = 'content';
const SAVE_DEBOUNCE_MS = 650;
const PRESENCE_COLORS = 8;
function colorIndexFor(userId, socketId) {
    let hash = 0;
    const input = `${userId}:${socketId}`;
    for (let index = 0; index < input.length; index += 1) {
        hash = (hash * 31 + input.charCodeAt(index)) | 0;
    }
    return Math.abs(hash) % PRESENCE_COLORS;
}
/**
 * One authoritative Yjs document per open file. The server owns the CRDT and
 * persistence; clients exchange updates through Socket.IO.
 */
export class CollaborationDocument {
    doc;
    text;
    room;
    fileId;
    projectId;
    file;
    clients = new Map();
    saveTimer = null;
    queue = Promise.resolve({ ok: true });
    dirty = false;
    lastResult = { ok: true };
    lastEditorId = null;
    constructor(file, snapshot) {
        this.fileId = file.id;
        this.projectId = file.projectId;
        this.file = file;
        this.room = `file:${file.id}`;
        this.doc = new Y.Doc();
        this.text = this.doc.getText(DOCUMENT_TEXT_KEY);
        let loadedFromSnapshot = false;
        if (snapshot && snapshot.byteLength > 0) {
            try {
                Y.applyUpdate(this.doc, snapshot, 'snapshot');
                loadedFromSnapshot = true;
            }
            catch {
                // A corrupt checkpoint must not make the file unreadable.
                loadedFromSnapshot = false;
            }
        }
        if (!loadedFromSnapshot) {
            this.text.insert(0, file.content);
        }
    }
    get clientCount() {
        return this.clients.size;
    }
    get hasPendingChanges() {
        return this.dirty;
    }
    get content() {
        return this.text.toString();
    }
    addClient(socketId, role, user) {
        const client = {
            socketId,
            role,
            user,
            colorIndex: colorIndexFor(user.id, socketId),
            cursor: null,
            joinedAt: Date.now(),
        };
        this.clients.set(socketId, client);
        return this.toPresence(client);
    }
    removeClient(socketId) {
        return this.clients.delete(socketId);
    }
    getRole(socketId) {
        return this.clients.get(socketId)?.role ?? null;
    }
    setRole(socketId, role) {
        const client = this.clients.get(socketId);
        if (client)
            client.role = role;
    }
    setCursor(socketId, cursor) {
        const client = this.clients.get(socketId);
        if (client)
            client.cursor = cursor;
    }
    presence() {
        return [...this.clients.values()]
            .sort((left, right) => left.joinedAt - right.joinedAt || left.socketId.localeCompare(right.socketId))
            .map((client) => this.toPresence(client));
    }
    toPresence(client) {
        return {
            socketId: client.socketId,
            user: client.user,
            colorIndex: client.colorIndex,
            cursor: client.cursor,
        };
    }
    /** Apply a client update. Yjs updates are idempotent, so duplicates are safe. */
    applyUpdate(update, editorId) {
        Y.applyUpdate(this.doc, update, 'collab');
        this.lastEditorId = editorId;
        this.markDirty();
    }
    /**
     * Reject an update that would push the document over the same 1 MB limit as
     * the REST API. The common case is cheap; only updates near the limit are
     * replayed against a temporary document to measure the resulting UTF-8 size.
     */
    wouldExceedContentLimit(update) {
        const currentBytes = Buffer.byteLength(this.content, 'utf8');
        if (currentBytes + update.byteLength <= MAX_FILE_CONTENT_BYTES)
            return false;
        const probe = new Y.Doc();
        try {
            Y.applyUpdate(probe, Y.encodeStateAsUpdate(this.doc), 'probe');
            Y.applyUpdate(probe, update, 'probe');
            return Buffer.byteLength(probe.getText(DOCUMENT_TEXT_KEY).toString(), 'utf8') > MAX_FILE_CONTENT_BYTES;
        }
        catch {
            // Let the real apply report an invalid update.
            return false;
        }
        finally {
            probe.destroy();
        }
    }
    markDirty() {
        this.dirty = true;
    }
    schedulePersist(io) {
        this.dirty = true;
        io.to(this.room).emit('collab:saving', { fileId: this.fileId });
        if (this.saveTimer)
            clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.flush(io);
        }, SAVE_DEBOUNCE_MS);
        this.saveTimer.unref?.();
    }
    /** Persist the current document state, serialising concurrent requests. */
    flush(io) {
        const run = this.queue.then(() => this.writeIfDirty(io));
        this.queue = run.catch(() => ({ ok: false }));
        return run;
    }
    async writeIfDirty(io) {
        if (!this.dirty)
            return this.lastResult;
        this.dirty = false;
        const content = this.content;
        const state = Y.encodeStateAsUpdate(this.doc);
        const stateVector = Y.encodeStateVector(this.doc);
        try {
            const persisted = await persistCollaborativeDocument(this.fileId, content, state, this.lastEditorId);
            this.file = { ...this.file, content, updatedAt: new Date(persisted.updatedAt) };
            this.lastResult = {
                ok: true,
                updatedAt: persisted.updatedAt,
                version: persisted.version,
                stateVector,
            };
            io.to(this.room).emit('collab:saved', {
                fileId: this.fileId,
                updatedAt: persisted.updatedAt,
                version: persisted.version,
                stateVector,
            });
            return this.lastResult;
        }
        catch (error) {
            this.dirty = true;
            const message = error instanceof Error ? error.message : 'The document could not be saved.';
            this.lastResult = { ok: false, error: message };
            io.to(this.room).emit('collab:save-error', { fileId: this.fileId, message });
            return this.lastResult;
        }
    }
    clearTimer() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
    }
    /** Persist and release CRDT resources. */
    async dispose(io) {
        this.clearTimer();
        await this.flush(io);
        this.doc.destroy();
    }
}
