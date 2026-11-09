import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type ExecutionCapabilities,
  type ExecutionJob,
  type ExecutionLanguage,
} from '../api';
import { isTerminalExecutionStatus } from './language';

const POLL_INTERVAL_MS = 600;
const POLL_RETRY_MS = 1_500;

function describeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong while talking to the execution service.';
}

export interface UseExecutionOptions {
  projectId: string | null;
}

export interface UseExecutionResult {
  capabilities: ExecutionCapabilities | null;
  capabilitiesLoading: boolean;
  capabilitiesError: string | null;
  refreshCapabilities: () => void;
  job: ExecutionJob | null;
  starting: boolean;
  cancelling: boolean;
  error: string | null;
  isActive: boolean;
  start: (
    fileId: string,
    language: ExecutionLanguage,
    beforeStart?: () => Promise<boolean>,
  ) => Promise<ExecutionJob | null>;
  cancel: () => Promise<void>;
  clear: () => void;
}

/**
 * Owns execution state for the active project: capability discovery, starting
 * a job, polling until it reaches a terminal status, and cancellation. Polling
 * stops automatically on completion and whenever the project changes.
 */
export function useExecution({ projectId }: UseExecutionOptions): UseExecutionResult {
  const [capabilities, setCapabilities] = useState<ExecutionCapabilities | null>(null);
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [capabilityRequest, setCapabilityRequest] = useState(0);
  const [job, setJob] = useState<ExecutionJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);
  jobIdRef.current = job?.id ?? null;
  // React state updates are asynchronous, so two fast clicks can both observe
  // `starting === false`. This ref closes that window before the request starts.
  const startGuardRef = useRef(false);

  // A project switch invalidates both the sandbox view and any previous job.
  useEffect(() => {
    setJob(null);
    setStarting(false);
    setCancelling(false);
    setError(null);
    setCapabilities(null);
    setCapabilitiesError(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;

    let cancelled = false;
    setCapabilitiesLoading(true);
    setCapabilitiesError(null);

    void api.executions.capabilities(projectId)
      .then(({ data }) => {
        if (!cancelled) setCapabilities(data);
      })
      .catch((caught) => {
        if (!cancelled) setCapabilitiesError(describeError(caught));
      })
      .finally(() => {
        if (!cancelled) setCapabilitiesLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, capabilityRequest]);

  const refreshCapabilities = useCallback(() => {
    setCapabilityRequest((value) => value + 1);
  }, []);

  // Poll only the job ID. Status changes do not restart the loop, so a slow
  // request cannot produce overlapping polls.
  useEffect(() => {
    if (!projectId || !job) return;
    if (isTerminalExecutionStatus(job.status)) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const { data } = await api.executions.get(projectId, job.id);
        if (cancelled) return;
        setJob(data);
        if (!isTerminalExecutionStatus(data.status)) {
          timer = setTimeout(poll, POLL_INTERVAL_MS);
        }
      } catch (caught) {
        if (cancelled) return;
        setError(describeError(caught));
        // The job may still be running server-side; keep trying to recover
        // the status instead of leaving the UI stuck on "Running".
        timer = setTimeout(poll, POLL_RETRY_MS);
      }
    };

    timer = setTimeout(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, job?.id]);

  const start = useCallback(async (
    fileId: string,
    language: ExecutionLanguage,
    beforeStart?: () => Promise<boolean>,
  ): Promise<ExecutionJob | null> => {
    if (!projectId) return null;
    if (job && !isTerminalExecutionStatus(job.status)) return null;
    if (starting || startGuardRef.current) return null;

    startGuardRef.current = true;
    setError(null);
    setStarting(true);
    try {
      if (beforeStart) {
        const ready = await beforeStart();
        if (!ready) {
          setError('The file could not be saved, so it was not executed.');
          return null;
        }
      }

      const { data } = await api.executions.start(projectId, { fileId, language });
      setJob(data);
      return data;
    } catch (caught) {
      setError(describeError(caught));
      return null;
    } finally {
      startGuardRef.current = false;
      setStarting(false);
    }
  }, [projectId, job, starting]);

  const cancel = useCallback(async () => {
    if (!projectId || !job || isTerminalExecutionStatus(job.status)) return;
    setCancelling(true);
    setError(null);
    try {
      const { data } = await api.executions.cancel(projectId, job.id);
      // Ignore a late response if the user switched projects mid-request.
      if (jobIdRef.current === data.id) setJob(data);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setCancelling(false);
    }
  }, [projectId, job]);

  const clear = useCallback(() => {
    setJob(null);
    setError(null);
  }, []);

  return {
    capabilities,
    capabilitiesLoading,
    capabilitiesError,
    refreshCapabilities,
    job,
    starting,
    cancelling,
    error,
    isActive: Boolean(job && !isTerminalExecutionStatus(job.status)),
    start,
    cancel,
    clear,
  };
}
