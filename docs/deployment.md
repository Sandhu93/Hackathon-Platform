# Deployment (Cloudflare Free Plan)

Everything below uses the Cloudflare **Free** plan: one Worker per environment (serving the API and the static React app), one D1 database per environment, no paid add-ons.

> **Verification status:** local development, tests, builds and `wrangler deploy --dry-run` for all three environments were run during Milestone 00. The remote steps (login, `d1 create`, remote migrations, deploy, Time Travel) need a Cloudflare account and **have not been executed against a live account yet**. Follow the manual validation list in the Milestone 00 handoff and record the outcome in `milestones/STATUS.md`.

## 1. Environments

| Environment | Worker name                     | D1 database            | Config key       | Purpose                               |
| ----------- | ------------------------------- | ---------------------- | ---------------- | ------------------------------------- |
| Local       | `wrangler dev` / `vitest`       | local SQLite files     | top level        | Development, tests (mock email/Drive) |
| Staging     | `hackathon-platform-staging`    | `hackathon-staging`    | `env.staging`    | Rehearsals, demos                     |
| Production  | `hackathon-platform-production` | `hackathon-production` | `env.production` | Real events                           |

Staging and production are fully separate (own Worker, database, secrets, origin). Wrangler does not inherit bindings or vars between environments, so each is spelled out in `apps/api/wrangler.jsonc`.

## 2. Prerequisites

- Node 24, `corepack enable`, `pnpm install` from the repo root.
- A free Cloudflare account. Authenticate with **either** `pnpm --filter @hackathon/api exec wrangler login` (interactive) **or** an API token exported as `CLOUDFLARE_API_TOKEN` (CI) with only: _Workers Scripts: Edit_, _D1: Edit_, _Account Settings: Read_. Never commit the token.
- Optional: `pnpm --filter @hackathon/api exec wrangler telemetry disable`.

## 3. One-time setup per environment

Run from the repo root. Replace `staging` with `production` for the second environment.

```bash
# 1. Create the database and note the returned database_id
pnpm --filter @hackathon/api exec wrangler d1 create hackathon-staging

# 2. Edit apps/api/wrangler.jsonc → env.staging:
#      d1_databases[0].database_id = <id from step 1>
#      vars.APP_ORIGIN             = the exact https origin users will visit,
#                                    e.g. https://hackathon-platform-staging.<your-subdomain>.workers.dev
#    (the <your-subdomain> part is shown after the first deploy, or on the Cloudflare dashboard
#     under Workers & Pages → Account details; deploy once, then set APP_ORIGIN and redeploy)

# 3. Guard: fails while any REPLACE_WITH_* placeholder or mock production provider remains
node scripts/check-deploy-config.mjs staging
```

Settings for sign-in (Milestone 01). Non-secret values go in `apps/api/wrangler.jsonc` under `env.<name>.vars`; the placeholder guard blocks deploys until they are real:

| Variable                     | Meaning                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | Comma-separated institutional domains, e.g. `college.edu`                                        |
| `AUTH_ELIGIBILITY_MODE`      | `roster` (default: only admin-approved addresses) or `domain` (any mailbox on an allowed domain) |
| `EMAIL_PROVIDER`             | `external` in staging/production (`mock` is refused in production)                               |
| `EMAIL_API_URL`              | https endpoint of the transactional-email API (POST JSON, Bearer key)                            |
| `EMAIL_FROM_ADDRESS`         | Sender address (must be a verified sender at the provider)                                       |

Optional tuning (defaults in parentheses): `AUTH_OTP_TTL_SECONDS` (600), `AUTH_OTP_MAX_ATTEMPTS` (5), `AUTH_OTP_RESEND_COOLDOWN_SECONDS` (60), `AUTH_EMAIL_TIMEOUT_MS` (8000), `AUTH_SESSION_TTL_SECONDS` (604800), `AUTH_SESSION_IDLE_TTL_SECONDS` (86400), and the `AUTH_RL_REQUEST_*` / `AUTH_RL_VERIFY_*` throttles (`EMAIL`, `SOURCE`, `GLOBAL`).

Secrets (never in `wrangler.jsonc`):

```bash
# >= 32 random characters; signs login codes, session tokens and throttle keys.
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # generate; copy the output
pnpm --filter @hackathon/api exec wrangler secret put AUTH_HMAC_SECRET --env staging
pnpm --filter @hackathon/api exec wrangler secret put EMAIL_PROVIDER_API_KEY --env staging
```

Rotating `AUTH_HMAC_SECRET` signs everyone out and voids pending codes; no data is lost. Until both secrets exist, sign-in answers a generic `503` (fail closed) and the log names the missing setting.

## 4. Deploy

```bash
# CI-quality gate first
pnpm check

# Apply migrations to the remote database (runs the placeholder guard first)
pnpm --filter @hackathon/api db:migrate:staging

# Build the web app and deploy the Worker + assets (runs the guard first)
pnpm --filter @hackathon/api deploy:staging
```

If this is the very first deploy and `APP_ORIGIN` still holds the placeholder, the guard stops you. Temporarily set a syntactically valid origin (`https://example.invalid`), deploy once to learn the real `workers.dev` URL, set `APP_ORIGIN` to it, and deploy again. With a custom domain, set `APP_ORIGIN` to it from the start and attach the domain in the dashboard (Workers & Pages → your Worker → Settings → Domains & Routes).

## 5. Verify a deployment

```bash
curl -i https://<origin>/api/health      # 200 {"status":"ok",…,"checks":{"database":"ok"}}, environment matches
curl -i https://<origin>/api/nope        # 404 JSON error envelope
curl -I https://<origin>/                # 200 with Content-Security-Policy and X-Content-Type-Options
```

Open the site in a browser: the shell loads, **System status** shows "All systems operational", a deep link such as `/status` survives refresh.

### Rollback and recovery

| Problem                      | Action                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bad Worker release           | `pnpm --filter @hackathon/api exec wrangler deployments list --env <env>` then `wrangler rollback <version-id> --env <env>`. (Assets and code roll back together.)                     |
| Bad migration / data         | See [database.md](database.md#rollback-and-recovery): forward-fix, or D1 Time Travel restore (`wrangler d1 time-travel info/restore`, 7-day window on Free), or restore an SQL export. |
| Config mistake (origin/vars) | Fix `wrangler.jsonc`, redeploy. A bad config fails closed (generic 503) rather than running unsafely.                                                                                  |
| Lost `database_id` / account | Recreate the database, import the latest `wrangler d1 export … --remote` file with `wrangler d1 execute <DB> --remote --file backup.sql`, update `database_id`, redeploy.              |

Take an export before every production migration: `wrangler d1 export <DB> --remote --env production --output backup-$(date +%F).sql`. Store it outside the repository (it will contain personal data from Milestone 01 on).

## 5a. Create the first administrator (once per environment)

There is deliberately no HTTP route that makes the first admin. Run this **from your machine** after migrating and deploying, with Cloudflare credentials available (section 2). Use the address of a real person's personal mailbox on an allowed domain.

```bash
# Local database (development):
pnpm admin:bootstrap --email you@college.edu --name "Your Name"

# Deployed database (confirm with --yes; the placeholder guard runs first):
pnpm admin:bootstrap --email you@college.edu --name "Your Name" --remote --env staging --yes
```

It succeeds only when **no active admin exists** (the check and the write are one SQL statement, so two operators cannot both win), prints what it did, and records `admin.bootstrap` in the audit log. If an admin already exists it changes nothing and says so. All later admin changes (more admins, roster, suspension) go through the admin API; at least one active admin must always remain.

## 5b. Manual real-mailbox test (required before email is "verified")

Automated tests use a mock provider and fakes, so they cannot prove that real mail arrives. Before announcing sign-in to users, on **staging** with the real provider configured:

1. Bootstrap yourself as admin (5a). Add a second real mailbox (a colleague, or a second address of yours) to the roster via `POST /api/admin/users`.
2. In a browser, open `/login`, enter the second address, and confirm a code **arrives in that mailbox** (check spam/junk; note the delay). Sign in with it.
3. Confirm: refresh keeps you signed in; **Sign out** returns to signed-out; the old cookie no longer works.
4. Request a code for an address that is **not** on the roster and confirm nothing arrives and the page looks identical.
5. Reuse the same code, and let one expire (10 minutes); both must be refused.
6. In the Cloudflare dashboard (Workers → your Worker → Metrics) check CPU time per request stays well under 10 ms and there are no error spikes.
7. Check sender reputation basics at your email provider (SPF/DKIM verified for `EMAIL_FROM_ADDRESS`'s domain), otherwise codes may be junked.

Record the date, who tested and the result in `docs/milestones/STATUS.md`. Until then the status stays "production email integration **not verified**".

## 6. Free-plan limits

Figures from Cloudflare's documentation as read on 2026-11-24; re-check before each event, since plans change. Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

| Resource                                   | Free-plan limit                                     | Why it matters here                                                                                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker requests                            | 100,000 per day (resets 00:00 UTC)                  | Only `/api/*` invokes the Worker. 1,000 users × ~100 API calls each exhausts the day. Avoid polling; cache read-mostly data client-side; batch UI calls. Past the limit, requests fail until reset. |
| Static asset requests                      | Free and unlimited                                  | The SPA is served as assets, so page loads do not consume the Worker quota.                                                                                                                         |
| CPU time per request                       | 10 ms                                               | No password-style hashing; use fast keyed HMAC for OTP/session hashing (M01) and measure.                                                                                                           |
| Subrequests per request                    | 50                                                  | Email/Drive calls are few per request; fine.                                                                                                                                                        |
| D1 queries per invocation                  | 50 (a `batch()` counts as one)                      | Design endpoints around a handful of queries; use batches.                                                                                                                                          |
| D1 simultaneous connections per invocation | 6                                                   | Do not fan out queries in parallel beyond this.                                                                                                                                                     |
| D1 rows read                               | 5,000,000 per day                                   | Always index filters; never table-scan on hot paths; paginate.                                                                                                                                      |
| D1 rows written                            | 100,000 per day                                     | Each write touches indexed rows too. Budget for registration spikes, notification/outbox rows (M04) and audit logs.                                                                                 |
| D1 size                                    | 500 MB per database, 5 GB per account, 10 databases | Ample for metadata; keep uploads in Drive, not D1.                                                                                                                                                  |
| D1 throughput                              | One query at a time per database                    | At ~1 ms/query ≈ 1,000 queries/s. Slow queries queue and can return "overloaded"; keep queries short.                                                                                               |
| D1 Time Travel                             | 7 days (Paid: 30)                                   | Recovery window; take explicit exports around events.                                                                                                                                               |
| Cron triggers                              | 5 per account; 10 ms CPU each                       | Enough for reminders and outbox draining (M04); keep each run tiny.                                                                                                                                 |
| Worker size / assets                       | 64 MiB Worker; 20,000 asset files; 25 MiB per asset | The current bundle is about 0.86 MiB total upload.                                                                                                                                                  |
| Env vars + secrets                         | 64 per Worker, 5 KB each                            | Ample.                                                                                                                                                                                              |

**Operating guidance.** Run load tests (M07) with 200/500/1,000-user profiles and compare the projected daily reads, writes and requests to the table above; define a runbook for quota exhaustion (reads/writes blocked until 00:00 UTC; upgrading to Workers Paid lifts limits within minutes). The free plan is a starting point; a ~US$5/month Workers Paid plan is the contingency if an event's peak exceeds it. That is a business decision, so no paid dependency is added by default.

## 7. Migration strategy off Cloudflare

Goal: be able to move to standard Node.js and PostgreSQL without a rewrite.

**What is already portable**

- Hono and Zod run unchanged on Node (`@hono/node-server`); handlers use Web-standard `Request`/`Response`/`crypto` only (enforced by lint and by bundling without Node compatibility).
- All environment access goes through the validated config object; secrets are plain env vars.
- Email and Drive sit behind interfaces; the mocks and real adapters are interchangeable.
- The SPA is static files; any web server or CDN can host it, with `/api` reverse-proxied.
- Database access will go through a thin repository layer (from M01) so SQL lives in one place; migrations are plain `.sql` files.

**Cloudflare-specific pieces to replace**

| Concern                   | Cloudflare today                  | Node/Postgres replacement                                                  |
| ------------------------- | --------------------------------- | -------------------------------------------------------------------------- |
| Entry point               | `src/index.ts` default export     | Small Node entry using `@hono/node-server`                                 |
| Database                  | D1 binding (`prepare/bind/batch`) | `pg`/Drizzle behind the same repository interface; `batch` → a transaction |
| Scheduled jobs (M04)      | Cron Triggers                     | OS cron / `pg_cron` / a worker process calling the same job functions      |
| Static assets and headers | Assets binding + `_headers`       | nginx/Caddy/CDN serving `dist` and setting the same headers                |
| Tests                     | `@cloudflare/vitest-plugin`       | Plain Vitest against a Postgres test database                              |

**SQL translation notes**: `STRICT` removed; `TEXT` ISO timestamps → `timestamptz`; `CHECK … GLOB` → `~`/`CHECK` with regex or dropped in favour of the native type; `INSERT … ON CONFLICT` and `RETURNING` already match; avoid SQLite-only functions in app queries (rule in [database.md](database.md#conventions-apply-to-every-migration)).

**Procedure (when ever needed)**: (1) stand up Postgres and port migrations; (2) implement the Postgres repository against the existing repository tests; (3) export D1 (`wrangler d1 export`), convert, and load; (4) run the full test suite plus E2E against the Node build; (5) switch DNS during a quiet period with the export as rollback.
