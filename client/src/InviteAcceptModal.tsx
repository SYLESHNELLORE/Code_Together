import { useEffect, useState } from 'react';
import { Check, Clock, Mail, ShieldCheck, Users, X } from 'lucide-react';
import { api, ApiError, type InvitationPreview } from './api';

const ROLE_LABELS: Record<string, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  EDITOR: 'Editor',
  VIEWER: 'Viewer',
};

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

interface InviteAcceptModalProps {
  token: string;
  onClose: () => void;
  onAccepted: (projectId: string, message: string) => void;
}

export default function InviteAcceptModal({ token, onClose, onAccepted }: InviteAcceptModalProps) {
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api.invitations.preview(token)
      .then(({ data }) => {
        if (!cancelled) setPreview(data);
      })
      .catch((previewError) => {
        if (!cancelled) setError(errorMessage(previewError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  async function acceptInvitation() {
    setAccepting(true);
    setAcceptError(null);
    try {
      const { data } = await api.invitations.accept(token);
      onAccepted(
        data.project.id,
        data.alreadyMember
          ? `You already had access to "${data.project.name}". It is now open.`
          : `You joined "${data.project.name}" as ${ROLE_LABELS[data.role] ?? data.role}.`,
      );
    } catch (acceptFailure) {
      setAcceptError(errorMessage(acceptFailure));
    } finally {
      setAccepting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="invite-modal invite-accept-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-accept-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close invitation"><X size={18} /></button>
        <div className="modal-icon"><Mail size={21} /></div>

        {loading && (
          <>
            <h2 id="invite-accept-title">Checking invitation…</h2>
            <p>Verifying the secure token and your account access.</p>
            <div className="invite-loading"><span className="auth-spinner" aria-label="Loading" /></div>
          </>
        )}

        {!loading && error && (
          <>
            <h2 id="invite-accept-title">Invitation unavailable</h2>
            <div className="inline-banner error auth-banner" role="alert"><span>{error}</span></div>
            <p className="team-hint">Ask a project owner or admin for a new invitation link.</p>
            <button className="secondary-button full-button" onClick={onClose}>Close</button>
          </>
        )}

        {!loading && !error && preview && (
          <>
            <h2 id="invite-accept-title">Join {preview.project.name}</h2>
            <p>
              <strong>{preview.invitedBy.username}</strong> invited you to collaborate on this project
              as <strong>{ROLE_LABELS[preview.role] ?? preview.role}</strong>.
            </p>

            <div className="invite-summary">
              <div><Users size={14} /><span>Project</span><strong>{preview.project.name}</strong></div>
              <div><ShieldCheck size={14} /><span>Role</span><strong>{ROLE_LABELS[preview.role] ?? preview.role}</strong></div>
              <div><Clock size={14} /><span>Expires</span><strong>{new Date(preview.expiresAt).toLocaleDateString()}</strong></div>
            </div>

            {preview.alreadyMember && (
              <div className="invite-already">
                <Check size={14} /> You already have access to this project{preview.currentRole ? ` as ${ROLE_LABELS[preview.currentRole]}` : ''}.
              </div>
            )}

            {acceptError && (
              <div className="inline-banner error auth-banner" role="alert"><span>{acceptError}</span></div>
            )}

            <button
              className="primary-button full-button"
              onClick={() => { void acceptInvitation(); }}
              disabled={accepting}
            >
              {accepting
                ? 'Joining…'
                : preview.alreadyMember
                  ? 'Open project'
                  : `Accept invitation`}
            </button>
            <button className="secondary-button full-button invite-decline" onClick={onClose} disabled={accepting}>
              Not now
            </button>
          </>
        )}
      </div>
    </div>
  );
}
