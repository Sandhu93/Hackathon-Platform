import type { MiddlewareHandler } from 'hono';
import type { HonoEnv } from '../types';

/**
 * One structured line per request. Logs the path only (never the query string, which can
 * carry tokens), no headers and no bodies.
 */
export const accessLog: MiddlewareHandler<HonoEnv> = async (c, next) => {
  const started = Date.now();
  try {
    await next();
  } finally {
    const status = c.res.status;
    const fields = {
      method: c.req.method,
      path: c.req.path,
      status,
      durationMs: Date.now() - started,
    };
    const logger = c.get('logger');
    if (status >= 500) logger.error('http.request', fields);
    else if (status >= 400) logger.warn('http.request', fields);
    else logger.info('http.request', fields);
  }
};
