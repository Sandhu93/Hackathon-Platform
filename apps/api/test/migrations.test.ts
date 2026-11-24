import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('migrations on a fresh database', () => {
  it('records the baseline migration', async () => {
    const rows = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{
      name: string;
    }>();
    expect(rows.results.map((r) => r.name)).toEqual(['0001_baseline.sql']);
  });

  it('creates app_metadata with its seed row', async () => {
    const row = await env.DB.prepare(
      "SELECT value FROM app_metadata WHERE key = 'schema_baseline'",
    ).first<{ value: string }>();
    expect(row?.value).toBe('1');
  });

  it('enforces the table constraints (STRICT types, CHECKs, primary key)', async () => {
    const insert = (key: unknown, value: unknown, at: unknown) =>
      env.DB.prepare('INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)')
        .bind(key, value, at)
        .run();
    await expect(insert('k1', 'v', 'not-a-timestamp')).rejects.toThrow();
    await expect(insert('', 'v', '2026-01-01T00:00:00Z')).rejects.toThrow();
    await expect(insert('k2', new Uint8Array([1, 2, 3]), '2026-01-01T00:00:00Z')).rejects.toThrow();
    await expect(insert('schema_baseline', 'v', '2026-01-01T00:00:00Z')).rejects.toThrow();
    await expect(insert('k3', 'v', '2026-01-01T00:00:00Z')).resolves.toBeDefined();
  });
});
