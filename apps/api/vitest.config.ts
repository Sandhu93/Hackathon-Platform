import { resolve } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const here = (path: string) => resolve(import.meta.dirname, path);

// Tests run inside the real Workers runtime (workerd) against a local D1 database with all
// migrations applied. The test wrangler config has no static assets and fixed test vars.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(here('./migrations'));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: here('./test/wrangler.test.jsonc') },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: [here('./test/apply-migrations.ts')],
    },
  };
});
