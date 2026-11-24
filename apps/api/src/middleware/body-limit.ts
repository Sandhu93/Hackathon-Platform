import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { AppError } from '../lib/errors';
import type { HonoEnv } from '../types';

/** Rejects oversized bodies via Content-Length and while streaming (chunked uploads). */
export const requestBodyLimit: MiddlewareHandler<HonoEnv> = (c, next) =>
  bodyLimit({
    maxSize: c.get('config').MAX_JSON_BODY_BYTES,
    onError: () => {
      throw new AppError('PAYLOAD_TOO_LARGE', 'Request body is too large.');
    },
  })(c, next);
