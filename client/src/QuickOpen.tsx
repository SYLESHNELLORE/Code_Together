import { useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2, Search, X } from 'lucide-react';
import type { ProjectFileSummary } from './api';

interface QuickOpenProps {
  files: ProjectFileSummary[];
  onSelect: (fileId: string) => void;
  onClose: () => void;
}

/**
 * Keyboard-first file search (Ctrl/Cmd+P). Filters the already-loaded
 * metadata, so searching never downloads file contents.
 */
export default function QuickOpen({ files, onSelect, onClose }: QuickOpenProps) {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    return files
      .filter((file) => !file.isFolder)
      .filter((file) => !term || file.name.toLowerCase().includes(term) || file.path.toLowerCase().includes(term))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 80);
  }, [files, query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function choose(fileId: string) {
    onSelect(fileId);
    onClose();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => Math.min(current + 1, Math.max(matches.length - 1, 0)));
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const match = matches[activeIndex];
      if (match) choose(match.id);
    }
  }

  return (
    <div className="modal-backdrop quick-open-backdrop" onClick={onClose}>
      <div
        className="quick-open"
        role="dialog"
        aria-modal="true"
        aria-label="Search project files"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="quick-open-search">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search files by name or path…"
            aria-label="Search files"
          />
          <button className="subtle-icon" onClick={onClose} aria-label="Close file search"><X size={15} /></button>
        </div>

        <div className="quick-open-list" role="listbox" aria-label="Matching files">
          {matches.length === 0 && (
            <p className="quick-open-empty">No files match “{query.trim()}”.</p>
          )}
          {matches.map((file, index) => (
            <button
              key={file.id}
              className={`quick-open-row ${index === activeIndex ? 'active' : ''}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(file.id)}
            >
              <FileCode2 size={15} />
              <span className="quick-open-name">{file.name}</span>
              <span className="quick-open-path">{file.path}</span>
            </button>
          ))}
        </div>

        <div className="quick-open-footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
