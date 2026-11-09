import { useState, type FormEvent } from 'react';
import {
  Code2, Eye, EyeOff, FileCode2, GitBranch, ShieldCheck, Users, Zap,
} from 'lucide-react';
import { api, ApiError, type AuthUser } from './api';

type Mode = 'login' | 'register';

interface AuthScreenProps {
  onAuthenticated: (user: AuthUser) => void;
  initialMessage?: string | null;
}

function friendlyError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Please try again.';
}

export default function AuthScreen({ onAuthenticated, initialMessage }: AuthScreenProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function switchMode(next: Mode) {
    if (submitting || next === mode) return;
    setMode(next);
    setError(null);
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setError(null);

    if (mode === 'register' && password !== confirmPassword) {
      setError('Passwords do not match. Please re-enter them.');
      return;
    }

    setSubmitting(true);
    try {
      const { data } = mode === 'login'
        ? await api.auth.login({ email: email.trim(), password })
        : await api.auth.register({ username: username.trim(), email: email.trim(), password });
      onAuthenticated(data.user);
    } catch (submitError) {
      setError(friendlyError(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  const isRegister = mode === 'register';

  return (
    <div className="auth-shell">
      <section className="auth-showcase">
        <a className="brand auth-brand" href="#" onClick={(event) => event.preventDefault()}>
          <span className="brand-mark"><Code2 size={20} strokeWidth={2.5} /></span>
          <span>code<span className="brand-light">together</span></span>
          <span className="beta-tag">BETA</span>
        </a>

        <div className="auth-showcase-copy">
          <div className="page-eyebrow"><span className="eyebrow-line" /> SECURE COLLABORATION</div>
          <h1>Your workspace,<span> protected.</span></h1>
          <p>
            Sign in to open your projects, files and team space. Every request is tied to your
            server-side session, so your work stays private.
          </p>

          <ul className="auth-feature-list">
            <li><span><FileCode2 size={16} /></span><div><strong>Persistent projects</strong><p>Files and folders are stored in MySQL, ready after every refresh.</p></div></li>
            <li><span><Users size={16} /></span><div><strong>Private by default</strong><p>Only you and the people you invite can reach your projects and files.</p></div></li>
            <li><span><ShieldCheck size={16} /></span><div><strong>Hardened sessions</strong><p>Argon2id password hashing, per-tab session tokens and CSRF protection.</p></div></li>
          </ul>
        </div>

        <div className="auth-footnote">
          <span><GitBranch size={13} /> Persistent MySQL storage</span>
          <span><Zap size={13} /> Monaco autosave</span>
        </div>
      </section>

      <section className="auth-panel">
        <form className="auth-card" onSubmit={submit} noValidate>
          <div className="auth-mode-tabs" role="tablist" aria-label="Authentication mode">
            <button
              type="button"
              role="tab"
              aria-selected={!isRegister}
              className={!isRegister ? 'active' : ''}
              onClick={() => switchMode('login')}
            >
              Sign in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={isRegister}
              className={isRegister ? 'active' : ''}
              onClick={() => switchMode('register')}
            >
              Create account
            </button>
          </div>

          <h2>{isRegister ? 'Create your account' : 'Welcome back'}</h2>
          <p className="auth-subtitle">
            {isRegister
              ? 'Choose a username, email and a strong password to get started.'
              : 'Sign in to continue to your projects and files.'}
          </p>

          {initialMessage && !error && (
            <div className="auth-notice" role="status">{initialMessage}</div>
          )}
          {error && (
            <div className="inline-banner error auth-banner" role="alert">
              <span>{error}</span>
            </div>
          )}

          {isRegister && (
            <>
              <label className="field-label" htmlFor="auth-username">Username</label>
              <input
                id="auth-username"
                className="text-input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="ada-lovelace"
                autoComplete="username"
                minLength={3}
                maxLength={40}
                pattern="[A-Za-z0-9_\-]+"
                title="Letters, numbers, hyphens and underscores only"
                required
                autoFocus
              />
            </>
          )}

          <label className="field-label" htmlFor="auth-email">Email</label>
          <input
            id="auth-email"
            className="text-input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            maxLength={254}
            required
            autoFocus={!isRegister}
          />

          <label className="field-label" htmlFor="auth-password">Password</label>
          <div className="password-field">
            <input
              id="auth-password"
              className="text-input"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={isRegister ? 'At least 10 characters' : 'Your password'}
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              minLength={isRegister ? 10 : undefined}
              maxLength={128}
              required
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowPassword((value) => !value)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>

          {isRegister && (
            <>
              <label className="field-label" htmlFor="auth-confirm-password">Confirm password</label>
              <input
                id="auth-confirm-password"
                className="text-input"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Repeat your password"
                autoComplete="new-password"
                minLength={10}
                maxLength={128}
                required
              />
              <p className="auth-hint">Passwords are hashed with Argon2id before they are stored.</p>
            </>
          )}

          <button className="primary-button full-button auth-submit" type="submit" disabled={submitting}>
            {submitting
              ? (isRegister ? 'Creating account…' : 'Signing in…')
              : (isRegister ? 'Create account' : 'Sign in')}
          </button>

          <p className="auth-switch">
            {isRegister ? 'Already have an account?' : 'New to CodeTogether?'}{' '}
            <button type="button" onClick={() => switchMode(isRegister ? 'login' : 'register')}>
              {isRegister ? 'Sign in' : 'Create an account'}
            </button>
          </p>

          <p className="auth-legal">
            Email verification, password reset and social sign-in are not implemented yet.
          </p>
        </form>
      </section>
    </div>
  );
}
