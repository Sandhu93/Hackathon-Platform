import type { Context } from 'hono';
import type { HonoEnv } from '../types';

/** Reject if `promise` does not settle within `ms`. The underlying work is not cancelled. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/**
 * Run work after the response has been sent (Workers `waitUntil`) so response time does not
 * depend on slow third parties. Where there is no execution context (unit tests) the work is
 * awaited inline, which keeps tests deterministic. Failures are logged, never thrown.
 */
export function afterResponse(c: Context<HonoEnv>, work: () => Promise<void>): Promise<void> {
  const task = work().catch((err: unknown) => {
    c.get('logger').error('background.failed', { err });
  });
  try {
    c.executionCtx.waitUntil(task);
    return Promise.resolve();
  } catch {
    return task;
  }
}
