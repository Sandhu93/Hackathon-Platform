import { Hono } from 'hono';
import type { HealthResponse } from '@hackathon/shared';
import type { HonoEnv } from '../types';

const DB_TIMEOUT_MS = 2000;

async function databaseReachable(db: D1Database): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = db.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('database probe timed out')), DB_TIMEOUT_MS);
    });
    const row = await Promise.race([probe, timeout]);
    return row?.ok === 1;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export const healthRoutes = new Hono<HonoEnv>();

/**
 * Liveness + minimal readiness. Public and unauthenticated, so it reveals nothing beyond
 * the environment name, a version label and whether the database answers.
 * Returns 503 (same body shape, status "degraded") when the database is unreachable.
 */
healthRoutes.get('/health', async (c) => {
  const config = c.get('config');
  const databaseOk = await databaseReachable(c.env.DB);
  if (!databaseOk) c.get('logger').error('health.database_unavailable');

  const body: HealthResponse = {
    status: databaseOk ? 'ok' : 'degraded',
    service: 'hackathon-api',
    environment: config.ENVIRONMENT,
    version: config.APP_VERSION,
    timestamp: new Date().toISOString(),
    checks: { database: databaseOk ? 'ok' : 'unavailable' },
  };
  return c.json(body, databaseOk ? 200 : 503);
});
