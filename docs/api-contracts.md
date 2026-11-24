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

| Code                      | HTTP | Meaning                                              |
| ------------------------- | ---- | ---------------------------------------------------- |
| `BAD_REQUEST`             | 400  | Generic malformed request                            |
| `MALFORMED_JSON`          | 400  | Body is empty or not valid JSON                      |
| `VALIDATION_ERROR`        | 400  | Body parsed but failed schema validation             |
| `UNAUTHENTICATED`         | 401  | No/invalid/expired/revoked session                   |
| `INVALID_OR_EXPIRED_CODE` | 401  | Sign-in code wrong, used, expired or locked          |
| `FORBIDDEN`               | 403  | Authenticated but not allowed (e.g. not an admin)    |
| `FORBIDDEN_ORIGIN`        | 403  | Cross-origin state-changing request rejected         |
| `NOT_FOUND`               | 404  | Unknown route or resource                            |
| `METHOD_NOT_ALLOWED`      | 405  | Path exists, method does not (`Allow` header set)    |
| `CONFLICT`                | 409  | State conflict (duplicates, capacity, stale version) |
| `LAST_ADMIN`              | 409  | Would leave the system with no active administrator  |
| `PAYLOAD_TOO_LARGE`       | 413  | Body over the limit                                  |
| `UNSUPPORTED_MEDIA_TYPE`  | 415  | Not `application/json`                               |
| `RATE_LIMITED`            | 429  | Throttled; `Retry-After` (seconds) set               |
| `INTERNAL_ERROR`          | 500  | Unexpected failure; nothing else disclosed           |
| `SERVICE_UNAVAILABLE`     | 503  | Misconfiguration or dependency outage                |

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

## Authentication (Milestone 01)

Sessions are an opaque random token in an `HttpOnly`, `SameSite=Strict`, `Path=/` cookie (`hackathon_session`; over HTTPS the name is `__Host-hackathon_session` and the cookie is also `Secure`). The token is never in a response body. State-changing requests need a same-origin `Origin` header (browsers send it) as everywhere else.

Sign-in is **two steps**: ask for a code, then prove you received it. Neither step ever tells the caller whether an address is approved.

| Method & path                    | Auth    | Success                                            | Notable errors                                              |
| -------------------------------- | ------- | -------------------------------------------------- | ----------------------------------------------------------- |
| `POST /api/auth/otp/request`     | none    | `202` `{status:"accepted", resendAfterSeconds}`    | `400` malformed email, `429` throttled, `503` misconfigured |
| `POST /api/auth/otp/verify`      | none    | `200` `{user, session}` + `Set-Cookie`             | `401 INVALID_OR_EXPIRED_CODE`, `400`, `429`, `503`          |
| `GET /api/auth/session`          | session | `200` `{user, session:{expiresAt}}`                | `401 UNAUTHENTICATED` (and the stale cookie is cleared)     |
| `POST /api/auth/logout`          | any     | `204`, cookie cleared                              | none: idempotent, safe without a session                    |
| `POST /api/auth/sessions/revoke` | session | `200` `{revoked: n}` (every session of the caller) | `401`                                                       |

### `POST /api/auth/otp/request`

Body `{ "email": "name@institution.edu" }` (strict: unknown fields → `400`). The email is trimmed and lower-cased; nothing else is changed (no plus-tag or dot rewriting, see `docs/security.md`).

**Always `202` with the same body** when the address is well-formed and the caller is not throttled, whether the address is approved, unknown, on another domain, suspended, revoked or a shared mailbox. A code is emailed only to an approved personal mailbox. A request inside the resend cooldown (default 60 s) still answers `202` but sends nothing new; after the cooldown a new code replaces the old one (only the newest works). A mail-provider failure is also hidden from the caller (it is audited, and the dead code is released so an immediate retry works).

### `POST /api/auth/otp/verify`

Body `{ "email", "code" }` where `code` is exactly 6 digits. On success: `200`, `Set-Cookie`, and

```json
{
  "user": {
    "id": "…",
    "email": "ada@institution.edu",
    "displayName": "Ada",
    "role": "participant"
  },
  "session": { "expiresAt": "2026-12-01T10:00:00.000Z" }
}
```

**Every** failure (no code requested, wrong, expired, already used, attempts exhausted, account no longer eligible, unknown address) is the identical `401 INVALID_OR_EXPIRED_CODE`. A code is single-use even under concurrent submission (exactly one request wins), expires after `AUTH_OTP_TTL_SECONDS` (default 600), and locks after `AUTH_OTP_MAX_ATTEMPTS` (default 5) wrong guesses. Any new sign-in creates a brand-new session token; a cookie sent by the client before sign-in is ignored (no session fixation).

### Sessions

A session ends at the absolute lifetime (`AUTH_SESSION_TTL_SECONDS`, default 7 days), after `AUTH_SESSION_IDLE_TTL_SECONDS` of inactivity (default 24 h), on logout, on "sign out everywhere", when an admin revokes it, or when the account stops being eligible (suspended, revoked, marked shared, or its domain removed from the allow-list). Eligibility and role are **re-read on every request**, so a revocation or demotion applies to the very next call; a revoked cookie is dead on the server even if someone stole a copy.

### Throttling

`429 RATE_LIMITED` with `Retry-After`. Request and verify are each limited per **address**, per **network source** (IPv4 address, or IPv6 /64) and **globally**, so one noisy IP cannot lock out everyone and one address cannot be sprayed from many IPs. Limits are configurable (`AUTH_RL_*`). Unknown and ineligible addresses are throttled exactly like real ones.

## Administration (Milestone 01)

All `/api/admin/*` routes need a session whose user is an **active admin**: `401` without a session, `403 FORBIDDEN` for a participant. Roles are never accepted from a client at creation time; they change only through the role endpoint.

| Method & path                               | Success                                      | Notable errors                                                      |
| ------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `GET /api/admin/users`                      | `200` `{users[], nextCursor}`                | `400` bad query                                                     |
| `POST /api/admin/users`                     | `201` user                                   | `400` email invalid or domain not allowed, `409 CONFLICT` duplicate |
| `POST /api/admin/users/bulk`                | `200` `{created, alreadyExisted, invalid[]}` | `400` more than 50 entries                                          |
| `GET /api/admin/users/:id`                  | `200` user                                   | `404`                                                               |
| `PATCH /api/admin/users/:id`                | `200` user                                   | `404`, `409 CONFLICT` stale version, `409 LAST_ADMIN`, `400`        |
| `PUT /api/admin/users/:id/role`             | `200` user                                   | `404`, `409 CONFLICT`, `409 LAST_ADMIN`, `400`                      |
| `POST /api/admin/users/:id/sessions/revoke` | `200` `{revoked: n}`                         | `404`                                                               |
| `GET /api/admin/audit`                      | `200` `{entries[], nextCursor}`              | `400`                                                               |

A user object: `{ id, email, displayName, role: "participant"|"admin", status: "active"|"suspended"|"revoked", mailboxKind: "personal"|"shared", version, createdAt, updatedAt, lastLoginAt }`.

- **List**: `?limit` (1–100, default 50), `?after=<cursor>` (keyset on email), `?status`, `?role`, `?q` (email/name prefix-or-substring, ≤ 40 chars).
- **Create**: `{ email, displayName?, mailboxKind? }`. The domain must be on the allow-list.
- **Bulk**: `{ users: [{email, displayName?}] }`, at most 50 per call. Invalid rows are reported by index with a reason (`invalid_email`, `domain_not_allowed`, `duplicate_in_request`) and the rest are still created; existing addresses are counted, not changed.
- **Change** (`PATCH`): `{ expectedVersion, status?, displayName?, mailboxKind? }`, at least one field. `status: "suspended"|"revoked"` (and `mailboxKind: "shared"`) immediately revokes the user's sessions and pending codes.
- **Role** (`PUT …/role`): `{ role, expectedVersion }`.
- **Optimistic concurrency**: read the user, send back its `version` as `expectedVersion`. If someone else changed it meanwhile the answer is `409 CONFLICT` and **nothing is applied**; reload and retry.
- **Last admin**: demoting, suspending, revoking or marking-shared the only active personal-mailbox admin is refused with `409 LAST_ADMIN`. The check and the write are one atomic statement, so two admins demoting each other at the same instant cannot leave zero admins.
- **Audit**: `?limit` (≤ 100), `?before=<id>`, `?eventType`, `?targetUserId`; newest first. Entries carry categories and ids, never codes, tokens or full email addresses.

### Development only

`GET /api/dev/mailbox` returns the messages the **mock** email provider "sent" (so a developer can read the code). It answers `404` unless `ENVIRONMENT=development` **and** `EMAIL_PROVIDER=mock`.

### Reserved for later milestones

Events/registration/profiles (M02), teams (M03), admin/notifications (M04), submissions (M05), file uploads (M06). Exact routes and status codes are fixed in each milestone's design step and recorded here.
