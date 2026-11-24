import { Hono, type Context } from 'hono';
import {
  bulkCreateUsersSchema,
  changeRoleSchema,
  createUserSchema,
  listAuditQuerySchema,
  listUsersQuerySchema,
  normalizeEmail,
  updateUserSchema,
  type AdminUser,
  type BulkCreateResult,
} from '@hackathon/shared';
import { domainAllowed } from '../auth/eligibility';
import {
  findUserById,
  insertUsersAudited,
  listAudit,
  listUsers,
  revokeAllSessionsForUser,
  updateUser,
  writeAudit,
  type UpdateOutcome,
  type UserPatch,
  type UserRow,
} from '../auth/repo';
import { requireAdmin, requireAuth } from '../auth/session';
import { getAuthSettings } from '../auth/settings';
import { AppError } from '../lib/errors';
import { parseJsonBody, parseQuery } from '../lib/validate';
import type { AuthContext, HonoEnv } from '../types';

export const adminRoutes = new Hono<HonoEnv>();

// Every /api/admin/* route needs a valid session AND the admin role, read fresh from the
// database on each request (a demoted admin loses access immediately).
adminRoutes.use('/admin/*', requireAuth, requireAdmin);

const ID_FORMAT = /^[A-Za-z0-9-]{8,64}$/;

function actor(c: Context<HonoEnv>): AuthContext {
  const auth = c.get('auth');
  if (!auth) throw new Error('auth context missing after requireAuth');
  return auth;
}

function toAdminUser(row: UserRow): AdminUser {
  return {
    id: row.id,
    email: row.email_normalized,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    mailboxKind: row.mailbox_kind,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

function userIdParam(raw: string): string {
  if (!ID_FORMAT.test(raw)) throw new AppError('NOT_FOUND', 'User not found.');
  return raw;
}

/** GET /api/admin/users?limit&after&status&role&q — roster, keyset-paginated by email. */
adminRoutes.get('/admin/users', async (c) => {
  const query = parseQuery(c, listUsersQuerySchema);
  const rows = await listUsers(c.env.DB, {
    limit: query.limit + 1,
    after: query.after,
    status: query.status,
    role: query.role,
    prefix: query.q?.toLowerCase(),
  });
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return c.json({
    users: page.map(toAdminUser),
    nextCursor: rows.length > query.limit && last ? last.email_normalized : null,
  });
});

/** POST /api/admin/users — approve one person (adds them to the eligibility roster). 201 / 409. */
adminRoutes.post('/admin/users', async (c) => {
  const admin = actor(c);
  const body = await parseJsonBody(c, createUserSchema);
  const { config } = getAuthSettings(c);
  if (!domainAllowed(config, body.email)) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed.', {
      details: [
        {
          path: 'email',
          code: 'custom',
          message: 'The address is not on an allowed institutional domain.',
        },
      ],
    });
  }
  const id = crypto.randomUUID();
  const now = c.get('now')().toISOString();
  const [created] = await insertUsersAudited(
    c.env.DB,
    [
      {
        id,
        email: body.email,
        displayName: body.displayName ?? null,
        mailboxKind: body.mailboxKind ?? 'personal',
        now,
      },
    ],
    { actorUserId: admin.userId, requestId: c.get('requestId') },
  );
  if (!created) throw new AppError('CONFLICT', 'A user with that email already exists.');
  const row = await findUserById(c.env.DB, id);
  if (!row) throw new Error('user missing after insert');
  return c.json(toAdminUser(row), 201);
});

/** POST /api/admin/users/bulk — roster import, at most 50 per call. Existing addresses are skipped. */
adminRoutes.post('/admin/users/bulk', async (c) => {
  const admin = actor(c);
  const body = await parseJsonBody(c, bulkCreateUsersSchema);
  const { config } = getAuthSettings(c);
  const now = c.get('now')().toISOString();

  const invalid: BulkCreateResult['invalid'] = [];
  const seen = new Set<string>();
  const toInsert: {
    id: string;
    email: string;
    displayName: string | null;
    mailboxKind: 'personal';
    now: string;
  }[] = [];
  body.users.forEach((entry, index) => {
    const normalized = normalizeEmail(entry.email);
    if (!normalized) return void invalid.push({ index, reason: 'invalid_email' });
    if (!domainAllowed(config, normalized.email))
      return void invalid.push({ index, reason: 'domain_not_allowed' });
    if (seen.has(normalized.email))
      return void invalid.push({ index, reason: 'duplicate_in_request' });
    seen.add(normalized.email);
    toInsert.push({
      id: crypto.randomUUID(),
      email: normalized.email,
      displayName: entry.displayName ?? null,
      mailboxKind: 'personal',
      now,
    });
  });

  const outcomes =
    toInsert.length > 0
      ? await insertUsersAudited(c.env.DB, toInsert, {
          actorUserId: admin.userId,
          requestId: c.get('requestId'),
        })
      : [];
  const created = outcomes.filter(Boolean).length;
  const result: BulkCreateResult = { created, alreadyExisted: outcomes.length - created, invalid };
  return c.json(result, 200);
});

/** GET /api/admin/users/:id */
adminRoutes.get('/admin/users/:id', async (c) => {
  const row = await findUserById(c.env.DB, userIdParam(c.req.param('id')));
  if (!row) throw new AppError('NOT_FOUND', 'User not found.');
  return c.json(toAdminUser(row));
});

async function applyChange(
  c: Context<HonoEnv>,
  id: string,
  expectedVersion: number,
  patch: UserPatch,
  auditEvent: string,
) {
  const admin = actor(c);
  const now = c.get('now')().toISOString();
  const requestId = c.get('requestId');
  const outcome: UpdateOutcome = await updateUser(c.env.DB, {
    id,
    expectedVersion,
    patch,
    auditEvent,
    actorUserId: admin.userId,
    requestId,
    now,
  });
  if (outcome === 'updated') {
    const row = await findUserById(c.env.DB, id);
    if (!row) throw new Error('user missing after update');
    return c.json(toAdminUser(row), 200);
  }
  if (outcome === 'not_found') throw new AppError('NOT_FOUND', 'User not found.');
  await writeAudit(c.env.DB, {
    eventType: auditEvent,
    outcome: outcome === 'last_admin' ? 'blocked_last_admin' : 'conflict',
    actorUserId: admin.userId,
    targetUserId: id,
    requestId,
    now,
  });
  if (outcome === 'last_admin') {
    throw new AppError('LAST_ADMIN', 'There must always be at least one active administrator.');
  }
  throw new AppError('CONFLICT', 'This user was changed by someone else. Reload and try again.');
}

/**
 * PATCH /api/admin/users/:id — change status (active | suspended | revoked), display name or
 * mailbox kind. Requires `expectedVersion`. Disabling an account revokes its sessions at once.
 */
adminRoutes.patch('/admin/users/:id', async (c) => {
  const id = userIdParam(c.req.param('id'));
  const body = await parseJsonBody(c, updateUserSchema);
  const patch: UserPatch = {};
  if (body.status !== undefined) patch.status = body.status;
  if (body.displayName !== undefined) patch.displayName = body.displayName;
  if (body.mailboxKind !== undefined) patch.mailboxKind = body.mailboxKind;
  const event = body.status !== undefined ? 'admin.user.status' : 'admin.user.update';
  return applyChange(c, id, body.expectedVersion, patch, event);
});

/** PUT /api/admin/users/:id/role — set role. Requires `expectedVersion`; last-admin protected. */
adminRoutes.put('/admin/users/:id/role', async (c) => {
  const id = userIdParam(c.req.param('id'));
  const body = await parseJsonBody(c, changeRoleSchema);
  return applyChange(c, id, body.expectedVersion, { role: body.role }, 'admin.user.role');
});

/** POST /api/admin/users/:id/sessions/revoke — force-sign-out a user everywhere. */
adminRoutes.post('/admin/users/:id/sessions/revoke', async (c) => {
  const admin = actor(c);
  const id = userIdParam(c.req.param('id'));
  const target = await findUserById(c.env.DB, id);
  if (!target) throw new AppError('NOT_FOUND', 'User not found.');
  const now = c.get('now')().toISOString();
  const revoked = await revokeAllSessionsForUser(c.env.DB, id, 'admin_revoke', now);
  await writeAudit(c.env.DB, {
    eventType: 'admin.sessions.revoke',
    outcome: 'success',
    actorUserId: admin.userId,
    targetUserId: id,
    requestId: c.get('requestId'),
    details: { revoked },
    now,
  });
  return c.json({ revoked }, 200);
});

/** GET /api/admin/audit?limit&before&eventType&targetUserId — newest first. */
adminRoutes.get('/admin/audit', async (c) => {
  const query = parseQuery(c, listAuditQuerySchema);
  const rows = await listAudit(c.env.DB, {
    limit: query.limit + 1,
    before: query.before,
    eventType: query.eventType,
    targetUserId: query.targetUserId,
  });
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return c.json({
    entries: page.map((row) => ({
      id: String(row.seq),
      createdAt: row.created_at,
      eventType: row.event_type,
      outcome: row.outcome,
      actorUserId: row.actor_user_id,
      targetUserId: row.target_user_id,
      requestId: row.request_id,
      details: row.details ? (JSON.parse(row.details) as Record<string, unknown>) : null,
    })),
    nextCursor: rows.length > query.limit && last ? String(last.seq) : null,
  });
});
