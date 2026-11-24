# Milestone Status

Single source of truth for milestone progress. Updated at the end of every milestone (step H of the implementation cycle). Handoff reports are appended below the table.

| #   | Milestone                                    | Status                                               |
| --- | -------------------------------------------- | ---------------------------------------------------- |
| 00  | Foundation and deployment                    | Accepted locally; live Cloudflare deploy not yet run |
| 01  | Secure institutional authentication          | Not started                                          |
| 02  | Event registration and participant profiles  | Not started                                          |
| 03  | Team creation, invitations and join requests | Not started                                          |
| 04  | Event administration and notifications       | Not started                                          |
| 05  | Project submissions                          | Not started                                          |
| 06  | Google Drive uploads                         | Not started                                          |
| 07  | Production hardening                         | Not started                                          |
| 08  | Optional team chat                           | Not started                                          |

Suggested order from the project owner: build 00–03 first, demo to the manager, then 04–06; chat (08) only after the full registration-to-submission flow has been demonstrated.

## Open decisions before production

These do not block Milestone 00. They must be answered before the milestone shown.

| Decision                                                                                                                                        | Needed by    | Answer |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------ |
| Permitted institutional email domain(s), and which sending method is available (SMTP/transactional service, Microsoft 365, or Google Workspace) | Milestone 01 | Open   |
| Eligibility rule: every verified account on the domain, or only emails present in an employee roster (roster preferred)                         | Milestone 01 | Open   |
| Does the organization have a Google Workspace Shared Drive (depends on edition), and which identity will own the integration                    | Milestone 06 | Open   |

## Environment notes

- The Cloudflare D1 free database is limited to 500 MB per database; load testing and quota monitoring are required (Milestone 07).
- Cloudflare free-plan limits and the migration-off-Cloudflare strategy are in `docs/deployment.md` (sections 6 and 7).
- The remote Cloudflare steps have not been executed yet; see the Milestone 00 handoff.

## Housekeeping log

- 2026-11-24: Repository housekeeping files added (`AGENTS.md`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.nvmrc`, this file). Nothing committed yet.
- 2026-11-24: Milestone 00 implemented on branch `milestone-00-foundation` (monorepo, API, web shell, D1 migrations, scripts, CI, docs). Not committed.
- 2026-11-24: Milestone 00 accepted by the owner after local verification (`pnpm check`, E2E, `pnpm dev`). Milestone 01 not started.

## Handoff reports

### Milestone 00 — Foundation (summary; full report delivered in chat)

- **Verified by execution (isolated copy, Linux VM):** shared 6/6, web 10/10, API 48/48 tests (Workers runtime, local D1); format, ESLint, typecheck, migration validation, secret scan, `pnpm audit --prod` (no known vulnerabilities), build and staging/production dry-run bundles, backup/restore drill 5/5.
- **Run on the owner's PC (2026-11-24):** `pnpm check` passed in full (format, lint, typecheck, migrations, secret scan, 64 tests, build). Playwright E2E: 13 passed, 3 skipped by design, 2 failed because of an ambiguous locator in `e2e/smoke.spec.ts` (a test bug, not an app bug); fixed and re-run: 15 passed, 3 skipped by design, 0 failed. `pnpm db:migrate:local` now runs non-interactively, and `pnpm dev` shows the System status page as operational (confirmed by the owner with a screenshot).
- **Not executed by the assistant:** any remote Cloudflare step.
- **Still open:** the deployment guide's live Cloudflare steps (needs an account; do before the first demo).
- **Setup note:** a restricted network may block `registry.npmjs.org`; install pnpm with `npm install -g pnpm@12.23.0` and set `pnpm_config_registry` to a reachable mirror for the session.
- **Known limitation:** `wrangler dev` may log a harmless `Unable to fetch Request.cf` warning when offline.
