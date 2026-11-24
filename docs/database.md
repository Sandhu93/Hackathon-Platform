# Database

Cloudflare D1 (SQLite) bound as `DB`. Business tables arrive from Milestone 01; Milestone 00 ships the migration machinery and a single baseline table.

## Conventions (apply to every migration)

- **Timestamps**: UTC, stored as ISO-8601 text ending in `Z` (`2026-11-24T10:00:00Z`), with a `CHECK` on the shape. Deadlines are persisted in UTC; the event's IANA timezone is stored separately and used only for display.
- **Strictness**: `STRICT` tables; explicit `NOT NULL`, `CHECK` and `UNIQUE` constraints. Constraints, not application code, are the last line of defence for uniqueness and capacity rules.
- **Identifiers**: opaque, non-guessable IDs generated server-side (decided in Milestone 01); never accepted from clients as proof of ownership.
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
