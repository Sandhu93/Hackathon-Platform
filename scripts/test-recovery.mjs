#!/usr/bin/env node
// Backup / restore drill against LOCAL D1 databases (no network, no credentials).
//   1. apply all migrations to a fresh database A and add a marker row
//   2. export A to SQL (this is the backup)
//   3. restore the backup into a brand-new, empty database B  (simulated data loss + recovery)
//   4. verify B holds the same data AND the migration history, so `migrations apply` is a no-op
// Production recovery uses D1 Time Travel / exports instead; see docs/deployment.md.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiDir, wranglerBin, wranglerEnv } from './wrangler-bin.mjs';

// `wrangler d1 export` always reads the default local state of the project it runs in, so each
// database lives in its own throwaway project directory (config + migrations copied from
// apps/api). Your real local database in apps/api/.wrangler is never touched.
const work = mkdtempSync(join(tmpdir(), 'hackathon-recovery-'));

function makeProject(name) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  cpSync(join(apiDir, 'wrangler.jsonc'), join(dir, 'wrangler.jsonc'));
  cpSync(join(apiDir, 'migrations'), join(dir, 'migrations'), { recursive: true });
  return dir;
}

function wrangler(cwd, args) {
  const result = spawnSync(process.execPath, [wranglerBin, ...args], {
    cwd,
    env: wranglerEnv,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `wrangler ${args.join(' ')} failed (exit ${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function query(cwd, sql) {
  const out = wrangler(cwd, ['d1', 'execute', 'DB', '--local', '--json', '--command', sql]);
  const parsed = JSON.parse(out.slice(out.indexOf('[')));
  return parsed[0].results;
}

const checks = [];
function check(name, condition) {
  checks.push([name, condition]);
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}`);
}

try {
  const a = makeProject('a');
  const b = makeProject('b');
  const backup = join(work, 'backup.sql');

  wrangler(a, ['d1', 'migrations', 'apply', 'DB', '--local']);
  query(
    a,
    "INSERT INTO app_metadata (key, value, updated_at) VALUES ('recovery_marker', 'present', '2026-11-24T00:00:00Z')",
  );
  check(
    'fresh database: migrations applied and marker row written',
    query(a, "SELECT value FROM app_metadata WHERE key = 'recovery_marker'")[0]?.value ===
      'present',
  );

  wrangler(a, ['d1', 'export', 'DB', '--local', '--output', backup]);
  check(
    'export produced a non-empty SQL backup',
    existsSync(backup) && readFileSync(backup, 'utf8').includes('app_metadata'),
  );

  // B is a brand-new empty database: this is the "data loss" scenario.
  wrangler(b, ['d1', 'execute', 'DB', '--local', '--file', backup]);
  const restored = query(b, 'SELECT key, value FROM app_metadata ORDER BY key');
  check(
    'restore into an empty database recreates all rows',
    restored.length === 2 &&
      restored.some((r) => r.key === 'recovery_marker' && r.value === 'present'),
  );
  check(
    'restore preserves the migration history',
    query(b, 'SELECT name FROM d1_migrations').some((r) => r.name === '0001_baseline.sql'),
  );

  const reapply = wrangler(b, ['d1', 'migrations', 'apply', 'DB', '--local']);
  check(
    're-running migrations on the restored database is a no-op',
    /no migrations to apply/i.test(reapply),
  );
} catch (error) {
  console.error(String(error));
  checks.push(['unexpected error', false]);
} finally {
  rmSync(work, { recursive: true, force: true });
}

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  console.error(`Recovery drill FAILED (${failed.length} check(s)).`);
  process.exit(1);
}
console.log('Recovery drill passed.');
