import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate } from 'react-router';
import { normalizeEmail } from '@hackathon/shared';
import { useAuth } from '../components/AuthProvider';
import { ApiRequestError } from '../lib/api';
import { RateLimitedError, requestSignInCode, verifySignInCode } from '../lib/auth-api';

type Step = { name: 'email' } | { name: 'code'; email: string };

function describeError(error: unknown, context: 'request' | 'verify'): string {
  if (error instanceof RateLimitedError) {
    const minutes = error.retryAfterSeconds ? Math.ceil(error.retryAfterSeconds / 60) : null;
    return minutes
      ? `Too many attempts. Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
      : 'Too many attempts. Please try again later.';
  }
  if (error instanceof ApiRequestError) {
    if (error.code === 'INVALID_OR_EXPIRED_CODE') {
      return 'That code is not valid or has expired. Check the code, or request a new one.';
    }
    if (error.status === 400) {
      return context === 'request'
        ? 'Enter a valid email address.'
        : 'Enter the 6-digit code from the email.';
    }
    if (error.status === 503) return 'Sign-in is temporarily unavailable. Please try again later.';
    return error.message;
  }
  return 'Something went wrong. Please try again.';
}

export function LoginPage() {
  const { state, setUser } = useAuth();
  const [step, setStep] = useState<Step>({ name: 'email' });
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step.name === 'code') codeRef.current?.focus();
  }, [step.name]);

  if (state.status === 'authenticated') return <Navigate to="/" replace />;

  async function sendCode(address: string, resend: boolean) {
    setBusy(true);
    setError(null);
    setResent(false);
    try {
      await requestSignInCode(address);
      setStep({ name: 'code', email: address });
      setCode('');
      setResent(resend);
    } catch (cause) {
      setError(describeError(cause, 'request'));
    } finally {
      setBusy(false);
    }
  }

  function onSubmitEmail(event: FormEvent) {
    event.preventDefault();
    const normalized = normalizeEmail(email);
    if (!normalized) {
      setError('Enter a valid email address.');
      return;
    }
    void sendCode(normalized.email, false);
  }

  async function onSubmitCode(event: FormEvent) {
    event.preventDefault();
    if (step.name !== 'code') return;
    const trimmed = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(trimmed)) {
      setError('Enter the 6-digit code from the email.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setUser(await verifySignInCode(step.email, trimmed));
    } catch (cause) {
      setError(describeError(cause, 'verify'));
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="login-heading" className="auth-card">
      <h1 id="login-heading">Sign in</h1>
      {step.name === 'email' ? (
        <form onSubmit={onSubmitEmail} noValidate>
          <p className="muted">
            Use your institutional email address. We will email you a one-time sign-in code.
          </p>
          <div className="field">
            <label htmlFor="login-email">Email address</label>
            <input
              id="login-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-describedby={error ? 'login-error' : undefined}
              aria-invalid={error ? true : undefined}
            />
          </div>
          {error && (
            <p id="login-error" className="notice notice--error" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="button" disabled={busy}>
            {busy ? 'Sending…' : 'Email me a code'}
          </button>
        </form>
      ) : (
        <form onSubmit={(event) => void onSubmitCode(event)} noValidate>
          <p role="status">
            If <strong>{step.email}</strong> is approved for this platform, a 6-digit code is on its
            way. It expires in a few minutes and works once.
            {resent ? ' We sent a new code.' : ''}
          </p>
          <div className="field">
            <label htmlFor="login-code">Sign-in code</label>
            <input
              id="login-code"
              ref={codeRef}
              name="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={12}
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
              aria-describedby={error ? 'login-error' : undefined}
              aria-invalid={error ? true : undefined}
            />
          </div>
          {error && (
            <p id="login-error" className="notice notice--error" role="alert">
              {error}
            </p>
          )}
          <p className="form-actions">
            <button type="submit" className="button" disabled={busy}>
              {busy ? 'Checking…' : 'Sign in'}
            </button>
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => void sendCode(step.email, true)}
            >
              Send a new code
            </button>
            <button
              type="button"
              className="button button--secondary"
              disabled={busy}
              onClick={() => {
                setStep({ name: 'email' });
                setError(null);
              }}
            >
              Use a different email
            </button>
          </p>
        </form>
      )}
    </section>
  );
}
