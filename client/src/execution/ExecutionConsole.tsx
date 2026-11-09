import { Terminal, X } from 'lucide-react';
import type { ExecutionCapabilities, ExecutionJob } from '../api';
import {
  EXECUTION_LANGUAGE_LABELS,
  EXECUTION_STATUS_LABELS,
  formatDuration,
  isTerminalExecutionStatus,
} from './language';

interface ExecutionConsoleProps {
  capabilities: ExecutionCapabilities | null;
  capabilitiesLoading: boolean;
  capabilitiesError: string | null;
  job: ExecutionJob | null;
  starting: boolean;
  cancelling: boolean;
  error: string | null;
  fileNameFor: (fileId: string | null) => string | null;
  onCancel: () => void;
  onClose: () => void;
  onRetryCapabilities: () => void;
}

function statusClass(job: ExecutionJob): string {
  return `exec-status-${job.status.toLowerCase().replace('_', '-')}`;
}

/**
 * Bounded execution output. stdout/stderr are rendered as text nodes inside
 * <pre>, never as HTML, and the server has already capped their size.
 */
export default function ExecutionConsole({
  capabilities,
  capabilitiesLoading,
  capabilitiesError,
  job,
  starting,
  cancelling,
  error,
  fileNameFor,
  onCancel,
  onClose,
  onRetryCapabilities,
}: ExecutionConsoleProps) {
  const active = Boolean(job && !isTerminalExecutionStatus(job.status));
  const fileName = fileNameFor(job?.fileId ?? null);
  const statusLabel = starting
    ? 'Starting'
    : job
      ? EXECUTION_STATUS_LABELS[job.status]
      : 'Idle';

  return (
    <div className="output-panel execution-console" aria-live="polite">
      <div className="output-heading">
        <span>
          <Terminal size={15} /> OUTPUT
          <span className={`exec-status ${job ? statusClass(job) : 'exec-status-idle'}`}>
            {active && <span className="exec-spinner" aria-hidden="true" />}
            {statusLabel}
          </span>
        </span>
        <span className="exec-heading-actions">
          {active && (
            <button className="secondary-button exec-cancel" onClick={onCancel} disabled={cancelling}>
              {cancelling ? 'Cancelling…' : 'Cancel'}
            </button>
          )}
          <button className="subtle-icon" onClick={onClose} aria-label="Close output"><X size={15} /></button>
        </span>
      </div>

      {error && (
        <div className="exec-alert" role="alert">
          <span>{error}</span>
          <button className="secondary-button" onClick={onRetryCapabilities}>Refresh sandbox</button>
        </div>
      )}

      {capabilitiesLoading && !capabilities && (
        <p className="output-placeholder">Checking the execution sandbox…</p>
      )}

      {capabilitiesError && !capabilities && (
        <div className="exec-alert" role="alert">
          <span>Could not read sandbox capabilities: {capabilitiesError}</span>
          <button className="secondary-button" onClick={onRetryCapabilities}>Retry</button>
        </div>
      )}

      {capabilities && !capabilities.enabled && (
        <div className="exec-disabled">
          <strong>Secure execution is disabled</strong>
          <p>{capabilities.reason ?? 'No isolated execution backend is available.'}</p>
          <p className="exec-hint">
            Build the sandbox image and set <code>EXECUTION_RUNNER=docker</code> on the API server.
            See <code>execution-sandbox/README.md</code>.
          </p>
        </div>
      )}

      {!job && !starting && capabilities?.enabled && (
        <p className="output-placeholder">
          Run a supported file to execute it inside the isolated sandbox.
        </p>
      )}

      {job && (
        <div className="exec-body">
          <div className="exec-meta">
            <span>{EXECUTION_LANGUAGE_LABELS[job.language]}</span>
            {fileName && <span title={fileName}>{fileName}</span>}
            <span>exit {job.exitCode === null ? (job.signal ?? '—') : job.exitCode}</span>
            <span>{formatDuration(job.durationMs)}</span>
            {job.outputTruncated && capabilities && (
              <span className="exec-truncated">
                output capped at {Math.round(capabilities.limits.maxOutputBytes / 1024)} KB
              </span>
            )}
          </div>

          {job.error && <div className={`exec-job-error ${statusClass(job)}`}>{job.error.message}</div>}

          <div className="exec-stream">
            <span className="exec-stream-label">stdout</span>
            <pre className="exec-output">{job.stdout || 'No stdout output.'}</pre>
          </div>

          {job.stderr && (
            <div className="exec-stream">
              <span className="exec-stream-label stderr">stderr</span>
              <pre className="exec-output stderr">{job.stderr}</pre>
            </div>
          )}

          {active && (
            <p className="exec-hint">
              {job.status === 'QUEUED' ? 'Waiting for a sandbox slot…' : 'Running inside the sandbox…'}
            </p>
          )}

          {capabilities?.enabled && (
            <p className="exec-hint">
              {Math.round(capabilities.limits.timeoutMs / 1_000)}s time limit ·
              {' '}{capabilities.limits.memoryMb} MB memory ·
              {' '}{capabilities.limits.cpus} CPU ·
              {' '}no network
            </p>
          )}
        </div>
      )}
    </div>
  );
}
