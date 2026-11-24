import type { Context } from 'hono';
import type { z } from 'zod';
import type { FieldIssue } from '@hackathon/shared';
import type { HonoEnv } from '../types';
import { AppError } from './errors';

/**
 * Read and validate a JSON request body. All endpoints that accept JSON must use this:
 * it enforces the content type, turns parse failures into a standard 400 and never
 * echoes rejected values back to the client. Body size is capped earlier by the
 * body-limit middleware.
 */
export async function parseJsonBody<S extends z.ZodType>(
  c: Context<HonoEnv>,
  schema: S,
): Promise<z.infer<S>> {
  const contentType = c.req.header('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await c.req.text());
  } catch {
    throw new AppError('MALFORMED_JSON', 'Request body is not valid JSON.');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const details: FieldIssue[] = parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(body)',
      code: issue.code,
      message: issue.message,
    }));
    throw new AppError('VALIDATION_ERROR', 'Request validation failed.', { details });
  }
  return parsed.data;
}
