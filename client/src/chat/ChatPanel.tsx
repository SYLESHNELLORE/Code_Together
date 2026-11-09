import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  Clock, MessageSquare, RefreshCw, ShieldCheck, Trash2, Users, X,
} from 'lucide-react';
import {
  api, getAuthToken,
  type AuthUser, type ChatMessage, type ChatPresenceUser, type Project, type ProjectRole,
} from '../api';

const MAX_MESSAGE_LENGTH = 2_000;
const TYPING_THROTTLE_MS = 1_500;
const TYPING_IDLE_MS = 3_500;
const SEND_TIMEOUT_MS = 10_000;

type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';
type HistoryState = 'idle' | 'loading' | 'ready' | 'error';
type PanelTab = 'people' | 'chat';

interface ChatJoinAck {
  ok: boolean;
  error?: { code: string; message: string };
  presence?: ChatPresenceUser[];
}

interface ChatSendAck {
  ok: boolean;
  error?: { code: string; message: string };
  message?: ChatMessage;
}

interface ChatDeleteAck {
  ok: boolean;
  error?: { code: string; message: string };
  messageId?: string;
}

interface ChatPanelProps {
  project: Project | null;
  currentUser: AuthUser;
  role: ProjectRole;
  canAdminister: boolean;
  onManageTeam: () => void;
  onClose: () => void;
}

function socketOrigin(): string {
  const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
  try {
    return new URL(apiBase, window.location.origin).origin;
  } catch {
    return window.location.origin;
  }
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
  return (name.trim().slice(0, 2) || '?').toUpperCase();
}

function avatarClass(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return `chat-avatar-${hash % 6}`;
}

function mergeMessages(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return current;
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => {
    const byTime = left.createdAt.localeCompare(right.createdAt);
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function emitAck<T>(socket: Socket, event: string, payload: unknown, timeoutMs = SEND_TIMEOUT_MS): Promise<T | null> {
  return new Promise((resolve) => {
    if (!socket.connected) {
      resolve(null);
      return;
    }
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(null);
    }, timeoutMs);

    socket.emit(event, payload, (response: T) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(response ?? null);
    });
  });
}

/**
 * Project chat and project-wide presence. The message transcript comes from
 * MySQL over REST for history and Socket.IO for live delivery; both paths merge
 * by message ID so reconnects and retries can never duplicate a message.
 */
export default function ChatPanel({
  project,
  currentUser,
  role,
  canAdminister,
  onManageTeam,
  onClose,
}: ChatPanelProps) {
  const [tab, setTab] = useState<PanelTab>('chat');
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [joined, setJoined] = useState(false);
  const [presence, setPresence] = useState<ChatPresenceUser[]>([]);
  const [typingUsers, setTypingUsers] = useState<ChatPresenceUser[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyState, setHistoryState] = useState<HistoryState>('idle');
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [socketError, setSocketError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const socketRef = useRef<Socket | null>(null);
  const joinedProjectRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const lastProjectRef = useRef<string | null>(null);
  const typingSentRef = useRef<{ projectId: string; at: number } | null>(null);
  const sendRef = useRef<(content: string) => void>(() => undefined);
  const loadOlderRef = useRef<() => void>(() => undefined);
  const retryHistoryRef = useRef<() => void>(() => undefined);
  const deleteRef = useRef<(messageId: string) => void>(() => undefined);

  const commitMessages = useCallback((incoming: ChatMessage[]) => {
    setMessages((current) => {
      const next = mergeMessages(current, incoming);
      messagesRef.current = next;
      return next;
    });
  }, []);

  const sendTyping = useCallback((projectId: string, typing: boolean) => {
    const socket = socketRef.current;
    if (!socket?.connected || joinedProjectRef.current !== projectId) return;
    socket.emit('chat:typing', { projectId, typing });
  }, []);

  useEffect(() => {
    const projectId = project?.id ?? null;
    setDraft('');
    setSendError(null);
    setSocketError(null);
    setTypingUsers([]);
    setPendingCount(0);
    setDeletingId(null);
    setLoadingOlder(false);
    setHasMore(false);
    messagesRef.current = [];
    setMessages([]);
    joinedProjectRef.current = null;
    setJoined(false);
    typingSentRef.current = null;

    if (!projectId) {
      setConnection('disconnected');
      setPresence([]);
      setHistoryState('idle');
      setHistoryError(null);
      return;
    }

    let disposed = false;
    let fatalError = false;
    let historyLoaded = false;
    let historyLoad: Promise<void> | null = null;
    let hasMoreLocal = false;
    let nextCursor: string | null = null;
    let flushing = false;
    let loadingOlderLocal = false;
    let retryTimer: number | null = null;
    const pending: Array<{ clientMessageId: string; content: string }> = [];

    const socket = io(socketOrigin(), {
      // Each tab authenticates its own socket with its own session token.
      auth: (cb) => cb({ token: getAuthToken() ?? '' }),
      withCredentials: false,
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 400,
      reconnectionDelayMax: 5_000,
    });
    socketRef.current = socket;
    setConnection('connecting');

    const updatePagination = (more: boolean, cursor: string | null) => {
      hasMoreLocal = more;
      nextCursor = cursor;
      setHasMore(more);
    };

    // Share one in-flight initial load so a join that races the first fetch can
    // still catch up on anything sent before its socket subscription landed.
    const loadInitial = (): Promise<void> => {
      if (historyLoad) return historyLoad;
      historyLoad = (async () => {
        setHistoryState('loading');
        setHistoryError(null);
        try {
          const response = await api.chat.history(projectId, { limit: 30 });
          if (disposed) return;
          historyLoaded = true;
          commitMessages(response.data.messages);
          updatePagination(response.data.hasMore, response.data.nextCursor);
          setHistoryState('ready');
        } catch (error) {
          if (disposed) return;
          setHistoryState(messagesRef.current.length > 0 ? 'ready' : 'error');
          setHistoryError(error instanceof Error ? error.message : 'Unable to load chat history.');
        }
      })().finally(() => {
        historyLoad = null;
      });
      return historyLoad;
    };

    const catchUp = async () => {
      if (!historyLoaded) {
        await loadInitial();
        if (!historyLoaded) return;
      }
      let guard = 0;
      while (!disposed && guard < 10) {
        const last = messagesRef.current[messagesRef.current.length - 1];
        if (!last) {
          await loadInitial();
          return;
        }
        try {
          const response = await api.chat.history(projectId, { after: last.id, limit: 50 });
          if (disposed) return;
          commitMessages(response.data.messages);
          if (!response.data.hasMore || !response.data.nextCursor) return;
          guard += 1;
        } catch {
          // Live delivery resumes once the socket is back; the next reconnect
          // attempts another catch-up.
          return;
        }
      }
    };

    const flushPending = async () => {
      if (disposed || flushing || pending.length === 0) return;
      if (!socket.connected || joinedProjectRef.current !== projectId) return;
      flushing = true;
      try {
        while (!disposed && pending.length > 0) {
          const next = pending[0]!;
          const result = await emitAck<ChatSendAck>(socket, 'chat:send', {
            projectId,
            content: next.content,
            clientMessageId: next.clientMessageId,
          });
          if (disposed) return;
          if (!result) {
            setSendError('Message not confirmed. It will retry automatically when the connection is stable.');
            if (retryTimer === null) {
              retryTimer = window.setTimeout(() => {
                retryTimer = null;
                void flushPending();
              }, 3_000);
            }
            break;
          }
          if (!result.ok) {
            pending.shift();
            setPendingCount(pending.length);
            setSendError(result.error?.message ?? 'The message was rejected.');
            setDraft((current) => current || next.content);
            break;
          }
          pending.shift();
          setPendingCount(pending.length);
          setSendError(null);
          if (result.message) commitMessages([result.message]);
        }
      } finally {
        flushing = false;
      }
    };

    const join = async () => {
      if (disposed || !socket.connected) return;
      const result = await emitAck<ChatJoinAck>(socket, 'chat:join', { projectId }, 8_000);
      if (disposed || !socket.connected) return;
      if (!result) {
        setSocketError('The chat server did not respond. Retrying…');
        setJoined(false);
        joinedProjectRef.current = null;
        return;
      }
      if (!result.ok) {
        setSocketError(result.error?.message ?? 'Unable to join project chat.');
        setJoined(false);
        joinedProjectRef.current = null;
        setPresence([]);
        return;
      }
      joinedProjectRef.current = projectId;
      setJoined(true);
      setSocketError(null);
      setPresence(result.presence ?? []);
      void catchUp();
      void flushPending();
    };

    loadOlderRef.current = () => {
      if (loadingOlderLocal || !hasMoreLocal || !nextCursor) return;
      const cursor = nextCursor;
      loadingOlderLocal = true;
      setLoadingOlder(true);
      setHistoryError(null);
      void (async () => {
        try {
          const response = await api.chat.history(projectId, { cursor, limit: 30 });
          if (disposed) return;
          commitMessages(response.data.messages);
          updatePagination(response.data.hasMore, response.data.nextCursor);
        } catch (error) {
          if (disposed) return;
          setHistoryError(error instanceof Error ? error.message : 'Unable to load older messages.');
        } finally {
          loadingOlderLocal = false;
          if (!disposed) setLoadingOlder(false);
        }
      })();
    };

    retryHistoryRef.current = () => {
      void loadInitial();
    };

    sendRef.current = (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || !socket.connected || joinedProjectRef.current !== projectId) return;
      pending.push({ clientMessageId: newClientMessageId(), content: trimmed });
      setPendingCount(pending.length);
      setSendError(null);
      setDraft('');
      void flushPending();
    };

    deleteRef.current = (messageId: string) => {
      if (!socket.connected || joinedProjectRef.current !== projectId) {
        setSendError('Reconnect before deleting a message.');
        return;
      }
      setDeletingId(messageId);
      setSendError(null);
      void (async () => {
        const result = await emitAck<ChatDeleteAck>(socket, 'chat:delete', { projectId, messageId });
        if (disposed) return;
        setDeletingId(null);
        if (!result) {
          setSendError('Delete timed out. Try again when the connection is stable.');
          return;
        }
        if (!result.ok) {
          setSendError(result.error?.message ?? 'Unable to delete that message.');
          return;
        }
        const deletedAt = new Date().toISOString();
        setMessages((current) => {
          const next = current.map((message) => (
            message.id === messageId ? { ...message, content: '', deletedAt } : message
          ));
          messagesRef.current = next;
          return next;
        });
      })();
    };

    socket.on('connect', () => {
      if (disposed) return;
      setConnection('connected');
      setSocketError(null);
      void join();
    });

    socket.on('disconnect', (reason) => {
      if (disposed || fatalError) return;
      joinedProjectRef.current = null;
      setJoined(false);
      setPresence([]);
      setTypingUsers([]);
      setConnection(reason === 'io client disconnect' ? 'disconnected' : 'reconnecting');
    });

    socket.on('connect_error', (error: Error) => {
      if (disposed) return;
      const message = error.message || 'Unable to reach the chat server.';
      if (message.includes('UNAUTHENTICATED') || message.includes('SESSION_EXPIRED') || message.includes('INVALID_ORIGIN')) {
        fatalError = true;
        joinedProjectRef.current = null;
        setJoined(false);
        setPresence([]);
        setTypingUsers([]);
        setConnection('error');
        setSocketError(message.includes('SESSION_EXPIRED')
          ? 'Your session expired. Sign in again to use chat.'
          : 'You are not authorized to use project chat.');
        socket.disconnect();
        return;
      }
      setConnection('reconnecting');
      setSocketError('Chat connection lost. Reconnecting…');
    });

    socket.on('chat:presence', (event: { projectId?: unknown; users?: unknown } | null) => {
      if (disposed || event?.projectId !== projectId) return;
      setPresence(Array.isArray(event.users) ? event.users as ChatPresenceUser[] : []);
    });

    socket.on('chat:typing', (event: { projectId?: unknown; users?: unknown } | null) => {
      if (disposed || event?.projectId !== projectId) return;
      const users = Array.isArray(event.users) ? event.users as ChatPresenceUser[] : [];
      setTypingUsers(users.filter((user) => user.id !== currentUser.id));
    });

    socket.on('chat:message', (event: { projectId?: unknown; message?: unknown } | null) => {
      if (disposed || event?.projectId !== projectId || !event.message) return;
      commitMessages([event.message as ChatMessage]);
    });

    socket.on('chat:message-deleted', (event: {
      projectId?: unknown;
      messageId?: unknown;
      deletedAt?: unknown;
    } | null) => {
      if (disposed || event?.projectId !== projectId) return;
      const messageId = typeof event.messageId === 'string' ? event.messageId : '';
      const deletedAt = typeof event.deletedAt === 'string' ? event.deletedAt : new Date().toISOString();
      if (!messageId) return;
      setMessages((current) => {
        const next = current.map((message) => (
          message.id === messageId ? { ...message, content: '', deletedAt } : message
        ));
        messagesRef.current = next;
        return next;
      });
    });

    socket.on('chat:error', (event: { code?: unknown; message?: unknown } | null) => {
      if (disposed || !event) return;
      const message = typeof event.message === 'string' ? event.message : 'Chat error.';
      setSocketError(message);
      if (event.code === 'RATE_LIMITED') setSendError(message);
    });

    void loadInitial();

    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      sendRef.current = () => undefined;
      loadOlderRef.current = () => undefined;
      retryHistoryRef.current = () => undefined;
      deleteRef.current = () => undefined;
      if (joinedProjectRef.current === projectId) {
        socket.emit('chat:leave', { projectId });
      }
      joinedProjectRef.current = null;
      socket.removeAllListeners();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [project?.id, currentUser.id, commitMessages]);

  // Throttle typing pulses and stop automatically after a short idle period.
  useEffect(() => {
    const projectId = project?.id;
    if (!projectId || connection !== 'connected' || !joined) return;
    if (!draft.trim()) {
      if (typingSentRef.current?.projectId === projectId) {
        sendTyping(projectId, false);
        typingSentRef.current = null;
      }
      return;
    }

    const now = Date.now();
    if (!typingSentRef.current || now - typingSentRef.current.at > TYPING_THROTTLE_MS) {
      sendTyping(projectId, true);
      typingSentRef.current = { projectId, at: now };
    }

    const timer = window.setTimeout(() => {
      sendTyping(projectId, false);
      if (typingSentRef.current?.projectId === projectId) typingSentRef.current = null;
    }, TYPING_IDLE_MS);

    return () => window.clearTimeout(timer);
  }, [draft, project?.id, connection, joined, sendTyping]);

  // Keep the transcript pinned to the newest message unless the reader has
  // deliberately scrolled up to read older history.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const projectChanged = lastProjectRef.current !== (project?.id ?? null);
    lastProjectRef.current = project?.id ?? null;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (projectChanged || nearBottom) list.scrollTop = list.scrollHeight;
  }, [messages, project?.id]);

  const connected = connection === 'connected';
  const canModerate = role === 'OWNER' || role === 'ADMIN';
  const onlineCount = presence.length;
  const connectionLabel = connection === 'connected'
    ? (joined ? 'Live' : 'Joining…')
    : connection === 'reconnecting'
      ? 'Reconnecting…'
      : connection === 'error'
        ? 'Offline'
        : connection === 'connecting'
          ? 'Connecting…'
          : 'Disconnected';

  return (
    <aside className="collab-sidebar">
      <div className="collab-tabs">
        <button
          className={`collab-tab ${tab === 'people' ? 'active' : ''}`}
          onClick={() => setTab('people')}
          type="button"
        >
          <Users size={15} /> People <span className="count-pill">{onlineCount}</span>
        </button>
        <button
          className={`collab-tab ${tab === 'chat' ? 'active' : ''}`}
          onClick={() => setTab('chat')}
          type="button"
        >
          <MessageSquare size={15} /> Chat
        </button>
        <button className="close-panel" title="Close panel" onClick={onClose} type="button">
          <X size={15} />
        </button>
      </div>

      {tab === 'people' ? (
        <>
          <div className="collab-section presence-section">
            <div className="section-label">
              ONLINE NOW
              <span className={`online-count chat-status ${connected ? 'is-live' : ''}`}>{connectionLabel}</span>
            </div>
            {!project ? (
              <p className="muted-small">Open a project to see who is online.</p>
            ) : presence.length === 0 ? (
              <p className="muted-small">
                {connected ? 'No one else is online right now.' : 'Presence will return when chat reconnects.'}
              </p>
            ) : (
              <div className="presence-list">
                {presence.map((person) => (
                  <div className="person-row" key={person.id}>
                    <div className={`avatar message-avatar ${avatarClass(person.username)}`}>
                      {initialsFor(person.username)}
                    </div>
                    <div className="person-info">
                      <strong>
                        {person.username}
                        {person.id === currentUser.id && <span className="you-tag"> (you)</span>}
                      </strong>
                      <span>Online · project chat</span>
                    </div>
                    <span className="presence-dot" />
                  </div>
                ))}
              </div>
            )}
            {project && (
              <button className="invite-wide" onClick={onManageTeam} type="button">
                <Users size={15} /> {canAdminister ? 'Manage team' : 'View team'}
              </button>
            )}
          </div>
          <div className="collab-footer">
            <span><ShieldCheck size={14} /> Authenticated session</span>
            <span className={`chat-connection-dot ${connected ? 'is-live' : ''}`} />
          </div>
        </>
      ) : (
        <>
          <div className="chat-section">
            <div className="chat-heading">
              <span>ROOM CHAT</span>
              <span className={`chat-status ${connected ? 'is-live' : ''}`}>
                <span className="chat-live-dot" /> {connectionLabel}
              </span>
            </div>

            {!project ? (
              <div className="chat-state">
                <MessageSquare size={20} />
                <strong>No project selected</strong>
                <p>Open a project to join its private room chat.</p>
              </div>
            ) : (
              <>
                {!connected && (
                  <div className="chat-banner" role="status">
                    {connection === 'error'
                      ? 'Chat is offline. Reload or sign in again to reconnect.'
                      : 'Reconnecting to project chat. History is still available.'}
                  </div>
                )}
                {socketError && connected && (
                  <div className="chat-banner error" role="alert">{socketError}</div>
                )}
                {sendError && (
                  <div className="chat-banner error" role="alert">{sendError}</div>
                )}

                <div className="message-list" ref={listRef}>
                  {hasMore && (
                    <button
                      className="load-older"
                      onClick={() => loadOlderRef.current()}
                      disabled={loadingOlder}
                      type="button"
                    >
                      <RefreshCw size={12} className={loadingOlder ? 'spin' : undefined} />
                      {loadingOlder ? 'Loading older messages…' : 'Load older messages'}
                    </button>
                  )}

                  {historyState === 'loading' && messages.length === 0 && (
                    <div className="chat-loading" aria-label="Loading chat history">
                      <span /><span /><span />
                    </div>
                  )}

                  {historyState === 'error' && (
                    <div className="chat-state error">
                      <ShieldCheck size={20} />
                      <strong>Chat history unavailable</strong>
                      <p>{historyError ?? 'Unable to load messages.'}</p>
                      <button className="secondary-button compact" onClick={() => retryHistoryRef.current()} type="button">
                        <RefreshCw size={13} /> Retry
                      </button>
                    </div>
                  )}

                  {historyState === 'ready' && messages.length === 0 && (
                    <div className="chat-state">
                      <MessageSquare size={20} />
                      <strong>No messages yet</strong>
                      <p>Start the conversation with your project team.</p>
                    </div>
                  )}

                  {messages.map((message) => {
                    const own = message.sender.id === currentUser.id;
                    const canDelete = !message.deletedAt && (own || canModerate);
                    return (
                      <div className={`message ${own ? 'is-own' : ''}`} key={message.id}>
                        <div className={`avatar message-avatar ${avatarClass(message.sender.username)}`}>
                          {initialsFor(message.sender.username)}
                        </div>
                        <div className="message-body">
                          <div className="message-meta">
                            <strong>{message.sender.username}</strong>
                            <span title={new Date(message.createdAt).toLocaleString()}>
                              {formatMessageTime(message.createdAt)}
                            </span>
                            {message.deletedAt && <span className="message-edited">deleted</span>}
                            {canDelete && (
                              <button
                                className="message-delete"
                                type="button"
                                title={own ? 'Delete your message' : 'Delete as project moderator'}
                                aria-label="Delete message"
                                disabled={deletingId === message.id}
                                onClick={() => {
                                  if (window.confirm('Delete this message? The content is hidden but retained for audit.')) {
                                    deleteRef.current(message.id);
                                  }
                                }}
                              >
                                {deletingId === message.id
                                  ? <RefreshCw size={11} className="spin" />
                                  : <Trash2 size={11} />}
                              </button>
                            )}
                          </div>
                          {message.deletedAt ? (
                            <p className="message-deleted"><Clock size={11} /> Message deleted</p>
                          ) : (
                            <p>{message.content}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {typingUsers.length > 0 && (
                    <div className="typing-indicator" aria-live="polite">
                      <span className="typing-dots"><i /><i /><i /></span>
                      {typingUsers.map((user) => user.username).join(', ')}
                      {typingUsers.length === 1 ? ' is typing…' : ' are typing…'}
                    </div>
                  )}
                </div>

                <form
                  className="chat-composer"
                  onSubmit={(event) => {
                    event.preventDefault();
                    sendRef.current(draft);
                  }}
                >
                  <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder={
                      !connected
                        ? 'Reconnecting to chat…'
                        : joined
                          ? 'Message your team…'
                          : 'Joining the room…'
                    }
                    aria-label="Chat message"
                    maxLength={MAX_MESSAGE_LENGTH}
                    disabled={!connected || !joined}
                  />
                  <button
                    aria-label="Send message"
                    title={pendingCount > 0 ? `Send ${pendingCount} queued message(s)` : 'Send message'}
                    type="submit"
                    disabled={!connected || !joined || !draft.trim()}
                  >
                    <MessageSquare size={16} />
                  </button>
                </form>
                <div className="chat-composer-meta">
                  <span>
                    {pendingCount > 0
                      ? `${pendingCount} message${pendingCount === 1 ? '' : 's'} awaiting confirmation`
                      : typingUsers.length > 0
                        ? 'Someone is typing…'
                        : `${MAX_MESSAGE_LENGTH - draft.length}`}
                  </span>
                  <span>{draft.length > 0 ? `${draft.length}/${MAX_MESSAGE_LENGTH}` : 'Enter to send'}</span>
                </div>
              </>
            )}
          </div>
          <div className="collab-footer">
            <span><ShieldCheck size={14} /> Private to project members</span>
            <span className={`chat-connection-dot ${connected ? 'is-live' : ''}`} />
          </div>
        </>
      )}
    </aside>
  );
}
