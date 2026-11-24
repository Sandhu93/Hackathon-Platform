import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { ZodError } from 'zod';
import type { EmailProvider } from './adapters/email';
import { AppError, ConfigError, errorResponse } from './lib/errors';
import { allowedMethodsFor } from './lib/allowed-methods';
import type { LogSink } from './lib/logger';
import { accessLog } from './middleware/access-log';
import { configGuard } from './middleware/config-guard';
import { context } from './middleware/context';
import { corsPolicy } from './middleware/cors';
import { requestBodyLimit } from './middleware/body-limit';
import { originCheck } from './middleware/origin-check';
import { noStore, securityHeaders } from './middleware/security-headers';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { devRoutes } from './routes/dev';
import { healthRoutes } from './routes/health';
import type { HonoEnv } from './types';

export interface CreateAppOptions {
  /** Redirect log lines (tests). Defaults to console. */
  logSink?: LogSink;
  /** Clock override (tests). */
  now?: () => Date;
  /** Email provider override (tests). Production uses the configured adapter. */
  emailProvider?: EmailProvider;
  /** Mount extra routes under /api. Used by tests to exercise the shared pipeline. */
  registerRoutes?: (api: Hono<HonoEnv>) => void;
}

export function createApp(options: CreateAppOptions = {}): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>({ strict: false });

  // Order matters. Everything below `context` can rely on requestId + logger.
  app.use(
    '*',
    context({
      ...(options.logSink ? { logSink: options.logSink } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.emailProvider ? { emailProvider: options.emailProvider } : {}),
    }),
  );
  app.use('*', accessLog);
  app.use('*', securityHeaders);
  app.use('/api/*', noStore);
  app.use('*', configGuard);
  app.use('/api/*', corsPolicy);
  app.use('/api/*', originCheck);
  app.use('/api/*', requestBodyLimit);

  const api = new Hono<HonoEnv>();
  api.route('/', healthRoutes);
  api.route('/', authRoutes);
  api.route('/', adminRoutes);
  api.route('/', devRoutes);
  options.registerRoutes?.(api);
  app.route('/api', api);

  app.notFound((c) => {
    const allowed = allowedMethodsFor(app, c.req.path);
    if (allowed.length > 0 && c.req.method !== 'OPTIONS') {
      return errorResponse(c, 'METHOD_NOT_ALLOWED', 'Method not allowed for this resource.', {
        headers: { Allow: allowed.join(', ') },
      });
    }
    return errorResponse(c, 'NOT_FOUND', 'Resource not found.');
  });

  app.onError((err, c) => {
    if (err instanceof AppError) {
      if (err.status >= 500) c.get('logger').error('request.failed', { code: err.code, err });
      return errorResponse(c, err.code, err.message, {
        status: err.status,
        ...(err.details ? { details: err.details } : {}),
        ...(err.headers ? { headers: err.headers } : {}),
      });
    }
    if (err instanceof ConfigError) {
      c.get('logger').error('config.error', { err });
      return errorResponse(c, 'SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
    }
    if (err instanceof ZodError) {
      return errorResponse(c, 'VALIDATION_ERROR', 'Request validation failed.');
    }
    if (err instanceof HTTPException) {
      const status = err.status;
      if (status === 404) return errorResponse(c, 'NOT_FOUND', 'Resource not found.');
      if (status === 413)
        return errorResponse(c, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
      if (status >= 400 && status < 500) return errorResponse(c, 'BAD_REQUEST', 'Bad request.');
    }
    // Anything else is a bug or an outage. Log it; tell the client nothing about it.
    c.get('logger').error('request.unhandled_error', { err });
    return errorResponse(c, 'INTERNAL_ERROR', 'An unexpected error occurred.');
  });

  return app;
}
