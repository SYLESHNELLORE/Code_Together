import * as Y from 'yjs';
import { io, type Socket } from 'socket.io-client';
import { getAuthToken, type ProjectRole } from '../api';
import {
  createInitialState,
  type CollaborationState,
  type CollaborationErrorPayload,
  type Collaborator,
  type CollaboratorCursor,
  type JoinAck,
  type SaveAck,
} from './types';

/** Origins let the local binding and the socket layer tell their updates apart. */
export const LOCAL_ORIGIN = Symbol('codetogether-local');
export const REMOTE_ORIGIN = Symbol('codetogether-remote');
export const DOCUMENT_TEXT_KEY = 'content';

const PRESENCE_THROTTLE_MS = 70;
const JOIN_TIMEOUT_MS = 10_000;
const FLUSH_TIMEOUT_MS = 15_000;
const LEAVE_TIMEOUT_MS = 8_000;

function socketOrigin(): string {
  const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
  try {
    return new URL(apiBase, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}

export function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
    return Uint8Array.from(value as number[]);
  }
  return null;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return window.btoa(binary);
}

export function decodeBase64(value: string): Uint8Array | null {
  try {
    const binary = window.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

export interface YjsProviderOptions {
  projectId: string;
  fileId: string;
  onState: (state: CollaborationState) => void;
}

/**
 * A Socket.IO transport for a single Yjs document. It deliberately does not use
 * y-websocket or y-protocols: the server exposes a small, authenticated event
 * API instead of the generic Yjs websocket protocol.
 */
let providerCounter = 0;

export class YjsSocketProvider {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  readonly fileId: string;
  readonly projectId: string;
  /** Distinguishes provider instances so React can remount Monaco on rejoin. */
  readonly instanceId: number = ++providerCounter;

  private readonly socket: Socket;
  private readonly onState: (state: CollaborationState) => void;
  private state: CollaborationState = createInitialState();
  private cursor: CollaboratorCursor | null = null;
  private cursorTimer: number | null = null;
  private retryTimer: number | null = null;
  private destroyed = false;
  private closing = false;

  constructor(options: YjsProviderOptions) {
    this.projectId = options.projectId;
    this.fileId = options.fileId;
    this.onState = options.onState;
    this.doc = new Y.Doc();
    this.text = this.doc.getText(DOCUMENT_TEXT_KEY);

    this.socket = io(socketOrigin(), {
      // Each tab authenticates its own socket with its own session token.
      auth: (cb) => cb({ token: getAuthToken() ?? '' }),
      withCredentials: false,
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 400,
      reconnectionDelayMax: 5_000,
    });

    this.socket.on('connect', this.handleConnect);
    this.socket.on('disconnect', this.handleDisconnect);
    this.socket.on('connect_error', this.handleConnectError);
    this.socket.on('collab:update', this.handleRemoteUpdate);
    this.socket.on('collab:presence', this.handlePresence);
    this.socket.on('collab:saving', this.handleSaving);
    this.socket.on('collab:saved', this.handleSaved);
    this.socket.on('collab:save-error', this.handleSaveError);
    this.socket.on('collab:error', this.handleCollaborationError);

    this.doc.on('update', this.handleDocUpdate);

    this.socket.connect();
  }

  getState(): CollaborationState {
    return {
      ...this.state,
      collaborators: this.state.collaborators,
    };
  }

  getSocketId(): string | null {
    return this.socket.id ?? null;
  }

  /** Send the local selection to the room, throttled to keep presence light. */
  setCursor(cursor: CollaboratorCursor | null): void {
    this.cursor = cursor;
    if (cursor === null) {
      this.sendPresenceNow();
      return;
    }
    if (this.cursorTimer !== null) return;
    this.cursorTimer = window.setTimeout(() => {
      this.cursorTimer = null;
      this.sendPresenceNow();
    }, PRESENCE_THROTTLE_MS);
  }

  /** Persist the current document immediately (Ctrl+S, tab close, sign-out). */
  async flush(): Promise<boolean> {
    if (this.destroyed) return false;
    if (!this.state.dirty && !this.state.saving) return true;

    if (!this.socket.connected || !this.state.synced) {
      this.update({
        saving: false,
        saveError: 'You are offline. Your edits stay in this tab and will sync when the connection returns.',
      });
      return false;
    }

    this.update({ saving: true, saveError: null });
    const result = await this.emitWithAck<SaveAck>('collab:flush', { fileId: this.fileId }, FLUSH_TIMEOUT_MS);
    if (this.destroyed) return false;

    if (!result) {
      this.update({
        saving: false,
        saveError: 'The save request timed out. Retry when the connection is stable.',
      });
      return false;
    }

    if (!result.ok) {
      this.update({
        saving: false,
        saveError: result.error ?? 'The document could not be saved.',
      });
      return false;
    }

    const savedVector = toBytes(result.stateVector);
    const currentVector = Y.encodeStateVector(this.doc);
    const fullySaved = !savedVector || bytesEqual(savedVector, currentVector);

    this.update({
      saving: false,
      saveError: null,
      lastSavedAt: result.updatedAt ?? this.state.lastSavedAt,
      dirty: fullySaved ? false : this.state.dirty,
    });
    return true;
  }

  /** Rejoin after an error or a connection loss. Yjs updates are idempotent. */
  retry(): void {
    if (this.destroyed) return;
    if (!this.socket.connected) {
      this.update({ connection: 'connecting', loadError: null, saveError: null });
      this.socket.connect();
      return;
    }
    void this.join();
  }

  /** Leave the room and release the local document. */
  async dispose(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.closing = true;

    if (this.cursorTimer !== null) {
      window.clearTimeout(this.cursorTimer);
      this.cursorTimer = null;
    }
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    if (this.socket.connected && this.state.synced) {
      // The server flushes the document before acknowledging an explicit leave,
      // which also releases the "active document" lock for REST mutations.
      await this.emitWithAck('collab:leave', { fileId: this.fileId }, LEAVE_TIMEOUT_MS);
    }

    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.doc.off('update', this.handleDocUpdate);
    this.doc.destroy();
  }

  private snapshot(patch: Partial<CollaborationState>): CollaborationState {
    return { ...this.state, ...patch };
  }

  private update(patch: Partial<CollaborationState>): void {
    if (this.destroyed) return;
    this.state = this.snapshot(patch);
    this.onState(this.getState());
  }

  private handleConnect = (): void => {
    if (this.destroyed) return;
    this.update({ connection: 'connected', loadError: null });
    void this.join();
  };

  private handleDisconnect = (reason: string): void => {
    if (this.destroyed || this.closing) return;
    this.update({
      connection: reason === 'io client disconnect' ? 'offline' : 'reconnecting',
      synced: false,
      saving: false,
    });
  };

  private handleConnectError = (error: Error): void => {
    if (this.destroyed) return;
    const message = error.message || 'Unable to reach the collaboration server.';
    const fatal = message.includes('UNAUTHENTICATED') || message.includes('SESSION_EXPIRED') || message.includes('INVALID_ORIGIN');
    if (fatal) {
      this.socket.disconnect();
      this.update({
        phase: 'error',
        connection: 'error',
        synced: false,
        loadError: message.includes('SESSION_EXPIRED')
          ? 'Your session expired. Sign in again to collaborate.'
          : 'You are not authorized to collaborate on this file.',
      });
      return;
    }
    this.update({
      connection: 'reconnecting',
      loadError: this.state.synced ? this.state.loadError : 'Connection lost. Reconnecting…',
    });
  };

  private async join(): Promise<void> {
    if (this.destroyed || !this.socket.connected) return;

    this.update({ phase: this.state.synced ? 'ready' : 'joining', loadError: null });
    const result = await this.emitWithAck<JoinAck>(
      'collab:join',
      { projectId: this.projectId, fileId: this.fileId },
      JOIN_TIMEOUT_MS,
    );

    if (this.destroyed || !this.socket.connected) return;

    if (!result) {
      this.update({
        phase: 'error',
        synced: false,
        loadError: 'The collaboration server did not respond. Retrying…',
      });
      this.scheduleRetry();
      return;
    }

    if (!result.ok) {
      this.update({
        phase: 'error',
        synced: false,
        loadError: result.error?.message ?? 'Unable to join this document.',
      });
      return;
    }

    const syncUpdate = toBytes(result.syncUpdate);
    if (syncUpdate) {
      // Applying the server state before sending our diff preserves any local
      // edits made during a reconnect without duplicating existing content.
      Y.applyUpdate(this.doc, syncUpdate, REMOTE_ORIGIN);
    }

    const serverVector = toBytes(result.stateVector);
    if (serverVector) {
      const missing = Y.encodeStateAsUpdate(this.doc, serverVector);
      if (missing.byteLength > 0) {
        this.socket.emit('collab:update', { fileId: this.fileId, update: missing });
      }
    }

    this.update({
      phase: 'ready',
      connection: 'connected',
      role: result.role ?? this.state.role,
      synced: true,
      loadError: null,
      collaborators: result.presence ?? this.state.collaborators,
    });
    this.sendPresenceNow();
  }

  private scheduleRetry(): void {
    if (this.retryTimer !== null || this.destroyed) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (this.socket.connected) void this.join();
    }, 2_000);
  }

  private handleDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (this.destroyed || origin === REMOTE_ORIGIN) return;

    this.update({ dirty: true, saveError: null });

    // Updates sent before the initial join completes are recovered by the
    // state-vector diff in join(), so only transmit once the room is ready.
    if (this.socket.connected && this.state.synced) {
      this.socket.emit(
        'collab:update',
        { fileId: this.fileId, update },
        (ack: { ok?: boolean; error?: { message?: string } } | undefined) => {
          if (this.destroyed) return;
          if (ack && ack.ok === false) {
            this.update({
              saveError: ack.error?.message ?? 'The server rejected an edit. Reconnecting may help.',
            });
          }
        },
      );
    }
  };

  private handleRemoteUpdate = (payload: { fileId?: unknown; update?: unknown } | null): void => {
    if (this.destroyed || !payload || payload.fileId !== this.fileId) return;
    const update = toBytes(payload.update);
    if (!update) return;
    Y.applyUpdate(this.doc, update, REMOTE_ORIGIN);
  };

  private handlePresence = (payload: { fileId?: unknown; presence?: unknown } | null): void => {
    if (this.destroyed || !payload || payload.fileId !== this.fileId) return;
    const presence = Array.isArray(payload.presence)
      ? payload.presence as Collaborator[]
      : this.state.collaborators;
    this.update({ collaborators: presence });
  };

  private handleSaving = (payload: { fileId?: unknown } | null): void => {
    if (this.destroyed || !payload || payload.fileId !== this.fileId) return;
    this.update({ saving: true, saveError: null });
  };

  private handleSaved = (payload: {
    fileId?: unknown;
    updatedAt?: unknown;
    stateVector?: unknown;
  } | null): void => {
    if (this.destroyed || !payload || payload.fileId !== this.fileId) return;
    const savedVector = toBytes(payload.stateVector);
    const fullySaved = !savedVector || bytesEqual(savedVector, Y.encodeStateVector(this.doc));
    this.update({
      saving: false,
      saveError: null,
      lastSavedAt: typeof payload.updatedAt === 'string' ? payload.updatedAt : this.state.lastSavedAt,
      dirty: fullySaved ? false : this.state.dirty,
    });
  };

  private handleSaveError = (payload: { fileId?: unknown; message?: unknown } | null): void => {
    if (this.destroyed || !payload || payload.fileId !== this.fileId) return;
    this.update({
      saving: false,
      dirty: true,
      saveError: typeof payload.message === 'string'
        ? payload.message
        : 'The document could not be saved to MySQL.',
    });
  };

  private handleCollaborationError = (payload: CollaborationErrorPayload | null): void => {
    if (this.destroyed || !payload) return;
    if (payload.fileId && payload.fileId !== this.fileId) return;

    const fatal = payload.code === 'NOT_FOUND'
      || payload.code === 'UNAUTHENTICATED'
      || payload.code === 'SESSION_EXPIRED';

    this.update({
      ...(fatal ? { phase: 'error' as const, loadError: payload.message } : {}),
      ...(payload.code === 'FORBIDDEN' ? { saveError: payload.message } : {}),
    });
  };

  private sendPresenceNow(): void {
    if (this.destroyed || !this.socket.connected || !this.state.synced) return;
    this.socket.emit('collab:presence', { fileId: this.fileId, cursor: this.cursor });
  }

  private emitWithAck<T>(event: string, payload: unknown, timeoutMs: number): Promise<T | null> {
    return new Promise((resolve) => {
      if (!this.socket.connected) {
        resolve(null);
        return;
      }

      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve(null);
      }, timeoutMs);

      this.socket.emit(event, payload, (response: T) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(response ?? null);
      });
    });
  }
}

export type { ProjectRole };
