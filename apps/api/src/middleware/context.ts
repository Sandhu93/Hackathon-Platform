import type { MiddlewareHandler } from 'hono';
import { REQUEST_ID_HEADER, parseAppConfig } from '@hackathon/shared';
import type { EmailProvider } from '../adapters/email';
import { createLogger, type LogSink } from '../lib/logger';
import type { HonoEnv } from '../types';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * First middleware. Assigns the request ID, validates configuration, and creates the
 * request-scoped logger. Configuration problems are only *recorded* here; `configGuard`
 * turns them into a 503 after security headers have been attached.
 */
export interface ContextOptions {
  logSink?: LogSink;
  now?: () => Date;
  emailProvider?: EmailProvider;
}

export function context(options: ContextOptions = {}): MiddlewareHandler<HonoEnv> {
  return async (c, next) => {
    const inbound = c.req.header(REQUEST_ID_HEADER);
    const requestId = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('now', options.now ?? (() => new Date()));
    if (options.emailProvider) c.set('emailProviderOverride', options.emailProvider);
    c.header(REQUEST_ID_HEADER, requestId);

    const result = parseAppConfig(c.env);
    const level = result.ok ? result.config.LOG_LEVEL : 'info';
    const logger = createLogger({
      level,
      bindings: { requestId },
      ...(options.logSink ? { sink: options.logSink } : {}),
    });
    c.set('logger', logger);

    c.set('configInvalid', !result.ok);
    if (result.ok) {
      c.set('config', result.config);
    } else {
      logger.error('config.invalid', { issues: result.issues });
    }
    await next();
  };
}
