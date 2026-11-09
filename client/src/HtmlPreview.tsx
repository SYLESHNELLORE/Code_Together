import { Eye, X } from 'lucide-react';

interface HtmlPreviewProps {
  name: string;
  html: string;
  onClose: () => void;
}

/**
 * Safe browser preview for HTML project files. The document is rendered into
 * a sandboxed <iframe> via srcdoc with scripts allowed but no same-origin
 * grant: the document gets an opaque origin, so no matter what the HTML
 * contains it cannot read CodeTogether cookies or storage or call the API
 * with the session. Popups, forms, downloads and top-level navigation stay
 * disabled because only "allow-scripts" is granted.
 */
export default function HtmlPreview({ name, html, onClose }: HtmlPreviewProps) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="invite-modal preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="html-preview-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close preview"><X size={18} /></button>

        <div className="modal-icon"><Eye size={21} /></div>
        <h2 id="html-preview-title">Preview “{name}”</h2>
        <p className="preview-hint">
          Sandboxed preview — scripts run with no access to your session, cookies or the API.
          Press <kbd>Esc</kbd> to close.
        </p>

        <iframe
          className="html-preview-frame"
          title={`Sandboxed preview of ${name}`}
          sandbox="allow-scripts"
          srcDoc={html}
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}
