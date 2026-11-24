# Edge Cases

Each row names the behaviour and the test (or manual check) that proves it. Future milestones append their own sections.

## Milestone 00 — foundation

| Edge case                                                      | Expected behaviour                                                                                 | Verified by                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Unknown API route                                              | `404 NOT_FOUND`, standard envelope, request ID matches header                                      | `health.test.ts`                                   |
| Path outside `/api` reaching the Worker                        | `404 NOT_FOUND` JSON                                                                               | `health.test.ts`                                   |
| Known path, wrong method (`POST/PUT/PATCH/DELETE /api/health`) | `405` + `Allow: GET, HEAD`                                                                         | `health.test.ts`                                   |
| `HEAD /api/health`                                             | 200, empty body                                                                                    | `health.test.ts`                                   |
| Malformed JSON body                                            | `400 MALFORMED_JSON`                                                                               | `pipeline.test.ts`                                 |
| Empty body where JSON required                                 | `400 MALFORMED_JSON`                                                                               | `pipeline.test.ts`                                 |
| Wrong `Content-Type`                                           | `415 UNSUPPORTED_MEDIA_TYPE`                                                                       | `pipeline.test.ts`                                 |
| Schema-invalid body                                            | `400 VALIDATION_ERROR`, field paths only, no values echoed                                         | `pipeline.test.ts`                                 |
| Oversized body (declared length)                               | `413 PAYLOAD_TOO_LARGE`                                                                            | `pipeline.test.ts`                                 |
| Oversized body (chunked, no length)                            | `413`                                                                                              | `pipeline.test.ts`                                 |
| Unexpected exception containing secrets/PII                    | `500 INTERNAL_ERROR`, no detail to client; log line redacted                                       | `pipeline.test.ts`                                 |
| Missing `APP_ORIGIN` / `ENVIRONMENT`                           | `503 SERVICE_UNAVAILABLE`, generic body, setting name only in the log, security headers still sent | `config.test.ts`                                   |
| Invalid config value (e.g. origin with a path)                 | 503; the value is never logged                                                                     | `config.test.ts`, `env.test.ts`                    |
| Staging/production with `http://` or localhost origins         | Config invalid                                                                                     | `env.test.ts`                                      |
| Mock email/Drive selected in production                        | `ConfigError` → generic 503 when the feature is used                                               | `config.test.ts`                                   |
| Real provider selected without credentials                     | `ConfigError` naming the setting, never a value                                                    | `config.test.ts`                                   |
| Database unreachable                                           | `/api/health` → 503 `degraded`, error logged                                                       | `health.test.ts`                                   |
| Hostile `X-Request-Id`                                         | Replaced with a generated ID                                                                       | `health.test.ts`                                   |
| Cross-origin request from unlisted origin                      | No CORS headers; unsafe methods → `403 FORBIDDEN_ORIGIN`                                           | `pipeline.test.ts`                                 |
| Preflight from allowed / unlisted origin                       | Allowed: 204 with headers; unlisted: no `Access-Control-Allow-Origin`                              | `pipeline.test.ts`                                 |
| Request without `Origin` (non-browser client)                  | Allowed through origin check                                                                       | `pipeline.test.ts`                                 |
| Secrets in query string, headers or inline text of a log field | Never logged / redacted                                                                            | `logging.test.ts`                                  |
| Email address in logs                                          | Masked (`a***@domain`)                                                                             | `logging.test.ts`, `config.test.ts`                |
| Mock email body (future login code)                            | Never logged                                                                                       | `config.test.ts`                                   |
| Drive mock given `..` or `/` in names                          | Rejected (promise rejection, not a sync throw)                                                     | `config.test.ts`                                   |
| Migrations on a fresh database                                 | Applied, recorded, constraints enforced                                                            | `migrations.test.ts`                               |
| Edited applied migration                                       | `db:validate` fails (hash lock)                                                                    | manual: change `0001_…sql`, run `pnpm db:validate` |
| Migration with `BEGIN`, `DROP`, etc.                           | `db:validate` fails                                                                                | script rules                                       |
| Data loss and restore                                          | Export → restore into empty DB preserves data and migration history; re-migrating is a no-op       | `pnpm db:test-recovery`                            |
| Deploy with placeholder IDs/origins                            | `check-deploy-config` blocks the deploy                                                            | manual run (exit 1)                                |
| Deep link / refresh on an SPA route                            | Served `index.html`; client router renders the page                                                | `e2e/smoke.spec.ts`                                |
| Unknown SPA route                                              | In-app "Page not found"                                                                            | `App.test.tsx`, `e2e/smoke.spec.ts`                |
| API unreachable / non-JSON / wrong schema from the UI's view   | Status page shows a calm error, no internals; retry works                                          | `App.test.tsx`                                     |
| Mobile viewport                                                | Menu button, toggle with `aria-expanded`, Escape closes                                            | `App.test.tsx`, `e2e/smoke.spec.ts`                |

## Milestone 01 — institutional email authentication

| Edge case                                                                         | Expected behaviour                                                                                                       | Verified by                                         |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| Non-institutional email requests a code                                           | Same `202` as every other address; nothing mailed; audited as `domain_not_allowed`                                       | `auth-otp.test.ts`                                  |
| Institutional address not on the roster / deactivated / revoked / suspended       | Same `202`; nothing mailed; verify is the generic `401`                                                                  | `auth-otp.test.ts`                                  |
| Shared / group mailbox                                                            | Never receives a code; cannot sign in; does not count as an admin                                                        | `auth-otp.test.ts`, `admin.test.ts`                 |
| Plus-tag, dot variants, mixed case, surrounding spaces                            | Only trim + lower-case; `a+x@` and `ax@` are different mailboxes                                                         | `auth-otp.test.ts`, `email.test.ts`                 |
| Malformed / Unicode / over-long address                                           | `400 VALIDATION_ERROR` (format only; never account hints)                                                                | `email.test.ts`, `auth-otp.test.ts`                 |
| Account existence probing via request, verify or throttling                       | Byte-identical `202`; one generic `401`; identical `429` behaviour for known and unknown addresses                       | `auth-otp.test.ts`, `auth-throttle.test.ts`         |
| Code reuse, and browser refresh re-submitting the form                            | Second use is `401`                                                                                                      | `auth-otp.test.ts`                                  |
| Simultaneous verification of one code                                             | Exactly one `200`, the rest `401`; exactly one session                                                                   | `auth-otp.test.ts`                                  |
| Expired code                                                                      | `401`                                                                                                                    | `auth-otp.test.ts`                                  |
| Wrong code, brute force, parallel guesses                                         | Locked after the attempt limit; attempts never exceed it, even in parallel; right code refused afterwards                | `auth-otp.test.ts`                                  |
| Many code requests / concurrent requests                                          | Resend cooldown sends nothing new; only the newest code works; one usable challenge per address                          | `auth-otp.test.ts`                                  |
| Mail provider fails or times out                                                  | Client still sees `202`; failure audited; dead code released so an immediate retry works; request is not left hanging    | `auth-otp.test.ts`, `email-provider.test.ts`        |
| Email provider / `AUTH_HMAC_SECRET` / domain list missing or weak in production   | Generic `503` on auth routes only (health unaffected); setting name logged, never a value                                | `auth-otp.test.ts`                                  |
| Mock provider selected in production                                              | Refused (`503`); `/api/dev/mailbox` is `404` outside development                                                         | `auth-otp.test.ts`, `config.test.ts`                |
| Logout then replay of the old cookie                                              | `401`; session revoked server-side                                                                                       | `auth-session.test.ts`                              |
| Session idle / absolute expiry                                                    | `401` after either; activity extends idle only                                                                           | `auth-session.test.ts`                              |
| Session fixation (cookie planted before sign-in)                                  | Ignored; fresh token issued; planted value never authenticates                                                           | `auth-session.test.ts`                              |
| Cookie theft assumptions                                                          | HttpOnly, SameSite=Strict, `__Host-`+Secure over HTTPS; only a hash stored, so DB read ≠ access; revocation is immediate | `auth-session.test.ts`, `e2e/auth.spec.ts`          |
| Account suspended / marked shared / domain removed during an active session       | Next request is `401`                                                                                                    | `auth-session.test.ts`                              |
| Role changed during an active session                                             | Takes effect on the next request (demoted admin gets `403`)                                                              | `admin.test.ts`                                     |
| Participant calls an admin endpoint or promotes themselves                        | `403`; role unchanged. Unauthenticated: `401`                                                                            | `admin.test.ts`, `e2e/auth.spec.ts`                 |
| Demote / suspend / revoke / mark-shared the last active admin                     | `409 LAST_ADMIN`, nothing changed, attempt audited                                                                       | `admin.test.ts`                                     |
| Two admins demote each other simultaneously                                       | Exactly one succeeds; one active admin always remains                                                                    | `admin.test.ts`                                     |
| Two admins change the same user (stale version)                                   | Second gets `409 CONFLICT` and nothing is applied; identical concurrent requests apply once                              | `admin.test.ts`                                     |
| Disabling an account with pending codes and live sessions                         | Sessions and codes revoked in the same transaction                                                                       | `admin.test.ts`                                     |
| Bulk roster import with bad / duplicate / existing rows                           | Per-row report; valid rows created; > 50 rows → `400`                                                                    | `admin.test.ts`                                     |
| Throttling by address, source, IPv6 /64, global; blocked caller writes            | Each limit enforced independently; window reopens after an hour; blocked callers do not consume shared budget            | `auth-throttle.test.ts`                             |
| Codes, tokens, secrets or full addresses in logs / responses / DB                 | Never present; only keyed hashes stored                                                                                  | `auth-logging.test.ts`, `auth-otp.test.ts`          |
| Bootstrap run when an admin exists, with hostile input, or remote without `--yes` | Refuses, changes nothing; SQL-injection attempt rejected by charset check                                                | manual (see handoff), `scripts/bootstrap-admin.mjs` |
| Login UI: bad input, wrong code, throttled, 503, resend, change address           | Calm, specific, non-revealing messages; focus moves to the code field; logout failure still signs out locally            | `auth.test.tsx`                                     |
| End-to-end browser sign-in, reload, sign-out, admin vs participant                | Works; cookie HttpOnly; old cookie dead after logout                                                                     | `e2e/auth.spec.ts` (run locally)                    |
| Real organisational mailbox delivers a code                                       | **Not yet verified**: manual test required before production email is marked verified                                    | manual (deployment.md §5b)                          |

## Carried forward to later milestones

Recorded now so they are not forgotten:

- **M01 (still open)**: measure CPU time and D1 writes on the deployed Worker; real-mailbox delivery test.
- **M02**: concurrent registration, single published event under concurrency, profile text limits and sanitisation.
- **M03**: capacity and one-team-per-event invariants under concurrent accepts/joins.
- **M04**: duplicate scheduled jobs, outbox retries and dead-letter handling, daily D1 row-write quota.
- **M05–M06**: stale-write detection, deadline races, upload resumption and orphan cleanup.
