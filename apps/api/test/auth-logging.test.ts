import { beforeEach, describe, expect, it } from 'vitest';
import {
  DOMAIN,
  cookieFrom,
  jsonWithCookie,
  latestCode,
  makeApp,
  requestCode,
  resetDb,
  seedUser,
  signIn,
  verifyCode,
} from './helpers';

const ALICE = `alice@${DOMAIN}`;
// The test env logs errors only, so capture everything; and use a recognisable signing secret so
// the leak check below can really look for it.
const CANARY_SECRET = 'canary-signing-secret-must-never-be-logged-0123456789';
const DEBUG = { LOG_LEVEL: 'debug', AUTH_HMAC_SECRET: CANARY_SECRET };

beforeEach(resetDb);

describe('no secrets in logs or responses', () => {
  it('keeps codes, session tokens, full addresses and secrets out of every log line', async () => {
    const admin = `admin@${DOMAIN}`;
    await seedUser(admin, { role: 'admin' });
    const id = await seedUser(ALICE);
    const app = makeApp();
    const bodies: string[] = [];

    const adminCookie = await signIn(app, admin, DEBUG);
    await requestCode(app, ALICE, DEBUG);
    const code = latestCode(ALICE);
    await verifyCode(app, ALICE, '000000', DEBUG);
    const ok = await verifyCode(app, ALICE, code, DEBUG);
    bodies.push(await ok.text());
    const token = cookieFrom(ok)?.split('=')[1] ?? '';
    await app.request('/api/auth/session', { headers: { cookie: cookieFrom(ok) ?? '' } }, DEBUG);
    await app.request('/api/auth/logout', jsonWithCookie(cookieFrom(ok) ?? '', {}), DEBUG);
    await app.request(
      `/api/admin/users/${id}/sessions/revoke`,
      jsonWithCookie(adminCookie, {}),
      DEBUG,
    );
    const list = await app.request('/api/admin/users', { headers: { cookie: adminCookie } }, DEBUG);
    bodies.push(await list.text());

    const logs = app.logs.map((l) => l.line).join('\n');
    expect(token.length).toBeGreaterThan(20);
    expect(logs).toContain('email.mock.sent'); // proves the capture really sees info-level lines
    expect(logs).not.toContain(code);
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(adminCookie.split('=')[1] ?? 'x');
    expect(logs).not.toContain(ALICE);
    expect(logs).not.toContain(CANARY_SECRET);
    // Responses never echo the OTP, even the one for the user who just proved they own it.
    for (const body of bodies) {
      expect(body).not.toContain(code);
      expect(body).not.toContain(token);
    }
  });

  it('does not log request bodies or the Cookie header', async () => {
    await seedUser(ALICE);
    const app = makeApp();
    await requestCode(app, ALICE, DEBUG);
    await verifyCode(app, ALICE, '654321', DEBUG);
    const logs = app.logs.map((l) => l.line).join('\n');
    expect(logs).not.toContain('654321');
    expect(logs.toLowerCase()).not.toContain('cookie');
  });
});
