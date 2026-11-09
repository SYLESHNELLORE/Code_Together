import * as Y from 'yjs';
import type { Server, Socket } from 'socket.io';
import { applySocketAuthentication } from '../auth/socket.js';
import { ROLE_RANK, resolveProjectAccess } from '../middleware/projectAccess.js';
import { prisma } from '../db/prisma.js';
import {
  CollaborationDocument,
  type DocumentFileMetadata,
} from './CollaborationDocument.js';
import { loadLatestSnapshot } from './documentPersistence.js';
import {
  activeDocumentCount,
  isDocumentActive,
  markDocumentActive,
  markDocumentInactive,
} from './activeDocuments.js';
import type {
  CollaboratorCursor,
  JoinResult,
  SaveResult,
  SocketAuthData,
} from './types.js';

const documentMap = new Map<string, CollaborationDocument>();
const pendingDocuments = new Map<string, Promise<CollaborationDocument | null>>();
const joinedDocuments = new WeakMap<Socket, Map<string, CollaborationDocument>>();
const authorizationChecks = new WeakMap<Socket, Map<string, number>>();
const updateCounters = new WeakMap<Socket, { count: number; resetAt: number }>();
const cleanupTimers = new Map<string, NodeJS.Timeout>();

const CLEANUP_DELAY_MS = 12_000;
const ROLE_RECHECK_MS = 15_000;
const MAX_UPDATE_BYTES = 1_500_000;
const UPDATE_RATE_WINDOW_MS = 10_000;
const MAX_UPDATES_PER_WINDOW = 1_200;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/=_-]{1,1024}$/;

let attachedServer: Server | null = null;

function authData(socket: Socket): SocketAuthData | null {
  return (socket.data as Partial<SocketAuthData>).user ? socket.data as SocketAuthData : null;
}

function joinedFor(socket: Socket): Map<string, CollaborationDocument> {
  let map = joinedDocuments.get(socket);
  if (!map) {
    map = new Map();
    joinedDocuments.set(socket, map);
  }
  return map;
}

function checkedAtFor(socket: Socket): Map<string, number> {
  let map = authorizationChecks.get(socket);
  if (!map) {
    map = new Map();
    authorizationChecks.set(socket, map);
  }
  return map;
}

function respond(ack: unknown, payload: unknown): void {
  if (typeof ack === 'function') {
    (ack as (value: unknown) => void)(payload);
  }
}

function emitError(socket: Socket, fileId: string | null, code: string, message: string): void {
  socket.emit('collab:error', { fileId, code, message });
}

function expireSocket(socket: Socket): boolean {
  const auth = authData(socket);
  if (!auth) {
    emitError(socket, null, 'UNAUTHENTICATED', 'Please sign in to collaborate.');
    socket.disconnect(true);
    return true;
  }
  if (auth.sessionExpiresAt <= Date.now()) {
    emitError(socket, null, 'SESSION_EXPIRED', 'Your session expired. Please sign in again.');
    socket.disconnect(true);
    return true;
  }
  return false;
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(value as number[]);
  }
  return null;
}

function parseCursor(value: unknown): CollaboratorCursor | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'object' || !value) return undefined;
  const anchor = (value as { anchor?: unknown }).anchor;
  const head = (value as { head?: unknown }).head;
  if (typeof anchor !== 'string' || typeof head !== 'string') return undefined;
  if (!BASE64_PATTERN.test(anchor) || !BASE64_PATTERN.test(head)) return undefined;
  return { anchor, head };
}

function takeUpdateBudget(socket: Socket): boolean {
  const now = Date.now();
  const current = updateCounters.get(socket);
  if (!current || current.resetAt <= now) {
    updateCounters.set(socket, { count: 1, resetAt: now + UPDATE_RATE_WINDOW_MS });
    return true;
  }
  if (current.count >= MAX_UPDATES_PER_WINDOW) return false;
  current.count += 1;
  return true;
}

async function loadDocumentMetadata(projectId: string, fileId: string): Promise<DocumentFileMetadata | null> {
  const file = await prisma.projectFile.findFirst({
    where: { id: fileId, projectId, isFolder: false },
    select: {
      id: true,
      projectId: true,
      name: true,
      path: true,
      language: true,
      content: true,
      updatedAt: true,
    },
  });
  return file;
}

async function getOrCreateDocument(
  projectId: string,
  fileId: string,
): Promise<CollaborationDocument | null> {
  const existing = documentMap.get(fileId);
  if (existing) return existing;

  const pending = pendingDocuments.get(fileId);
  if (pending) return pending;

  const creation = (async () => {
    const metadata = await loadDocumentMetadata(projectId, fileId);
    if (!metadata) return null;

    const snapshot = await loadLatestSnapshot(fileId);
    const document = new CollaborationDocument(metadata, snapshot);

    // Another join may have completed while this one awaited the database.
    const raced = documentMap.get(fileId);
    if (raced) {
      document.doc.destroy();
      return raced;
    }

    documentMap.set(fileId, document);
    markDocumentActive(fileId);
    return document;
  })();

  pendingDocuments.set(fileId, creation);
  try {
    return await creation;
  } finally {
    pendingDocuments.delete(fileId);
  }
}

async function ensureMembership(
  socket: Socket,
  document: CollaborationDocument,
): Promise<boolean> {
  if (expireSocket(socket)) return false;

  const checks = checkedAtFor(socket);
  const lastCheck = checks.get(document.fileId) ?? 0;
  if (Date.now() - lastCheck < ROLE_RECHECK_MS) return true;

  const auth = authData(socket);
  if (!auth) return false;

  const access = await resolveProjectAccess(auth.user.id, document.projectId);
  if (!access) {
    checks.delete(document.fileId);
    emitError(socket, document.fileId, 'NOT_FOUND', 'You no longer have access to this project.');
    joinedFor(socket).delete(document.fileId);
    document.removeClient(socket.id);
    await socket.leave(document.room);
    const io = attachedServer;
    if (io) {
      io.to(document.room).emit('collab:presence', {
        fileId: document.fileId,
        presence: document.presence(),
      });
      if (document.clientCount === 0) {
        void document.flush(io);
        scheduleCleanup(document.fileId);
      }
    }
    return false;
  }

  document.setRole(socket.id, access.role);
  checks.set(document.fileId, Date.now());
  return true;
}

async function ensureWriteAuthorization(
  socket: Socket,
  document: CollaborationDocument,
): Promise<boolean> {
  if (!(await ensureMembership(socket, document))) return false;

  const role = document.getRole(socket.id);
  if (!role || ROLE_RANK[role] < ROLE_RANK.EDITOR) {
    emitError(socket, document.fileId, 'FORBIDDEN', 'Viewers cannot modify this document.');
    return false;
  }
  return true;
}

function scheduleCleanup(fileId: string): void {
  if (cleanupTimers.has(fileId)) return;

  const timer = setTimeout(() => {
    cleanupTimers.delete(fileId);
    const document = documentMap.get(fileId);
    if (!document || document.clientCount > 0) return;

    void (async () => {
      const io = attachedServer;
      if (!io) return;
      const result = await document.flush(io);
      if (!result.ok) {
        // Keep the authoritative CRDT in memory and retry rather than losing
        // edits when MySQL is temporarily unavailable.
        scheduleCleanup(fileId);
        return;
      }
      if (document.clientCount > 0) return;
      documentMap.delete(fileId);
      markDocumentInactive(fileId);
      document.clearTimer();
      document.doc.destroy();
    })();
  }, CLEANUP_DELAY_MS);
  timer.unref?.();
  cleanupTimers.set(fileId, timer);
}

function cancelCleanup(fileId: string): void {
  const timer = cleanupTimers.get(fileId);
  if (timer) {
    clearTimeout(timer);
    cleanupTimers.delete(fileId);
  }
}

async function handleJoin(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
  if (expireSocket(socket)) return;

  const data = payload as { projectId?: unknown; fileId?: unknown } | null;
  const projectId = typeof data?.projectId === 'string' ? data.projectId : '';
  const fileId = typeof data?.fileId === 'string' ? data.fileId : '';
  if (!UUID_PATTERN.test(projectId) || !UUID_PATTERN.test(fileId)) {
    respond(ack, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid project or file ID.' } } satisfies JoinResult);
    return;
  }

  const auth = authData(socket);
  if (!auth) return;

  const access = await resolveProjectAccess(auth.user.id, projectId);
  if (!access) {
    respond(ack, {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Project or file not found.' },
    } satisfies JoinResult);
    return;
  }

  const document = await getOrCreateDocument(projectId, fileId);
  if (!document) {
    respond(ack, {
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Project or file not found.' },
    } satisfies JoinResult);
    return;
  }

  cancelCleanup(fileId);
  await socket.join(document.room);
  joinedFor(socket).set(fileId, document);
  checkedAtFor(socket).set(fileId, Date.now());

  const presence = document.addClient(socket.id, access.role, auth.user);

  const result: JoinResult = {
    ok: true,
    role: access.role,
    file: {
      id: document.file.id,
      name: document.file.name,
      path: document.file.path,
      language: document.file.language,
      updatedAt: document.file.updatedAt.toISOString(),
    },
    syncUpdate: Y.encodeStateAsUpdate(document.doc),
    stateVector: Y.encodeStateVector(document.doc),
    presence: document.presence(),
  };
  respond(ack, result);

  socket.to(document.room).emit('collab:presence', {
    fileId,
    presence: document.presence(),
  });
}

async function handleUpdate(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
  if (expireSocket(socket)) return;

  const data = payload as { fileId?: unknown; update?: unknown } | null;
  const fileId = typeof data?.fileId === 'string' ? data.fileId : '';
  const document = joinedFor(socket).get(fileId);
  if (!document) {
    respond(ack, { ok: false, error: { code: 'NOT_JOINED', message: 'Join the document before sending updates.' } });
    return;
  }

  if (!takeUpdateBudget(socket)) {
    emitError(socket, fileId, 'RATE_LIMITED', 'Too many collaboration updates. Please slow down.');
    respond(ack, { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many updates.' } });
    return;
  }

  const update = toBytes(data?.update);
  if (!update || update.byteLength === 0 || update.byteLength > MAX_UPDATE_BYTES) {
    respond(ack, { ok: false, error: { code: 'VALIDATION_ERROR', message: 'Invalid collaboration update.' } });
    return;
  }

  if (!(await ensureWriteAuthorization(socket, document))) {
    respond(ack, { ok: false, error: { code: 'FORBIDDEN', message: 'You cannot modify this document.' } });
    return;
  }

  if (document.wouldExceedContentLimit(update)) {
    emitError(socket, fileId, 'FILE_TOO_LARGE', 'This document exceeds the 1,000,000-byte file limit.');
    respond(ack, {
      ok: false,
      error: { code: 'FILE_TOO_LARGE', message: 'This document exceeds the 1,000,000-byte file limit.' },
    });
    return;
  }

  try {
    document.applyUpdate(update, authData(socket)?.user.id ?? 'unknown');
  } catch {
    respond(ack, { ok: false, error: { code: 'INVALID_UPDATE', message: 'The collaboration update was rejected.' } });
    return;
  }

  socket.to(document.room).emit('collab:update', { fileId, update });
  document.schedulePersist(attachedServer!);
  respond(ack, { ok: true });
}

async function handlePresence(socket: Socket, payload: unknown): Promise<void> {
  if (expireSocket(socket)) return;

  const data = payload as { fileId?: unknown; cursor?: unknown } | null;
  const fileId = typeof data?.fileId === 'string' ? data.fileId : '';
  const document = joinedFor(socket).get(fileId);
  if (!document) return;

  const cursor = parseCursor(data?.cursor);
  if (cursor === undefined) return;

  // Presence is low-risk but still check membership periodically so a removed
  // member cannot keep broadcasting a cursor or observing collaborators.
  if (!(await ensureMembership(socket, document))) return;

  document.setCursor(socket.id, cursor);
  attachedServer?.to(document.room).emit('collab:presence', {
    fileId,
    presence: document.presence(),
  });
}

async function handleFlush(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
  if (expireSocket(socket)) return;

  const data = payload as { fileId?: unknown } | null;
  const fileId = typeof data?.fileId === 'string' ? data.fileId : '';
  const document = joinedFor(socket).get(fileId);
  if (!document || !attachedServer) {
    respond(ack, { ok: false, error: 'Join the document before saving.' } satisfies SaveResult);
    return;
  }

  // Persisting is a write: revalidate membership and editor access first.
  if (!(await ensureWriteAuthorization(socket, document))) {
    respond(ack, { ok: false, error: 'You no longer have permission to save this document.' } satisfies SaveResult);
    return;
  }

  const result = await document.flush(attachedServer);
  respond(ack, result);
}

async function leaveDocument(socket: Socket, fileId: string, immediate = false): Promise<boolean> {
  const document = joinedFor(socket).get(fileId);
  if (!document) return true;

  joinedFor(socket).delete(fileId);
  checkedAtFor(socket).delete(fileId);
  document.removeClient(socket.id);
  await socket.leave(document.room);

  const io = attachedServer;
  if (io) {
    io.to(document.room).emit('collab:presence', {
      fileId,
      presence: document.presence(),
    });
    if (document.clientCount === 0) {
      if (immediate) {
        // Explicit leave (tab close, delete, sign-out) must release the room
        // and the REST "document active" lock before the client is told it is
        // safe to mutate the file. A concurrent join keeps the document alive.
        cancelCleanup(fileId);
        const result = await document.flush(io);
        if (!result.ok) {
          // Do not destroy unsaved CRDT state or release the REST lock after a
          // persistence failure; retry in the background.
          scheduleCleanup(fileId);
          return false;
        }
        if (document.clientCount === 0 && documentMap.get(fileId) === document) {
          documentMap.delete(fileId);
          markDocumentInactive(fileId);
          document.clearTimer();
          document.doc.destroy();
        }
      } else {
        // A dropped socket may be a short network blip, so keep the CRDT warm
        // for a while before persisting and releasing it.
        void document.flush(io);
        scheduleCleanup(fileId);
      }
    }
  }
  return true;
}

async function handleLeave(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
  const data = payload as { fileId?: unknown } | null;
  const fileId = typeof data?.fileId === 'string' ? data.fileId : '';
  if (!fileId) {
    respond(ack, { ok: false });
    return;
  }
  const released = await leaveDocument(socket, fileId, true);
  respond(ack, { ok: released });
}

/**
 * Attach authenticated collaboration handlers to an existing Socket.IO server.
 * Socket identity always comes from the same hashed MySQL session token used by
 * the HTTP API, sent in the per-tab Socket.IO handshake `auth` payload; clients
 * cannot assert a user ID.
 */
export function attachCollaboration(io: Server): void {
  attachedServer = io;

  applySocketAuthentication(io);

  io.on('connection', (socket) => {
    socket.on('collab:join', (payload: unknown, ack: unknown) => {
      void handleJoin(socket, payload, ack).catch(() => {
        respond(ack, { ok: false, error: { code: 'SERVER_ERROR', message: 'Unable to join the document.' } });
      });
    });

    socket.on('collab:update', (payload: unknown, ack: unknown) => {
      void handleUpdate(socket, payload, ack).catch(() => {
        respond(ack, { ok: false, error: { code: 'SERVER_ERROR', message: 'Unable to apply the update.' } });
      });
    });

    socket.on('collab:presence', (payload: unknown) => {
      void handlePresence(socket, payload).catch(() => undefined);
    });

    socket.on('collab:flush', (payload: unknown, ack: unknown) => {
      void handleFlush(socket, payload, ack).catch(() => {
        respond(ack, { ok: false, error: 'Unable to save the document.' } satisfies SaveResult);
      });
    });

    socket.on('collab:leave', (payload: unknown, ack: unknown) => {
      void handleLeave(socket, payload, ack).catch(() => respond(ack, { ok: false }));
    });

    socket.on('disconnect', () => {
      const documents = joinedFor(socket);
      const fileIds = [...documents.keys()];
      for (const fileId of fileIds) {
        void leaveDocument(socket, fileId);
      }
    });
  });
}

/** Flush every live document before process shutdown. */
export async function shutdownCollaboration(): Promise<void> {
  for (const timer of cleanupTimers.values()) clearTimeout(timer);
  cleanupTimers.clear();

  const io = attachedServer;
  if (io) {
    await Promise.all([...documentMap.values()].map((document) => document.flush(io)));
  }

  for (const document of documentMap.values()) {
    document.clearTimer();
    document.doc.destroy();
    markDocumentInactive(document.fileId);
  }
  documentMap.clear();
  attachedServer = null;
}

export function liveDocumentCount(): number {
  return documentMap.size;
}

export function liveActiveDocumentCount(): number {
  return activeDocumentCount();
}
