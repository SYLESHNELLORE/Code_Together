import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Check, Clock, Copy, Crown, Mail, RefreshCw, ShieldCheck, Trash2, UserMinus, UserPlus, Users, X,
} from 'lucide-react';
import {
  api, ApiError,
  type CreateInvitationInput, type ProjectInvitation, type ProjectMember, type ProjectRole,
} from './api';

const ROLE_RANK: Record<ProjectRole, number> = {
  OWNER: 4,
  ADMIN: 3,
  EDITOR: 2,
  VIEWER: 1,
};

const ROLE_LABELS: Record<ProjectRole, string> = {
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

function initialsFor(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
  return (name.trim().slice(0, 2) || '?').toUpperCase();
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function inviteLinkFor(token: string): string {
  return `${window.location.origin}${window.location.pathname}#invite=${encodeURIComponent(token)}`;
}

interface TeamModalProps {
  projectId: string;
  projectName: string;
  currentUserId: string;
  role: ProjectRole;
  onClose: () => void;
  onLeft: () => void;
}

export default function TeamModal({
  projectId, projectName, currentUserId, role, onClose, onLeft,
}: TeamModalProps) {
  const canManage = role === 'OWNER' || role === 'ADMIN';

  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [updatingMemberId, setUpdatingMemberId] = useState<string | null>(null);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);

  const [invitations, setInvitations] = useState<ProjectInvitation[]>([]);
  const [invitationsLoading, setInvitationsLoading] = useState(canManage);
  const [invitationsError, setInvitationsError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<ProjectRole, 'OWNER'>>('EDITOR');
  const [inviteDays, setInviteDays] = useState('7');
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const loadMembers = useCallback(async () => {
    setMembersLoading(true);
    setMembersError(null);
    try {
      const { data } = await api.projects.members.list(projectId);
      setMembers(data);
    } catch (error) {
      setMembersError(errorMessage(error));
    } finally {
      setMembersLoading(false);
    }
  }, [projectId]);

  const loadInvitations = useCallback(async () => {
    if (!canManage) return;
    setInvitationsLoading(true);
    setInvitationsError(null);
    try {
      const { data } = await api.projects.invitations.list(projectId);
      setInvitations(data);
    } catch (error) {
      setInvitationsError(errorMessage(error));
    } finally {
      setInvitationsLoading(false);
    }
  }, [canManage, projectId]);

  useEffect(() => {
    void loadMembers();
    void loadInvitations();
  }, [loadMembers, loadInvitations]);

  const sortedMembers = useMemo(
    () => [...members].sort((a, b) => (
      ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.user.username.localeCompare(b.user.username)
    )),
    [members],
  );

  const assignableRoles: Array<Exclude<ProjectRole, 'OWNER'>> = role === 'OWNER'
    ? ['ADMIN', 'EDITOR', 'VIEWER']
    : ['EDITOR', 'VIEWER'];

  function canEditMember(member: ProjectMember): boolean {
    if (!canManage || member.role === 'OWNER' || member.userId === currentUserId) return false;
    if (role === 'OWNER') return true;
    return member.role === 'EDITOR' || member.role === 'VIEWER';
  }

  function canRemoveMember(member: ProjectMember): boolean {
    if (member.role === 'OWNER') return false;
    if (member.userId === currentUserId) return true;
    if (!canManage) return false;
    if (role === 'OWNER') return true;
    return member.role === 'EDITOR' || member.role === 'VIEWER';
  }

  async function changeRole(member: ProjectMember, nextRole: Exclude<ProjectRole, 'OWNER'>) {
    if (nextRole === member.role) return;
    setUpdatingMemberId(member.userId);
    setMembersError(null);
    try {
      const { data } = await api.projects.members.update(projectId, member.userId, nextRole);
      setMembers((current) => current.map((item) => (item.userId === data.userId ? data : item)));
    } catch (error) {
      setMembersError(errorMessage(error));
    } finally {
      setUpdatingMemberId(null);
    }
  }

  async function removeMember(member: ProjectMember) {
    const isSelf = member.userId === currentUserId;
    const prompt = isSelf
      ? `Leave "${projectName}"? You will lose access to its files unless invited again.`
      : `Remove ${member.user.username} from "${projectName}"?`;
    if (!window.confirm(prompt)) return;

    setRemovingMemberId(member.userId);
    setMembersError(null);
    try {
      await api.projects.members.remove(projectId, member.userId);
      if (isSelf) {
        onLeft();
        onClose();
        return;
      }
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
    } catch (error) {
      setMembersError(errorMessage(error));
    } finally {
      setRemovingMemberId(null);
    }
  }

  async function createInvitation(event: FormEvent) {
    event.preventDefault();
    const email = inviteEmail.trim();
    if (!email) return;

    setCreatingInvite(true);
    setInviteError(null);
    setCreatedLink(null);
    setCopied(false);

    const input: CreateInvitationInput = {
      email,
      role: inviteRole,
      expiresInDays: Number(inviteDays),
    };

    try {
      const { data } = await api.projects.invitations.create(projectId, input);
      setInvitations((current) => [data.invitation, ...current]);
      setCreatedLink(inviteLinkFor(data.token));
      setInviteEmail('');
    } catch (error) {
      setInviteError(errorMessage(error));
    } finally {
      setCreatingInvite(false);
    }
  }

  async function copyCreatedLink() {
    if (!createdLink) return;
    try {
      await navigator.clipboard.writeText(createdLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setInviteError('The link could not be copied automatically. Select it and copy it manually.');
    }
  }

  async function revokeInvitation(invitation: ProjectInvitation) {
    if (!window.confirm(`Revoke the invitation for ${invitation.email ?? 'this link'}?`)) return;

    setRevokingId(invitation.id);
    setInvitationsError(null);
    try {
      await api.projects.invitations.revoke(projectId, invitation.id);
      setInvitations((current) => current.map((item) => (
        item.id === invitation.id ? { ...item, status: 'REVOKED', revokedAt: new Date().toISOString() } : item
      )));
    } catch (error) {
      setInvitationsError(errorMessage(error));
    } finally {
      setRevokingId(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="invite-modal team-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close team panel"><X size={18} /></button>

        <div className="team-modal-head">
          <div className="modal-icon"><Users size={21} /></div>
          <div>
            <h2 id="team-title">Project team</h2>
            <p>{projectName} · {sortedMembers.length || '—'} {sortedMembers.length === 1 ? 'member' : 'members'}</p>
          </div>
          <span className={`role-pill role-${role.toLowerCase()}`}>{ROLE_LABELS[role]}</span>
        </div>

        <section className="team-section">
          <div className="team-section-heading">
            <span>MEMBERS</span>
            <button className="subtle-icon" title="Refresh members" onClick={() => { void loadMembers(); }}><RefreshCw size={14} /></button>
          </div>

          {membersLoading && <p className="team-muted">Loading project members…</p>}
          {membersError && (
            <div className="inline-error small">
              <span>{membersError}</span>
              <button className="secondary-button" onClick={() => { void loadMembers(); }}>Retry</button>
            </div>
          )}
          {!membersLoading && !membersError && sortedMembers.length === 0 && (
            <p className="team-muted">No members found for this project.</p>
          )}

          <div className="team-member-list">
            {sortedMembers.map((member) => {
              const isSelf = member.userId === currentUserId;
              const editable = canEditMember(member);
              const removable = canRemoveMember(member);
              return (
                <div className="team-member" key={member.userId}>
                  <div className={`avatar ${member.role === 'OWNER' ? 'avatar-owner' : 'avatar-you'}`}>
                    {initialsFor(member.user.username)}
                  </div>
                  <div className="team-member-info">
                    <strong>
                      {member.user.username}
                      {isSelf && <span className="you-tag"> (you)</span>}
                      {member.role === 'OWNER' && <Crown size={12} className="owner-crown" />}
                    </strong>
                    <span>Joined {formatDate(member.joinedAt)}</span>
                  </div>
                  <div className="team-member-actions">
                    {editable ? (
                      <select
                        className="role-select"
                        value={member.role}
                        disabled={updatingMemberId === member.userId || removingMemberId === member.userId}
                        onChange={(event) => {
                          void changeRole(member, event.target.value as Exclude<ProjectRole, 'OWNER'>);
                        }}
                        aria-label={`Role for ${member.user.username}`}
                      >
                        {assignableRoles.map((item) => (
                          <option key={item} value={item}>{ROLE_LABELS[item]}</option>
                        ))}
                      </select>
                    ) : (
                      <span className={`role-pill role-${member.role.toLowerCase()}`}>{ROLE_LABELS[member.role]}</span>
                    )}
                    {removable && (
                      <button
                        className="member-remove"
                        title={isSelf ? 'Leave project' : `Remove ${member.user.username}`}
                        onClick={() => { void removeMember(member); }}
                        disabled={removingMemberId === member.userId || updatingMemberId === member.userId}
                      >
                        {isSelf ? <UserMinus size={14} /> : <Trash2 size={14} />}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {canManage ? (
          <section className="team-section">
            <div className="team-section-heading"><span>INVITE A TEAMMATE</span><UserPlus size={14} /></div>
            <form className="team-invite-form" onSubmit={createInvitation}>
              <div className="team-invite-grid">
                <label>
                  <span>Email</span>
                  <input
                    className="text-input"
                    type="email"
                    value={inviteEmail}
                    onChange={(event) => setInviteEmail(event.target.value)}
                    placeholder="teammate@example.com"
                    maxLength={254}
                    required
                  />
                </label>
                <label>
                  <span>Role</span>
                  <select
                    className="text-input"
                    value={inviteRole}
                    onChange={(event) => setInviteRole(event.target.value as Exclude<ProjectRole, 'OWNER'>)}
                  >
                    {assignableRoles.map((item) => (
                      <option key={item} value={item}>{ROLE_LABELS[item]}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Expires</span>
                  <select className="text-input" value={inviteDays} onChange={(event) => setInviteDays(event.target.value)}>
                    <option value="1">1 day</option>
                    <option value="3">3 days</option>
                    <option value="7">7 days</option>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                  </select>
                </label>
              </div>
              {inviteError && <div className="inline-banner error team-banner" role="alert"><span>{inviteError}</span></div>}
              <button className="primary-button" type="submit" disabled={creatingInvite || !inviteEmail.trim()}>
                <Mail size={14} /> {creatingInvite ? 'Creating invitation…' : 'Create invitation'}
              </button>
            </form>

            {createdLink && (
              <div className="invite-link-box">
                <div className="invite-link-heading">
                  <span><Check size={13} /> Invitation created. Share this one-time link:</span>
                </div>
                <div className="invite-link-row">
                  <input className="text-input" value={createdLink} readOnly onFocus={(event) => event.target.select()} />
                  <button className="secondary-button" type="button" onClick={() => { void copyCreatedLink(); }}>
                    {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="team-hint">The link is shown once. Only its hash is stored, and it expires automatically.</p>
              </div>
            )}

            <div className="team-section-heading invitations-heading">
              <span>INVITATIONS</span>
              <button className="subtle-icon" title="Refresh invitations" onClick={() => { void loadInvitations(); }}><RefreshCw size={14} /></button>
            </div>
            {invitationsLoading && <p className="team-muted">Loading invitations…</p>}
            {invitationsError && (
              <div className="inline-error small">
                <span>{invitationsError}</span>
                <button className="secondary-button" onClick={() => { void loadInvitations(); }}>Retry</button>
              </div>
            )}
            {!invitationsLoading && !invitationsError && invitations.length === 0 && (
              <p className="team-muted">No invitations yet. Create one above to bring someone in.</p>
            )}
            <div className="invitation-list">
              {invitations.map((invitation) => (
                <div className="invitation-row" key={invitation.id}>
                  <div className="invitation-icon"><Mail size={14} /></div>
                  <div className="invitation-info">
                    <strong>{invitation.email ?? 'Shareable link'}</strong>
                    <span>
                      {ROLE_LABELS[invitation.role]} · expires {formatDate(invitation.expiresAt)}
                      {invitation.status !== 'PENDING' && ` · ${invitation.status.toLowerCase()}`}
                    </span>
                  </div>
                  <span className={`invite-status status-${invitation.status.toLowerCase()}`}>{invitation.status}</span>
                  {invitation.status === 'PENDING' && (
                    <button
                      className="member-remove"
                      title="Revoke invitation"
                      onClick={() => { void revokeInvitation(invitation); }}
                      disabled={revokingId === invitation.id}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>
        ) : (
          <div className="team-readonly-note">
            <ShieldCheck size={16} />
            <p>You can view the project roster. Only owners and admins can invite people or change roles.</p>
          </div>
        )}

        <div className="team-modal-footer">
          <span><Clock size={13} /> Invitations expire automatically</span>
          <button className="secondary-button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
