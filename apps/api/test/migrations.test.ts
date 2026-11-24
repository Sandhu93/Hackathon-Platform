import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('migrations on a fresh database', () => {
  it('records the applied migrations in order', async () => {
    const rows = await env.DB.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{
      name: string;
    }>();
    expect(rows.results.map((r) => r.name)).toEqual(['0001_baseline.sql', '0002_auth.sql']);
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

describe('0002_auth schema constraints', () => {
  const now = '2026-01-01T00:00:00Z';
  const user = (email: string, role = 'participant', status = 'active', kind = 'personal') =>
    env.DB.prepare(
      'INSERT INTO users (id, email_normalized, role, status, mailbox_kind, version, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6)',
    )
      .bind(crypto.randomUUID(), email, role, status, kind, now)
      .run();

  it('rejects mixed-case or duplicate emails and unknown role/status/kind values', async () => {
    await env.DB.prepare('DELETE FROM users').run();
    await expect(user('Mixed@example.test')).rejects.toThrow();
    await expect(user('a@example.test', 'owner')).rejects.toThrow();
    await expect(user('a@example.test', 'participant', 'banned')).rejects.toThrow();
    await expect(user('a@example.test', 'participant', 'active', 'group')).rejects.toThrow();
    await expect(user('a@example.test')).resolves.toBeDefined();
    await expect(user('a@example.test')).rejects.toThrow();
    await env.DB.prepare('DELETE FROM users').run();
  });

  it('allows only one unconsumed challenge per address', async () => {
    await env.DB.prepare('DELETE FROM auth_challenges').run();
    const challenge = (consumedAt: string | null) =>
      env.DB.prepare(
        'INSERT INTO auth_challenges (id, email_normalized, code_hash, created_at, expires_at, attempts, max_attempts, consumed_at, delivery_status, source_hash) VALUES (?1, ?2, ?3, ?4, ?4, 0, 5, ?5, ?6, ?7)',
      )
        .bind(
          crypto.randomUUID(),
          'a@example.test',
          'a'.repeat(64),
          now,
          consumedAt,
          'pending',
          'b'.repeat(64),
        )
        .run();
    await expect(challenge(null)).resolves.toBeDefined();
    await expect(challenge(null)).rejects.toThrow();
    await expect(challenge(now)).resolves.toBeDefined(); // consumed history is unlimited
    await env.DB.prepare('DELETE FROM auth_challenges').run();
  });

  it('refuses a session for a user that does not exist', async () => {
    await expect(
      env.DB.prepare(
        'INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, source_hash) VALUES (?1, ?2, ?3, ?4, ?4, ?4, ?5)',
      )
        .bind(crypto.randomUUID(), 'no-such-user', 'c'.repeat(64), now, 'd'.repeat(64))
        .run(),
    ).rejects.toThrow();
  });
});
