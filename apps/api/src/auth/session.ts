import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { AppError } from '../lib/errors';
import type { AuthContext, HonoEnv } from '../types';
import { hmacHex } from './crypto';
import { domainAllowed } from './eligibility';
import { lookupSession, touchSession } from './repo';
import { getAuthSettings } from './settings';

const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/;
/** last_seen_at is refreshed at most this often, to keep D1 writes (a free-plan quota) low. */
const TOUCH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Cookie hardening:
 *  - HttpOnly: unreadable by page scripts, so XSS cannot steal the token.
 *  - Secure + the `__Host-` prefix over https (staging/production are https-only, enforced by
 *    config validation): the browser refuses to send it over http or to share it with other
 *    hosts/paths. Plain `http://localhost` development uses an unprefixed, non-Secure cookie.
 *  - SameSite=Strict: never sent on cross-site requests (CSRF); the SPA is same-origin.
 *  - No Domain attribute: bound to this exact host.
 */
function cookieSettings(c: Context<HonoEnv>) {
  const secure = c.get('config').APP_ORIGIN.startsWith('https://');
  return { secure, name: secure ? '__Host-hackathon_session' : 'hackathon_session' };
}

export function setSessionCookie(c: Context<HonoEnv>, token: string, maxAgeSeconds: number): void {
  const { secure, name } = cookieSettings(c);
  setCookie(c, name, token, {
    httpOnly: true,
    secure,
    sameSite: 'Strict',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(c: Context<HonoEnv>): void {
  const { secure, name } = cookieSettings(c);
  deleteCookie(c, name, { path: '/', secure });
}

/** The raw cookie value, if one is present and well-formed. Never log it. */
export function readSessionToken(c: Context<HonoEnv>): string | null {
  const value = getCookie(c, cookieSettings(c).name);
  return value !== undefined && TOKEN_FORMAT.test(value) ? value : null;
}

/**
 * Resolve the current session, or null. Everything that matters is re-read from the database
 * on every request, so revocation, suspension, demotion and removal from the roster take
 * effect on the very next call, not at cookie expiry.
 */
export async function resolveSession(c: Context<HonoEnv>): Promise<AuthContext | null> {
  const token = readSessionToken(c);
  if (token === null) return null;
  const settings = getAuthSettings(c);
  const row = await lookupSession(c.env.DB, await hmacHex(settings.secret, 'session', token));
  if (!row) return null;

  const now = c.get('now')().getTime();
  if (Date.parse(row.expires_at) <= now) return null;
  if (now - Date.parse(row.last_seen_at) > settings.config.AUTH_SESSION_IDLE_TTL_SECONDS * 1000) {
    return null;
  }
  if (row.status !== 'active' || row.mailbox_kind !== 'personal') return null;
  if (!domainAllowed(settings.config, row.email_normalized)) return null;

  if (now - Date.parse(row.last_seen_at) > TOUCH_INTERVAL_MS) {
    await touchSession(c.env.DB, row.session_id, new Date(now).toISOString());
  }
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    email: row.email_normalized,
    displayName: row.display_name,
    role: row.role,
    sessionExpiresAt: row.expires_at,
  };
}

/** Require a valid session. Clears a stale cookie so the browser stops sending it. */
export const requireAuth: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const auth = await resolveSession(c);
  if (!auth) {
    if (readSessionToken(c) !== null) clearSessionCookie(c);
    throw new AppError('UNAUTHENTICATED', 'Sign in to continue.');
  }
  c.set('auth', auth);
  await next();
};

/** Server-controlled authorisation: the role comes from the database, never from the client. */
export const requireAdmin: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const auth = c.get('auth');
  if (auth?.role !== 'admin') {
    throw new AppError('FORBIDDEN', 'You do not have permission to do that.');
  }
  await next();
};
