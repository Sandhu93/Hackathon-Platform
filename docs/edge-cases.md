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

## Carried forward to later milestones

Recorded now so they are not forgotten:

- **M01**: OTP replay/concurrency, enumeration-safe responses, session revocation, last-admin protection, provider timeout, **10 ms CPU budget** for hashing on the Free plan.
- **M02**: concurrent registration, single published event under concurrency, profile text limits and sanitisation.
- **M03**: capacity and one-team-per-event invariants under concurrent accepts/joins.
- **M04**: duplicate scheduled jobs, outbox retries and dead-letter handling, daily D1 row-write quota.
- **M05–M06**: stale-write detection, deadline races, upload resumption and orphan cleanup.
