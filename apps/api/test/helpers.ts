import { env } from 'cloudflare:workers';
import { z } from 'zod';
import type { Hono } from 'hono';
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

export function makeApp(): TestApp {
  const logs: { level: string; line: string }[] = [];
  const app = createApp({
    logSink: (level, line) => logs.push({ level, line }),
    registerRoutes: registerTestRoutes,
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
