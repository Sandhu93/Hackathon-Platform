import type { D1Migration } from '@cloudflare/vitest-plugin';
import type * as WorkerEntry from '../src/index';

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof WorkerEntry;
    }
    interface Env {
      DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
export {};
