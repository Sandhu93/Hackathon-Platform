import type { Context } from 'hono';
import { AppError } from '../lib/errors';
import type { HonoEnv } from '../types';
import { hmacHex } from './crypto';
import { consumeRateLimit } from './repo';
import type { AuthSettings } from './settings';

export const RATE_WINDOW_SECONDS = 3600;

/**
 * Identify the caller's network source without trusting spoofable headers: Cloudflare sets
 * CF-Connecting-IP itself. IPv6 addresses collapse to their /64 so one subscriber cannot
 * rotate through addresses. Returns null where the header is absent (local development).
 */
export function networkSource(c: Context<HonoEnv>): string | null {
  const ip = c.req.header('cf-connecting-ip')?.trim().toLowerCase();
  if (!ip) return null;
  if (!ip.includes(':') || ip.includes('.')) return ip;
  const [head = '', tail] = ip.split('::');
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = Math.max(0, 8 - headGroups.length - tailGroups.length);
  const groups = [
    ...headGroups,
    ...Array<string>(tail === undefined ? 0 : missing).fill('0'),
    ...tailGroups,
  ];
  return groups
    .slice(0, 4)
    .map((g) => g.padStart(4, '0'))
    .join(':');
}

export interface ThrottleResult {
  /** Keyed hashes: safe to store in audit rows and buckets, impossible to reverse. */
  emailHash: string;
  sourceHash: string | null;
}

type Scope = 'request' | 'verify';

/**
 * Multi-signal throttling: per network source, per target address and globally, checked in
 * that order and stopping at the first full bucket (so a blocked source never burns shared
 * budget). Buckets depend only on what the caller sent, never on whether the account exists,
 * so a 429 reveals nothing about eligibility. Per-challenge attempt limits are enforced
 * separately, atomically, in the challenge row itself.
 */
export async function enforceThrottle(
  c: Context<HonoEnv>,
  settings: AuthSettings,
  scope: Scope,
  email: string,
): Promise<ThrottleResult> {
  const { config, secret } = settings;
  const limits =
    scope === 'request'
      ? {
          source: config.AUTH_RL_REQUEST_SOURCE,
          email: config.AUTH_RL_REQUEST_EMAIL,
          global: config.AUTH_RL_REQUEST_GLOBAL,
        }
      : {
          source: config.AUTH_RL_VERIFY_SOURCE,
          email: config.AUTH_RL_VERIFY_EMAIL,
          global: config.AUTH_RL_VERIFY_GLOBAL,
        };

  const nowSeconds = Math.floor(c.get('now')().getTime() / 1000);
  const windowStart = nowSeconds - (nowSeconds % RATE_WINDOW_SECONDS);
  const retryAfter = String(Math.max(1, windowStart + RATE_WINDOW_SECONDS - nowSeconds));

  const source = networkSource(c);
  const local =
    c.get('config').ENVIRONMENT === 'development' || c.get('config').ENVIRONMENT === 'test';
  const sourceHash = source === null ? null : await hmacHex(secret, 'source', source);
  const emailHash = await hmacHex(secret, 'email', email);

  const checks: [string, number][] = [];
  // No source signal in local development: skip rather than lump every developer together.
  if (sourceHash !== null || !local) {
    checks.push([`${scope}:src:${(sourceHash ?? 'unknown').slice(0, 32)}`, limits.source]);
  }
  checks.push([`${scope}:email:${emailHash.slice(0, 32)}`, limits.email]);
  checks.push([`${scope}:global`, limits.global]);

  for (const [bucket, limit] of checks) {
    const allowed = await consumeRateLimit(c.env.DB, bucket, windowStart, limit);
    if (!allowed) {
      c.get('logger').warn('auth.throttled', { scope, signal: bucket.split(':')[1] });
      throw new AppError('RATE_LIMITED', 'Too many attempts. Please try again later.', {
        headers: { 'Retry-After': retryAfter },
      });
    }
  }
  return { emailHash, sourceHash };
}
