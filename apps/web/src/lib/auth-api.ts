import {
  apiErrorSchema,
  otpRequestResponseSchema,
  sessionResponseSchema,
  type SessionUser,
} from '@hackathon/shared';
import { ApiRequestError } from './api';

export class RateLimitedError extends ApiRequestError {
  readonly retryAfterSeconds: number | null;

  constructor(message: string, retryAfterSeconds: number | null, requestId?: string) {
    super(message, { status: 429, code: 'RATE_LIMITED', ...(requestId ? { requestId } : {}) });
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function call(path: string, init: { method: string; body?: unknown }): Promise<Response> {
  try {
    return await fetch(path, {
      method: init.method,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  } catch {
    throw new ApiRequestError('Could not reach the server.');
  }
}

async function failure(response: Response): Promise<ApiRequestError> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return new ApiRequestError('The server sent an unreadable response.', {
      status: response.status,
    });
  }
  const parsed = apiErrorSchema.safeParse(payload);
  if (!parsed.success) {
    return new ApiRequestError('The server sent an unexpected response.', {
      status: response.status,
    });
  }
  const { code, message, requestId } = parsed.data.error;
  if (response.status === 429) {
    const header = Number(response.headers.get('retry-after'));
    return new RateLimitedError(
      message,
      Number.isFinite(header) && header > 0 ? header : null,
      requestId,
    );
  }
  return new ApiRequestError(message, { status: response.status, code, requestId });
}

/** Anything with Zod's safeParse shape; avoids a direct zod dependency in the web package. */
interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

async function parsed<T>(response: Response, schema: Parser<T>): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError('The server sent an unreadable response.', {
      status: response.status,
    });
  }
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new ApiRequestError('The server sent an unexpected response.', {
      status: response.status,
    });
  }
  return result.data;
}

/** Ask for a sign-in code. The answer is deliberately the same whether or not the address is approved. */
export async function requestSignInCode(email: string): Promise<{ resendAfterSeconds: number }> {
  const response = await call('/api/auth/otp/request', { method: 'POST', body: { email } });
  if (response.status !== 202) throw await failure(response);
  return parsed(response, otpRequestResponseSchema);
}

export async function verifySignInCode(email: string, code: string): Promise<SessionUser> {
  const response = await call('/api/auth/otp/verify', { method: 'POST', body: { email, code } });
  if (response.status !== 200) throw await failure(response);
  return (await parsed(response, sessionResponseSchema)).user;
}

/** The signed-in user, or null when nobody is signed in (401). Any other failure throws. */
export async function fetchSessionUser(): Promise<SessionUser | null> {
  const response = await call('/api/auth/session', { method: 'GET' });
  if (response.status === 401) return null;
  if (response.status !== 200) throw await failure(response);
  return (await parsed(response, sessionResponseSchema)).user;
}

export async function signOut(): Promise<void> {
  const response = await call('/api/auth/logout', { method: 'POST', body: {} });
  if (response.status !== 204) throw await failure(response);
}
