import * as Y from 'yjs';
import type * as Monaco from 'monaco-editor';
import { LOCAL_ORIGIN, decodeBase64, encodeBase64 } from './YjsSocketProvider';
import type { Collaborator, CollaboratorCursor } from './types';

export const COLLAB_COLORS = [
  '#f1b96d',
  '#8ad4ff',
  '#a6e3a1',
  '#f38ba8',
  '#cba6f7',
  '#94e2d5',
  '#fab387',
  '#f9e2af',
] as const;

export interface MonacoBinding {
  refresh(): void;
  dispose(): void;
}

interface BindingOptions {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof import('monaco-editor');
  doc: Y.Doc;
  text: Y.Text;
  getCollaborators: () => Collaborator[];
  ownSocketId: string | null;
  onCursor: (cursor: CollaboratorCursor | null) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sharedDiff(current: string, next: string) {
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) {
    start += 1;
  }

  let currentEnd = current.length;
  let nextEnd = next.length;
  while (currentEnd > start && nextEnd > start && current[currentEnd - 1] === next[nextEnd - 1]) {
    currentEnd -= 1;
    nextEnd -= 1;
  }

  return { start, currentEnd, nextEnd };
}

/**
 * Two-way binding between a Monaco model and a Y.Text. Local edits are turned
 * into minimal Yjs insert/delete operations so concurrent typing still merges
 * as a CRDT, while remote updates are applied to the model without feeding
 * them back to the document.
 */
export function bindMonacoToYjs(options: BindingOptions): MonacoBinding {
  const { editor, monaco, doc, text, getCollaborators, ownSocketId, onCursor } = options;
  const model = editor.getModel();
  if (!model) {
    return { refresh: () => undefined, dispose: () => undefined };
  }

  let applyingRemote = false;
  let disposed = false;

  const initial = text.toString();
  if (model.getValue() !== initial) {
    model.setValue(initial);
  }

  const selectionFor = (start: number, end: number) => {
    const startPosition = model.getPositionAt(start);
    const endPosition = model.getPositionAt(end);
    return new monaco.Range(
      startPosition.lineNumber,
      startPosition.column,
      endPosition.lineNumber,
      endPosition.column,
    );
  };

  const applyTextToModel = (next: string) => {
    const current = model.getValue();
    if (current === next) return;

    const { start, currentEnd, nextEnd } = sharedDiff(current, next);
    applyingRemote = true;
    try {
      model.pushEditOperations(
        [],
        [{
          range: selectionFor(start, currentEnd),
          text: next.slice(start, nextEnd),
          forceMoveMarkers: true,
        }],
        () => null,
      );
    } finally {
      applyingRemote = false;
    }
  };

  const decorations = editor.createDecorationsCollection([]);

  const refresh = () => {
    if (disposed) return;
    const nextDecorations: Monaco.editor.IModelDeltaDecoration[] = [];

    for (const collaborator of getCollaborators()) {
      if (collaborator.socketId === ownSocketId || !collaborator.cursor) continue;
      const anchorBytes = decodeBase64(collaborator.cursor.anchor);
      const headBytes = decodeBase64(collaborator.cursor.head);
      if (!anchorBytes || !headBytes) continue;

      let anchor: Y.AbsolutePosition | null = null;
      let head: Y.AbsolutePosition | null = null;
      try {
        anchor = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(anchorBytes),
          doc,
        );
        head = Y.createAbsolutePositionFromRelativePosition(
          Y.decodeRelativePosition(headBytes),
          doc,
        );
      } catch {
        // Ignore malformed or foreign relative positions instead of breaking
        // the whole editor for everyone else in the room.
        continue;
      }
      if (!anchor || !head || anchor.type !== text || head.type !== text) continue;

      const anchorIndex = clamp(anchor.index, 0, text.length);
      const headIndex = clamp(head.index, 0, text.length);
      const color = collaborator.colorIndex % COLLAB_COLORS.length;
      const colorValue = COLLAB_COLORS[color]!;
      const label = `${collaborator.user.username}`;

      if (anchorIndex !== headIndex) {
        nextDecorations.push({
          range: selectionFor(Math.min(anchorIndex, headIndex), Math.max(anchorIndex, headIndex)),
          options: {
            className: `collab-selection collab-color-${color}`,
            hoverMessage: { value: `**${label}** is selecting this text` },
            zIndex: 4,
          },
        });
      }

      nextDecorations.push({
        range: selectionFor(headIndex, headIndex),
        options: {
          beforeContentClassName: `collab-caret collab-color-${color}`,
          hoverMessage: { value: `**${label}**` },
          showIfCollapsed: true,
          zIndex: 12,
          overviewRuler: {
            color: colorValue,
            position: monaco.editor.OverviewRulerLane.Right,
          },
        },
      });
    }

    decorations.set(nextDecorations);
  };

  const onTextChange = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (disposed || transaction.origin === LOCAL_ORIGIN) return;

    // Rebuild the new model text from the event delta instead of replacing the
    // whole buffer. This keeps Monaco's cursor and undo experience intact.
    const current = model.getValue();
    let next = '';
    let offset = 0;
    for (const operation of event.delta) {
      if (operation.retain) {
        next += current.slice(offset, offset + operation.retain);
        offset += operation.retain;
      }
      if (operation.delete) {
        offset += operation.delete;
      }
      if (typeof operation.insert === 'string') {
        next += operation.insert;
      }
    }
    next += current.slice(offset);

    applyTextToModel(next);
    refresh();
  };

  const modelSubscription = model.onDidChangeContent(() => {
    if (disposed || applyingRemote) return;

    const next = model.getValue();
    const current = text.toString();
    if (current === next) return;

    const { start, currentEnd, nextEnd } = sharedDiff(current, next);
    doc.transact(() => {
      if (currentEnd > start) text.delete(start, currentEnd - start);
      if (nextEnd > start) text.insert(start, next.slice(start, nextEnd));
    }, LOCAL_ORIGIN);

    refresh();
  });

  const emitCursor = () => {
    if (disposed) return;
    const selection = editor.getSelection();
    if (!selection) {
      onCursor(null);
      return;
    }

    const anchorOffset = clamp(model.getOffsetAt(selection.getSelectionStart()), 0, text.length);
    const headOffset = clamp(model.getOffsetAt(selection.getPosition()), 0, text.length);
    const anchor = Y.createRelativePositionFromTypeIndex(text, anchorOffset);
    const head = Y.createRelativePositionFromTypeIndex(text, headOffset);

    onCursor({
      anchor: encodeBase64(Y.encodeRelativePosition(anchor)),
      head: encodeBase64(Y.encodeRelativePosition(head)),
    });
  };

  const cursorSubscription = editor.onDidChangeCursorSelection(() => {
    emitCursor();
  });

  text.observe(onTextChange);
  emitCursor();
  refresh();

  return {
    refresh,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      text.unobserve(onTextChange);
      modelSubscription.dispose();
      cursorSubscription.dispose();
      decorations.clear();
      onCursor(null);
    },
  };
}
