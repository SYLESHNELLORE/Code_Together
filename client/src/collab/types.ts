import type { ProjectRole } from '../api';

export type CollaborationPhase = 'joining' | 'ready' | 'error';
export type CollaborationConnection = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error';

export interface CollaboratorCursor {
  /** Base64-encoded Yjs RelativePosition for the selection anchor. */
  anchor: string;
  /** Base64-encoded Yjs RelativePosition for the selection head. */
  head: string;
}

export interface Collaborator {
  socketId: string;
  user: { id: string; username: string };
  colorIndex: number;
  cursor: CollaboratorCursor | null;
}

export interface CollaborationState {
  phase: CollaborationPhase;
  connection: CollaborationConnection;
  role: ProjectRole | null;
  /** True while the local CRDT contains edits the server has not persisted. */
  dirty: boolean;
  /** True while the server is writing content + snapshot to MySQL. */
  saving: boolean;
  saveError: string | null;
  loadError: string | null;
  lastSavedAt: string | null;
  collaborators: Collaborator[];
  /** True once the initial server state has been merged into the local doc. */
  synced: boolean;
}

export interface JoinAck {
  ok: boolean;
  error?: { code: string; message: string };
  role?: ProjectRole;
  file?: {
    id: string;
    name: string;
    path: string;
    language: string;
    updatedAt: string;
  };
  syncUpdate?: Uint8Array | number[];
  stateVector?: Uint8Array | number[];
  presence?: Collaborator[];
}

export interface SaveAck {
  ok: boolean;
  error?: string;
  updatedAt?: string;
  version?: number;
  stateVector?: Uint8Array | number[];
}

export interface CollaborationErrorPayload {
  fileId: string | null;
  code: string;
  message: string;
}

export function createInitialState(): CollaborationState {
  return {
    phase: 'joining',
    connection: 'connecting',
    role: null,
    dirty: false,
    saving: false,
    saveError: null,
    loadError: null,
    lastSavedAt: null,
    collaborators: [],
    synced: false,
  };
}
