import type { ProjectRole } from '@prisma/client';
import type { SocketAuthData, SocketUser } from '../auth/socket.js';

export type { SocketAuthData, SocketUser };

export interface CollaboratorCursor {
  /** Base64-encoded Yjs RelativePosition for the selection anchor. */
  anchor: string;
  /** Base64-encoded Yjs RelativePosition for the selection head. */
  head: string;
}

export interface CollaboratorPresence {
  socketId: string;
  user: { id: string; username: string };
  colorIndex: number;
  cursor: CollaboratorCursor | null;
}

export interface CollaborationError {
  code: string;
  message: string;
}

export interface JoinResult {
  ok: boolean;
  error?: CollaborationError;
  role?: ProjectRole;
  file?: {
    id: string;
    name: string;
    path: string;
    language: string;
    updatedAt: string;
  };
  /** Full state update the client applies to an empty local document. */
  syncUpdate?: Uint8Array;
  /** Server state vector; the client replies with its missing updates. */
  stateVector?: Uint8Array;
  presence?: CollaboratorPresence[];
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  updatedAt?: string;
  version?: number;
  stateVector?: Uint8Array;
}

