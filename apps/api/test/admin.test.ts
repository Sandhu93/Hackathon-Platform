import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adminUserListSchema,
  adminUserSchema,
  apiErrorSchema,
  auditListSchema,
  type AdminUser,
} from '@hackathon/shared';
import {
  DOMAIN,
  json,
  jsonWithCookie,
  makeApp,
  requestCode,
  resetDb,
  seedUser,
  signIn,
  verifyCode,
  latestCode,
  withCookie,
} from './helpers';

const ADMIN = `admin@${DOMAIN}`;
const ADMIN2 = `admin2@${DOMAIN}`;
const PERSON = `person@${DOMAIN}`;

beforeEach(resetDb);

type App = ReturnType<typeof makeApp>;

async function getUser(app: App, cookie: string, id: string): Promise<AdminUser> {
  const res = await app.request(`/api/admin/users/${id}`, withCookie(cookie));
  expect(res.status).toBe(200);
  return adminUserSchema.parse(await res.json());
}

async function errorCode(res: Response): Promise<string> {
  return apiErrorSchema.parse(await res.json()).error.code;
}

describe('access control', () => {
  const adminRequests: [string, string, unknown?][] = [
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/users', { email: `new@${DOMAIN}` }],
    ['POST', '/api/admin/users/bulk', { users: [{ email: `new@${DOMAIN}` }] }],
    ['GET', '/api/admin/users/00000000-0000-0000-0000-000000000000'],
    [
      'PATCH',
      '/api/admin/users/00000000-0000-0000-0000-000000000000',
      { expectedVersion: 1, status: 'revoked' },
    ],
    [
      'PUT',
      '/api/admin/users/00000000-0000-0000-0000-000000000000/role',
      { role: 'admin', expectedVersion: 1 },
    ],
    ['POST', '/api/admin/users/00000000-0000-0000-0000-000000000000/sessions/revoke', {}],
    ['GET', '/api/admin/audit'],
  ];

  it('refuses unauthenticated callers with 401', async () => {
    const app = makeApp();
    for (const [method, path, body] of adminRequests) {
      const res = await app.request(path, body === undefined ? { method } : json(body, { method }));
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('refuses participants with 403 on every admin endpoint', async () => {
    await seedUser(PERSON);
    const app = makeApp();
    const cookie = await signIn(app, PERSON);
    for (const [method, path, body] of adminRequests) {
      const res = await app.request(
        path,
        body === undefined ? withCookie(cookie, { method }) : jsonWithCookie(cookie, body, method),
      );
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await errorCode(res)).toBe('FORBIDDEN');
    }
  });

  it('a participant cannot promote themselves, even by guessing their own id', async () => {
    const id = await seedUser(PERSON);
    const app = makeApp();
    const cookie = await signIn(app, PERSON);
    const res = await app.request(
      `/api/admin/users/${id}/role`,
      jsonWithCookie(cookie, { role: 'admin', expectedVersion: 1 }, 'PUT'),
    );
    expect(res.status).toBe(403);
    const row = await env.DB.prepare('SELECT role FROM users WHERE id = ?1')
      .bind(id)
      .first<{ role: string }>();
    expect(row?.role).toBe('participant');
  });

  it('a demoted admin loses admin access on the very next request', async () => {
    const a1 = await seedUser(ADMIN, { role: 'admin' });
    await seedUser(ADMIN2, { role: 'admin' });
    const app = makeApp();
    const c1 = await signIn(app, ADMIN);
    const c2 = await signIn(app, ADMIN2);
    const target = await getUser(app, c2, a1);
    const demote = await app.request(
      `/api/admin/users/${a1}/role`,
      jsonWithCookie(c2, { role: 'participant', expectedVersion: target.version }, 'PUT'),
    );
    expect(demote.status).toBe(200);
    expect((await app.request('/api/admin/users', withCookie(c1))).status).toBe(403);
    expect((await app.request('/api/auth/session', withCookie(c1))).status).toBe(200); // still signed in, no longer admin
  });
});

describe('roster management', () => {
  it('creates, lists, paginates and reads users', async () => {
    await seedUser(ADMIN, { role: 'admin' });
    const app = makeApp();
    const cookie = await signIn(app, ADMIN);

    const created = await app.request(
      '/api/admin/users',
      jsonWithCookie(cookie, {
        email: `  New.Person@${DOMAIN.toUpperCase()} `,
        displayName: 'New Person',
      }),
    );
    expect(created.status).toBe(201);
    const user = adminUserSchema.parse(await created.json());
    expect(user).toMatchObject({
      email: `new.person@${DOMAIN}`,
      role: 'participant',
      status: 'active',
      mailboxKind: 'personal',
      version: 1,
    });

    for (const n of ['a', 'b', 'c']) {
      await app.request('/api/admin/users', jsonWithCookie(cookie, { email: `${n}@${DOMAIN}` }));
    }
    const page1 = adminUserListSchema.parse(
      await (await app.request('/api/admin/users?limit=2', withCookie(cookie))).json(),
    );
    expect(page1.users).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = adminUserListSchema.parse(
      await (
        await app.request(
          `/api/admin/users?limit=2&after=${encodeURIComponent(page1.nextCursor ?? '')}`,
          withCookie(cookie),
        )
      ).json(),
    );
    expect(page2.users.length).toBeGreaterThan(0);
    const all = [...page1.users, ...page2.users].map((u) => u.email);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual([...all].sort());

    const search = adminUserListSchema.parse(
      await (await app.request('/api/admin/users?q=new.', withCookie(cookie))).json(),
    );
    expect(search.users.map((u) => u.email)).toEqual([`new.person@${DOMAIN}`]);
    expect((await app.request('/api/admin/users?limit=500', withCookie(cookie))).status).toBe(400);
  });

  it('rejects duplicates (409), foreign domains and shared-by-accident input (400)', async () => {
    await seedUser(ADMIN, { role: 'admin' });
    const app = makeApp();
    const cookie = await signIn(app, ADMIN);
    expect(
      (await app.request('/api/admin/users', jsonWithCookie(cookie, { email: ADMIN }))).status,
    ).toBe(409);
    const foreign = await app.request(
      '/api/admin/users',
      jsonWithCookie(cookie, { email: 'x@gmail.com' }),
    );
    expect(foreign.status).toBe(400);
    expect(
      (
        await app.request(
          '/api/admin/users',
          jsonWithCookie(cookie, { email: `y@${DOMAIN}`, role: 'admin' }),
        )
      ).status,
    ).toBe(400); // role cannot be set at creation
  });

  it('imports a roster in bulk, reporting invalid, duplicate and existing entries', async () => {
    await seedUser(ADMIN, { role: 'admin' });
    await seedUser(`existing@${DOMAIN}`);
    const app = makeApp();
    const cookie = await signIn(app, ADMIN);
    const res = await app.request(
      '/api/admin/users/bulk',
      jsonWithCookie(cookie, {
        users: [
          { email: `one@${DOMAIN}` },
          { email: `TWO@${DOMAIN}`, displayName: 'Two' },
          { email: `one@${DOMAIN}` },
          { email: `existing@${DOMAIN}` },
          { email: 'nope' },
          { email: 'a@gmail.com' },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      created: 2,
      alreadyExisted: 1,
      invalid: [
        { index: 2, reason: 'duplicate_in_request' },
        { index: 4, reason: 'invalid_email' },
        { index: 5, reason: 'domain_not_allowed' },
      ],
    });
    expect(
      (
        await app.request(
          '/api/admin/users/bulk',
          jsonWithCookie(cookie, {
            users: Array.from({ length: 51 }, (_, i) => ({ email: `u${i}@${DOMAIN}` })),
          }),
        )
      ).status,
    ).toBe(400);
  });

  it('newly approved employees can then sign in (roster mode end to end)', async () => {
    await seedUser(ADMIN, { role: 'admin' });
    const app = makeApp();
    const cookie = await signIn(app, ADMIN);
    await requestCode(app, PERSON);
    expect((await verifyCode(app, PERSON, '123456')).status).toBe(401);
    await app.request('/api/admin/users', jsonWithCookie(cookie, { email: PERSON }));
    expect((await signIn(app, PERSON)).length).toBeGreaterThan(0);
  });
});

describe('suspension and revocation', () => {
  it('disabling an account revokes its sessions and pending codes at once', async () => {
    await seedUser(ADMIN, { role: 'admin' });
    const id = await seedUser(PERSON);
    const app = makeApp();
    const adminCookie = await signIn(app, ADMIN);
    const personCookie = await signIn(app, PERSON);
    await requestCode(app, PERSON); // a pending, unused code
    const user = await getUser(app, adminCookie, id);

    const res = await app.request(
      `/api/admin/users/${id}`,
      jsonWithCookie(adminCookie, { expectedVersion: user.version, status: 'revoked' }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    expect(adminUserSchema.parse(await res.json())).toMatchObject({
      status: 'revoked',
      version: user.version + 1,
    });

    expect((await app.request('/api/auth/session', withCookie(personCookie))).status).toBe(401);
    const pending = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM auth_challenges WHERE email_normalized = ?1 AND consumed_at IS NULL',
    )
      .bind(PERSON)
      .first<{ n: number }>();
    expect(pending?.n).toBe(0);
    const revokedBy = await env.DB.prepare('SELECT revoked_reason FROM sessions WHERE user_id = ?1')
      .bind(id)
      .first<{ revoked_reason: string }>();
    expect(revokedBy?.revoked_reason).toBe('account_status');
    // Cannot sign in again until re-approved.
    await requestCode(app, PERSON);
    expect((await verifyCode(app, PERSON, '123456')).status).toBe(401);
  });

  it('an administrator can reinstate a user', async () => {
    await seedUser(ADMIN, { role: 'admin' });
    const id = await seedUser(PERSON, { status: 'suspended' });
    const app = makeApp();
    const cookie = await signIn(app, ADMIN);
    const user = await getUser(app, cookie, id);
    const res = await app.request(
      `/api/admin/users/${id}`,
      jsonWithCookie(cookie, { expectedVersion: user.version, status: 'active' }, 'PATCH'),
    );
    expect(res.status).toBe(200);
    expect((await signIn(app, PERSON)).length).toBeGreaterThan(0);
  });

  it("force sign-out revokes all of a user's sessions", async () => {
    await seedUser(ADMIN, { role: 'admin' });
    const id = await seedUser(PERSON);
    const app = makeApp();
    const adminCookie = await signIn(app, ADMIN);
    const p1 = await signIn(app, PERSON);
    await signIn(app, PERSON);
    const res = await app.request(
      `/api/admin/users/${id}/sessions/revoke`,
      jsonWithCookie(adminCookie, {}),
    );
    expect(res.status).toBe(200);
    expect((await res.json<{ revoked: number }>()).revoked).toBe(2);
    expect((await app.request('/api/auth/session', withCookie(p1))).status).toBe(401);
    expect(
      (
        await app.request(
          '/api/admin/users/not-a-real-id-xx/sessions/revoke',
          jsonWithCookie(adminCookie, {}),
        )
      ).status,
    ).toBe(404);
  });
});

describe('role management and last-admin protection', () => {
  it('promotes a participant, and the new admin can use admin endpoints', async () => {
    await seedUser(ADMIN, { role: 'admin' });
    const id = await seedUser(PERSON);
    const app = makeApp();
    const adminCookie = await signIn(app, ADMIN);
    const personCookie = await signIn(app, PERSON);
    const user = await getUser(app, adminCookie, id);
    const res = await app.request(
      `/api/admin/users/${id}/role`,
      jsonWithCookie(adminCookie, { role: 'admin', expectedVersion: user.version }, 'PUT'),
    );
    expect(res.status).toBe(200);
    expect((await app.request('/api/admin/users', withCookie(personCookie))).status).toBe(200);
  });

  it('refuses to demote, suspend, revoke or mark-shared the last active administrator', async () => {
    const id = await seedUser(ADMIN, { role: 'admin' });
    const app = makeApp();
    const cookie = await signIn(app, ADMIN);
    const attempts: [string, string, unknown][] = [
      ['PUT', `/api/admin/users/${id}/role`, { role: 'participant', expectedVersion: 1 }],
      ['PATCH', `/api/admin/users/${id}`, { expectedVersion: 1, status: 'suspended' }],
      ['PATCH', `/api/admin/users/${id}`, { expectedVersion: 1, status: 'revoked' }],
      ['PATCH', `/api/admin/users/${id}`, { expectedVersion: 1, mailboxKind: 'shared' }],
    ];
    for (const [method, path, body] of attempts) {
      const res = await app.request(path, jsonWithCookie(cookie, body, method));
      expect(res.status, JSON.stringify(body)).toBe(409);
      expect(await errorCode(res)).toBe('LAST_ADMIN');
    }
    const row = await env.DB.prepare(
      'SELECT role, status, mailbox_kind, version FROM users WHERE id = ?1',
    )
      .bind(id)
      .first();
    expect(row).toEqual({ role: 'admin', status: 'active', mailbox_kind: 'personal', version: 1 });
    // Other edits (display name) are still allowed.
    const rename = await app.request(
      `/api/admin/users/${id}`,
      jsonWithCookie(cookie, { expectedVersion: 1, displayName: 'Boss' }, 'PATCH'),
    );
    expect(rename.status).toBe(200);
  });

  it('a suspended or shared admin does not count when deciding who is "the last admin"', async () => {
    const id = await seedUser(ADMIN, { role: 'admin' });
    await seedUser(ADMIN2, { role: 'admin', status: 'suspended' });
    await seedUser(`shared@${DOMAIN}`, { role: 'admin', mailboxKind: 'shared' });
    const app = makeApp();
    const cookie = await signIn(app, ADMIN);
    const res = await app.request(
      `/api/admin/users/${id}/role`,
      jsonWithCookie(cookie, { role: 'participant', expectedVersion: 1 }, 'PUT'),
    );
    expect(res.status).toBe(409);
  });

  it('allows demoting an admin while another active administrator remains', async () => {
    const id = await seedUser(ADMIN, { role: 'admin' });
    await seedUser(ADMIN2, { role: 'admin' });
    const app = makeApp();
    const cookie = await signIn(app, ADMIN);
    const res = await app.request(
      `/api/admin/users/${id}/role`,
      jsonWithCookie(cookie, { role: 'participant', expectedVersion: 1 }, 'PUT'),
    ); // self-demotion
    expect(res.status).toBe(200);
  });

  it('two admins demoting each other at the same time can never leave zero admins', async () => {
    const a = await seedUser(ADMIN, { role: 'admin' });
    const b = await seedUser(ADMIN2, { role: 'admin' });
    const app = makeApp();
    const ca = await signIn(app, ADMIN);
    const cb = await signIn(app, ADMIN2);
    const body = { role: 'participant', expectedVersion: 1 };
    const [r1, r2] = await Promise.all([
      app.request(`/api/admin/users/${b}/role`, jsonWithCookie(ca, body, 'PUT')),
      app.request(`/api/admin/users/${a}/role`, jsonWithCookie(cb, body, 'PUT')),
    ]);
    expect([r1.status, r2.status].filter((s) => s === 200)).toHaveLength(1);
    const admins = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND status = 'active'",
    ).first<{ n: number }>();
    expect(admins?.n).toBe(1);
  });

  it('two admins making conflicting changes to one user: the second gets a conflict, not a silent overwrite', async () => {
    await seedUser(ADMIN, { role: 'admin' });
    await seedUser(ADMIN2, { role: 'admin' });
    const id = await seedUser(PERSON);
    const app = makeApp();
    const ca = await signIn(app, ADMIN);
    const cb = await signIn(app, ADMIN2);
    const seenByBoth = await getUser(app, ca, id);
    const first = await app.request(
      `/api/admin/users/${id}/role`,
      jsonWithCookie(ca, { role: 'admin', expectedVersion: seenByBoth.version }, 'PUT'),
    );
    expect(first.status).toBe(200);
    const second = await app.request(
      `/api/admin/users/${id}`,
      jsonWithCookie(cb, { expectedVersion: seenByBoth.version, status: 'suspended' }, 'PATCH'),
    );
    expect(second.status).toBe(409);
    expect(await errorCode(second)).toBe('CONFLICT');
    expect((await getUser(app, cb, id)).status).toBe('active'); // the stale change was not applied
  });

  it('concurrent identical requests apply exactly once', async () => {
    await seedUser(ADMIN, { role: 'admin' });
    const id = await seedUser(PERSON);
    const app = makeApp();
    const cookie = await signIn(app, ADMIN);
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        app.request(
          `/api/admin/users/${id}/role`,
          jsonWithCookie(cookie, { role: 'admin', expectedVersion: 1 }, 'PUT'),
        ),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await getUser(app, cookie, id)).version).toBe(2);
  });

  it('answers 404 for unknown users and rejects bad bodies', async () => {
    await seedUser(ADMIN, { role: 'admin' });
    const app = makeApp();
    const cookie = await signIn(app, ADMIN);
    const missing = '11111111-1111-1111-1111-111111111111';
    expect((await app.request(`/api/admin/users/${missing}`, withCookie(cookie))).status).toBe(404);
    expect(
      (
        await app.request(
          `/api/admin/users/${missing}/role`,
          jsonWithCookie(cookie, { role: 'admin', expectedVersion: 1 }, 'PUT'),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/api/admin/users/${missing}`,
          jsonWithCookie(cookie, { expectedVersion: 1 }, 'PATCH'),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request(
          `/api/admin/users/${missing}/role`,
          jsonWithCookie(cookie, { role: 'owner', expectedVersion: 1 }, 'PUT'),
        )
      ).status,
    ).toBe(400);
  });
});

describe('audit trail', () => {
  it('records sign-ins, role changes and revocations with categories and no secrets', async () => {
    await seedUser(ADMIN, { role: 'admin' });
    const id = await seedUser(PERSON);
    const app = makeApp();
    const cookie = await signIn(app, ADMIN);
    await app.request(
      `/api/admin/users/${id}/role`,
      jsonWithCookie(cookie, { role: 'admin', expectedVersion: 1 }, 'PUT'),
    );
    await app.request(
      `/api/admin/users/${id}`,
      jsonWithCookie(cookie, { expectedVersion: 2, status: 'suspended' }, 'PATCH'),
    );
    await app.request(`/api/admin/users/${id}/sessions/revoke`, jsonWithCookie(cookie, {}));
    await verifyCode(app, ADMIN, '123456'); // a failed sign-in

    const res = await app.request('/api/admin/audit?limit=100', withCookie(cookie));
    const text = await res.text();
    const list = auditListSchema.parse(JSON.parse(text));
    const events = list.entries.map((e) => `${e.eventType}:${e.outcome}`);
    expect(events).toEqual(
      expect.arrayContaining([
        'auth.otp.request:issued',
        'auth.login:success',
        'admin.user.role:success',
        'admin.user.status:success',
        'admin.sessions.revoke:success',
        'auth.login:failure',
      ]),
    );
    const role = list.entries.find((e) => e.eventType === 'admin.user.role');
    expect(role).toMatchObject({
      actorUserId: expect.any(String),
      targetUserId: id,
      details: { fromRole: 'participant', toRole: 'admin' },
    });
    expect(text).not.toContain(latestCode(ADMIN));
    expect(text).not.toMatch(/hackathon_session|token_hash|code_hash/);
    // Newest first, and paginated.
    const first = list.entries[0];
    expect(Number(first?.id)).toBeGreaterThan(Number(list.entries[list.entries.length - 1]?.id));
    const small = auditListSchema.parse(
      await (await app.request('/api/admin/audit?limit=2', withCookie(cookie))).json(),
    );
    expect(small.entries).toHaveLength(2);
    expect(small.nextCursor).toBeTruthy();
  });

  it('records blocked last-admin attempts', async () => {
    const id = await seedUser(ADMIN, { role: 'admin' });
    const app = makeApp();
    const cookie = await signIn(app, ADMIN);
    await app.request(
      `/api/admin/users/${id}/role`,
      jsonWithCookie(cookie, { role: 'participant', expectedVersion: 1 }, 'PUT'),
    );
    const rows = await env.DB.prepare(
      "SELECT outcome FROM audit_log WHERE event_type = 'admin.user.role'",
    ).all<{ outcome: string }>();
    expect(rows.results.map((r) => r.outcome)).toEqual(['blocked_last_admin']);
  });
});
