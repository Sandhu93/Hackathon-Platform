import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiErrorSchema, otpRequestResponseSchema, sessionResponseSchema } from '@hackathon/shared';
import { EmailProviderError, mockMailboxStore, type EmailProvider } from '../src/adapters/email';
import {
  DOMAIN,
  cookieFrom,
  fakeClock,
  json,
  latestCode,
  makeApp,
  requestCode,
  resetDb,
  seedUser,
  verifyCode,
  withCookie,
} from './helpers';

const ALICE = `alice@${DOMAIN}`;

beforeEach(resetDb);

async function auditOutcomes(eventType: string): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT outcome, details FROM audit_log WHERE event_type = ?1 ORDER BY seq',
  )
    .bind(eventType)
    .all<{ outcome: string; details: string | null }>();
  return rows.results.map((r) => `${r.outcome}${r.details ? ` ${r.details}` : ''}`);
}

describe('request OTP', () => {
  it('sends a code to an approved employee and answers 202', async () => {
    await seedUser(ALICE);
    const res = await requestCode(makeApp(), ALICE);
    expect(res.status).toBe(202);
    expect(otpRequestResponseSchema.parse(await res.json()).status).toBe('accepted');
    expect(mockMailboxStore.messages).toHaveLength(1);
    expect(mockMailboxStore.messages[0]?.to).toBe(ALICE);
    expect(latestCode(ALICE)).toMatch(/^\d{6}$/);
  });

  it('answers identically for eligible, unknown, non-institutional, suspended and shared addresses', async () => {
    await seedUser(ALICE);
    await seedUser(`gone@${DOMAIN}`, { status: 'suspended' });
    await seedUser(`team@${DOMAIN}`, { mailboxKind: 'shared' });
    const app = makeApp();
    const addresses = [
      ALICE,
      `nobody@${DOMAIN}`,
      'someone@gmail.com',
      `gone@${DOMAIN}`,
      `team@${DOMAIN}`,
      `x@sub.${DOMAIN}`,
    ];
    const seen = new Set<string>();
    for (const address of addresses) {
      const res = await requestCode(app, address);
      expect(res.status).toBe(202);
      seen.add(await res.text());
    }
    expect(seen.size).toBe(1); // byte-for-byte the same body
    // ...but only the eligible address actually received mail.
    expect(mockMailboxStore.messages.map((m) => m.to)).toEqual([ALICE]);
  });

  it('records why an address was refused in the audit log, with no plaintext address', async () => {
    const app = makeApp();
    await requestCode(app, 'someone@gmail.com');
    await requestCode(app, `nobody@${DOMAIN}`);
    const outcomes = await auditOutcomes('auth.otp.request');
    expect(outcomes[0]).toContain('domain_not_allowed');
    expect(outcomes[1]).toContain('not_on_roster');
    const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM audit_log').all()).results);
    expect(dump).not.toContain('gmail.com');
    expect(dump).not.toContain('nobody');
  });

  it('rejects malformed addresses with a validation error (format only, no account hint)', async () => {
    const res = await requestCode(makeApp(), 'not an email');
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('normalises case but does not apply plus-addressing or dot rules', async () => {
    await seedUser(`first.last@${DOMAIN}`);
    const app = makeApp();
    await requestCode(app, `  First.Last@${DOMAIN.toUpperCase()}  `);
    expect(mockMailboxStore.messages.map((m) => m.to)).toEqual([`first.last@${DOMAIN}`]);
    mockMailboxStore.clear();
    // A plus-tag or a dot-less variant is a *different* mailbox and is not on the roster.
    await requestCode(app, `first.last+tag@${DOMAIN}`);
    await requestCode(app, `firstlast@${DOMAIN}`);
    expect(mockMailboxStore.messages).toHaveLength(0);
  });

  it('enforces the resend cooldown and supersedes the previous code afterwards', async () => {
    await seedUser(ALICE);
    const clock = fakeClock();
    const app = makeApp({ now: clock.now });
    const cooldown = { AUTH_OTP_RESEND_COOLDOWN_SECONDS: '60' };

    expect((await requestCode(app, ALICE, cooldown)).status).toBe(202);
    const first = latestCode(ALICE);
    clock.advance(10_000);
    expect((await requestCode(app, ALICE, cooldown)).status).toBe(202); // same answer...
    expect(mockMailboxStore.messages).toHaveLength(1); // ...but no second email
    expect(await auditOutcomes('auth.otp.request')).toEqual(['issued', 'cooldown']);

    clock.advance(60_000);
    await requestCode(app, ALICE, cooldown);
    expect(mockMailboxStore.messages).toHaveLength(2);
    const second = latestCode(ALICE);
    // Only the newest code works.
    if (first !== second) {
      expect((await verifyCode(app, ALICE, first)).status).toBe(401);
    }
    expect((await verifyCode(app, ALICE, second)).status).toBe(200);
  });

  it('keeps exactly one usable challenge per address even under concurrent requests', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    await Promise.all(Array.from({ length: 5 }, () => requestCode(app, ALICE)));
    const active = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM auth_challenges WHERE consumed_at IS NULL',
    ).first<{ n: number }>();
    expect(active?.n).toBe(1);
  });
});

describe('verify OTP', () => {
  it('lets an eligible employee sign in and returns the user, not the token', async () => {
    await seedUser(ALICE, { displayName: 'Alice' });
    const app = makeApp();
    await requestCode(app, ALICE);
    const code = latestCode(ALICE);
    const res = await verifyCode(app, ALICE, code);
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = sessionResponseSchema.parse(JSON.parse(text));
    expect(body.user).toMatchObject({ email: ALICE, displayName: 'Alice', role: 'participant' });
    const cookie = cookieFrom(res);
    expect(cookie).toBeTruthy();
    const token = cookie?.split('=')[1] ?? '';
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(text).not.toContain(token); // the token travels only in the cookie
    expect(text).not.toContain(code);
    expect(await auditOutcomes('auth.login')).toEqual(['success']);
  });

  it('stores only keyed hashes: no plaintext code and no plaintext session token', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    await requestCode(app, ALICE);
    const code = latestCode(ALICE);
    const res = await verifyCode(app, ALICE, code);
    const token = cookieFrom(res)?.split('=')[1] ?? '';
    const dump = JSON.stringify([
      (await env.DB.prepare('SELECT * FROM auth_challenges').all()).results,
      (await env.DB.prepare('SELECT * FROM sessions').all()).results,
      (await env.DB.prepare('SELECT * FROM audit_log').all()).results,
    ]);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(`"${code}"`);
    const hashes = (await env.DB.prepare('SELECT code_hash FROM auth_challenges').all()).results;
    expect((hashes[0] as { code_hash: string }).code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a wrong code with the same generic error as every other failure', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    await requestCode(app, ALICE);
    const wrong = latestCode(ALICE) === '000000' ? '000001' : '000000';
    const res = await verifyCode(app, ALICE, wrong);
    expect(res.status).toBe(401);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('INVALID_OR_EXPIRED_CODE');
    expect(cookieFrom(res)).toBeNull();
    // Unknown address / no code at all: indistinguishable.
    const none = await verifyCode(app, `nobody@${DOMAIN}`, '123456');
    expect(none.status).toBe(401);
    expect(apiErrorSchema.parse(await none.json()).error.code).toBe('INVALID_OR_EXPIRED_CODE');
  });

  it('refuses a code once it is used (reuse and browser refresh/replay)', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    await requestCode(app, ALICE);
    const code = latestCode(ALICE);
    expect((await verifyCode(app, ALICE, code)).status).toBe(200);
    // e.g. the user refreshes the page and the same form is submitted again
    expect((await verifyCode(app, ALICE, code)).status).toBe(401);
  });

  it('refuses an expired code', async () => {
    await seedUser(ALICE);
    const clock = fakeClock();
    const app = makeApp({ now: clock.now });
    await requestCode(app, ALICE);
    const code = latestCode(ALICE);
    clock.advance(10 * 60 * 1000 + 1000); // default TTL is 10 minutes
    expect((await verifyCode(app, ALICE, code)).status).toBe(401);
    expect((await auditOutcomes('auth.login'))[0]).toContain('expired_or_exhausted');
  });

  it('allows a code to be used exactly once even when submitted concurrently', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    await requestCode(app, ALICE);
    const code = latestCode(ALICE);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => verifyCode(app, ALICE, code)),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    const sessions = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{
      n: number;
    }>();
    expect(sessions?.n).toBe(1);
  });

  it('locks the code after the attempt limit, even for the correct code', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    await requestCode(app, ALICE);
    const right = latestCode(ALICE);
    const wrong = right === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i += 1) expect((await verifyCode(app, ALICE, wrong)).status).toBe(401);
    expect((await verifyCode(app, ALICE, right)).status).toBe(401);
  });

  it('cannot be brute-forced with parallel guesses: attempts never exceed the limit', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    await requestCode(app, ALICE);
    const right = latestCode(ALICE);
    const guesses = Array.from({ length: 12 }, (_, i) => String(100_000 + i)).filter(
      (g) => g !== right,
    );
    const results = await Promise.all(guesses.map((g) => verifyCode(app, ALICE, g)));
    expect(results.every((r) => r.status === 401)).toBe(true);
    const row = await env.DB.prepare('SELECT attempts, max_attempts FROM auth_challenges').first<{
      attempts: number;
      max_attempts: number;
    }>();
    expect(row?.attempts).toBe(row?.max_attempts);
    expect((await verifyCode(app, ALICE, right)).status).toBe(401);
  });

  it('denies an employee who was suspended after the code was sent', async () => {
    const id = await seedUser(ALICE);
    const app = makeApp();
    await requestCode(app, ALICE);
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(id).run();
    expect((await verifyCode(app, ALICE, latestCode(ALICE))).status).toBe(401);
    expect((await auditOutcomes('auth.login'))[0]).toContain('suspended');
  });

  it.each([
    ['suspended', { status: 'suspended' as const }],
    ['revoked', { status: 'revoked' as const }],
    ['shared mailbox', { mailboxKind: 'shared' as const }],
  ])('never emails or signs in a %s account', async (_name, options) => {
    await seedUser(ALICE, options);
    const app = makeApp();
    await requestCode(app, ALICE);
    expect(mockMailboxStore.messages).toHaveLength(0);
    expect((await verifyCode(app, ALICE, '123456')).status).toBe(401);
  });

  it('rejects malformed codes before touching the database', async () => {
    const res = await verifyCode(makeApp(), ALICE, '12ab');
    expect(res.status).toBe(400);
  });
});

describe('eligibility modes', () => {
  it('roster mode: an unlisted institutional address cannot sign in', async () => {
    const app = makeApp();
    await requestCode(app, `new@${DOMAIN}`);
    expect(mockMailboxStore.messages).toHaveLength(0);
    expect((await verifyCode(app, `new@${DOMAIN}`, '123456')).status).toBe(401);
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n,
    ).toBe(0);
  });

  it('domain mode: any mailbox on an allowed domain signs in and is provisioned once', async () => {
    const app = makeApp();
    const mode = { AUTH_ELIGIBILITY_MODE: 'domain' };
    await requestCode(app, `new@${DOMAIN}`, mode);
    const res = await verifyCode(app, `new@${DOMAIN}`, latestCode(`new@${DOMAIN}`), mode);
    expect(res.status).toBe(200);
    const users = await env.DB.prepare('SELECT role, status FROM users').all<{
      role: string;
      status: string;
    }>();
    expect(users.results).toEqual([{ role: 'participant', status: 'active' }]);
    // Other domains are still refused, and a suspended account stays refused in domain mode.
    await requestCode(app, 'x@gmail.com', mode);
    await seedUser(`bad@${DOMAIN}`, { status: 'revoked' });
    await requestCode(app, `bad@${DOMAIN}`, mode);
    expect(mockMailboxStore.messages).toHaveLength(1);
  });
});

describe('email delivery problems', () => {
  const failing: EmailProvider = {
    name: 'failing',
    send: () => Promise.reject(new EmailProviderError('boom for ada@example.test', true)),
  };
  const hanging: EmailProvider = { name: 'hanging', send: () => new Promise(() => undefined) };

  it('hides a delivery failure from the client, audits it and frees an immediate retry', async () => {
    await seedUser(ALICE);
    const cooldown = { AUTH_OTP_RESEND_COOLDOWN_SECONDS: '60' };
    const broken = makeApp({ emailProvider: failing });
    const res = await requestCode(broken, ALICE, cooldown);
    expect(res.status).toBe(202); // same answer as success: no oracle
    expect(await auditOutcomes('auth.otp.delivery')).toEqual(['failed {"retryable":true}']);
    const challenge = await env.DB.prepare(
      'SELECT delivery_status, consumed_at FROM auth_challenges',
    ).first<{ delivery_status: string; consumed_at: string | null }>();
    expect(challenge?.delivery_status).toBe('failed');
    expect(challenge?.consumed_at).not.toBeNull(); // nobody received it, so it is dead

    // The user can retry straight away (no cooldown penalty for our failure).
    const working = makeApp();
    await requestCode(working, ALICE, cooldown);
    expect(mockMailboxStore.messages).toHaveLength(1);
    expect((await verifyCode(working, ALICE, latestCode(ALICE), cooldown)).status).toBe(200);
  });

  it('times out a hanging provider instead of hanging the request', async () => {
    await seedUser(ALICE);
    const started = Date.now();
    const res = await requestCode(makeApp({ emailProvider: hanging }), ALICE, {
      AUTH_EMAIL_TIMEOUT_MS: '150',
    });
    expect(res.status).toBe(202);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await auditOutcomes('auth.otp.delivery')).toHaveLength(1);
  });
});

describe('configuration problems fail closed', () => {
  const production = {
    ENVIRONMENT: 'production',
    APP_ORIGIN: 'https://hack.example.com',
    CORS_ALLOWED_ORIGINS: '',
  };

  it('returns a generic 503 when the mock email provider is selected in production', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    const res = await requestCode(app, ALICE, {
      ...production,
      EMAIL_PROVIDER: 'mock',
      AUTH_HMAC_SECRET: 'x'.repeat(40),
    });
    expect(res.status).toBe(503);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe('SERVICE_UNAVAILABLE');
    expect(app.logs.map((l) => l.line).join('\n')).toContain('EMAIL_PROVIDER=mock');
    expect(mockMailboxStore.messages).toHaveLength(0);
  });

  it('503 for an unconfigured real provider, even for an ineligible address (no oracle)', async () => {
    const app = makeApp();
    const res = await requestCode(app, 'someone@gmail.com', {
      ...production,
      EMAIL_PROVIDER: 'external',
      AUTH_HMAC_SECRET: 'x'.repeat(40),
    });
    expect(res.status).toBe(503);
    expect(app.logs.map((l) => l.line).join('\n')).toContain('EMAIL_PROVIDER_API_KEY');
  });

  it('503 when AUTH_HMAC_SECRET is missing or weak outside development', async () => {
    const base = { ...production, EMAIL_PROVIDER: 'external', EMAIL_PROVIDER_API_KEY: 'k' };
    for (const secret of [undefined, 'short']) {
      const app = makeApp();
      const res = await requestCode(app, ALICE, { ...base, AUTH_HMAC_SECRET: secret });
      expect(res.status).toBe(503);
      expect(app.logs.map((l) => l.line).join('\n')).toContain('AUTH_HMAC_SECRET');
    }
  });

  it('503 when the institutional domain list is missing, without affecting /api/health', async () => {
    const app = makeApp();
    const res = await requestCode(app, ALICE, { AUTH_ALLOWED_EMAIL_DOMAINS: '' });
    expect(res.status).toBe(503);
    expect((await app.request('/api/health', {}, { AUTH_ALLOWED_EMAIL_DOMAINS: '' })).status).toBe(
      200,
    );
  });
});

describe('dev mailbox route', () => {
  it('does not exist outside development', async () => {
    const res = await makeApp().request('/api/dev/mailbox');
    expect(res.status).toBe(404);
  });

  it('shows the mock mailbox in development only', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    const dev = { ENVIRONMENT: 'development' };
    await requestCode(app, ALICE, dev);
    const res = await app.request('/api/dev/mailbox', withCookie('x=y'), dev);
    expect(res.status).toBe(200);
    const body = await res.json<{ messages: { to: string; text: string }[] }>();
    expect(body.messages[0]?.text).toContain(latestCode(ALICE));
    // Selecting a real provider also hides it.
    expect(
      (await app.request('/api/dev/mailbox', {}, { ...dev, EMAIL_PROVIDER: 'external' })).status,
    ).toBe(404);
  });
});

describe('request validation', () => {
  it('rejects unknown fields and wrong content types', async () => {
    const app = makeApp();
    expect(
      (await app.request('/api/auth/otp/request', json({ email: ALICE, admin: true }))).status,
    ).toBe(400);
    expect(
      (
        await app.request('/api/auth/otp/request', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: ALICE,
        })
      ).status,
    ).toBe(415);
  });
});
