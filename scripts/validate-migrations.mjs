#!/usr/bin/env node
// Static checks for D1 migrations. Run in CI and before every deploy.
//
// Rules:
//  1. Files in apps/api/migrations are named NNNN_snake_case.sql, numbered 0001.. with no gaps or duplicates.
//  2. Applied migrations are immutable: each file's SHA-256 is pinned in apps/api/migrations.lock.json.
//     A changed hash fails the check. New files must be added deliberately with `pnpm db:lock`.
//  3. No explicit transaction control (D1 runs each migration atomically), no PRAGMA foreign_keys,
//     and no destructive statements (DROP / DELETE FROM / TRUNCATE) unless the file carries
//     `-- destructive: approved` after human review.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'apps/api/migrations');
const lockPath = join(root, 'apps/api/migrations.lock.json');
const updateLock = process.argv.includes('--update-lock');

const errors = [];
const files = existsSync(dir)
  ? readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
  : [];
if (files.length === 0) errors.push('No migrations found in apps/api/migrations.');

const NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const hashes = {};
files.forEach((file, index) => {
  const match = NAME.exec(file);
  if (!match) {
    errors.push(`${file}: name must look like 0001_short_description.sql`);
    return;
  }
  const expected = String(index + 1).padStart(4, '0');
  if (match[1] !== expected)
    errors.push(`${file}: expected sequence number ${expected} (no gaps or duplicates)`);

  const sql = readFileSync(join(dir, file), 'utf8');
  hashes[file] = createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
  const code = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (code.trim().length === 0) errors.push(`${file}: migration is empty`);
  if (!code.trim().endsWith(';')) errors.push(`${file}: last statement must end with a semicolon`);
  if (/\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(code)) {
    errors.push(`${file}: do not use explicit transactions; D1 applies each migration atomically`);
  }
  if (/\bPRAGMA\s+foreign_keys\b/i.test(code)) {
    errors.push(`${file}: do not toggle foreign_keys; use PRAGMA defer_foreign_keys if needed`);
  }
  if (
    /\b(DROP\s+(TABLE|COLUMN|INDEX)|DELETE\s+FROM|TRUNCATE)\b/i.test(code) &&
    !/--\s*destructive:\s*approved/i.test(sql)
  ) {
    errors.push(`${file}: destructive statement without a '-- destructive: approved' marker`);
  }
});

if (updateLock && errors.length === 0) {
  writeFileSync(lockPath, `${JSON.stringify(hashes, null, 2)}\n`);
  console.log(`Wrote ${lockPath} (${files.length} migration(s)).`);
  process.exit(0);
}

if (!existsSync(lockPath)) {
  errors.push('apps/api/migrations.lock.json is missing. Run `pnpm db:lock` to create it.');
} else {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  for (const [file, hash] of Object.entries(lock)) {
    if (!(file in hashes)) errors.push(`${file}: listed in the lock file but missing on disk`);
    else if (hashes[file] !== hash) {
      errors.push(
        `${file}: contents changed after being locked. Applied migrations are immutable; add a new migration instead.`,
      );
    }
  }
  for (const file of Object.keys(hashes)) {
    if (!(file in lock))
      errors.push(
        `${file}: new migration not in the lock file. Review it, then run \`pnpm db:lock\`.`,
      );
  }
}

if (errors.length > 0) {
  console.error('Migration validation FAILED:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`Migration validation passed (${files.length} migration(s)).`);
