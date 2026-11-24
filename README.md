# Hackathon Platform

Internal web application for running hackathons (200–1,000 participants): eligible employees register, find teammates, form teams of 1–4, and submit projects. Built on Cloudflare Workers, D1 and React.

> **Status:** Milestone 00 (foundation) only — project skeleton, API plumbing, migrations, tests and deployment guide. There is no sign-in, event or team functionality yet. See [`docs/milestones/STATUS.md`](docs/milestones/STATUS.md).

## Stack

TypeScript · React + Vite · Hono on Cloudflare Workers · Cloudflare D1 (SQLite) · Zod · Vitest · Playwright · pnpm workspaces.

```
apps/api         Hono Worker (also serves the built web app as static assets)
apps/web         React + Vite single-page app
packages/shared  Zod schemas and types shared by both (API errors, health, config)
scripts/         Migration validation, recovery drill, secret scan, deploy guards, E2E server
docs/            Requirements, architecture, database, security, API, edge cases, deployment
```

## Prerequisites

- **Node.js 24** (`.nvmrc`; Node ≥ 22.12 also works)
- **pnpm 12.23.0** — `corepack enable` and the pinned `packageManager` field do the rest
- A Cloudflare account is **not** needed for local development or tests

## Quick start

```bash
corepack enable
pnpm install
pnpm db:migrate:local      # create the local D1 database and apply migrations
pnpm dev                   # API on :8787, web on :5173 (proxying /api to the API)
```

Open http://localhost:5173. The **System status** page calls `GET /api/health`.

No credentials are required: email and Google Drive use in-memory mocks locally. Optional local overrides go in `apps/api/.dev.vars` (copy from `.dev.vars.example`; it is git-ignored).

## Commands

| Command                     | What it does                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `pnpm dev`                  | Start API (:8787) and web (:5173)                                                   |
| `pnpm check`                | Everything below except E2E: format, lint, types, migrations, secrets, tests, build |
| `pnpm test`                 | Unit and integration tests (Vitest; API tests run inside the Workers runtime)       |
| `pnpm test:e2e`             | Playwright smoke tests (first run: `pnpm exec playwright install chromium`)         |
| `pnpm typecheck`            | `tsc` in every package (strict mode)                                                |
| `pnpm lint` / `pnpm format` | ESLint (type-aware, a11y) / Prettier                                                |
| `pnpm build`                | Build the web app, then bundle the Worker (dry run, no deploy)                      |
| `pnpm db:migrate:local`     | Apply migrations to the local D1 database                                           |
| `pnpm db:validate`          | Static checks on migration files (naming, immutability, forbidden statements)       |
| `pnpm db:lock`              | Record hashes of new migrations after review                                        |
| `pnpm db:test-recovery`     | Backup → restore drill on throwaway local databases                                 |
| `pnpm security:secrets`     | Scan the working tree for committed secrets                                         |
| `pnpm security:audit`       | `pnpm audit --prod`                                                                 |

## Documentation

| Document                                      | Contents                                                    |
| --------------------------------------------- | ----------------------------------------------------------- |
| [requirements](docs/requirements.md)          | Product scope, decisions, Milestone 00 requirements         |
| [architecture](docs/architecture.md)          | Components, request pipeline, configuration, adapters       |
| [database](docs/database.md)                  | Conventions, migration workflow, recovery, portability      |
| [security](docs/security.md)                  | Threat coverage, controls, logging policy, known gaps       |
| [api-contracts](docs/api-contracts.md)        | Conventions, error format, endpoints                        |
| [edge-cases](docs/edge-cases.md)              | Edge cases and the tests that cover them                    |
| [deployment](docs/deployment.md)              | Cloudflare free-plan deployment, limits, migration strategy |
| [milestone status](docs/milestones/STATUS.md) | Progress, open decisions, handoff reports                   |
| [AGENTS.md](AGENTS.md)                        | Engineering rules for AI-assisted development               |
