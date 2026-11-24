import { useCallback, useEffect, useState } from 'react';
import type { HealthResponse } from '@hackathon/shared';
import { ApiRequestError, fetchHealth } from '../lib/api';

type State =
  | { phase: 'loading' }
  | { phase: 'loaded'; health: HealthResponse }
  | { phase: 'error'; message: string; requestId: string | null };

export function StatusPage() {
  const [state, setState] = useState<State>({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchHealth(controller.signal).then(
      (health) => setState({ phase: 'loaded', health }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          phase: 'error',
          message: error instanceof ApiRequestError ? error.message : 'Something went wrong.',
          requestId: error instanceof ApiRequestError ? error.requestId : null,
        });
      },
    );
    return () => controller.abort();
  }, [attempt]);

  const retry = useCallback(() => {
    setState({ phase: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  return (
    <section aria-labelledby="status-heading">
      <h1 id="status-heading">System status</h1>
      <div aria-live="polite" aria-atomic="true">
        {state.phase === 'loading' && (
          <p className="notice" role="status">
            Checking…
          </p>
        )}
        {state.phase === 'loaded' && <HealthReport health={state.health} />}
        {state.phase === 'error' && (
          <div className="notice notice--error" role="alert">
            <p>
              <strong>Unable to check status.</strong> {state.message}
            </p>
            {state.requestId && <p className="muted">Reference: {state.requestId}</p>}
          </div>
        )}
      </div>
      {state.phase !== 'loading' && (
        <p>
          <button type="button" className="button button--secondary" onClick={retry}>
            Check again
          </button>
        </p>
      )}
    </section>
  );
}

function HealthReport({ health }: { health: HealthResponse }) {
  const ok = health.status === 'ok';
  return (
    <div className={ok ? 'notice notice--ok' : 'notice notice--warn'}>
      <p>
        <strong>{ok ? 'All systems operational.' : 'Service degraded.'}</strong>{' '}
        {ok ? '' : 'The database is not responding; please try again shortly.'}
      </p>
      <dl className="facts">
        <div>
          <dt>Environment</dt>
          <dd>{health.environment}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{health.version}</dd>
        </div>
        <div>
          <dt>Database</dt>
          <dd>{health.checks.database === 'ok' ? 'Available' : 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Checked at</dt>
          <dd>
            <time dateTime={health.timestamp}>{new Date(health.timestamp).toUTCString()}</time>
          </dd>
        </div>
      </dl>
    </div>
  );
}
