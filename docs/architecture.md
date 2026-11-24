# Architecture

## Overview

One Cloudflare Worker serves everything from a single origin:

```
Browser ──► Cloudflare edge
              ├─ /api/*  ──► Worker (Hono) ──► D1 (SQLite)
              │                  └─ adapters: email, Drive (mocks locally)
              └─ everything else ──► static assets (built React SPA, SPA fallback)
```

`run_worker_first: ["/api/*"]` makes only API paths invoke the Worker; static files are served by the platform (free, unlimited) with their own headers from `apps/web/public/_headers`. One origin means no CORS for the app itself, simple cookies (`SameSite`, Milestone 01) and an easy CSRF story.

Local development uses two processes with the same shape: Vite on `:5173` proxies `/api` to `wrangler dev` on `:8787`.

## Packages

| Package             | Responsibility                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `@hackathon/shared` | Zod schemas and types shared by API and web: error envelope, health response, config schema. Consumed as TypeScript source (no build step). |
| `@hackathon/api`    | Hono app, middleware, routes, adapters, migrations, tests.                                                                                  |
| `@hackathon/web`    | React SPA: layout/navigation shell, status page, API client that validates responses with the shared schemas.                               |

Cloudflare-specific code stays at the edges: `src/index.ts` (entry), the `DB`/`ASSETS` bindings in `types.ts`, and `wrangler.jsonc`. Handlers use Hono and Web-standard APIs only; ESLint forbids Node built-ins in Worker, shared and web code, and the Worker is bundled **without** `nodejs_compat`, so Node-only APIs fail the build.

## Request pipeline

Order is deliberate (`apps/api/src/app.ts`):

1. **context** — request ID (safe inbound `X-Request-Id` reused, otherwise a UUID), config validation, request-scoped logger.
2. **access log** — one line per request after the response: method, path (no query string), status, duration.
3. **security headers** — CSP `default-src 'none'`, HSTS, nosniff, frame deny, referrer, COOP/CORP, permissions policy.
4. **no-store** — API responses are never cached.
5. **config guard** — invalid configuration fails closed with a generic 503 (details only in logs).
6. **CORS** — allow-list from `CORS_ALLOWED_ORIGINS`; default none; never `*`.
7. **origin check** — state-changing requests with an unlisted `Origin` get 403 (CSRF defence in depth).
8. **body limit** — `MAX_JSON_BODY_BYTES` (default 64 KiB), enforced for `Content-Length` and streamed bodies.
9. **routes**, then `notFound` (404, or 405 with `Allow` when the path exists for other methods) and `onError`.

`onError` maps `AppError` → its code; `ConfigError` → generic 503; Zod/HTTP exceptions → standard 4xx; anything else → `INTERNAL_ERROR` 500 with no detail. Stacks and messages go to the redacted log only.

Handlers that accept JSON must call `parseJsonBody(c, schema)`: it enforces `Content-Type: application/json`, returns `MALFORMED_JSON` / `VALIDATION_ERROR` and never echoes rejected values.

## Configuration and secrets

- **Non-secret config** (`ENVIRONMENT`, `APP_ORIGIN`, `CORS_ALLOWED_ORIGINS`, `LOG_LEVEL`, `APP_VERSION`, `EMAIL_PROVIDER`, `DRIVE_PROVIDER`, `MAX_JSON_BODY_BYTES`) lives in `wrangler.jsonc` `vars`, validated per request by `appConfigSchema`. Staging/production additionally require https, non-local origins.
- **Secrets** (`EMAIL_PROVIDER_API_KEY`, `GOOGLE_SERVICE_ACCOUNT_JSON`, later keys) are set with `wrangler secret put` and `.dev.vars` locally. They are validated _lazily_ by the adapter factory that needs them, so a missing third-party credential cannot take down `/api/health` or unrelated endpoints, yet features that need them fail closed.
- Factories refuse the mock providers when `ENVIRONMENT=production`.

## Adapters

| Adapter             | Interface                           | Local                                                                                   | Production                                  |
| ------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------- |
| Institutional email | `EmailProvider.send(message)`       | `MockEmailProvider` (in-memory; logs masked recipient and subject only, never the body) | Milestone 01, once the mail system is known |
| Google Drive        | `DriveStorageAdapter` (provisional) | `MockDriveStorageAdapter` (in-memory, safe-name validation)                             | Milestone 06                                |

Mocks keep state per Worker isolate, which is fine for tests and single-process local dev. Milestone 01 must decide how developers read mock emails (e.g. a development-only inspection route or log line).

## Web app

React 19 + react-router. The shell has a skip link, landmarks, a responsive menu (`aria-expanded`/`aria-controls`, Escape closes it, 44 px targets), per-route document titles and focus moved to `<main>` on navigation. The API client validates every response against the shared Zod schemas and shows request IDs on errors so users can quote them.

## Testing layers

| Layer       | Tool                                                        | Scope                                                                              |
| ----------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Unit        | Vitest (Node)                                               | `packages/shared` config schema                                                    |
| Integration | Vitest in the Workers runtime (`@cloudflare/vitest-plugin`) | Real Worker entry, local D1 with migrations applied, middleware, adapters, logging |
| Component   | Vitest + Testing Library (jsdom)                            | Shell, navigation, status page states                                              |
| E2E         | Playwright (Chromium; desktop + mobile viewport)            | Built SPA + Worker + local D1 on one origin                                        |
| Tooling     | Node scripts                                                | Migration validation, backup/restore drill, secret scan                            |
