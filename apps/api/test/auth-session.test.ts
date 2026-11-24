import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiErrorSchema, sessionResponseSchema } from '@hackathon/shared';
import {
  DOMAIN,
  cookieFrom,
  fakeClock,
  jsonWithCookie,
  latestCode,
  makeApp,
  requestCode,
  resetDb,
  seedUser,
  signIn,
  verifyCode,
  withCookie,
} from './helpers';

const ALICE = `alice@${DOMAIN}`;
const COOKIE_NAME = 'hackathon_session';

beforeEach(resetDb);

async function sessionStatus(
  app: ReturnType<typeof makeApp>,
  cookie: string,
  over?: Record<string, unknown>,
) {
  return (await app.request('/api/auth/session', withCookie(cookie), over)).status;
}

describe('session cookie', () => {
  it('is HttpOnly, SameSite=Strict, path-scoped and bound to the session lifetime', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    await requestCode(app, ALICE);
    const res = await verifyCode(app, ALICE, latestCode(ALICE));
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toContain(`${COOKIE_NAME}=`);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/Max-Age=604800/);
    expect(header).not.toMatch(/Domain=/i);
    expect(header).not.toMatch(/Secure/i); // plain http://localhost development only
  });

  it('is Secure and __Host- prefixed over https', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    const https = {
      ENVIRONMENT: 'staging',
      APP_ORIGIN: 'https://staging.example.com',
      CORS_ALLOWED_ORIGINS: '',
      AUTH_HMAC_SECRET: 'staging-test-secret-'.padEnd(48, 'x'),
    };
    await requestCode(app, ALICE, https);
    const res = await verifyCode(app, ALICE, latestCode(ALICE), https);
    const header = res.headers.get('set-cookie') ?? '';
    expect(header).toMatch(/^__Host-hackathon_session=/);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toMatch(/Path=\//);
    expect(header).not.toMatch(/Domain=/i);
  });
});

describe('reading the session', () => {
  it('returns the signed-in user and never the token', async () => {
    await seedUser(ALICE, { displayName: 'Alice' });
    const app = makeApp();
    const cookie = await signIn(app, ALICE);
    const res = await app.request('/api/auth/session', withCookie(cookie));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(sessionResponseSchema.parse(JSON.parse(text)).user.email).toBe(ALICE);
    expect(text).not.toContain(cookie.split('=')[1] ?? 'never');
  });

  it.each([
    ['no cookie', ''],
    ['garbage', `${COOKIE_NAME}=garbage`],
    ['well-formed but unknown token', `${COOKIE_NAME}=${'A'.repeat(43)}`],
  ])('rejects %s with 401 and the standard error', async (_name, cookie) => {
    const app = makeApp();
    const res = await app.request('/api/auth/session', cookie ? withCookie(cookie) : {});
    expect(res.status).toBe(401);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('UNAUTHENTICATED');
  });

  it('clears a stale cookie so the browser stops sending it', async () => {
    const res = await makeApp().request(
      '/api/auth/session',
      withCookie(`${COOKIE_NAME}=${'A'.repeat(43)}`),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toMatch(/hackathon_session=;.*Max-Age=0/i);
  });
});

describe('session lifetime and replay', () => {
  it('expires at the absolute lifetime', async () => {
    await seedUser(ALICE);
    const clock = fakeClock();
    const app = makeApp({ now: clock.now });
    const keepAlive = { AUTH_SESSION_IDLE_TTL_SECONDS: '2592000' };
    const cookie = await signIn(app, ALICE, keepAlive);
    clock.advance(6 * 86_400_000);
    expect(await sessionStatus(app, cookie, keepAlive)).toBe(200);
    clock.advance(2 * 86_400_000);
    expect(await sessionStatus(app, cookie, keepAlive)).toBe(401);
  });

  it('expires after being idle, but activity keeps it alive', async () => {
    await seedUser(ALICE);
    const clock = fakeClock();
    const app = makeApp({ now: clock.now });
    const cookie = await signIn(app, ALICE);
    for (let i = 0; i < 3; i += 1) {
      clock.advance(20 * 3_600_000); // 20h, inside the 24h idle window each time
      expect(await sessionStatus(app, cookie)).toBe(200);
    }
    clock.advance(25 * 3_600_000);
    expect(await sessionStatus(app, cookie)).toBe(401);
  });

  it('logout revokes the session server-side: replaying the old cookie fails', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    const cookie = await signIn(app, ALICE);
    const out = await app.request('/api/auth/logout', jsonWithCookie(cookie, {}));
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
    expect(await sessionStatus(app, cookie)).toBe(401); // the attacker's copy is dead too
    const row = await env.DB.prepare('SELECT revoked_reason FROM sessions').first<{
      revoked_reason: string;
    }>();
    expect(row?.revoked_reason).toBe('logout');
  });

  it('logout is idempotent and safe without a session', async () => {
    const res = await makeApp().request('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(204);
  });

  it('"sign out everywhere" revokes every session of the user, and only theirs', async () => {
    await seedUser(ALICE);
    await seedUser(`bob@${DOMAIN}`);
    const app = makeApp();
    const phone = await signIn(app, ALICE);
    const laptop = await signIn(app, ALICE);
    const bob = await signIn(app, `bob@${DOMAIN}`);
    expect(phone).not.toBe(laptop);
    const res = await app.request('/api/auth/sessions/revoke', jsonWithCookie(phone, {}));
    expect(res.status).toBe(200);
    expect((await res.json<{ revoked: number }>()).revoked).toBe(2);
    expect(await sessionStatus(app, phone)).toBe(401);
    expect(await sessionStatus(app, laptop)).toBe(401);
    expect(await sessionStatus(app, bob)).toBe(200);
  });

  it('requires a session to revoke sessions', async () => {
    const res = await makeApp().request('/api/auth/sessions/revoke', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('revocation takes effect on the next protected request', () => {
  it('a suspended account is rejected immediately, mid-session', async () => {
    const id = await seedUser(ALICE);
    const app = makeApp();
    const cookie = await signIn(app, ALICE);
    expect(await sessionStatus(app, cookie)).toBe(200);
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(id).run();
    expect(await sessionStatus(app, cookie)).toBe(401);
  });

  it('removing the account from the roster or marking it shared ends access', async () => {
    const id = await seedUser(ALICE);
    const app = makeApp();
    const cookie = await signIn(app, ALICE);
    await env.DB.prepare("UPDATE users SET mailbox_kind = 'shared' WHERE id = ?1").bind(id).run();
    expect(await sessionStatus(app, cookie)).toBe(401);
  });

  it('removing the domain from the allow-list ends access', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    const cookie = await signIn(app, ALICE);
    expect(await sessionStatus(app, cookie, { AUTH_ALLOWED_EMAIL_DOMAINS: 'other.test' })).toBe(
      401,
    );
  });
});

describe('session fixation and token handling', () => {
  it('ignores a cookie planted before sign-in and issues a fresh token', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    const planted = `${COOKIE_NAME}=${'B'.repeat(43)}`;
    await app.request('/api/auth/otp/request', jsonWithCookie(planted, { email: ALICE }));
    const verified = await app.request(
      '/api/auth/otp/verify',
      jsonWithCookie(planted, { email: ALICE, code: latestCode(ALICE) }),
    );
    expect(verified.status).toBe(200);
    const issued = cookieFrom(verified);
    expect(issued).toBeTruthy();
    expect(issued).not.toBe(planted);
    expect(await sessionStatus(app, planted)).toBe(401); // the attacker's pre-set value never gains access
  });

  it('issues a new, unrelated token for every sign-in', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    const tokens = new Set([
      await signIn(app, ALICE),
      await signIn(app, ALICE),
      await signIn(app, ALICE),
    ]);
    expect(tokens.size).toBe(3);
  });

  it('does not honour a token that was only ever stored hashed (database read = no access)', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    await signIn(app, ALICE);
    const stored = await env.DB.prepare('SELECT token_hash FROM sessions').first<{
      token_hash: string;
    }>();
    // Presenting the stored hash as if it were a token must not authenticate.
    expect(await sessionStatus(app, `${COOKIE_NAME}=${stored?.token_hash.slice(0, 43)}`)).toBe(401);
  });
});
