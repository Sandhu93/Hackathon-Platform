import type { MiddlewareHandler } from 'hono';
import { AppError } from '../lib/errors';
import type { HonoEnv } from '../types';

/** Fail closed: with invalid configuration nothing else runs. Details stay in the server log. */
export const configGuard: MiddlewareHandler<HonoEnv> = async (c, next) => {
  if (c.get('configInvalid')) {
    throw new AppError('SERVICE_UNAVAILABLE', 'The service is temporarily unavailable.');
  }
  await next();
};
