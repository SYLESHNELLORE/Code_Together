import { useMemo, useState } from 'react';
import { Folder, FolderInput, Home, Search, X } from 'lucide-react';
import type { ProjectFileSummary } from './api';

interface MoveEntryModalProps {
  entry: ProjectFileSummary;
  files: ProjectFileSummary[];
  onClose: () => void;
  /** Resolves true when the move succeeded and the modal should close. */
  onMove: (parentId: string | null) => Promise<boolean>;
}

export default function MoveEntryModal({ entry, files, onClose, onMove }: MoveEntryModalProps) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const folders = useMemo(() => {
    const excluded = new Set<string>([entry.id]);
    if (entry.isFolder) {
      for (const file of files) {
        if (file.path.startsWith(`${entry.path}/`)) excluded.add(file.id);
      }
    }
    const term = query.trim().toLowerCase();
    return files
      .filter((file) => file.isFolder && !excluded.has(file.id))
      .filter((file) => !term || file.name.toLowerCase().includes(term) || file.path.toLowerCase().includes(term))
      .sort((a, b) => a.path.localeCompare(b.path));
  }, [entry, files, query]);

  async function choose(parentId: string | null) {
    setBusyId(parentId ?? 'root');
    setError(null);
    try {
      const moved = await onMove(parentId);
      if (moved) onClose();
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : 'The item could not be moved.');
    } finally {
      setBusyId(null);
    }
  }

  const currentParentId = entry.parentId;
  const isBusy = busyId !== null;

  return (
    <div className="modal-backdrop" onClick={isBusy ? undefined : onClose}>
      <div
        className="invite-modal move-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close move dialog" disabled={isBusy}><X size={18} /></button>
        <div className="modal-icon"><FolderInput size={21} /></div>
        <h2 id="move-title">Move “{entry.name}”</h2>
        <p>Choose a destination folder. Paths are recalculated by the server.</p>

        <div className="search-box move-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter folders…"
            aria-label="Filter destination folders"
            autoFocus
          />
        </div>

        <div className="move-folder-list" role="listbox" aria-label="Destination folders">
          <button
            className={`move-folder-row ${currentParentId === null ? 'current' : ''}`}
            onClick={() => { void choose(null); }}
            disabled={isBusy || currentParentId === null}
            role="option"
            aria-selected={currentParentId === null}
          >
            <Home size={15} />
            <span>Project root</span>
            {currentParentId === null && <span className="move-current">Current</span>}
            {busyId === 'root' && <span className="move-busy">Moving…</span>}
          </button>

          {folders.map((folder) => {
            const isCurrent = folder.id === currentParentId;
            return (
              <button
                key={folder.id}
                className={`move-folder-row ${isCurrent ? 'current' : ''}`}
                onClick={() => { void choose(folder.id); }}
                disabled={isBusy || isCurrent}
                role="option"
                aria-selected={isCurrent}
                title={folder.path}
              >
                <Folder size={15} className="folder-icon" />
                <span className="move-folder-name">{folder.name}</span>
                <span className="move-folder-path">{folder.path}</span>
                {isCurrent && <span className="move-current">Current</span>}
                {busyId === folder.id && <span className="move-busy">Moving…</span>}
              </button>
            );
          })}

          {folders.length === 0 && (
            <p className="quick-open-empty">No other folders are available as a destination.</p>
          )}
        </div>

        {error && <div className="inline-error small" role="alert"><span>{error}</span></div>}
      </div>
    </div>
  );
}
