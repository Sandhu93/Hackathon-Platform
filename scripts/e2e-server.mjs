#!/usr/bin/env node
// Starts the production-like stack for Playwright: built SPA + Worker on one origin (:8788),
// with a throwaway local D1 database. Used by playwright.config.ts `webServer`.
import { spawn, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { apiDir, root, wranglerBin, wranglerEnv } from './wrangler-bin.mjs';

const PORT = '8788';
const state = join(apiDir, '.wrangler', 'e2e-state');

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, env: wranglerEnv, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

rmSync(state, { recursive: true, force: true });

// The web build is a plain Vite build; invoke it through its own package script via the pnpm
// binary that launched us (npm_execpath), or fall back to `pnpm`.
const pnpm = process.env.npm_execpath ?? 'pnpm';
if (pnpm.endsWith('.js') || pnpm.endsWith('.cjs') || pnpm.endsWith('.mjs')) {
  run(process.execPath, [pnpm, '--filter', '@hackathon/web', 'run', 'build'], root);
} else {
  run(pnpm, ['--filter', '@hackathon/web', 'run', 'build'], root);
}

run(
  process.execPath,
  [wranglerBin, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state],
  apiDir,
);

// Approved accounts for the sign-in tests. Every test gets its own address in every Playwright
// project: a login code belongs to an address, so tests running in parallel must never share one
// (they would overwrite each other's codes and trip the resend cooldown).
// The throwaway database is recreated on every run, so these never reach a real environment.
const seedUsers = ['desktop', 'mobile'].flatMap((project) => [
  [`e2e-signin-${project}@example.test`, 'participant'],
  [`e2e-wrong-${project}@example.test`, 'participant'],
  [`e2e-perm-person-${project}@example.test`, 'participant'],
  [`e2e-perm-admin-${project}@example.test`, 'admin'],
]);
const stamp = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
run(
  process.execPath,
  [
    wranglerBin,
    'd1',
    'execute',
    'DB',
    '--local',
    '--persist-to',
    state,
    '--command',
    seedUsers
      .map(
        ([email, role]) =>
          `INSERT INTO users (id, email_normalized, display_name, role, status, mailbox_kind, version, created_at, updated_at) ` +
          `VALUES (lower(hex(randomblob(16))), '${email}', 'E2E ${role}', '${role}', 'active', 'personal', 1, ${stamp}, ${stamp});`,
      )
      .join(' '),
  ],
  apiDir,
);

const dev = spawn(
  process.execPath,
  [
    wranglerBin,
    'dev',
    '--port',
    PORT,
    '--persist-to',
    state,
    '--var',
    `APP_ORIGIN:http://localhost:${PORT}`,
    '--var',
    'LOG_LEVEL:warn',
  ],
  { cwd: apiDir, env: wranglerEnv, stdio: 'inherit' },
);
const stop = () => dev.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
dev.on('exit', (code) => process.exit(code ?? 0));
