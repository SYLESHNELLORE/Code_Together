import * as Y from 'yjs';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma.js';

export const MAX_FILE_CONTENT_BYTES = 1_000_000;
/** Keep enough checkpoints for recovery without letting snapshots grow forever. */
export const MAX_SNAPSHOTS_PER_FILE = 25;

export interface PersistedDocument {
  updatedAt: string;
  version: number;
}

/** Build a throwaway Yjs document from plain text (used by REST content writes). */
export function documentFromContent(content: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText('content').insert(0, content);
  return doc;
}

function contentBytes(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

export function isContentWithinLimit(content: string): boolean {
  return contentBytes(content) <= MAX_FILE_CONTENT_BYTES;
}

async function nextSnapshotVersion(
  tx: Prisma.TransactionClient,
  fileId: string,
): Promise<number> {
  const latest = await tx.documentSnapshot.aggregate({
    where: { projectFileId: fileId },
    _max: { version: true },
  });
  return (latest._max.version ?? 0) + 1;
}

async function pruneSnapshots(tx: Prisma.TransactionClient, fileId: string): Promise<void> {
  const stale = await tx.documentSnapshot.findMany({
    where: { projectFileId: fileId },
    orderBy: { version: 'desc' },
    skip: MAX_SNAPSHOTS_PER_FILE,
    select: { id: true },
  });
  if (stale.length > 0) {
    await tx.documentSnapshot.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
  }
}

/**
 * Create a checkpoint for a REST content write. The snapshot and the content
 * update run in the caller's transaction so they can never disagree.
 */
export async function createContentSnapshot(
  tx: Prisma.TransactionClient,
  fileId: string,
  content: string,
  createdById: string | null,
): Promise<number> {
  const doc = documentFromContent(content);
  const state = Y.encodeStateAsUpdate(doc);
  const version = await nextSnapshotVersion(tx, fileId);

  await tx.documentSnapshot.create({
    data: {
      projectFileId: fileId,
      version,
      state: Buffer.from(state),
      createdById,
    },
  });
  await pruneSnapshots(tx, fileId);
  doc.destroy();
  return version;
}

/**
 * Persist the authoritative collaboration document. Content and the binary
 * Yjs checkpoint are written atomically, so a restart always reloads the same
 * CRDT history that produced the stored text.
 */
export async function persistCollaborativeDocument(
  fileId: string,
  content: string,
  state: Uint8Array,
  createdById: string | null,
): Promise<PersistedDocument> {
  if (!isContentWithinLimit(content)) {
    throw new Error('File content exceeds the 1,000,000-byte limit.');
  }

  return prisma.$transaction(async (tx) => {
    const version = await nextSnapshotVersion(tx, fileId);

    const updated = await tx.projectFile.update({
      where: { id: fileId },
      data: { content },
      select: { id: true, updatedAt: true },
    });

    await tx.documentSnapshot.create({
      data: {
        projectFileId: fileId,
        version,
        state: Buffer.from(state),
        createdById,
      },
    });
    await pruneSnapshots(tx, fileId);

    return { updatedAt: updated.updatedAt.toISOString(), version };
  });
}

/** Latest CRDT checkpoint for a file, or null when it has never collaborated. */
export async function loadLatestSnapshot(fileId: string): Promise<Uint8Array | null> {
  const snapshot = await prisma.documentSnapshot.findFirst({
    where: { projectFileId: fileId },
    orderBy: { version: 'desc' },
    select: { state: true },
  });
  return snapshot ? new Uint8Array(snapshot.state) : null;
}
