import type { MiddlewareHandler } from 'hono';
import { AppError } from '../lib/errors';
import type { HonoEnv } from '../types';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence in depth for state-changing requests. Browsers always send `Origin` on
 * cross-site POST/PUT/PATCH/DELETE, so a present-but-unlisted origin is rejected.
 * Requests without `Origin` (non-browser clients) pass; they cannot ride a victim's
 * cookies. SameSite cookies (Milestone 01) are the primary control.
 */
export const originCheck: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) {
    const origin = c.req.header('origin');
    if (origin !== undefined) {
      const config = c.get('config');
      const trusted = new Set([config.APP_ORIGIN, ...config.CORS_ALLOWED_ORIGINS]);
      if (!trusted.has(origin)) {
        throw new AppError('FORBIDDEN_ORIGIN', 'Cross-origin request rejected.');
      }
    }
  }
  await next();
};
