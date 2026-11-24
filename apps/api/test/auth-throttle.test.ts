import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@hackathon/shared';
import { mockMailboxStore } from '../src/adapters/email';
import {
  DOMAIN,
  fakeClock,
  latestCode,
  makeApp,
  requestCode,
  resetDb,
  seedUser,
  verifyCode,
} from './helpers';

const ALICE = `alice@${DOMAIN}`;

beforeEach(resetDb);

describe('request throttling', () => {
  it('limits requests per address and answers 429 with Retry-After', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    const limit = { AUTH_RL_REQUEST_EMAIL: '3' };
    for (let i = 0; i < 3; i += 1) expect((await requestCode(app, ALICE, limit)).status).toBe(202);
    const res = await requestCode(app, ALICE, limit);
    expect(res.status).toBe(429);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('throttles an unknown address exactly like a real one (the limit is not an oracle)', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    const limit = { AUTH_RL_REQUEST_EMAIL: '2' };
    const outcome = async (email: string) => {
      const out: number[] = [];
      for (let i = 0; i < 4; i += 1) out.push((await requestCode(app, email, limit)).status);
      return out;
    };
    expect(await outcome(ALICE)).toEqual([202, 202, 429, 429]);
    expect(await outcome(`ghost@${DOMAIN}`)).toEqual([202, 202, 429, 429]);
    expect(await outcome('x@gmail.com')).toEqual([202, 202, 429, 429]);
  });

  it('limits per network source across different addresses', async () => {
    const app = makeApp();
    const limit = { AUTH_RL_REQUEST_SOURCE: '3' };
    const from = (ip: string) => ({ 'cf-connecting-ip': ip });
    for (let i = 0; i < 3; i += 1) {
      expect((await requestCode(app, `u${i}@${DOMAIN}`, limit, from('203.0.113.9'))).status).toBe(
        202,
      );
    }
    expect((await requestCode(app, `u9@${DOMAIN}`, limit, from('203.0.113.9'))).status).toBe(429);
    // Another source is unaffected: the signal is not "IP alone" and not global.
    expect((await requestCode(app, `u9@${DOMAIN}`, limit, from('203.0.113.77'))).status).toBe(202);
  });

  it('treats one IPv6 /64 as a single source', async () => {
    const app = makeApp();
    const limit = { AUTH_RL_REQUEST_SOURCE: '2' };
    const from = (ip: string) => ({ 'cf-connecting-ip': ip });
    expect((await requestCode(app, `a@${DOMAIN}`, limit, from('2001:db8::1'))).status).toBe(202);
    expect(
      (await requestCode(app, `b@${DOMAIN}`, limit, from('2001:db8:0:0:aaaa::2'))).status,
    ).toBe(202);
    expect(
      (await requestCode(app, `c@${DOMAIN}`, limit, from('2001:0db8:0:0:1:2:3:4'))).status,
    ).toBe(429);
    expect((await requestCode(app, `c@${DOMAIN}`, limit, from('2001:db8:0:1::1'))).status).toBe(
      202,
    ); // different /64
  });

  it('applies a global ceiling regardless of who asks', async () => {
    const app = makeApp();
    const limit = { AUTH_RL_REQUEST_GLOBAL: '3' };
    for (let i = 0; i < 3; i += 1) {
      expect(
        (
          await requestCode(app, `u${i}@${DOMAIN}`, limit, {
            'cf-connecting-ip': `198.51.100.${i}`,
          })
        ).status,
      ).toBe(202);
    }
    expect(
      (await requestCode(app, 'z@example.test', limit, { 'cf-connecting-ip': '192.0.2.1' })).status,
    ).toBe(429);
  });

  it('a blocked caller does not consume shared budget or write to the database', async () => {
    const app = makeApp();
    const limits = { AUTH_RL_REQUEST_SOURCE: '1', AUTH_RL_REQUEST_GLOBAL: '100' };
    const ip = { 'cf-connecting-ip': '203.0.113.5' };
    await requestCode(app, `a@${DOMAIN}`, limits, ip);
    for (let i = 0; i < 20; i += 1) await requestCode(app, `b${i}@${DOMAIN}`, limits, ip);
    const rows = await env.DB.prepare('SELECT bucket, count FROM rate_limits').all<{
      bucket: string;
      count: number;
    }>();
    const global = rows.results.find((r) => r.bucket === 'request:global');
    expect(global?.count).toBe(1); // the 20 blocked requests never reached the global bucket
    expect(Math.max(...rows.results.map((r) => r.count))).toBeLessThanOrEqual(1);
  });

  it('opens a fresh window after an hour', async () => {
    const clock = fakeClock();
    const app = makeApp({ now: clock.now });
    const limit = { AUTH_RL_REQUEST_EMAIL: '1' };
    expect((await requestCode(app, ALICE, limit)).status).toBe(202);
    expect((await requestCode(app, ALICE, limit)).status).toBe(429);
    clock.advance(3_600_000);
    expect((await requestCode(app, ALICE, limit)).status).toBe(202);
  });

  it('stores only hashed buckets: no address and no IP in the rate-limit table', async () => {
    const app = makeApp();
    await requestCode(app, ALICE, undefined, { 'cf-connecting-ip': '203.0.113.9' });
    const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM rate_limits').all()).results);
    expect(dump).not.toContain('alice');
    expect(dump).not.toContain('203.0.113.9');
  });
});

describe('verify throttling', () => {
  it('limits verification attempts per address independently of the per-code limit', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    const limit = { AUTH_RL_VERIFY_EMAIL: '3', AUTH_OTP_MAX_ATTEMPTS: '10' };
    await requestCode(app, ALICE, limit);
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1)
      statuses.push((await verifyCode(app, ALICE, '000000', limit)).status);
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    // Even the right code is refused while throttled.
    expect((await verifyCode(app, ALICE, latestCode(ALICE), limit)).status).toBe(429);
  });

  it('limits verification attempts per source across many addresses', async () => {
    const app = makeApp();
    const limit = { AUTH_RL_VERIFY_SOURCE: '2' };
    const ip = { 'cf-connecting-ip': '203.0.113.44' };
    expect((await verifyCode(app, `a@${DOMAIN}`, '123456', limit, ip)).status).toBe(401);
    expect((await verifyCode(app, `b@${DOMAIN}`, '123456', limit, ip)).status).toBe(401);
    expect((await verifyCode(app, `c@${DOMAIN}`, '123456', limit, ip)).status).toBe(429);
  });

  it('does not email anyone while throttled', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    const limit = { AUTH_RL_REQUEST_EMAIL: '1' };
    await requestCode(app, ALICE, limit);
    mockMailboxStore.clear();
    await requestCode(app, ALICE, limit);
    expect(mockMailboxStore.messages).toHaveLength(0);
  });
});
