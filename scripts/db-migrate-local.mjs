#!/usr/bin/env node
// Applies migrations to the LOCAL D1 database without wrangler's interactive "continue?" prompt
// (which defaults to "no" in a terminal). Remote migrations (staging/production) deliberately keep
// the prompt: run `pnpm --filter @hackathon/api db:migrate:staging` and confirm by hand.
import { spawnSync } from 'node:child_process';
import { apiDir, wranglerBin, wranglerEnv } from './wrangler-bin.mjs';

const result = spawnSync(
  process.execPath,
  [wranglerBin, 'd1', 'migrations', 'apply', 'DB', '--local'],
  { cwd: apiDir, env: wranglerEnv, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
