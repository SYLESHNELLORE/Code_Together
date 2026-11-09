const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

const CSRF_COOKIE = 'ct_csrf';
const CSRF_HEADER = 'X-CSRF-Token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The session token lives in sessionStorage. Unlike localStorage and cookies,
 * sessionStorage is scoped to one tab, so two tabs may sign in as different
 * users without overwriting each other. It is read from storage on every
 * request; there is intentionally no module-level "current token" cache.
 */
const AUTH_TOKEN_KEY = 'codetogether.auth.token.v1';

function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getAuthToken(): string | null {
  try {
    return storage()?.getItem(AUTH_TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

export function hasAuthToken(): boolean {
  return getAuthToken() !== null;
}

function setAuthToken(token: string): void {
  try {
    storage()?.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    // Private browsing can reject storage; the API call that follows will
    // report an authentication failure rather than silently sharing a token.
  }
}

export function clearAuthToken(): void {
  try {
    storage()?.removeItem(AUTH_TOKEN_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

let cachedCsrfToken: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

/** Called when the API reports that the session is missing or expired. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

export function clearCsrfCache(): void {
  cachedCsrfToken = null;
}

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  for (const part of document.cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== CSRF_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

async function fetchCsrfToken(): Promise<string | null> {
  const cookieToken = readCsrfCookie();
  if (cookieToken) {
    cachedCsrfToken = cookieToken;
    return cookieToken;
  }

  try {
    const res = await fetch(`${API_BASE}/auth/csrf`, { credentials: 'include' });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    const token = body?.data?.csrfToken;
    if (typeof token === 'string' && token.length > 0) {
      cachedCsrfToken = token;
      return token;
    }
  } catch {
    // The actual request below will surface a friendly network error.
  }

  return null;
}

async function ensureCsrfToken(): Promise<string | null> {
  // The CSRF cookie is not an identity token, but another tab may refresh it.
  // Prefer the current cookie value so both tabs stay in sync.
  const cookieToken = readCsrfCookie();
  if (cookieToken) {
    cachedCsrfToken = cookieToken;
    return cookieToken;
  }
  if (cachedCsrfToken) return cachedCsrfToken;
  return fetchCsrfToken();
}

function parseBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function execute<T>(path: string, options: RequestInit, allowCsrfRetry: boolean): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);

  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  // Always resolve authentication from this tab's storage. Never reuse a token
  // captured by an earlier request or by another tab.
  const authToken = getAuthToken();
  if (authToken) headers.set('Authorization', `Bearer ${authToken}`);

  if (!SAFE_METHODS.has(method)) {
    const token = await ensureCsrfToken();
    if (token) headers.set(CSRF_HEADER, token);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      // Only the readable CSRF cookie is needed; session identity is sent in
      // the per-tab Authorization header above.
      credentials: 'include',
    });
  } catch {
    throw new ApiError(
      'NETWORK_ERROR',
      'Unable to reach the CodeTogether server. Check your connection and try again.',
      0,
    );
  }

  const text = await res.text();
  const data = parseBody(text) as { error?: { code?: string; message?: string }; data?: unknown };

  if (!res.ok) {
    const code = data.error?.code ?? 'ERROR';

    // A stale CSRF cookie/token pair can happen after a restart or expiry.
    // Re-issue the token once and replay the request.
    if (res.status === 403 && code === 'CSRF_INVALID' && allowCsrfRetry) {
      cachedCsrfToken = null;
      const refreshed = await fetchCsrfToken();
      if (refreshed) return execute<T>(path, options, false);
    }

    if (res.status === 401 && (code === 'UNAUTHENTICATED' || code === 'SESSION_EXPIRED')) {
      // Clear only this tab's credentials and notify only this tab's UI.
      cachedCsrfToken = null;
      clearAuthToken();
      unauthorizedHandler?.();
    }

    throw new ApiError(code, data.error?.message ?? 'Request failed. Please try again.', res.status);
  }

  return data as T;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  return execute<T>(path, options, true);
}

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  createdAt: string;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface RegistrationInput extends Credentials {
  username: string;
}

export type ProjectRole = 'OWNER' | 'ADMIN' | 'EDITOR' | 'VIEWER';

export interface Project {
  id: string;
  name: string;
  description: string;
  visibility: string;
  createdAt: string;
  updatedAt: string;
  role?: ProjectRole;
  isOwner?: boolean;
  owner?: { id: string; username: string };
  _count?: { files: number; members: number; rooms: number };
}

export interface ProjectMember {
  userId: string;
  role: ProjectRole;
  joinedAt: string;
  user: { id: string; username: string; avatarUrl: string | null };
}

export type InvitationStatus = 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';

export interface ProjectInvitation {
  id: string;
  email: string | null;
  role: ProjectRole;
  status: InvitationStatus;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  invitedBy: { id: string; username: string };
  acceptedBy: { id: string; username: string } | null;
}

export interface CreatedInvitation {
  invitation: ProjectInvitation;
  token: string;
  expiresAt: string;
}

export interface PendingInvitation {
  id: string;
  role: ProjectRole;
  expiresAt: string;
  createdAt: string;
  invitedBy: { id: string; username: string };
  project: { id: string; name: string; description: string };
  alreadyMember: boolean;
}

export interface InvitationPreview {
  project: {
    id: string;
    name: string;
    description: string;
    owner: { id: string; username: string };
  };
  role: ProjectRole;
  expiresAt: string;
  invitedBy: { id: string; username: string };
  alreadyMember: boolean;
  currentRole: ProjectRole | null;
}

export interface AcceptInvitationResult {
  project: { id: string; name: string; description: string };
  role: ProjectRole;
  alreadyMember: boolean;
}

/** Folder listings deliberately omit content to keep large projects fast. */
export interface ProjectFileSummary {
  id: string;
  projectId: string;
  parentId: string | null;
  name: string;
  path: string;
  isFolder: boolean;
  language: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectFile extends ProjectFileSummary {
  content: string;
}

export interface ChatPresenceUser {
  id: string;
  username: string;
}

export interface ChatMessage {
  id: string;
  projectId: string;
  content: string;
  createdAt: string;
  deletedAt: string | null;
  sender: {
    id: string;
    username: string;
    avatarUrl: string | null;
  };
}

export interface ChatHistoryPage {
  roomId: string;
  messages: ChatMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ChatHistoryOptions {
  /** Load messages older than this message ID. */
  cursor?: string;
  /** Load messages newer than this message ID (reconnect catch-up). */
  after?: string;
  limit?: number;
}

export type ExecutionLanguage = 'python' | 'javascript' | 'typescript' | 'c' | 'cpp' | 'java';

export type ExecutionStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED';

export interface ExecutionJobError {
  code: string;
  message: string;
}

export interface ExecutionJob {
  id: string;
  projectId: string;
  fileId: string | null;
  language: ExecutionLanguage;
  status: ExecutionStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  timedOut: boolean;
  cancelled: boolean;
  outputTruncated: boolean;
  error: ExecutionJobError | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ExecutionCapabilities {
  enabled: boolean;
  reason: string | null;
  runner: string | null;
  languages: Array<{ id: ExecutionLanguage; label: string }>;
  limits: {
    timeoutMs: number;
    memoryMb: number;
    cpus: number;
    pidsLimit: number;
    maxCodeBytes: number;
    maxOutputBytes: number;
  };
}

export interface CreateProjectInput {
  name: string;
  description?: string;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string;
}

export interface CreateInvitationInput {
  email?: string;
  role?: Exclude<ProjectRole, 'OWNER'>;
  expiresInDays?: number;
}

export interface CreateFileInput {
  name: string;
  path: string;
  parentId?: string | null;
  isFolder?: boolean;
  language?: string;
  content?: string;
}

export interface UpdateFileInput {
  name?: string;
  path?: string;
  /** Destination folder. `null` moves to the project root; omit to keep it. */
  parentId?: string | null;
  language?: string;
  content?: string;
  version?: number;
}

export const api = {
  auth: {
    csrf: async () => {
      const response = await request<{ data: { csrfToken: string } }>('/auth/csrf');
      cachedCsrfToken = response.data.csrfToken;
      return response;
    },
    me: () => {
      if (!getAuthToken()) {
        return Promise.reject(
          new ApiError('UNAUTHENTICATED', 'Please sign in to continue.', 401),
        );
      }
      return request<{ data: { user: AuthUser } }>('/auth/me');
    },
    register: async (input: RegistrationInput) => {
      const response = await request<{ data: { user: AuthUser; token: string } }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      setAuthToken(response.data.token);
      return response;
    },
    login: async (input: Credentials) => {
      const response = await request<{ data: { user: AuthUser; token: string } }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      setAuthToken(response.data.token);
      return response;
    },
    logout: async () => {
      try {
        await request<void>('/auth/logout', { method: 'POST' });
      } finally {
        // Remove only this tab's token. Other tabs keep their own sessions.
        clearAuthToken();
        clearCsrfCache();
      }
    },
  },

  projects: {
    list: () => request<{ data: Project[] }>('/projects'),
    create: (input: CreateProjectInput) =>
      request<{ data: Project }>('/projects', { method: 'POST', body: JSON.stringify(input) }),
    get: (id: string) => request<{ data: Project }>(`/projects/${id}`),
    update: (id: string, input: UpdateProjectInput) =>
      request<{ data: Project }>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
    delete: (id: string) => request<void>(`/projects/${id}`, { method: 'DELETE' }),

    members: {
      list: (projectId: string) =>
        request<{ data: ProjectMember[] }>(`/projects/${projectId}/members`),
      update: (projectId: string, userId: string, role: Exclude<ProjectRole, 'OWNER'>) =>
        request<{ data: ProjectMember }>(`/projects/${projectId}/members/${userId}`, {
          method: 'PATCH',
          body: JSON.stringify({ role }),
        }),
      remove: (projectId: string, userId: string) =>
        request<void>(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),
    },

    invitations: {
      list: (projectId: string) =>
        request<{ data: ProjectInvitation[] }>(`/projects/${projectId}/invitations`),
      create: (projectId: string, input: CreateInvitationInput) =>
        request<{ data: CreatedInvitation }>(`/projects/${projectId}/invitations`, {
          method: 'POST',
          body: JSON.stringify(input),
        }),
      revoke: (projectId: string, invitationId: string) =>
        request<void>(`/projects/${projectId}/invitations/${invitationId}`, { method: 'DELETE' }),
    },
  },

  invitations: {
    preview: (token: string) =>
      request<{ data: InvitationPreview }>('/invitations/preview', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    accept: (token: string) =>
      request<{ data: AcceptInvitationResult }>('/invitations/accept', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    acceptById: (invitationId: string) =>
      request<{ data: AcceptInvitationResult }>(`/invitations/${invitationId}/accept`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    mine: () => request<{ data: PendingInvitation[] }>('/invitations/mine'),
  },

  files: {
    list: (projectId: string, search?: string) => {
      const query = search?.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
      return request<{ data: ProjectFileSummary[] }>(`/projects/${projectId}/files${query}`);
    },
    create: (projectId: string, input: CreateFileInput) =>
      request<{ data: ProjectFile }>(`/projects/${projectId}/files`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    get: (projectId: string, fileId: string) =>
      request<{ data: ProjectFile }>(`/projects/${projectId}/files/${fileId}`),
    update: (projectId: string, fileId: string, input: UpdateFileInput) =>
      request<{ data: ProjectFile }>(`/projects/${projectId}/files/${fileId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    delete: (projectId: string, fileId: string) =>
      request<void>(`/projects/${projectId}/files/${fileId}`, { method: 'DELETE' }),
  },

  executions: {
    capabilities: (projectId: string) =>
      request<{ data: ExecutionCapabilities }>(`/projects/${projectId}/executions/capabilities`),
    list: (projectId: string) =>
      request<{ data: { jobs: ExecutionJob[] } }>(`/projects/${projectId}/executions`),
    get: (projectId: string, jobId: string) =>
      request<{ data: ExecutionJob }>(`/projects/${projectId}/executions/${jobId}`),
    start: (projectId: string, input: { fileId: string; language: ExecutionLanguage }) =>
      request<{ data: ExecutionJob }>(`/projects/${projectId}/executions`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    cancel: (projectId: string, jobId: string) =>
      request<{ data: ExecutionJob }>(`/projects/${projectId}/executions/${jobId}/cancel`, {
        method: 'POST',
      }),
  },

  chat: {
    history: (projectId: string, options: ChatHistoryOptions = {}) => {
      const params = new URLSearchParams();
      if (options.cursor) params.set('cursor', options.cursor);
      if (options.after) params.set('after', options.after);
      if (options.limit) params.set('limit', String(options.limit));
      const query = params.toString();
      return request<{ data: ChatHistoryPage }>(
        `/projects/${projectId}/chat/messages${query ? `?${query}` : ''}`,
      );
    },
  },
};
