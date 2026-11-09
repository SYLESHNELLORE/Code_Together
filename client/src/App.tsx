import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Activity, Bell, ChevronDown, ChevronRight, Code2, Command, Eye, FileCode2,
  FilePlus2, Folder, FolderInput, FolderPlus, GitBranch, Globe2, LayoutDashboard, LogOut, Mail,
  Pencil, Play, Plus, RefreshCw, Save, Search, Settings2, Share2,
  ShieldCheck, Trash2, UserRound, Users, X, Zap, MoreHorizontal,
} from 'lucide-react';
import AuthScreen from './AuthScreen';
import TeamModal from './TeamModal';
import InviteAcceptModal from './InviteAcceptModal';
import QuickOpen from './QuickOpen';
import MoveEntryModal from './MoveEntryModal';
import HtmlPreview from './HtmlPreview';
import ChatPanel from './chat/ChatPanel';
import ExecutionConsole from './execution/ExecutionConsole';
import { EXECUTION_STATUS_LABELS, executionLanguageForFile, isHtmlFile } from './execution/language';
import { useExecution } from './execution/useExecution';
import CollaborativeEditor from './collab/CollaborativeEditor';
import { YjsSocketProvider } from './collab/YjsSocketProvider';
import { createInitialState, type CollaborationState, type Collaborator } from './collab/types';
import {
  api, ApiError, hasAuthToken, setUnauthorizedHandler,
  type AuthUser, type PendingInvitation, type Project, type ProjectFile, type ProjectFileSummary, type ProjectRole,
} from './api';

/** Open tabs keep only file metadata; the live document lives in Yjs. */
type OpenFileState = ProjectFileSummary;

interface StoredTabs {
  order: string[];
  activeId: string | null;
}

const TAB_STORAGE_PREFIX = 'codetogether.openTabs.v1.';
const EMPTY_COLLAB_STATE = createInitialState();

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase();
  }
  return (name.trim().slice(0, 2) || '?').toUpperCase();
}

/** Monaco language ids for the file types commonly used in a web workspace. */
function languageForFile(name: string): string {
  const base = name.toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const ext = base.split('.').pop() ?? '';
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript';
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'javascript';
    case 'py':
    case 'pyw':
      return 'python';
    case 'rb':
      return 'ruby';
    case 'php':
      return 'php';
    case 'java':
      return 'java';
    case 'kt':
    case 'kts':
      return 'kotlin';
    case 'c':
      return 'c';
    case 'h':
    case 'hpp':
    case 'hh':
    case 'cc':
    case 'cpp':
    case 'cxx':
      return 'cpp';
    case 'cs':
      return 'csharp';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    case 'swift':
      return 'swift';
    case 'scala':
      return 'scala';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'shell';
    case 'ps1':
      return 'powershell';
    case 'css':
      return 'css';
    case 'scss':
    case 'sass':
      return 'scss';
    case 'less':
      return 'less';
    case 'html':
    case 'htm':
      return 'html';
    case 'xml':
    case 'svg':
      return 'xml';
    case 'json':
      return 'json';
    case 'jsonc':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'toml':
      return 'ini';
    case 'ini':
    case 'conf':
    case 'env':
      return 'ini';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'sql':
      return 'sql';
    case 'graphql':
    case 'gql':
      return 'graphql';
    case 'vue':
    case 'svelte':
      return 'html';
    case 'lua':
      return 'lua';
    case 'r':
      return 'r';
    case 'dart':
      return 'dart';
    default:
      return 'plaintext';
  }
}

function fileIconClass(name: string): string {
  if (name.endsWith('.css') || name.endsWith('.scss')) return 'file-css';
  if (name.endsWith('.md')) return 'file-md';
  if (name.endsWith('.json')) return 'file-json';
  return 'file-ts';
}

function toSummary(file: ProjectFile): ProjectFileSummary {
  const { content: _content, ...summary } = file;
  return summary;
}

function readStoredTabs(userId: string, projectId: string): StoredTabs | null {
  try {
    const raw = window.localStorage.getItem(`${TAB_STORAGE_PREFIX}${userId}.${projectId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { order?: unknown; activeId?: unknown };
    if (!Array.isArray(parsed.order)) return null;
    return {
      order: parsed.order.filter((id): id is string => typeof id === 'string').slice(0, 50),
      activeId: typeof parsed.activeId === 'string' ? parsed.activeId : null,
    };
  } catch {
    return null;
  }
}

function writeStoredTabs(
  userId: string,
  projectId: string,
  order: string[],
  activeId: string | null,
): void {
  try {
    // Only tab IDs are persisted, and they are namespaced by account so two
    // accounts in different tabs never reuse each other's open-tab state.
    // File contents always come from MySQL.
    window.localStorage.setItem(
      `${TAB_STORAGE_PREFIX}${userId}.${projectId}`,
      JSON.stringify({ order, activeId }),
    );
  } catch {
    // Storage can be unavailable in private browsing; tabs still work in memory.
  }
}

const ROLE_LABELS: Record<ProjectRole, string> = {
  OWNER: 'Owner',
  ADMIN: 'Admin',
  EDITOR: 'Editor',
  VIEWER: 'Viewer',
};

function canWriteWithRole(role: ProjectRole | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'EDITOR';
}

function canAdministerWithRole(role: ProjectRole | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

/** Invitation tokens travel in the URL fragment so they are not sent to servers or logs. */
function readInviteTokenFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return null;
  const token = new URLSearchParams(raw).get('invite');
  return token && token.length >= 20 ? token : null;
}

function clearInviteHash(): void {
  if (typeof window === 'undefined') return;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'workspace' | 'projects'>('workspace');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [chatOpen, setChatOpen] = useState(true);
  const [teamOpen, setTeamOpen] = useState(false);
  const [projectQuery, setProjectQuery] = useState('');
  const [fileQuery, setFileQuery] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);

  // Authentication
  const [authStatus, setAuthStatus] = useState<'loading' | 'authenticated' | 'anonymous'>('loading');
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  // Remote data
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);

  // Invitations addressed to the signed-in account.
  const [pendingInvitations, setPendingInvitations] = useState<PendingInvitation[]>([]);
  const [pendingInvitationsLoading, setPendingInvitationsLoading] = useState(false);
  const [pendingInvitationsError, setPendingInvitationsError] = useState<string | null>(null);
  const [acceptingInvitationId, setAcceptingInvitationId] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState<string | null>(null);

  // File explorer (metadata only).
  const [files, setFiles] = useState<ProjectFileSummary[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [moveEntry, setMoveEntry] = useState<ProjectFileSummary | null>(null);

  // Per-tab editor state. Document text lives in the Yjs provider, never here.
  const [openFiles, setOpenFiles] = useState<Record<string, OpenFileState>>({});
  const [openOrder, setOpenOrder] = useState<string[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [collabStates, setCollabStates] = useState<Record<string, CollaborationState>>({});
  const [providerEpoch, setProviderEpoch] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [htmlPreview, setHtmlPreview] = useState<{ name: string; html: string } | null>(null);

  // Create-project modal
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [creatingProject, setCreatingProject] = useState(false);

  // Refs mirror state so provider callbacks and async responses never read stale values.
  const activeProjectIdRef = useRef<string | null>(null);
  const filesRef = useRef<ProjectFileSummary[]>([]);
  const openFilesRef = useRef<Record<string, OpenFileState>>({});
  const openOrderRef = useRef<string[]>([]);
  const activeFileIdRef = useRef<string | null>(null);
  const canWriteRef = useRef(false);
  const providersRef = useRef<Map<string, YjsSocketProvider>>(new Map());
  const collabStatesRef = useRef<Record<string, CollaborationState>>({});
  const tabsHydratedRef = useRef<string | null>(null);
  const fileSearchRef = useRef<HTMLInputElement>(null);
  const closeTabRef = useRef<(fileId: string) => void>(() => {});

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );
  const activeRole = activeProject?.role;
  const canWrite = canWriteWithRole(activeRole);
  const canAdminister = canAdministerWithRole(activeRole);
  canWriteRef.current = canWrite;

  const activeFile = activeFileId ? openFiles[activeFileId] ?? null : null;
  const activeProvider = activeFileId ? providersRef.current.get(activeFileId) ?? null : null;
  const activeCollab = activeFileId ? collabStates[activeFileId] ?? EMPTY_COLLAB_STATE : null;
  const execution = useExecution({ projectId: activeProject?.id ?? null });
  const activeExecutionLanguage = activeFile ? executionLanguageForFile(activeFile.name) : null;
  const executionFileNameFor = useCallback(
    (fileId: string | null): string | null => {
      if (!fileId) return null;
      return openFiles[fileId]?.name ?? files.find((item) => item.id === fileId)?.name ?? null;
    },
    [openFiles, files],
  );
  // The Run button explains exactly why it cannot be used instead of failing
  // only after a request reaches the server. The checks run in import order:
  // role → file type → live document readiness → empty content → sandbox
  // availability. HTML files never run: they get the Preview action instead.
  const activeFileIsHtml = Boolean(activeFile && isHtmlFile(activeFile.name));
  const activeFileEmpty = Boolean(
    activeProvider && activeCollab?.synced && activeProvider.text.length === 0,
  );
  const executionBlockedReason = !canWrite
    ? 'You need edit access to run code in this project.'
    : !activeExecutionLanguage
      ? activeFileIsHtml
        ? 'HTML files are previewed, not executed. Use the Preview button.'
        : 'Only Python, JavaScript, TypeScript, Java, C and C++ files can be executed.'
      : !activeCollab?.synced
        ? 'Wait for the live document to finish connecting, then run again.'
        : activeFileEmpty
          ? 'The file is empty. Add some code before running it.'
          : execution.capabilitiesLoading && !execution.capabilities
            ? 'Checking the execution sandbox…'
            : execution.capabilities && !execution.capabilities.enabled
              ? execution.capabilities.reason ?? 'Secure execution is not available.'
              : execution.capabilitiesError && !execution.capabilities
                ? `Could not check the execution sandbox: ${execution.capabilitiesError}`
                : execution.isActive || execution.starting
                  ? 'An execution is already queued or running.'
                  : null;
  const canRunActiveFile = executionBlockedReason === null;

  /**
   * Sandbox availability surfaced as a visible banner. Backend-level causes
   * (not configured / not reachable) are permanent for the button, so they are
   * communicated on the screen instead of only inside a hover tooltip.
   */
  const executionSandboxNotice: { message: string; kind: 'disabled' | 'error' } | null = (() => {
    // A failed check is the newest information. Surface it even when an older
    // successful response is still cached, so the banner never claims a stale
    // "available" state after the API stopped responding.
    if (!execution.capabilitiesLoading && execution.capabilitiesError) {
      return {
        message: execution.capabilities?.enabled
          ? `Could not re-check the execution sandbox: ${execution.capabilitiesError} Run may fail until the API is reachable again.`
          : `Could not check the execution sandbox: ${execution.capabilitiesError}`,
        kind: 'error',
      };
    }
    if (execution.capabilities) {
      if (execution.capabilities.enabled) return null;
      return {
        message: execution.capabilities.reason ?? 'No isolated execution backend is configured on the server.',
        kind: 'disabled',
      };
    }
    return null;
  })();
  const activeFileDirty = Boolean(activeCollab?.dirty);
  const dirtyIds = useMemo(
    () => openOrder.filter((id) => Boolean(collabStates[id]?.dirty)),
    [openOrder, collabStates],
  );
  const liveCollaborators = useMemo(() => {
    const unique = new Map<string, Collaborator>();
    for (const collaborator of activeCollab?.collaborators ?? []) {
      if (!unique.has(collaborator.user.id)) unique.set(collaborator.user.id, collaborator);
    }
    return [...unique.values()];
  }, [activeCollab?.collaborators]);

  const selectedFolder = useMemo(
    () => files.find((item) => item.isFolder && item.id === selectedFolderId) ?? null,
    [files, selectedFolderId],
  );
  const selectedEntry = useMemo(
    () => selectedFolder
      ?? (activeFileId ? files.find((item) => item.id === activeFileId) ?? null : null),
    [selectedFolder, activeFileId, files],
  );

  const commitFiles = useCallback((next: ProjectFileSummary[]) => {
    filesRef.current = next;
    setFiles(next);
  }, []);

  const commitOpenFiles = useCallback((next: Record<string, OpenFileState>) => {
    openFilesRef.current = next;
    setOpenFiles(next);
  }, []);

  const commitOrder = useCallback((next: string[]) => {
    openOrderRef.current = next;
    setOpenOrder(next);
  }, []);

  const activateFile = useCallback((fileId: string | null) => {
    activeFileIdRef.current = fileId;
    setActiveFileId(fileId);
  }, []);

  const updateOpenFile = useCallback((
    fileId: string,
    updater: (current: OpenFileState) => OpenFileState,
  ) => {
    const current = openFilesRef.current[fileId];
    if (!current) return;
    const next = { ...openFilesRef.current, [fileId]: updater(current) };
    commitOpenFiles(next);
  }, [commitOpenFiles]);

  const commitCollabState = useCallback((fileId: string, state: CollaborationState) => {
    collabStatesRef.current = { ...collabStatesRef.current, [fileId]: state };
    setCollabStates(collabStatesRef.current);
  }, []);

  const removeOpenFiles = useCallback((fileIds: Set<string>) => {
    if (fileIds.size === 0) return;
    const nextOpen = { ...openFilesRef.current };
    const nextCollab = { ...collabStatesRef.current };
    for (const fileId of fileIds) {
      delete nextOpen[fileId];
      delete nextCollab[fileId];
      const provider = providersRef.current.get(fileId);
      if (provider) {
        providersRef.current.delete(fileId);
        void provider.dispose();
      }
    }
    const nextOrder = openOrderRef.current.filter((id) => !fileIds.has(id));
    commitOpenFiles(nextOpen);
    commitOrder(nextOrder);
    collabStatesRef.current = nextCollab;
    setCollabStates(nextCollab);
    if (activeFileIdRef.current && fileIds.has(activeFileIdRef.current)) {
      activateFile(nextOrder[0] ?? null);
    }
  }, [activateFile, commitOpenFiles, commitOrder]);

  /**
   * Merge fresh metadata from the server. Document text stays in Yjs; only
   * names, paths and languages are adopted here.
   */
  const applyFiles = useCallback((next: ProjectFileSummary[]) => {
    commitFiles(next);

    const byId = new Map(next.map((item) => [item.id, item]));
    const nextOpen: Record<string, OpenFileState> = {};
    let openChanged = false;

    for (const [id, current] of Object.entries(openFilesRef.current)) {
      const summary = byId.get(id);
      if (!summary || summary.isFolder) {
        openChanged = true;
        continue;
      }

      const metadataChanged = current.name !== summary.name
        || current.path !== summary.path
        || current.language !== summary.language;

      if (metadataChanged) {
        nextOpen[id] = {
          ...current,
          name: summary.name,
          path: summary.path,
          language: summary.language,
        };
        openChanged = true;
      } else {
        nextOpen[id] = current;
      }
    }

    if (openChanged) commitOpenFiles(nextOpen);

    const nextOrder = openOrderRef.current.filter((id) => Boolean(nextOpen[id]));
    if (nextOrder.length !== openOrderRef.current.length) commitOrder(nextOrder);

    const currentActive = activeFileIdRef.current;
    if (!currentActive || !nextOpen[currentActive]) {
      activateFile(nextOrder[0] ?? null);
    }

    const folderIds = next.filter((item) => item.isFolder).map((item) => item.id);
    setExpandedFolders((current) => {
      const valid = new Set(folderIds);
      const merged = new Set([...current].filter((id) => valid.has(id)));
      if (merged.size === 0) {
        for (const id of folderIds) merged.add(id);
      }
      return merged;
    });
  }, [activateFile, commitFiles, commitOpenFiles, commitOrder]);

  const reloadFiles = useCallback(async (projectId: string) => {
    const { data } = await api.files.list(projectId);
    applyFiles(data);
    return data;
  }, [applyFiles]);

  /**
   * Persist one tab by flushing its live document. The server writes content
   * and the Yjs snapshot in one MySQL transaction.
   */
  const performSaveRef = useRef<(fileId: string) => Promise<boolean>>(async () => true);
  const performSave = useCallback(async (fileId: string): Promise<boolean> => {
    if (!canWriteRef.current) return true;
    const provider = providersRef.current.get(fileId);
    if (!provider) return true;
    return provider.flush();
  }, []);
  performSaveRef.current = performSave;

  /**
   * Persist the live document first: the execution service intentionally reads
   * the file from MySQL instead of accepting arbitrary code in the request.
   */
  const runActiveFile = useCallback(async () => {
    if (!activeFile || !activeExecutionLanguage || !canWrite) return;
    setShowOutput(true);
    await execution.start(activeFile.id, activeExecutionLanguage, async () => {
      if (!activeCollab?.synced) return false;
      return performSave(activeFile.id);
    });
  }, [
    activeFile,
    activeExecutionLanguage,
    canWrite,
    activeCollab?.synced,
    performSave,
    execution.start,
  ]);

  /**
   * Render the active HTML document in a sandboxed preview frame. The live
   * document text is used when the tab is connected (so unsaved edits are
   * included); otherwise the persisted content is read from MySQL.
   */
  const openHtmlPreview = useCallback(async () => {
    const projectId = activeProjectIdRef.current;
    const fileId = activeFileIdRef.current;
    if (!projectId || !fileId) return;
    const file = openFilesRef.current[fileId];
    if (!file) return;
    const provider = providersRef.current.get(fileId);
    if (provider && collabStatesRef.current[fileId]?.synced) {
      setHtmlPreview({ name: file.name, html: provider.text.toString() });
      return;
    }
    try {
      const { data } = await api.files.get(projectId, fileId);
      setHtmlPreview({ name: data.name, html: data.content });
    } catch (caught) {
      setNotice(errorMessage(caught));
    }
  }, []);

  const flushAllSaves = useCallback(async (): Promise<boolean> => {
    const providers = [...providersRef.current.values()];
    if (providers.length === 0) return true;
    const results = await Promise.all(providers.map((provider) => provider.flush()));
    return results.every(Boolean);
  }, []);

  const disposeAllProviders = useCallback(async (): Promise<void> => {
    const providers = [...providersRef.current.values()];
    providersRef.current.clear();
    collabStatesRef.current = {};
    setCollabStates({});
    await Promise.all(providers.map((provider) => provider.dispose()));
  }, []);

  /**
   * Keep one Socket.IO/Yjs provider per open tab. Providers stay alive while a
   * tab is inactive so its document remains connected and dirty state visible.
   */
  useEffect(() => {
    const projectId = activeProjectId;
    if (!projectId) {
      void disposeAllProviders();
      return;
    }

    const wanted = new Set(openOrder.filter((id) => openFilesRef.current[id]?.projectId === projectId));
    let removed = false;

    for (const [fileId, provider] of [...providersRef.current]) {
      if (wanted.has(fileId)) continue;
      providersRef.current.delete(fileId);
      delete collabStatesRef.current[fileId];
      removed = true;
      void provider.dispose();
    }

    for (const fileId of wanted) {
      if (providersRef.current.has(fileId)) continue;
      let provider: YjsSocketProvider | null = null;
      provider = new YjsSocketProvider({
        projectId,
        fileId,
        onState: (state) => {
          if (!provider || providersRef.current.get(fileId) !== provider) return;
          commitCollabState(fileId, state);
        },
      });
      providersRef.current.set(fileId, provider);
      commitCollabState(fileId, provider.getState());
    }

    if (removed) setCollabStates({ ...collabStatesRef.current });
  }, [activeProjectId, openOrder, providerEpoch, commitCollabState, disposeAllProviders]);

  function reconnectFile(fileId: string): void {
    const provider = providersRef.current.get(fileId);
    if (provider) {
      provider.retry();
    } else {
      setProviderEpoch((current) => current + 1);
    }
  }

  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const { data } = await api.projects.list();
      setProjects(data);
      setProjectsError(null);
      const current = activeProjectIdRef.current;
      const nextId = current && data.some((project) => project.id === current)
        ? current
        : data[0]?.id ?? null;
      activeProjectIdRef.current = nextId;
      setActiveProjectId(nextId);
    } catch (error) {
      setProjectsError(errorMessage(error));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const loadPendingInvitations = useCallback(async () => {
    setPendingInvitationsLoading(true);
    try {
      const { data } = await api.invitations.mine();
      setPendingInvitations(data);
      setPendingInvitationsError(null);
    } catch (error) {
      setPendingInvitationsError(errorMessage(error));
    } finally {
      setPendingInvitationsLoading(false);
    }
  }, []);

  // Restore this tab's session from its own sessionStorage token. A tab with
  // no token is anonymous immediately; it never borrows another tab's session.
  useEffect(() => {
    if (!hasAuthToken()) {
      setAuthUser(null);
      setAuthStatus('anonymous');
      setAuthMessage(null);
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const { data } = await api.auth.me();
        if (cancelled) return;
        setAuthUser(data.user);
        setAuthStatus('authenticated');
        setAuthMessage(null);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.code === 'SESSION_EXPIRED') {
          setAuthMessage('Your session expired. Please sign in again.');
        } else if (error instanceof ApiError && error.code !== 'UNAUTHENTICATED') {
          setAuthMessage(error.message);
        }
        setAuthUser(null);
        setAuthStatus('anonymous');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Surface session expiry from any API call while signed in.
  useEffect(() => {
    if (authStatus !== 'authenticated') {
      setUnauthorizedHandler(null);
      return;
    }

    setUnauthorizedHandler(() => {
      setAuthUser(null);
      setAuthStatus('anonymous');
      setAuthMessage('Your session expired. Please sign in again.');
      setAccountOpen(false);
    });

    return () => setUnauthorizedHandler(null);
  }, [authStatus]);

  // Projects are private, so only load them once authentication succeeds.
  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    void loadProjects();
    void loadPendingInvitations();
  }, [authStatus, loadProjects, loadPendingInvitations]);

  // Open an invitation link on first load or whenever the fragment changes.
  useEffect(() => {
    if (authStatus !== 'authenticated') return;

    const syncInviteToken = () => {
      const token = readInviteTokenFromHash();
      if (token) setInviteToken(token);
    };

    syncInviteToken();
    window.addEventListener('hashchange', syncInviteToken);
    return () => window.removeEventListener('hashchange', syncInviteToken);
  }, [authStatus]);

  // Drop cached workspace data when the user signs out or the session expires.
  useEffect(() => {
    if (authStatus !== 'anonymous') return;

    void disposeAllProviders();
    tabsHydratedRef.current = null;
    activeProjectIdRef.current = null;
    activeFileIdRef.current = null;

    setProjects([]);
    setProjectsError(null);
    setProjectsLoading(false);
    setActiveProjectId(null);
    commitFiles([]);
    commitOpenFiles({});
    commitOrder([]);
    setActiveFileId(null);
    setSelectedFolderId(null);
    setExpandedFolders(new Set());
    setFileQuery('');
    setNotice(null);
    setAccountOpen(false);
    setAccountError(null);
    setTeamOpen(false);
    setPendingInvitations([]);
    setPendingInvitationsError(null);
    setPendingInvitationsLoading(false);
    setInviteToken(null);
    setQuickOpen(false);
    setMoveEntry(null);
  }, [authStatus, commitFiles, commitOpenFiles, commitOrder, disposeAllProviders]);

  /**
   * Load the project's file metadata, then restore the tabs that were open in
   * this browser. Each restored tab opens its own live collaboration room.
   */
  useEffect(() => {
    const projectId = activeProjectId;
    const userId = authUser?.id ?? null;
    tabsHydratedRef.current = null;

    commitFiles([]);
    commitOpenFiles({});
    commitOrder([]);
    activateFile(null);
    setSelectedFolderId(null);
    setExpandedFolders(new Set());
    setFileQuery('');
    setMoveEntry(null);
    setNotice(null);

    if (!projectId || !userId) {
      setFilesLoading(false);
      setFilesError(null);
      return;
    }

    let cancelled = false;
    setFilesLoading(true);
    setFilesError(null);

    api.files
      .list(projectId)
      .then(({ data }) => {
        if (cancelled) return;
        commitFiles(data);
        setFilesLoading(false);

        const filesOnly = data.filter((item) => !item.isFolder);
        const fileIds = new Set(filesOnly.map((item) => item.id));
        const stored = readStoredTabs(userId, projectId);

        let order: string[] = [];
        let active: string | null = null;

        if (stored) {
          order = stored.order.filter((id) => fileIds.has(id));
          active = stored.activeId && fileIds.has(stored.activeId) ? stored.activeId : order[0] ?? null;
        } else {
          const first = filesOnly[0]?.id ?? null;
          if (first) {
            order = [first];
            active = first;
          }
        }

        const restored: Record<string, OpenFileState> = {};
        for (const id of order) {
          const summary = data.find((item) => item.id === id);
          if (!summary) continue;
          restored[id] = { ...summary };
        }

        commitOpenFiles(restored);
        commitOrder(order);
        activateFile(active);
        tabsHydratedRef.current = projectId;
      })
      .catch((error) => {
        if (cancelled) return;
        setFilesError(errorMessage(error));
        setFilesLoading(false);
        tabsHydratedRef.current = projectId;
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeProjectId, authUser?.id, activateFile, commitFiles, commitOpenFiles, commitOrder,
  ]);

  // Persist only tab IDs and the active tab, scoped to this account; content
  // always reloads from MySQL.
  useEffect(() => {
    const projectId = activeProjectIdRef.current;
    const userId = authUser?.id;
    if (!projectId || !userId || tabsHydratedRef.current !== projectId) return;
    writeStoredTabs(userId, projectId, openOrder, activeFileId);
  }, [openOrder, activeFileId, activeProjectId, authUser?.id]);

  // Warn before closing the browser with unsaved or in-flight work.
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyIds.length > 0 || Object.values(collabStates).some((state) => state.saving)) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirtyIds.length, collabStates]);

  function handleAuthenticated(user: AuthUser) {
    setAuthUser(user);
    setAuthStatus('authenticated');
    setAuthMessage(null);
    setAccountOpen(false);
    setAccountError(null);
    setActiveTab('workspace');
  }

  async function signOut() {
    setAccountError(null);

    const saved = await flushAllSaves();
    if (!saved && !window.confirm('Some files could not be saved. Sign out anyway?')) {
      return;
    }

    setLoggingOut(true);
    try {
      await api.auth.logout();
      setAuthUser(null);
      setAuthStatus('anonymous');
      setAuthMessage(null);
      setAccountOpen(false);
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'UNAUTHENTICATED' || error.code === 'SESSION_EXPIRED')) {
        setAuthUser(null);
        setAuthStatus('anonymous');
        setAuthMessage(null);
        setAccountOpen(false);
      } else {
        setAccountError(errorMessage(error));
      }
    } finally {
      setLoggingOut(false);
    }
  }

  async function selectProject(projectId: string): Promise<boolean> {
    setActiveTab('workspace');
    if (projectId === activeProjectIdRef.current) return true;

    const ok = await flushAllSaves();
    if (!ok && !window.confirm('Some files could not be saved. Discard your unsaved changes?')) {
      return false;
    }

    activeProjectIdRef.current = projectId;
    setActiveProjectId(projectId);
    return true;
  }

  function openFileTab(fileId: string) {
    setActiveTab('workspace');

    const existing = openFilesRef.current[fileId];
    if (existing) {
      activateFile(fileId);
      return;
    }

    const summary = filesRef.current.find((item) => item.id === fileId && !item.isFolder);
    if (!summary) return;

    commitOpenFiles({ ...openFilesRef.current, [fileId]: { ...summary } });
    commitOrder([...openOrderRef.current, fileId]);
    activateFile(fileId);
  }

  async function closeFileTab(fileId: string) {
    const entry = openFilesRef.current[fileId];
    if (!entry) return;

    if (collabStatesRef.current[fileId]?.dirty) {
      const saved = await performSaveRef.current(fileId);
      if (!saved && !window.confirm('This file could not be saved. Close the tab and discard your changes?')) {
        return;
      }
    }

    removeOpenFiles(new Set([fileId]));
  }
  closeTabRef.current = (fileId) => { void closeFileTab(fileId); };

  async function createProject(event: FormEvent) {
    event.preventDefault();
    const name = projectName.trim();
    if (!name) return;

    setCreatingProject(true);
    try {
      const saved = await flushAllSaves();
      if (!saved && !window.confirm('Some files could not be saved. Create the project anyway?')) {
        return;
      }

      const { data } = await api.projects.create({
        name,
        description: projectDescription.trim(),
      });
      setProjects((current) => [data, ...current]);
      setProjectModalOpen(false);
      setProjectName('');
      setProjectDescription('');
      setNotice(null);
      activeProjectIdRef.current = data.id;
      setActiveProjectId(data.id);
      setActiveTab('workspace');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setCreatingProject(false);
    }
  }

  async function renameProject(project: Project) {
    const name = window.prompt('Rename project', project.name)?.trim();
    if (!name || name === project.name) return;

    try {
      const { data } = await api.projects.update(project.id, { name });
      setProjects((current) => current.map((item) => (item.id === data.id ? { ...item, ...data } : item)));
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function deleteProject(project: Project) {
    if (!window.confirm(`Delete "${project.name}" and all of its files? This cannot be undone.`)) return;

    if (project.id === activeProjectIdRef.current) {
      const ok = await flushAllSaves();
      if (!ok && !window.confirm('Some files could not be saved. Delete the project anyway?')) {
        return;
      }
      // Release live documents before the cascade deletes their file rows.
      await disposeAllProviders();
    }

    try {
      await api.projects.delete(project.id);
      const remaining = projects.filter((item) => item.id !== project.id);
      setProjects(remaining);

      if (project.id === activeProjectIdRef.current) {
        const nextId = remaining[0]?.id ?? null;
        activeProjectIdRef.current = nextId;
        setActiveProjectId(nextId);
      }
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function openTeamForProject(projectId: string) {
    const selected = await selectProject(projectId);
    if (selected) setTeamOpen(true);
  }

  function openActiveTeam() {
    if (!activeProject) {
      setNotice('Open a project before managing its team.');
      return;
    }
    setTeamOpen(true);
  }

  async function acceptPendingInvitation(invitation: PendingInvitation) {
    setAcceptingInvitationId(invitation.id);
    setPendingInvitationsError(null);
    try {
      const { data } = await api.invitations.acceptById(invitation.id);
      setPendingInvitations((current) => current.filter((item) => item.id !== invitation.id));
      await loadProjects();
      activeProjectIdRef.current = data.project.id;
      setActiveProjectId(data.project.id);
      setActiveTab('workspace');
      setNotice(`Joined "${data.project.name}" as ${ROLE_LABELS[data.role]}.`);
      void loadPendingInvitations();
    } catch (error) {
      setPendingInvitationsError(errorMessage(error));
    } finally {
      setAcceptingInvitationId(null);
    }
  }

  async function handleInviteAccepted(projectId: string, message: string) {
    setInviteToken(null);
    clearInviteHash();
    setNotice(message);
    await loadProjects();
    activeProjectIdRef.current = projectId;
    setActiveProjectId(projectId);
    setActiveTab('workspace');
    void loadPendingInvitations();
  }

  function closeInviteModal() {
    setInviteToken(null);
    clearInviteHash();
  }

  function handleLeftProject() {
    const leftId = activeProjectIdRef.current;
    void disposeAllProviders();
    const remaining = projects.filter((project) => project.id !== leftId);
    setProjects(remaining);

    const nextId = remaining[0]?.id ?? null;
    activeProjectIdRef.current = nextId;
    setActiveProjectId(nextId);
    setTeamOpen(false);
    setNotice('You left the project. Its files are no longer accessible to you.');
  }

  function toggleFolder(folderId: string) {
    setExpandedFolders((current) => {
      const next = new Set(current);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }

  function selectNode(item: ProjectFileSummary) {
    setActiveTab('workspace');
    if (item.isFolder) {
      setSelectedFolderId(item.id);
      toggleFolder(item.id);
      return;
    }
    setSelectedFolderId(null);
    openFileTab(item.id);
  }

  async function createEntry(isFolder: boolean) {
    const projectId = activeProjectIdRef.current;
    if (!projectId) {
      setNotice('Create or open a project before adding files.');
      return;
    }
    if (!canWriteRef.current) {
      setNotice('Your Viewer role allows reading files but not creating or editing them.');
      return;
    }

    const label = isFolder ? 'New folder name' : 'New file name (for example, app.ts)';
    const name = window.prompt(label)?.trim();
    if (!name) return;
    if (/[\\/]/.test(name)) {
      setNotice('Names cannot contain slashes. Create a folder first, then add files inside it.');
      return;
    }
    if (name === '.' || name === '..') {
      setNotice('That name is not allowed.');
      return;
    }

    const parent = filesRef.current.find(
      (item) => item.isFolder && item.id === selectedFolderId,
    ) ?? null;
    const duplicate = filesRef.current.some(
      (item) =>
        item.parentId === (parent?.id ?? null)
        && item.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) {
      window.alert(`"${name}" already exists in this location.`);
      return;
    }

    const saved = await flushAllSaves();
    if (!saved && !window.confirm('Some files could not be saved. Create a new item anyway?')) {
      return;
    }

    const path = parent ? `${parent.path}/${name}` : name;

    try {
      const { data } = await api.files.create(projectId, {
        name,
        path,
        parentId: parent?.id ?? null,
        isFolder,
        language: isFolder ? 'plaintext' : languageForFile(name),
        content: '',
      });

      const summary = toSummary(data);
      commitFiles([...filesRef.current, summary]);

      if (isFolder) {
        setSelectedFolderId(data.id);
        setExpandedFolders((current) => {
          const next = new Set(current);
          if (parent) next.add(parent.id);
          next.add(data.id);
          return next;
        });
      } else {
        commitOpenFiles({ ...openFilesRef.current, [data.id]: summary });
        commitOrder([...openOrderRef.current, data.id]);
        activateFile(data.id);
      }
      setActiveTab('workspace');
      setNotice(null);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  async function renameEntry(entry: ProjectFileSummary) {
    const projectId = activeProjectIdRef.current;
    if (!projectId) return;
    if (!canWriteRef.current) {
      setNotice('Your Viewer role allows reading files but not renaming them.');
      return;
    }

    const kind = entry.isFolder ? 'folder' : 'file';
    const name = window.prompt(`Rename ${kind}`, entry.name)?.trim();
    if (!name || name === entry.name) return;
    if (/[\\/]/.test(name) || name === '.' || name === '..') {
      setNotice(`${kind === 'folder' ? 'Folder' : 'File'} names cannot contain slashes.`);
      return;
    }
    if (filesRef.current.some(
      (item) =>
        item.id !== entry.id
        && item.parentId === entry.parentId
        && item.name.toLowerCase() === name.toLowerCase(),
    )) {
      window.alert(`"${name}" already exists in this location.`);
      return;
    }

    const saved = await flushAllSaves();
    if (!saved && !window.confirm('Some files could not be saved. Rename anyway?')) {
      return;
    }

    try {
      const { data } = await api.files.update(projectId, entry.id, {
        name,
        language: entry.isFolder ? undefined : languageForFile(name),
      });

      if (entry.isFolder) {
        // The server rewrites descendant paths inside a transaction.
        await reloadFiles(projectId);
      } else {
        const summary = toSummary(data);
        commitFiles(filesRef.current.map((item) => (item.id === data.id ? summary : item)));
        updateOpenFile(data.id, (current) => ({
          ...current,
          name: data.name,
          path: data.path,
          language: data.language,
        }));
      }
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        await reloadFiles(projectId).catch(() => undefined);
      }
      setNotice(errorMessage(error));
    }
  }

  /** Move a file or folder. The server derives the new path from the parent. */
  async function moveEntryTo(entry: ProjectFileSummary, parentId: string | null): Promise<boolean> {
    const projectId = activeProjectIdRef.current;
    if (!projectId) return false;

    const saved = await flushAllSaves();
    if (!saved && !window.confirm('Some files could not be saved. Move the item anyway?')) {
      return false;
    }

    try {
      await api.files.update(projectId, entry.id, { parentId });
      await reloadFiles(projectId);
      if (parentId) {
        setExpandedFolders((current) => {
          const next = new Set(current);
          next.add(parentId);
          return next;
        });
      }
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        await reloadFiles(projectId).catch(() => undefined);
      }
      throw error;
    }
  }

  async function deleteEntry(entry: ProjectFileSummary) {
    const projectId = activeProjectIdRef.current;
    if (!projectId) return;
    if (!canWriteRef.current) {
      setNotice('Your Viewer role allows reading files but not deleting them.');
      return;
    }

    const prompt = entry.isFolder
      ? `Delete folder "${entry.name}" and everything inside it? This cannot be undone.`
      : `Delete ${entry.name}? This cannot be undone.`;
    if (!window.confirm(prompt)) return;

    const affectedIds = new Set<string>([entry.id]);
    if (entry.isFolder) {
      for (const item of filesRef.current) {
        if (item.path.startsWith(`${entry.path}/`)) affectedIds.add(item.id);
      }
    }

    const affectedDirty = openOrderRef.current.filter((id) => (
      affectedIds.has(id) && Boolean(collabStatesRef.current[id]?.dirty)
    ));
    const saveResults = await Promise.all(affectedDirty.map((id) => performSaveRef.current(id)));
    if (saveResults.some((ok) => !ok) && !window.confirm('Some affected files could not be saved. Delete anyway?')) {
      return;
    }

    try {
      // Explicitly leave live rooms so the server flushes them and releases
      // the active-document lock before the rows are deleted.
      for (const id of affectedIds) {
        const provider = providersRef.current.get(id);
        if (provider) {
          providersRef.current.delete(id);
          delete collabStatesRef.current[id];
          await provider.dispose();
        }
      }
      setCollabStates({ ...collabStatesRef.current });

      await api.files.delete(projectId, entry.id);
      removeOpenFiles(affectedIds);
      applyFiles(filesRef.current.filter((item) => !affectedIds.has(item.id)));

      if (selectedFolderId && affectedIds.has(selectedFolderId)) setSelectedFolderId(null);
      setNotice(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setNotice('That item was already deleted. The explorer has been refreshed.');
        await reloadFiles(projectId).catch(() => undefined);
        return;
      }
      // Recreate providers for tabs that are still open after a failed delete.
      setProviderEpoch((current) => current + 1);
      setNotice(errorMessage(error));
    }
  }

  /** Rejoin the active file after a connection or authorization error. */
  function reconnectActiveFile() {
    const fileId = activeFileIdRef.current;
    if (fileId) reconnectFile(fileId);
  }

  // Global keyboard shortcuts: save, quick open, explorer toggle and tab close.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (modifier && key === 's') {
        event.preventDefault();
        if (activeFileIdRef.current) void performSaveRef.current(activeFileIdRef.current);
        return;
      }

      if (modifier && key === 'p') {
        event.preventDefault();
        setQuickOpen(true);
        return;
      }

      if (modifier && key === 'b') {
        event.preventDefault();
        setSidebarOpen((current) => !current);
        return;
      }

      if (modifier && event.shiftKey && key === 'f') {
        event.preventDefault();
        setSidebarOpen(true);
        window.setTimeout(() => fileSearchRef.current?.focus(), 0);
        return;
      }

      if (event.altKey && key === 'w') {
        event.preventDefault();
        if (activeFileIdRef.current) closeTabRef.current(activeFileIdRef.current);
        return;
      }

      if (event.key === 'Escape') {
        setQuickOpen(false);
        setMoveEntry(null);
        setHtmlPreview(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const activeCollabError = activeCollab?.saveError ?? null;
  const activeCollabLoadError = activeCollab?.phase === 'error' ? activeCollab.loadError : null;

  const saveLabel = !activeFile
    ? 'No file open'
    : activeCollabLoadError
      ? 'Live document unavailable'
      : activeCollab?.connection === 'reconnecting'
        ? 'Reconnecting…'
        : activeCollabError
          ? 'Save failed — retry'
          : activeCollab?.saving
            ? 'Saving…'
            : dirtyIds.length > 0
              ? `${dirtyIds.length} unsaved ${dirtyIds.length === 1 ? 'file' : 'files'}`
              : !activeCollab?.synced
                ? 'Connecting…'
                : 'All changes saved · live';

  const saveClass = activeCollabLoadError || activeCollabError || activeCollab?.connection === 'error'
    ? 'error'
    : dirtyIds.length > 0
      || activeCollab?.saving
      || activeCollab?.connection === 'reconnecting'
      || (activeFile && !activeCollab?.synced)
      ? 'unsaved'
      : '';

  const fileCount = files.filter((item) => !item.isFolder).length;
  const folderCount = files.length - fileCount;

  // Build a parent -> children index, folders first, then alphabetical.
  const fileTree = useMemo(() => {
    const byParent = new Map<string | null, ProjectFileSummary[]>();
    for (const item of files) {
      const key = item.parentId;
      const list = byParent.get(key);
      if (list) list.push(item);
      else byParent.set(key, [item]);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => (
        a.isFolder === b.isFolder ? a.name.localeCompare(b.name) : a.isFolder ? -1 : 1
      ));
    }

    // While searching, show matching files plus the folders that contain them.
    const query = fileQuery.trim().toLowerCase();
    let visibleIds: Set<string> | null = null;
    if (query) {
      const byId = new Map(files.map((item) => [item.id, item]));
      visibleIds = new Set<string>();
      for (const item of files) {
        if (item.isFolder) continue;
        if (item.name.toLowerCase().includes(query) || item.path.toLowerCase().includes(query)) {
          visibleIds.add(item.id);
          let parentId = item.parentId;
          while (parentId) {
            visibleIds.add(parentId);
            parentId = byId.get(parentId)?.parentId ?? null;
          }
        }
      }
      if (visibleIds.size === 0) {
        for (const item of files) {
          if (item.isFolder && (item.name.toLowerCase().includes(query) || item.path.toLowerCase().includes(query))) {
            visibleIds.add(item.id);
          }
        }
      }
    }

    return { byParent, visibleIds };
  }, [files, fileQuery]);

  const treeRows = useMemo(() => {
    const rows: Array<{ item: ProjectFileSummary; depth: number }> = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const item of fileTree.byParent.get(parentId) ?? []) {
        if (fileTree.visibleIds && !fileTree.visibleIds.has(item.id)) continue;
        rows.push({ item, depth });
        const expanded = fileTree.visibleIds !== null || expandedFolders.has(item.id);
        if (item.isFolder && expanded) walk(item.id, depth + 1);
      }
    };
    walk(null, 0);
    return rows;
  }, [fileTree, expandedFolders]);

  const filteredProjects = useMemo(() => {
    const query = projectQuery.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => (
      project.name.toLowerCase().includes(query)
      || project.description.toLowerCase().includes(query)
    ));
  }, [projects, projectQuery]);

  if (authStatus === 'loading') {
    return (
      <div className="auth-shell auth-shell-loading">
        <div className="auth-loading-card">
          <span className="brand-mark"><Code2 size={20} strokeWidth={2.5} /></span>
          <div>
            <strong>CodeTogether</strong>
            <span>Restoring your session…</span>
          </div>
          <span className="auth-spinner" aria-label="Loading" />
        </div>
      </div>
    );
  }

  if (authStatus !== 'authenticated' || !authUser) {
    return <AuthScreen onAuthenticated={handleAuthenticated} initialMessage={authMessage} />;
  }

  const userInitials = initialsFor(authUser.username);

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={() => setActiveTab('workspace')}>
          <span className="brand-mark"><Code2 size={20} strokeWidth={2.5} /></span>
          <span>code<span className="brand-light">together</span></span>
          <span className="beta-tag">BETA</span>
        </a>
        <div className="topbar-center">
          <span className="crumb-muted">Workspace</span><ChevronRight size={14} />
          <button className="crumb-button" onClick={() => setActiveTab('projects')}>
            <span className="crumb-current">{activeProject?.name ?? 'No project'}</span><ChevronDown size={14} />
          </button>
        </div>
        <div className="topbar-actions">
          <span className={`save-state ${saveClass}`} title={activeCollabError ?? activeCollabLoadError ?? undefined}>
            <span className="status-dot" />{saveLabel}
          </span>
          {(activeCollabError || activeCollabLoadError) && (
            <button
              className="icon-button"
              title={activeCollabLoadError ? 'Reconnect live document' : 'Retry save'}
              onClick={() => {
                const fileId = activeFileIdRef.current;
                if (!fileId) return;
                if (activeCollabLoadError) reconnectFile(fileId);
                else void performSaveRef.current(fileId);
              }}
            >
              <RefreshCw size={16} />
            </button>
          )}
          <button className="icon-button" aria-label="Notifications"><Bell size={17} /></button>
          <button
            className="avatar avatar-you account-trigger"
            aria-label="Account menu"
            title={`@${authUser.username}`}
            onClick={() => { setAccountError(null); setAccountOpen(true); }}
          >
            {userInitials}
          </button>
        </div>
      </header>

      <div className="workspace-layout">
        <aside className="activitybar">
          <button className={`activity-item ${activeTab === 'workspace' ? 'selected' : ''}`} title="Workspace" onClick={() => setActiveTab('workspace')}><Code2 size={21} /></button>
          <button className={`activity-item ${activeTab === 'projects' ? 'selected' : ''}`} title="Projects" onClick={() => setActiveTab('projects')}><LayoutDashboard size={20} /></button>
          <button className="activity-item" title="Activity"><Activity size={20} /></button>
          <div className="activity-spacer" />
          <button className="activity-item" title="Settings"><Settings2 size={20} /></button>
          <button
            className="activity-profile"
            title={`Account · @${authUser.username}`}
            onClick={() => { setAccountError(null); setAccountOpen(true); }}
          >
            {userInitials}
          </button>
        </aside>

        {sidebarOpen && <aside className="file-sidebar">
          <div className="sidebar-heading"><span>EXPLORER</span><button className="subtle-icon" title="Collapse explorer (Ctrl+B)" onClick={() => setSidebarOpen(false)}><MoreHorizontal size={18} /></button></div>
          <div className="project-tree-heading">
            <button
              className={`tree-root ${selectedFolderId === null ? 'selected-folder' : ''}`}
              onClick={() => { setSelectedFolderId(null); setActiveTab('workspace'); }}
              title="Project root — new items are created here"
            >
              <ChevronDown size={14} /><Folder size={15} />
              <span>{activeProject ? activeProject.name.toUpperCase() : 'NO PROJECT'}</span>
            </button>
            <div className="tree-actions">
              <button title={canWrite ? 'New file' : 'Viewers cannot create files'} onClick={() => { void createEntry(false); }} disabled={!activeProject || !canWrite}><FilePlus2 size={15} /></button>
              <button title={canWrite ? 'New folder' : 'Viewers cannot create folders'} onClick={() => { void createEntry(true); }} disabled={!activeProject || !canWrite}><FolderPlus size={15} /></button>
              <button title="Rename selected (double-click a row)" disabled={!selectedEntry || !canWrite} onClick={() => { if (selectedEntry) void renameEntry(selectedEntry); }}><Pencil size={14} /></button>
              <button title="Move selected" disabled={!selectedEntry || !canWrite} onClick={() => { if (selectedEntry) setMoveEntry(selectedEntry); }}><FolderInput size={14} /></button>
              <button title="Delete selected" disabled={!selectedEntry || !canWrite} onClick={() => { if (selectedEntry) void deleteEntry(selectedEntry); }}><Trash2 size={14} /></button>
            </div>
          </div>

          <div className="sidebar-search">
            <Search size={13} />
            <input
              ref={fileSearchRef}
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              placeholder="Search files…"
              aria-label="Search files in this project"
            />
            {fileQuery && <button className="subtle-icon compact" onClick={() => setFileQuery('')} aria-label="Clear file search"><X size={12} /></button>}
          </div>

          <div className="file-list">
            {filesLoading && <p className="muted-small">Loading files…</p>}
            {filesError && (
              <div className="inline-error small">
                <span>{filesError}</span>
                <button
                  className="secondary-button"
                  onClick={() => {
                    if (!activeProject) return;
                    void reloadFiles(activeProject.id)
                      .then(() => setFilesError(null))
                      .catch((error) => setFilesError(errorMessage(error)));
                  }}
                >
                  Retry
                </button>
              </div>
            )}
            {!filesLoading && !filesError && treeRows.length === 0 && (
              <p className="muted-small">
                {files.length === 0
                  ? 'No files yet. Create your first file or folder above.'
                  : 'No files match your search.'}
              </p>
            )}
            {treeRows.map(({ item, depth }) => (
              <button
                key={item.id}
                className={`file-row tree-row ${item.isFolder && selectedFolderId === item.id ? 'selected-folder' : ''} ${!item.isFolder && activeFileId === item.id ? 'active' : ''}`}
                style={{ paddingLeft: 9 + depth * 14 }}
                onClick={() => selectNode(item)}
                onDoubleClick={() => { if (canWrite) void renameEntry(item); }}
                title={item.path}
              >
                {item.isFolder ? (
                  <>
                    {(fileTree.visibleIds !== null || expandedFolders.has(item.id))
                      ? <ChevronDown size={13} />
                      : <ChevronRight size={13} />}
                    <Folder size={14} className="folder-icon" />
                  </>
                ) : (
                  <>
                    <span className="tree-chevron-spacer" />
                    <FileCode2 size={15} className={fileIconClass(item.name)} />
                  </>
                )}
                <span className="file-row-name">{item.name}</span>
                {!item.isFolder && dirtyIds.includes(item.id) && <span className="unsaved-dot" />}
              </button>
            ))}
          </div>
          <div className="sidebar-bottom">
            <div className="sidebar-heading"><span>DETAILS</span><ChevronDown size={15} /></div>
            <p className="muted-small">
              {activeProject
                ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'} · ${folderCount} ${folderCount === 1 ? 'folder' : 'folders'} · stored in MySQL`
                : 'Select a project to see its files.'}
            </p>
            {activeProject && (
              <p className="muted-small">
                New items are created in {selectedFolder ? `“${selectedFolder.name}”` : 'the project root'}.
              </p>
            )}
            <p className="muted-small shortcut-hint">
              <kbd>Ctrl</kbd>+<kbd>P</kbd> search · <kbd>Ctrl</kbd>+<kbd>S</kbd> save
            </p>
          </div>
        </aside>}

        <main className="main-area">
          {notice && (
            <div className="inline-banner" role="alert">
              <span>{notice}</span>
              <button className="subtle-icon" onClick={() => setNotice(null)} aria-label="Dismiss message"><X size={15} /></button>
            </div>
          )}

          {activeCollabError && (
            <div className="inline-banner error" role="alert">
              <span>Not saved: {activeCollabError}</span>
              <span className="inline-banner-actions">
                <button className="primary-button" onClick={() => { void performSaveRef.current(activeFile!.id); }}>Retry save</button>
                <button className="secondary-button" onClick={reconnectActiveFile}>Reconnect</button>
              </span>
            </div>
          )}

          {activeCollabLoadError && (
            <div className="inline-banner error" role="alert">
              <span>Live document unavailable: {activeCollabLoadError}</span>
              <span className="inline-banner-actions">
                <button className="primary-button" onClick={reconnectActiveFile}>Reconnect</button>
              </span>
            </div>
          )}

          {activeTab === 'projects' ? (
            <section className="projects-view">
              <div className="page-eyebrow"><span className="eyebrow-line" /> YOUR WORKSPACE</div>
              <h1>Your projects, <span>in sync.</span></h1>
              <p className="page-description">A focused space for teams to build better software together.</p>
              <div className="project-toolbar">
                <div className="search-box"><Search size={16} /><input value={projectQuery} onChange={(e) => setProjectQuery(e.target.value)} placeholder="Search projects…" /></div>
                <button className="primary-button" onClick={() => setProjectModalOpen(true)}><Plus size={16} /> New project</button>
              </div>

              {(pendingInvitationsLoading || pendingInvitations.length > 0 || pendingInvitationsError) && (
                <section className="invitation-inbox">
                  <div className="invitation-inbox-heading">
                    <span><Mail size={14} /> INVITATIONS FOR YOU</span>
                    <button className="subtle-icon" title="Refresh invitations" onClick={() => { void loadPendingInvitations(); }}>
                      <RefreshCw size={14} />
                    </button>
                  </div>
                  {pendingInvitationsLoading && <p className="team-muted">Checking for invitations…</p>}
                  {pendingInvitationsError && (
                    <div className="inline-error small">
                      <span>{pendingInvitationsError}</span>
                      <button className="secondary-button" onClick={() => { void loadPendingInvitations(); }}>Retry</button>
                    </div>
                  )}
                  {pendingInvitations.map((invitation) => (
                    <div className="invitation-inbox-row" key={invitation.id}>
                      <div className="invitation-icon"><Users size={14} /></div>
                      <div className="invitation-info">
                        <strong>{invitation.project.name}</strong>
                        <span>
                          {invitation.invitedBy.username} invited you as {ROLE_LABELS[invitation.role]} ·
                          {' '}expires {new Date(invitation.expiresAt).toLocaleDateString()}
                        </span>
                      </div>
                      <button
                        className="primary-button"
                        onClick={() => { void acceptPendingInvitation(invitation); }}
                        disabled={acceptingInvitationId === invitation.id}
                      >
                        {acceptingInvitationId === invitation.id
                          ? 'Joining…'
                          : invitation.alreadyMember ? 'Open' : 'Accept'}
                      </button>
                    </div>
                  ))}
                </section>
              )}

              {projectsLoading && <p className="muted-small">Loading projects…</p>}
              {projectsError && (
                <div className="inline-error">
                  <span>{projectsError}</span>
                  <button className="primary-button" onClick={() => { void loadProjects(); }}>Retry</button>
                </div>
              )}
              {!projectsLoading && !projectsError && projects.length === 0 && (
                <p className="projects-empty">You do not have any projects yet. Create one, or accept an invitation to join a team.</p>
              )}
              {!projectsLoading && !projectsError && projects.length > 0 && filteredProjects.length === 0 && (
                <p className="projects-empty">No projects match “{projectQuery.trim()}”.</p>
              )}

              <div className="project-card-grid">
                {filteredProjects.map((project) => (
                  <div
                    key={project.id}
                    className={`project-card ${project.id === activeProjectId ? 'selected' : ''}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => { void selectProject(project.id); }}
                    onKeyDown={(event) => { if (event.key === 'Enter') void selectProject(project.id); }}
                  >
                    <div className="project-card-icon"><Code2 size={22} /></div>
                    <div className="project-card-top">
                      <span className="project-status">
                        <span className="status-dot" /> {project.id === activeProjectId ? 'Open' : ROLE_LABELS[project.role ?? 'VIEWER']}
                      </span>
                      <span className="project-card-actions">
                        <button
                          className="subtle-icon"
                          title="Project team and invitations"
                          onClick={(event) => { event.stopPropagation(); void openTeamForProject(project.id); }}
                        >
                          <Users size={14} />
                        </button>
                        {canAdministerWithRole(project.role) && (
                          <button
                            className="subtle-icon"
                            title="Rename project"
                            onClick={(event) => { event.stopPropagation(); void renameProject(project); }}
                          >
                            <Pencil size={14} />
                          </button>
                        )}
                        {project.role === 'OWNER' && (
                          <button
                            className="subtle-icon"
                            title="Delete project"
                            onClick={(event) => { event.stopPropagation(); void deleteProject(project); }}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </span>
                    </div>
                    <h3>{project.name}</h3>
                    <p>{project.description || 'No description yet.'}</p>
                    <div className="project-card-footer">
                      <span><FileCode2 size={14} /> {project.id === activeProjectId ? fileCount : project._count?.files ?? 0} files</span>
                      <span><Users size={14} /> {project._count?.members ?? 1} members</span>
                      <span><GitBranch size={14} /> {ROLE_LABELS[project.role ?? 'VIEWER']}</span>
                    </div>
                  </div>
                ))}

                <button className="new-project-card" onClick={() => setProjectModalOpen(true)}>
                  <span className="new-project-icon"><Plus size={20} /></span>
                  <strong>Create a project</strong>
                  <span>Start something new</span>
                </button>
              </div>
            </section>
          ) : (
            <>
              {!activeProject ? (
                <div className="empty-state">
                  <div className="empty-state-icon"><Folder size={26} /></div>
                  <h2>No project open</h2>
                  <p>Projects and files are stored in MySQL. Create your first project to start coding.</p>
                  <button className="primary-button" onClick={() => setProjectModalOpen(true)}><Plus size={16} /> Create a project</button>
                </div>
              ) : (
                <>
                  <div className="editor-toolbar">
                    <div className="tabs" role="tablist" aria-label="Open files">
                      {openOrder.map((fileId) => {
                        const file = openFiles[fileId];
                        if (!file) return null;
                        const fileCollab = collabStates[file.id];
                        const isDirty = Boolean(fileCollab?.dirty);
                        return (
                          <div
                            key={file.id}
                            className={`editor-tab ${file.id === activeFileId ? 'active' : ''}`}
                          >
                            <button
                              className="editor-tab-main"
                              role="tab"
                              aria-selected={file.id === activeFileId}
                              onClick={() => openFileTab(file.id)}
                              title={file.path}
                            >
                              <FileCode2 size={14} />
                              <span>{file.name}</span>
                              {fileCollab?.saving && <span className="tab-saving" aria-label="Saving" />}
                              {isDirty && !fileCollab?.saving && (
                                <span className={`tab-unsaved ${fileCollab?.saveError ? 'tab-error' : ''}`} aria-label="Unsaved changes" />
                              )}
                            </button>
                            <button
                              className="tab-close"
                              title="Close tab (Alt+W)"
                              aria-label={`Close ${file.name}`}
                              onClick={(event) => { event.stopPropagation(); void closeFileTab(file.id); }}
                            >
                              <X size={12} />
                            </button>
                          </div>
                        );
                      })}
                      {openOrder.length === 0 && <span className="tabs-empty">No open tabs</span>}
                    </div>
                    <div className="editor-tools">
                      <button
                        className="icon-button small"
                        title="Save file (Ctrl+S)"
                        aria-label="Save file"
                        disabled={!canWrite || !activeFileDirty || activeCollab?.saving}
                        onClick={() => { if (activeFileIdRef.current) void performSaveRef.current(activeFileIdRef.current); }}
                      >
                        <Save size={15} />
                      </button>
                      <button
                        className="icon-button small"
                        title="Search files (Ctrl+P)"
                        aria-label="Search files"
                        onClick={() => setQuickOpen(true)}
                      >
                        <Search size={15} />
                      </button>
                      {activeFile && isHtmlFile(activeFile.name) && (
                        <button
                          className="icon-button small"
                          title="Preview this HTML file in a sandboxed frame"
                          aria-label="Preview HTML"
                          onClick={() => { void openHtmlPreview(); }}
                        >
                          <Eye size={15} />
                        </button>
                      )}
                      <button
                        className="run-button"
                        onClick={() => { void runActiveFile(); }}
                        disabled={!canRunActiveFile}
                        title={executionBlockedReason ?? `Run ${activeFile?.name ?? 'the active file'} in the sandbox`}
                      >
                        <Play size={14} fill="currentColor" />
                        {execution.starting ? 'Starting…' : execution.isActive ? 'Running…' : 'Run'}
                      </button>
                      <button className="icon-button small" title="Project team and invitations" onClick={openActiveTeam}><Share2 size={16} /></button>
                    </div>
                  </div>

                  {executionSandboxNotice && (
                    <div className="exec-alert sandbox-notice" role="status">
                      <p>
                        <strong>
                          {executionSandboxNotice.kind === 'disabled'
                            ? 'Secure code execution is unavailable — '
                            : 'Execution status unknown — '}
                        </strong>
                        <span>{executionSandboxNotice.message}</span>
                      </p>
                      <button className="secondary-button" onClick={execution.refreshCapabilities}>
                        {executionSandboxNotice.kind === 'disabled' ? 'Check again' : 'Retry'}
                      </button>
                    </div>
                  )}

                  {activeFile ? (
                    <>
                      <div className="editor-breadcrumb">
                        <span>{activeProject.name}</span><ChevronRight size={13} /><span>{activeFile.path}</span>
                        {liveCollaborators.length > 0 && (
                          <span className="live-collaborators" aria-label="People in this document">
                            {liveCollaborators.slice(0, 5).map((collaborator) => (
                              <span
                                key={collaborator.socketId}
                                className={`collaborator-chip collab-bg-${collaborator.colorIndex % 8}`}
                                title={`${collaborator.user.username} is editing this file`}
                              >
                                {collaborator.user.username.slice(0, 1).toUpperCase()}
                              </span>
                            ))}
                            {liveCollaborators.length > 5 && (
                              <span className="collaborator-chip more">+{liveCollaborators.length - 5}</span>
                            )}
                          </span>
                        )}
                        <span className="breadcrumb-right">
                          <ShieldCheck size={13} />
                          {!canWrite
                            ? 'Read-only access'
                            : activeCollab?.connection === 'reconnecting'
                              ? 'Reconnecting to the live document…'
                              : !activeCollab?.synced
                                ? 'Connecting to the live document…'
                                : activeCollabError
                                  ? 'Persistence failed — retry'
                                  : activeFileDirty
                                    ? 'Unsaved changes · synced live'
                                    : 'Saved to MySQL · live'}
                        </span>
                      </div>
                      <div className="editor-container">
                        {!activeProvider ? (
                          <div className="editor-placeholder">
                            <RefreshCw size={20} className="spin" />
                            <span>Opening the live document…</span>
                          </div>
                        ) : activeCollabLoadError ? (
                          <div className="editor-placeholder error">
                            <span>{activeCollabLoadError}</span>
                            <button className="secondary-button" onClick={() => reconnectFile(activeFile.id)}>Try again</button>
                          </div>
                        ) : (
                          <CollaborativeEditor
                            key={`${activeFile.id}:${activeProvider.instanceId}`}
                            provider={activeProvider}
                            language={activeFile.language}
                            readOnly={!canWrite || !activeCollab?.synced}
                            collaborators={activeCollab?.collaborators ?? []}
                          />
                        )}
                      </div>
                      {showOutput && (
                        <ExecutionConsole
                          capabilities={execution.capabilities}
                          capabilitiesLoading={execution.capabilitiesLoading}
                          capabilitiesError={execution.capabilitiesError}
                          job={execution.job}
                          starting={execution.starting}
                          cancelling={execution.cancelling}
                          error={execution.error}
                          fileNameFor={executionFileNameFor}
                          onCancel={() => { void execution.cancel(); }}
                          onClose={() => setShowOutput(false)}
                          onRetryCapabilities={execution.refreshCapabilities}
                        />
                      )}
                      <div className="statusbar">
                        <span><GitBranch size={13} /> main</span>
                        <span>{activeFile.language}</span>
                        <span>UTF-8</span>
                        <span>Spaces: 2</span>
                        <span className="status-spacer" />
                        {execution.job && (
                          <span
                            className={`status-exec status-exec-${execution.job.status.toLowerCase().replace('_', '-')}`}
                            title="Last execution in this project"
                          >
                            <Zap size={13} />
                            {EXECUTION_STATUS_LABELS[execution.job.status]}
                          </span>
                        )}
                        <span>{openOrder.length} open {openOrder.length === 1 ? 'tab' : 'tabs'}</span>
                        <span><Globe2 size={13} /> MySQL</span>
                        <span><Zap size={13} /> CodeTogether</span>
                      </div>
                    </>
                  ) : (
                    <div className="empty-state">
                      <div className="empty-state-icon"><FilePlus2 size={26} /></div>
                      <h2>{files.length === 0 ? 'This project is empty' : 'No file open'}</h2>
                      <p>
                        {files.length === 0
                          ? 'Create a file to start editing — every save is persisted to MySQL.'
                          : 'Select a file in the explorer, use Ctrl+P, or create a new file or folder here.'}
                      </p>
                      <span className="empty-actions">
                        <button className="primary-button" onClick={() => { void createEntry(false); }} disabled={!canWrite}><Plus size={16} /> New file</button>
                        <button className="secondary-button" onClick={() => { void createEntry(true); }} disabled={!canWrite}><FolderPlus size={16} /> New folder</button>
                      </span>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </main>

        {chatOpen && (
          <ChatPanel
            project={activeProject}
            currentUser={authUser}
            role={activeRole ?? 'VIEWER'}
            canAdminister={canAdminister}
            onManageTeam={openActiveTeam}
            onClose={() => setChatOpen(false)}
          />
        )}
        {!chatOpen && <button className="reopen-panel" onClick={() => setChatOpen(true)}><Users size={16} /> Team</button>}
      </div>

      {quickOpen && activeProject && (
        <QuickOpen
          files={files}
          onSelect={openFileTab}
          onClose={() => setQuickOpen(false)}
        />
      )}

      {moveEntry && activeProject && (
        <MoveEntryModal
          entry={moveEntry}
          files={files}
          onClose={() => setMoveEntry(null)}
          onMove={(parentId) => moveEntryTo(moveEntry, parentId)}
        />
      )}

      {htmlPreview && (
        <HtmlPreview
          name={htmlPreview.name}
          html={htmlPreview.html}
          onClose={() => setHtmlPreview(null)}
        />
      )}

      {teamOpen && activeProject && (
        <TeamModal
          projectId={activeProject.id}
          projectName={activeProject.name}
          currentUserId={authUser.id}
          role={activeProject.role ?? 'VIEWER'}
          onClose={() => setTeamOpen(false)}
          onLeft={handleLeftProject}
        />
      )}

      {inviteToken && (
        <InviteAcceptModal
          token={inviteToken}
          onClose={closeInviteModal}
          onAccepted={handleInviteAccepted}
        />
      )}

      {accountOpen && (
        <div className="modal-backdrop" onClick={() => setAccountOpen(false)}>
          <div
            className="invite-modal account-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button className="modal-close" onClick={() => setAccountOpen(false)} aria-label="Close account panel"><X size={18} /></button>

            <div className="account-head">
              <div className="avatar avatar-you account-avatar">{userInitials}</div>
              <div className="account-identity">
                <h2 id="account-title">{authUser.username}</h2>
                <p>{authUser.email}</p>
              </div>
            </div>

            <div className="account-meta">
              <div>
                <span>MEMBER SINCE</span>
                <strong>{new Date(authUser.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}</strong>
              </div>
              <div>
                <span>SESSION</span>
                <strong><span className="status-dot" /> Active · this tab only</strong>
              </div>
            </div>

            <div className="account-security">
              <UserRound size={16} />
              <p>Your password is hashed with Argon2id and is never stored in the browser. Each tab keeps its own session token, and sessions live in MySQL and expire automatically.</p>
            </div>

            <p className="account-note">Email verification, password reset and account deletion are not implemented yet.</p>

            {accountError && (
              <div className="inline-banner error auth-banner" role="alert"><span>{accountError}</span></div>
            )}

            <button className="secondary-button full-button account-logout" type="button" onClick={() => { void signOut(); }} disabled={loggingOut}>
              <LogOut size={15} /> {loggingOut ? 'Signing out…' : 'Sign out'}
            </button>
            <button className="primary-button full-button account-stay" type="button" onClick={() => setAccountOpen(false)}>
              Back to workspace
            </button>
          </div>
        </div>
      )}

      {projectModalOpen && (
        <div className="modal-backdrop" onClick={() => setProjectModalOpen(false)}>
          <form className="invite-modal" onClick={(e) => e.stopPropagation()} onSubmit={createProject}>
            <button type="button" className="modal-close" onClick={() => setProjectModalOpen(false)}><X size={18} /></button>
            <div className="modal-icon"><Plus size={21} /></div>
            <h2>Create a project</h2>
            <p>Projects and their files are stored in MySQL.</p>
            <label className="field-label" htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              className="text-input"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              maxLength={80}
              placeholder="my-team-project"
              autoFocus
              required
            />
            <label className="field-label" htmlFor="project-description">Description</label>
            <textarea
              id="project-description"
              className="text-input text-area"
              value={projectDescription}
              onChange={(e) => setProjectDescription(e.target.value)}
              maxLength={500}
              placeholder="What are you building?"
              rows={3}
            />
            <button className="primary-button full-button" type="submit" disabled={creatingProject || !projectName.trim()}>
              {creatingProject ? 'Creating…' : 'Create project'}
            </button>
          </form>
        </div>
      )}

      <div className="bottom-hint"><Command size={12} /> Built for teams who build things together <span>·</span> Development preview</div>
    </div>
  );
}
