import { env } from 'cloudflare:workers';
import { z } from 'zod';
import type { Hono } from 'hono';
import { mockMailboxStore, type EmailProvider } from '../src/adapters/email';
import { createApp } from '../src/app';
import { parseJsonBody } from '../src/lib/validate';
import { AppError } from '../src/lib/errors';
import type { HonoEnv } from '../src/types';

export const ORIGIN = 'http://localhost:5173';
export const CORS_ORIGIN = 'http://localhost:3000';

export const echoSchema = z.object({
  name: z.string().min(1).max(10),
  age: z.number().int().min(0).optional(),
});

/** Test-only routes that exercise the shared request pipeline (no business logic exists yet). */
function registerTestRoutes(api: Hono<HonoEnv>): void {
  api.post('/_test/echo', async (c) => c.json(await parseJsonBody(c, echoSchema)));
  api.get('/_test/boom', () => {
    throw new Error('db exploded: password=hunter2 for alice@example.org');
  });
  api.get('/_test/app-error', () => {
    throw new AppError('CONFLICT', 'Already exists.');
  });
}

export interface TestApp {
  request(
    path: string,
    init?: RequestInit,
    envOverride?: Record<string, unknown>,
  ): Promise<Response>;
  logs: { level: string; line: string }[];
}

export interface MakeAppOptions {
  now?: () => Date;
  emailProvider?: EmailProvider;
}

export function makeApp(options: MakeAppOptions = {}): TestApp {
  const logs: { level: string; line: string }[] = [];
  const app = createApp({
    logSink: (level, line) => logs.push({ level, line }),
    registerRoutes: registerTestRoutes,
    ...(options.now ? { now: options.now } : {}),
    ...(options.emailProvider ? { emailProvider: options.emailProvider } : {}),
  });
  return {
    logs,
    request: (path, init, envOverride) =>
      Promise.resolve(app.request(path, init, { ...env, ...envOverride })),
  };
}

export function json(body: unknown, init: RequestInit = {}): RequestInit {
  return {
    method: 'POST',
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
    body: JSON.stringify(body),
  };
}

// ---- authentication helpers ----------------------------------------------------------------

export const DOMAIN = 'example.test';

/** A clock tests can move forward to exercise expiry, cooldowns and rate-limit windows. */
export function fakeClock(start = '2026-11-24T10:00:00.000Z') {
  let time = Date.parse(start);
  return {
    now: () => new Date(time),
    advance(ms: number) {
      time += ms;
    },
    iso: () => new Date(time).toISOString(),
  };
}

export async function resetDb(): Promise<void> {
  // Child tables first (sessions reference users).
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM auth_challenges'),
    env.DB.prepare('DELETE FROM audit_log'),
    env.DB.prepare('DELETE FROM rate_limits'),
    env.DB.prepare('DELETE FROM users'),
  ]);
  mockMailboxStore.clear();
}

export interface SeedOptions {
  role?: 'participant' | 'admin';
  status?: 'active' | 'suspended' | 'revoked';
  mailboxKind?: 'personal' | 'shared';
  displayName?: string | null;
}

export async function seedUser(email: string, options: SeedOptions = {}): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO users (id, email_normalized, display_name, role, status, mailbox_kind, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)`,
  )
    .bind(
      id,
      email,
      options.displayName ?? null,
      options.role ?? 'participant',
      options.status ?? 'active',
      options.mailboxKind ?? 'personal',
      now,
    )
    .run();
  return id;
}

/** The six-digit code in the most recent mock email to `email`. */
export function latestCode(email: string): string {
  const message = [...mockMailboxStore.messages].reverse().find((m) => m.to === email);
  const match = message?.text.match(/\b(\d{6})\b/);
  if (!match?.[1]) throw new Error(`no code mailed to ${email}`);
  return match[1];
}

export function cookieFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  const pair = raw.split(';')[0] ?? '';
  return pair.includes('=') && !/=\s*$/.test(pair) ? pair : null;
}

export async function requestCode(
  app: TestApp,
  email: string,
  envOverride?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('/api/auth/otp/request', json({ email }, { headers }), envOverride);
}

export async function verifyCode(
  app: TestApp,
  email: string,
  code: string,
  envOverride?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request('/api/auth/otp/verify', json({ email, code }, { headers }), envOverride);
}

/** Full sign-in. Returns the Cookie header value to send on later requests. */
export async function signIn(
  app: TestApp,
  email: string,
  envOverride?: Record<string, unknown>,
): Promise<string> {
  const requested = await requestCode(app, email, envOverride);
  if (requested.status !== 202) throw new Error(`request failed: ${requested.status}`);
  const verified = await verifyCode(app, email, latestCode(email), envOverride);
  const cookie = cookieFrom(verified);
  if (verified.status !== 200 || !cookie) throw new Error(`verify failed: ${verified.status}`);
  return cookie;
}

export function withCookie(cookie: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string>), cookie } };
}

export function jsonWithCookie(cookie: string, body: unknown, method = 'POST'): RequestInit {
  return json(body, { method, headers: { cookie } });
}
