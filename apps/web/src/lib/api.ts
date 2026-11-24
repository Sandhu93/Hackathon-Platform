import { apiErrorSchema, healthResponseSchema, type HealthResponse } from '@hackathon/shared';

export class ApiRequestError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly requestId: string | null;

  constructor(
    message: string,
    details: { status?: number; code?: string; requestId?: string } = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = details.status ?? null;
    this.code = details.code ?? null;
    this.requestId = details.requestId ?? null;
  }
}

/**
 * GET /api/health. The API answers 503 with the same body shape (status "degraded") when its
 * database is down, so both 200 and 503 are valid health reports. Anything else is an error.
 */
export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  let response: Response;
  try {
    response = await fetch('/api/health', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiRequestError('Could not reach the server.');
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiRequestError('The server sent an unreadable response.', {
      status: response.status,
    });
  }

  if (response.status === 200 || response.status === 503) {
    const health = healthResponseSchema.safeParse(payload);
    if (health.success) return health.data;
  }

  const apiError = apiErrorSchema.safeParse(payload);
  if (apiError.success) {
    throw new ApiRequestError(apiError.data.error.message, {
      status: response.status,
      code: apiError.data.error.code,
      requestId: apiError.data.error.requestId,
    });
  }
  throw new ApiRequestError('The server sent an unexpected response.', { status: response.status });
}
