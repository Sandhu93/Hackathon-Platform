# API Contracts

Base path `/api`. JSON only. Same origin as the web app.

## Conventions

- **Content type**: requests with a body must send `Content-Type: application/json` (else `415 UNSUPPORTED_MEDIA_TYPE`). Responses are `application/json`.
- **Body limit**: `MAX_JSON_BODY_BYTES` (default 65,536) → `413 PAYLOAD_TOO_LARGE`.
- **Request ID**: every response has `X-Request-Id`. Clients may send their own (`^[A-Za-z0-9._-]{8,64}$`); anything else is replaced.
- **Caching**: `Cache-Control: no-store` on all API responses.
- **Time**: ISO-8601 UTC strings (`2026-11-24T10:00:00.000Z`).
- **Idempotency / pagination**: defined per endpoint from Milestone 02 onwards (server-side pagination is mandatory for lists).
- **Methods**: `HEAD` is supported wherever `GET` is. A known path with an unsupported method returns `405` with an `Allow` header. `OPTIONS` is handled by the CORS layer.
- **Cross-origin**: no CORS headers unless the caller's origin is allow-listed; unsafe methods with an unlisted `Origin` return `403 FORBIDDEN_ORIGIN`.

## Error format

Every non-2xx response (except the health 503, below) is:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed.",
    "requestId": "5d0c4e0b-…",
    "details": [{ "path": "name", "code": "too_big", "message": "…" }]
  }
}
```

`code` is stable and machine-readable; `message` is for humans and may change; `details` appears only for validation errors and never contains submitted values.

| Code                     | HTTP | Meaning                                              |
| ------------------------ | ---- | ---------------------------------------------------- |
| `BAD_REQUEST`            | 400  | Generic malformed request                            |
| `MALFORMED_JSON`         | 400  | Body is empty or not valid JSON                      |
| `VALIDATION_ERROR`       | 400  | Body parsed but failed schema validation             |
| `UNAUTHENTICATED`        | 401  | No/invalid/expired session _(from M01)_              |
| `FORBIDDEN`              | 403  | Authenticated but not allowed _(from M01)_           |
| `FORBIDDEN_ORIGIN`       | 403  | Cross-origin state-changing request rejected         |
| `NOT_FOUND`              | 404  | Unknown route or resource                            |
| `METHOD_NOT_ALLOWED`     | 405  | Path exists, method does not (`Allow` header set)    |
| `CONFLICT`               | 409  | State conflict (duplicates, capacity, stale version) |
| `PAYLOAD_TOO_LARGE`      | 413  | Body over the limit                                  |
| `UNSUPPORTED_MEDIA_TYPE` | 415  | Not `application/json`                               |
| `RATE_LIMITED`           | 429  | Throttled; `Retry-After` set _(from M01)_            |
| `INTERNAL_ERROR`         | 500  | Unexpected failure; nothing else disclosed           |
| `SERVICE_UNAVAILABLE`    | 503  | Misconfiguration or dependency outage                |

Schemas live in `packages/shared/src/errors.ts` and are used by both the API and the web client.

## Endpoints

### `GET /api/health`

Public liveness and minimal readiness probe.

**200 OK**

```json
{
  "status": "ok",
  "service": "hackathon-api",
  "environment": "development",
  "version": "dev",
  "timestamp": "2026-11-24T10:00:00.000Z",
  "checks": { "database": "ok" }
}
```

**503 Service Unavailable** — same shape with `"status": "degraded"` and `"checks": { "database": "unavailable" }` when the database does not answer within 2 s. (Deliberately not the error envelope, so monitors can read the same fields on both outcomes.) If configuration is invalid the standard `SERVICE_UNAVAILABLE` error is returned instead.

Other methods → `405` with `Allow: GET, HEAD`.

Schema: `healthResponseSchema` in `packages/shared/src/health.ts`.

### Reserved for later milestones

Authentication and sessions (M01), events/registration/profiles (M02), teams (M03), admin/notifications (M04), submissions (M05), file uploads (M06). Exact routes and status codes are fixed in each milestone's design step and recorded here.
