# Database

Cloudflare D1 (SQLite) bound as `DB`. Milestone 00 shipped the migration machinery and a baseline table; Milestone 01 adds authentication tables (`0002_auth.sql`). Event, team and submission tables arrive in later milestones.

## Conventions (apply to every migration)

- **Timestamps**: UTC, stored as ISO-8601 text ending in `Z` (`2026-11-24T10:00:00Z`), with a `CHECK` on the shape. Deadlines are persisted in UTC; the event's IANA timezone is stored separately and used only for display.
- **Strictness**: `STRICT` tables; explicit `NOT NULL`, `CHECK` and `UNIQUE` constraints. Constraints, not application code, are the last line of defence for uniqueness and capacity rules.
- **Identifiers**: opaque, non-guessable IDs generated server-side (random 128-bit hex, decided in Milestone 01); never accepted from clients as proof of ownership.
- **Queries**: parameter binding only (`prepare().bind()`); no string-built SQL. Bounded `LIMIT`, keyset or offset pagination, and an index for every filter/sort used.
- **Multi-statement atomicity**: use `db.batch([...])` (a D1 transaction) or single conditional statements (`INSERT … SELECT … WHERE`, `UPDATE … WHERE`) for concurrency-sensitive writes.
- **Portability**: stay within SQL that PostgreSQL also supports (`ON CONFLICT`, `RETURNING`, standard `CHECK`s); avoid SQLite-only functions in application queries. `STRICT` and `GLOB` in checks are SQLite-specific and are translated in a Postgres migration ([deployment.md](deployment.md#7-migration-strategy-off-cloudflare)).

## Current schema

### `app_metadata` (migration `0001_baseline.sql`)

| Column       | Type | Constraints                   |
| ------------ | ---- | ----------------------------- |
| `key`        | TEXT | PRIMARY KEY, 1–64 characters  |
| `value`      | TEXT | NOT NULL, ≤ 1024 characters   |
| `updated_at` | TEXT | NOT NULL, UTC ISO-8601 (`…Z`) |

Seeded with `schema_baseline = 1`. Wrangler also maintains `d1_migrations` (applied migration names).

### Authentication tables (migration `0002_auth.sql`)

All `STRICT`; timestamps UTC ISO-8601 with a `GLOB` shape check. Secrets (login codes, session tokens, addresses and IPs in throttle/audit rows) are stored **only as keyed HMAC-SHA256 hex** (64 chars); see [security.md](security.md#authentication-design-milestone-01).

**`users`**: the account table, which is also the eligibility roster.

| Column                                    | Notes                                                                                                 |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`                                      | PK, server-generated                                                                                  |
| `email_normalized`                        | `UNIQUE`, must equal `lower(...)`, 3–254 chars. The normalised address is the identity                |
| `display_name`                            | nullable, 1–100 chars                                                                                 |
| `role`                                    | `participant` (default) \| `admin`                                                                    |
| `status`                                  | `active` (default) \| `suspended` \| `revoked`                                                        |
| `mailbox_kind`                            | `personal` (default) \| `shared`; shared mailboxes cannot sign in and never count as an administrator |
| `version`                                 | optimistic-concurrency token, starts at 1, incremented by every admin change                          |
| `created_at`/`updated_at`/`last_login_at` | UTC timestamps (`last_login_at` nullable)                                                             |

Index `users_role_status (role, status, mailbox_kind)` serves the "is there another active admin?" guard.

**`auth_challenges`**: one-time email codes, keyed by address (not user) so `domain` mode can challenge an address with no user row yet. Columns: `id`, `email_normalized`, `code_hash` (HMAC of `challengeId:code`), `created_at`, `expires_at`, `attempts`, `max_attempts` (1–20), `consumed_at` (set when used, superseded, invalidated by an account change or its delivery failed; `NULL` = usable), `delivery_status` (`pending|sent|failed`), `source_hash`. A **partial unique index** `auth_challenges_one_active (email_normalized) WHERE consumed_at IS NULL` guarantees at most one usable code per address even under concurrent requests. Index on `expires_at` for purging.

**`sessions`**: `id`, `user_id` → `users(id)`, `token_hash` (`UNIQUE`; HMAC of the cookie token), `created_at`, `last_seen_at`, `expires_at`, `revoked_at`, `revoked_reason` (`logout|revoke_all|admin_revoke|account_status`), `source_hash`. Partial index on active sessions per user; index on `expires_at`.

**`audit_log`**: append-only by convention. `seq` (`AUTOINCREMENT`, the pagination cursor), `created_at`, `event_type`, `outcome`, `actor_user_id`, `target_user_id`, `subject_hash`, `source_hash`, `request_id`, `details` (≤ 1000 chars of small JSON; no secrets). Indexed by time, event type and target.

**`rate_limits`**: fixed-window counters. PK `(bucket, window_start)`, `count`; the bucket name embeds a keyed hash, never an address or IP. Written with a guarded upsert (`INSERT … ON CONFLICT DO UPDATE … WHERE count < limit`) so a full bucket causes no write.

**Retention.** Expired challenges, sessions and old rate-limit windows are purged opportunistically (roughly one in 25 sign-ins). They are inert once expired, so this only affects storage. Audit rows are kept.

## Migration workflow

1. Add `apps/api/migrations/NNNN_short_description.sql` (next number, no gaps).
2. `pnpm db:validate` — checks naming/sequence, forbids `BEGIN/COMMIT`, `PRAGMA foreign_keys`, and destructive statements (`DROP`, `DELETE FROM`, `TRUNCATE`) unless the file contains `-- destructive: approved` after human review. Also verifies **immutability**: every migration's SHA-256 is pinned in `apps/api/migrations.lock.json`; editing an applied migration fails.
3. After review, `pnpm db:lock` records the new hash. Commit the lock file with the migration.
4. `pnpm db:migrate:local`; run the tests (they apply all migrations to a fresh database in the Workers runtime).
5. Staging: `pnpm --filter @hackathon/api db:migrate:staging`, verify, then production.

CI runs `db:validate` and `db:test-recovery` on every push.

## Rollback and recovery

D1 has no down-migrations, and migrations apply atomically (a failed migration leaves the database unchanged). The strategy is therefore **forward-fix plus restore**:

| Situation                                  | Action                                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration failed to apply                  | Nothing changed. Fix the SQL (it was never recorded), re-run. If it was already locked and committed, add a corrective migration only if it had been applied somewhere; otherwise correct the file and `pnpm db:lock`.                                                    |
| Applied migration is wrong                 | Add a new forward migration that corrects it. Never edit an applied migration.                                                                                                                                                                                            |
| Bad data change / accidental deletion      | **D1 Time Travel** (point-in-time restore; 7-day retention on the Free plan): `wrangler d1 time-travel restore <DB> --timestamp=<RFC3339>`; first `wrangler d1 time-travel info <DB>`. Restoring overwrites the live database, so restore staging first when time allows. |
| Total loss / corruption beyond Time Travel | Restore from the latest SQL export into a new database, update `database_id`, redeploy.                                                                                                                                                                                   |
| Before any risky migration                 | `wrangler d1 export <DB> --remote --output backup.sql` (and note the Time Travel bookmark).                                                                                                                                                                               |

`pnpm db:test-recovery` rehearses the export/restore path on throwaway local databases: migrate → write a marker row → export → restore into an empty database → verify data and migration history → confirm re-running migrations is a no-op. The remote Time Travel commands are documented but not exercised until Milestone 07 (they need a Cloudflare account).

## Local database

`wrangler dev` persists to `apps/api/.wrangler/state` (git-ignored). Delete that folder for a clean slate, then `pnpm db:migrate:local`.
