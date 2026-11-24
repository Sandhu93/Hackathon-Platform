// Shared helper: locate the wrangler CLI that apps/api depends on, so scripts run it with the
// current Node binary on every OS (no shell, no PATH assumptions).
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const apiDir = join(root, 'apps/api');
// wrangler restricts its package "exports", so resolve the bin by path (pnpm links it here).
export const wranglerBin = join(apiDir, 'node_modules/wrangler/bin/wrangler.js');
if (!existsSync(wranglerBin)) {
  console.error('wrangler is not installed. Run `pnpm install` first.');
  process.exit(1);
}
export const wranglerEnv = {
  ...process.env,
  WRANGLER_SEND_METRICS: 'false',
  CI: '1',
  NO_COLOR: '1',
};
