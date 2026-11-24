import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ERROR_STATUS, type ApiError, type ErrorCode, type FieldIssue } from '@hackathon/shared';
import type { HonoEnv } from '../types';

export interface AppErrorOptions {
  status?: number;
  details?: FieldIssue[];
  headers?: Record<string, string>;
  cause?: unknown;
}

/** An error whose message is safe to show to API clients. */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: FieldIssue[] | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? ERROR_STATUS[code];
    this.details = options.details;
    this.headers = options.headers;
  }
}

/**
 * Server misconfiguration (missing/invalid binding or secret). The message may name
 * a setting but must never contain its value. Clients only ever see a generic 503.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Build the one standard error response. */
export function errorResponse(
  c: Context<HonoEnv>,
  code: ErrorCode,
  message: string,
  options: Pick<AppErrorOptions, 'status' | 'details' | 'headers'> = {},
): Response {
  const body: ApiError = {
    error: {
      code,
      message,
      requestId: c.get('requestId'),
      ...(options.details ? { details: options.details } : {}),
    },
  };
  return c.json(
    body,
    (options.status ?? ERROR_STATUS[code]) as ContentfulStatusCode,
    options.headers,
  );
}
