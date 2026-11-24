import { cors } from 'hono/cors';
import type { MiddlewareHandler } from 'hono';
import type { HonoEnv } from '../types';

/**
 * CORS policy: the app is same-origin (SPA and API share one Worker), so by default no
 * cross-origin caller is allowed. Only origins listed in CORS_ALLOWED_ORIGINS get CORS
 * headers. Never `*`, because credentialed requests are used.
 */
export const corsPolicy: MiddlewareHandler<HonoEnv> = (c, next) => {
  const allowed = new Set(c.get('config').CORS_ALLOWED_ORIGINS);
  return cors({
    origin: (origin) => (allowed.has(origin) ? origin : null),
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-Request-Id'],
    exposeHeaders: ['X-Request-Id', 'Retry-After'],
    credentials: true,
    maxAge: 600,
  })(c, next);
};
