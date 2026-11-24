# Milestone Status

Single source of truth for milestone progress. Updated at the end of every milestone (step H of the implementation cycle). Handoff reports are appended below the table.

| #   | Milestone                                    | Status                                                                                                               |
| --- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 00  | Foundation and deployment                    | Accepted locally; live Cloudflare deploy not yet run                                                                 |
| 01  | Secure institutional authentication          | Implemented and verified locally (unit, integration, E2E); awaiting owner acceptance. Real-mailbox test **not done** |
| 02  | Event registration and participant profiles  | Not started                                                                                                          |
| 03  | Team creation, invitations and join requests | Not started                                                                                                          |
| 04  | Event administration and notifications       | Not started                                                                                                          |
| 05  | Project submissions                          | Not started                                                                                                          |
| 06  | Google Drive uploads                         | Not started                                                                                                          |
| 07  | Production hardening                         | Not started                                                                                                          |
| 08  | Optional team chat                           | Not started                                                                                                          |

Suggested order from the project owner: build 00–03 first, demo to the manager, then 04–06; chat (08) only after the full registration-to-submission flow has been demonstrated.

## Open decisions before production

These do not block Milestone 00. They must be answered before the milestone shown.

| Decision                                                                                                                                        | Needed by    | Answer                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Permitted institutional email domain(s), and which sending method is available (SMTP/transactional service, Microsoft 365, or Google Workspace) | Milestone 01 | **Still open for production.** Built: configurable domain list + generic HTTPS provider (`EMAIL_API_URL`, Bearer key). If the organisation sends via Microsoft 365/Google Workspace/SMTP, one sibling provider class is needed. |
| Eligibility rule: every verified account on the domain, or only emails present in an employee roster (roster preferred)                         | Milestone 01 | **Both built**, switchable with `AUTH_ELIGIBILITY_MODE`; default `roster`. Owner to confirm.                                                                                                                                    |
| Does the organization have a Google Workspace Shared Drive (depends on edition), and which identity will own the integration                    | Milestone 06 | Open                                                                                                                                                                                                                            |

## Environment notes

- The Cloudflare D1 free database is limited to 500 MB per database; load testing and quota monitoring are required (Milestone 07).
- Cloudflare free-plan limits and the migration-off-Cloudflare strategy are in `docs/deployment.md` (sections 6 and 7).
- The remote Cloudflare steps have not been executed yet; see the Milestone 00 handoff.

## Housekeeping log

- 2026-11-24: Repository housekeeping files added (`AGENTS.md`, `.gitignore`, `.gitattributes`, `.editorconfig`, `.nvmrc`, this file). Nothing committed yet.
- 2026-11-24: Milestone 00 implemented on branch `milestone-00-foundation` (monorepo, API, web shell, D1 migrations, scripts, CI, docs). Not committed.
- 2026-11-24: Milestone 00 accepted by the owner after local verification (`pnpm check`, E2E, `pnpm dev`) and committed (`a121428`).
- 2026-11-24: Milestone 01 (institutional email authentication) implemented in the working tree on branch `milestone-00-foundation`. Not committed; a `milestone-01-auth` branch is suggested.

## Handoff reports

### Milestone 00 — Foundation (summary; full report delivered in chat)

- **Verified by execution (isolated copy, Linux VM):** shared 6/6, web 10/10, API 48/48 tests (Workers runtime, local D1); format, ESLint, typecheck, migration validation, secret scan, `pnpm audit --prod` (no known vulnerabilities), build and staging/production dry-run bundles, backup/restore drill 5/5.
- **Run on the owner's PC (2026-11-24):** `pnpm check` passed in full (format, lint, typecheck, migrations, secret scan, 64 tests, build). Playwright E2E: 13 passed, 3 skipped by design, 2 failed because of an ambiguous locator in `e2e/smoke.spec.ts` (a test bug, not an app bug); fixed and re-run: 15 passed, 3 skipped by design, 0 failed. `pnpm db:migrate:local` now runs non-interactively, and `pnpm dev` shows the System status page as operational (confirmed by the owner with a screenshot).
- **Not executed by the assistant:** any remote Cloudflare step.
- **Still open:** the deployment guide's live Cloudflare steps (needs an account; do before the first demo).
- **Setup note:** a restricted network may block `registry.npmjs.org`; install pnpm with `npm install -g pnpm@12.23.0` and set `pnpm_config_registry` to a reachable mirror for the session.
- **Known limitation:** `wrangler dev` may log a harmless `Unable to fetch Request.cf` warning when offline.

### Milestone 01 — Institutional email authentication (summary; full report delivered in chat)

- **Built:** email normalisation and domain allow-list; roster/domain eligibility; emailed 6-digit codes (hashed, single-use, expiring, attempt-limited, resend cooldown); server-side sessions in an HttpOnly/SameSite=Strict cookie (`__Host-` + Secure over HTTPS); logout and global revocation; admin roster and role management with optimistic concurrency and last-admin protection; audit log; multi-signal throttling; pluggable email provider (mock + generic HTTPS); `pnpm admin:bootstrap`; minimal login UI. Migration `0002_auth.sql`. API: see `docs/api-contracts.md`.
- **Verified by execution (isolated Linux copy, 2026-11-24):** shared 31/31, web 20/20 (21 after the menu fix), API 143/143 tests (Workers runtime, local D1); format, ESLint, typecheck, migration validation, secret scan (118 files), build (Worker bundle 156 KiB gzip), recovery drill 5/5. Four mutation checks (removing the single-use guard, the attempt limit, the last-admin guard and the session-revocation check) each made the relevant tests fail, so those tests do detect regressions.
- **Also exercised against a real `wrangler dev` Worker with curl:** identical `202` for approved and unapproved addresses, no mail to the unapproved one, wrong code `401`, right code `200` + HttpOnly/SameSite=Strict cookie, replay `401`, admin list `200`, logout then cookie replay `401`, cross-origin POST `403`, SPA `/login` served. `pnpm admin:bootstrap` checked locally (success, second run refused, hostile input rejected, remote without `--yes`/with placeholders refused).
- **Run on the owner's PC (2026-11-24):** `pnpm check` passed in full (shared 31, web 21, API 143 tests; build). Manual sign-in at `localhost:5173` worked. Playwright E2E first run: 17 passed, 3 skipped by design, 4 failed because of test/UI defects (E2E tests shared accounts and overwrote each other's codes; the mobile menu reopened when navigation returned to the page it was opened on, an M00 bug now fixed with a regression test; the smoke test counted the deliberate signed-out 401 as a console error). After fixing: **21 passed, 3 skipped by design, 0 failed**, including real-browser sign-in, reload, sign-out, wrong code, unapproved address and admin-versus-participant checks on desktop and mobile.
- **NOT executed:** any remote Cloudflare step; **a real organisational mailbox test** (see `docs/deployment.md` §5b). Production email integration is therefore **not verified**.
- **Design defaults chosen (confirm or change):** eligibility mode `roster`; generic HTTPS JSON email provider; first admin via `pnpm admin:bootstrap` (no HTTP route); code 10 min / 5 attempts / 60 s cooldown; session 7 days absolute, 24 h idle.
- **Known limitations:** see `docs/security.md` (Known gaps and risks, Milestone 01). Notably: CPU time and D1 write budget not measured on a deployed Worker; per-address throttle can delay a targeted person; no admin UI yet (admin API only).
