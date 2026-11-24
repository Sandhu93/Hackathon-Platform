# Requirements

## Product

A secure application for an organisation that hosts hackathons one after another (200–1,000 participants).

**Participants** sign in with an approved institutional email (OTP / magic link), register for the one published event, build a profile, discover other participants of the same event, form teams of 1–4 (invitations and join requests, changes allowed until the team-lock deadline), receive in-app and email notifications, and prepare a team project submission (editable until the deadline).

**Administrators** create, configure, publish and archive events; manage eligibility, registrations and teams; configure deadlines and file limits; publish announcements and reminders; review submissions; and perform audited overrides.

Judging and chat are out of the first production release.

## Decisions

| Decision                | Policy                                        |
| ----------------------- | --------------------------------------------- |
| Participant identity    | Institutional email plus employee eligibility |
| Registration            | Automatic for eligible employees              |
| Multiple events         | Supported, only one active at a time          |
| Team size               | 1–4                                           |
| Team membership         | One active team per participant per event     |
| Invitations             | In-app with email notification                |
| Team changes            | Allowed until team lock                       |
| Project editing         | All active members                            |
| Final submission        | Team leader                                   |
| Project storage         | Organisation Google Drive                     |
| Data visibility         | Event- and team-scoped                        |
| Chat / Judging          | After MVP / deferred                          |
| Deployment              | Cloudflare free infrastructure initially      |
| Commercial dependencies | No mandatory paid additions                   |

Open organisational questions (email domain and sending method, employee roster, Shared Drive) are tracked in [`milestones/STATUS.md`](milestones/STATUS.md).

## Non-functional requirements (all milestones)

- Backend authorisation independent of the UI; never trust client-supplied role, event, team, user or file identifiers.
- Database constraints and transactions for concurrency-sensitive operations.
- UTC timestamps persisted; server is authoritative for deadlines.
- Bounded queries, server-side pagination, indexes.
- No secrets in the repository or in logs; no auth credentials in `localStorage`.
- Accessible (WCAG 2.1 AA target) and mobile-responsive UI.
- Keep a migration path to Node.js and PostgreSQL ([deployment.md](deployment.md#7-migration-strategy-off-cloudflare)).

## Milestone 00 — Foundation (this milestone)

In scope: monorepo; React shell; Hono Worker; D1 with local/staging/production environments; migration workflow; shared Zod schemas and error format; environment validation; email and Drive mocks; `GET /api/health`; Vitest and Playwright; lint/format/strict types/CI; security headers, request IDs, redacted structured logs, CORS, body limits, central error handling; deployment guide and free-tier notes.

Out of scope: authentication, users, events, teams, uploads, notifications.

| #     | Requirement                                                   | Where                                                    |
| ----- | ------------------------------------------------------------- | -------------------------------------------------------- |
| 1–3   | Monorepo, React + Vite, Hono Worker                           | `apps/*`, `packages/shared`                              |
| 4     | D1 local and production environments                          | `apps/api/wrangler.jsonc`                                |
| 5     | Migrations and validation workflow                            | `apps/api/migrations`, `scripts/validate-migrations.mjs` |
| 6     | Shared Zod schemas, standard error responses                  | `packages/shared/src`                                    |
| 7     | Environment validation and secret management                  | `packages/shared/src/env.ts`, [security.md](security.md) |
| 8     | Mocks for email and Google Drive                              | `apps/api/src/adapters`                                  |
| 9     | `GET /api/health`                                             | `apps/api/src/routes/health.ts`                          |
| 10    | Vitest and Playwright                                         | `apps/*/vitest                                           | vite.config.ts`, `playwright.config.ts` |
| 11    | ESLint, Prettier, strict TypeScript, automated checks         | `eslint.config.js`, `.github/workflows/ci.yml`           |
| 12    | Responsive application shell                                  | `apps/web/src/components/Layout.tsx`                     |
| 13    | Headers, request IDs, redacted logs, CORS, body limit, errors | `apps/api/src/middleware`, `apps/api/src/app.ts`         |
| 14–15 | Deployment guide, free-tier limits, migration strategy        | [deployment.md](deployment.md)                           |
