/**
 * All authentication SQL lives here (portability: this is the only file to port to PostgreSQL).
 * Every query is parameterised. Concurrency-sensitive rules are single conditional statements
 * or `batch()` transactions, never read-then-write in application code.
 */
import type { MailboxKind, Role, UserStatus } from '@hackathon/shared';

export interface UserRow {
  id: string;
  email_normalized: string;
  display_name: string | null;
  role: Role;
  status: UserStatus;
  mailbox_kind: MailboxKind;
  version: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

const USER_COLUMNS =
  'id, email_normalized, display_name, role, status, mailbox_kind, version, created_at, updated_at, last_login_at';

// ---- users ---------------------------------------------------------------------------------

export function findUserByEmail(db: D1Database, email: string): Promise<UserRow | null> {
  return db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE email_normalized = ?1`)
    .bind(email)
    .first<UserRow>();
}

export function findUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?1`).bind(id).first<UserRow>();
}

export interface NewUser {
  id: string;
  email: string;
  displayName: string | null;
  mailboxKind: MailboxKind;
  now: string;
}

const INSERT_USER_IGNORE = `INSERT INTO users (id, email_normalized, display_name, mailbox_kind, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?5) ON CONFLICT (email_normalized) DO NOTHING`;

export function insertUserStatement(db: D1Database, user: NewUser): D1PreparedStatement {
  return db
    .prepare(INSERT_USER_IGNORE)
    .bind(user.id, user.email, user.displayName, user.mailboxKind, user.now);
}

/** Returns true when a row was created, false when the address already existed. */
export async function insertUserIfAbsent(db: D1Database, user: NewUser): Promise<boolean> {
  const result = await insertUserStatement(db, user).run();
  return result.meta.changes === 1;
}

/**
 * Insert users and, for each row actually created, an audit row, all in one transaction.
 * Returns, per input, whether it was created (false = the address already existed).
 */
export async function insertUsersAudited(
  db: D1Database,
  users: NewUser[],
  audit: { actorUserId: string; requestId: string },
): Promise<boolean[]> {
  const statements: D1PreparedStatement[] = [];
  for (const user of users) {
    statements.push(
      insertUserStatement(db, user),
      db
        .prepare(
          `INSERT INTO audit_log (created_at, event_type, outcome, actor_user_id, target_user_id, request_id, details)
           SELECT ?1, 'admin.user.create', 'success', ?2, ?3, ?4, ?5 WHERE changes() > 0`,
        )
        .bind(
          user.now,
          audit.actorUserId,
          user.id,
          audit.requestId,
          JSON.stringify({ mailboxKind: user.mailboxKind }),
        ),
    );
  }
  const results = await db.batch(statements);
  return users.map((_, i) => (results[i * 2]?.meta.changes ?? 0) === 1);
}

export interface ListUsersParams {
  limit: number;
  after?: string | undefined;
  status?: UserStatus | undefined;
  role?: Role | undefined;
  prefix?: string | undefined;
}

/** Keyset pagination on the unique email: stable under concurrent inserts, no OFFSET scans. */
export async function listUsers(db: D1Database, params: ListUsersParams): Promise<UserRow[]> {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (params.after !== undefined) {
    binds.push(params.after);
    where.push(`email_normalized > ?${binds.length}`);
  }
  if (params.status !== undefined) {
    binds.push(params.status);
    where.push(`status = ?${binds.length}`);
  }
  if (params.role !== undefined) {
    binds.push(params.role);
    where.push(`role = ?${binds.length}`);
  }
  if (params.prefix !== undefined) {
    // Escape LIKE wildcards so a search for "100%" matches literally.
    binds.push(`${params.prefix.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`email_normalized LIKE ?${binds.length} ESCAPE '\\'`);
  }
  binds.push(params.limit);
  const sql = `SELECT ${USER_COLUMNS} FROM users ${
    where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  } ORDER BY email_normalized LIMIT ?${binds.length}`;
  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<UserRow>();
  return result.results;
}

export interface UserPatch {
  role?: Role;
  status?: UserStatus;
  displayName?: string | null;
  mailboxKind?: MailboxKind;
}

export interface AuditInput {
  eventType: string;
  outcome: string;
  actorUserId?: string | null;
  targetUserId?: string | null;
  subjectHash?: string | null;
  sourceHash?: string | null;
  requestId?: string | null;
  details?: Record<string, unknown> | null;
  now: string;
}

export function auditStatement(db: D1Database, entry: AuditInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_log (created_at, event_type, outcome, actor_user_id, target_user_id, subject_hash, source_hash, request_id, details)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      entry.now,
      entry.eventType,
      entry.outcome,
      entry.actorUserId ?? null,
      entry.targetUserId ?? null,
      entry.subjectHash ?? null,
      entry.sourceHash ?? null,
      entry.requestId ?? null,
      entry.details ? JSON.stringify(entry.details).slice(0, 1000) : null,
    );
}

export async function writeAudit(db: D1Database, entry: AuditInput): Promise<void> {
  await auditStatement(db, entry).run();
}

export type UpdateOutcome = 'updated' | 'not_found' | 'version_conflict' | 'last_admin';

export interface UpdateUserInput {
  id: string;
  expectedVersion: number;
  patch: UserPatch;
  /** Event name for the audit row written atomically with the change. */
  auditEvent: string;
  actorUserId: string;
  requestId: string;
  now: string;
}

/**
 * Apply a change to a user atomically.
 *
 * - Optimistic concurrency: the UPDATE only matches the version the caller saw, so two
 *   administrators making conflicting changes cannot both win (the loser gets a conflict).
 * - Last-admin protection: when the change would stop an active administrator being one
 *   (demotion, suspension, revocation, marking the mailbox shared), the same statement
 *   requires another active administrator to exist. Evaluated inside the UPDATE, so two
 *   admins demoting each other concurrently cannot leave the system with none.
 * - When the account stops being usable, its sessions and pending codes are revoked in the
 *   same transaction, and the audit row is written only if the UPDATE changed a row.
 */
export async function updateUser(db: D1Database, input: UpdateUserInput): Promise<UpdateOutcome> {
  const current = await findUserById(db, input.id);
  if (!current) return 'not_found';

  const { patch } = input;
  const next = {
    role: patch.role ?? current.role,
    status: patch.status ?? current.status,
    mailboxKind: patch.mailboxKind ?? current.mailbox_kind,
  };
  const isActiveAdmin = (u: { role: Role; status: UserStatus; mailboxKind: MailboxKind }) =>
    u.role === 'admin' && u.status === 'active' && u.mailboxKind === 'personal';
  const wasActiveAdmin = isActiveAdmin({
    role: current.role,
    status: current.status,
    mailboxKind: current.mailbox_kind,
  });
  const needsAnotherAdmin = wasActiveAdmin && !isActiveAdmin(next);
  const accountDisabled = next.status !== 'active' || next.mailboxKind !== 'personal';

  const sets = ['updated_at = ?1', 'version = version + 1'];
  const binds: (string | number | null)[] = [input.now];
  const set = (column: string, value: string | null) => {
    binds.push(value);
    sets.push(`${column} = ?${binds.length}`);
  };
  if (patch.role !== undefined) set('role', patch.role);
  if (patch.status !== undefined) set('status', patch.status);
  if (patch.displayName !== undefined) set('display_name', patch.displayName);
  if (patch.mailboxKind !== undefined) set('mailbox_kind', patch.mailboxKind);

  binds.push(input.id);
  const idIndex = binds.length;
  binds.push(input.expectedVersion);
  const versionIndex = binds.length;
  const guard = needsAnotherAdmin
    ? `AND EXISTS (SELECT 1 FROM users other WHERE other.id != ?${idIndex} AND other.role = 'admin' AND other.status = 'active' AND other.mailbox_kind = 'personal')`
    : '';

  const newVersion = input.expectedVersion + 1;
  const details = JSON.stringify({
    fromRole: current.role,
    toRole: next.role,
    fromStatus: current.status,
    toStatus: next.status,
    mailboxKind: next.mailboxKind,
  });

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE users SET ${sets.join(', ')} WHERE id = ?${idIndex} AND version = ?${versionIndex} ${guard}`,
      )
      .bind(...binds),
    // Written only if the UPDATE above changed a row (same transaction, same connection).
    db
      .prepare(
        `INSERT INTO audit_log (created_at, event_type, outcome, actor_user_id, target_user_id, request_id, details)
         SELECT ?1, ?2, 'success', ?3, ?4, ?5, ?6 WHERE changes() > 0`,
      )
      .bind(input.now, input.auditEvent, input.actorUserId, input.id, input.requestId, details),
  ];
  if (accountDisabled) {
    statements.push(
      db
        .prepare(
          `UPDATE sessions SET revoked_at = ?1, revoked_reason = 'account_status'
           WHERE user_id = ?2 AND revoked_at IS NULL
             AND (SELECT version FROM users WHERE id = ?2) = ?3`,
        )
        .bind(input.now, input.id, newVersion),
      db
        .prepare(
          `UPDATE auth_challenges SET consumed_at = ?1
           WHERE email_normalized = ?2 AND consumed_at IS NULL
             AND (SELECT version FROM users WHERE id = ?3) = ?4`,
        )
        .bind(input.now, current.email_normalized, input.id, newVersion),
    );
  }

  const results = await db.batch(statements);
  if ((results[0]?.meta.changes ?? 0) === 1) return 'updated';

  // Nothing changed: work out why so the caller can answer precisely.
  const latest = await findUserById(db, input.id);
  if (!latest) return 'not_found';
  return latest.version !== input.expectedVersion ? 'version_conflict' : 'last_admin';
}

// ---- challenges ----------------------------------------------------------------------------

export interface NewChallenge {
  id: string;
  email: string;
  codeHash: string;
  now: string;
  expiresAt: string;
  /** Existing challenges created at or before this instant may be superseded. */
  cooldownCutoff: string;
  maxAttempts: number;
  sourceHash: string | null;
}

/**
 * Issue a challenge, superseding the previous one, unless that one is still inside the resend
 * cooldown. Returns false when the cooldown blocked it. Atomic: the partial unique index
 * guarantees at most one usable challenge per address even under concurrent requests.
 */
export async function createChallenge(db: D1Database, c: NewChallenge): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE auth_challenges SET consumed_at = ?1
         WHERE email_normalized = ?2 AND consumed_at IS NULL AND created_at <= ?3`,
      )
      .bind(c.now, c.email, c.cooldownCutoff),
    db
      .prepare(
        `INSERT INTO auth_challenges (id, email_normalized, code_hash, created_at, expires_at, max_attempts, source_hash)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
         WHERE NOT EXISTS (SELECT 1 FROM auth_challenges WHERE email_normalized = ?2 AND consumed_at IS NULL)`,
      )
      .bind(c.id, c.email, c.codeHash, c.now, c.expiresAt, c.maxAttempts, c.sourceHash),
  ]);
  return (results[1]?.meta.changes ?? 0) === 1;
}

export function markDelivery(
  db: D1Database,
  id: string,
  status: 'sent' | 'failed',
  now: string,
): Promise<D1Result> {
  // A failed delivery also invalidates the code (nobody received it) and frees the cooldown.
  return db
    .prepare(
      `UPDATE auth_challenges SET delivery_status = ?1, consumed_at = CASE WHEN ?1 = 'failed' THEN COALESCE(consumed_at, ?2) ELSE consumed_at END
       WHERE id = ?3`,
    )
    .bind(status, now, id)
    .run();
}

export interface ActiveChallenge {
  id: string;
  code_hash: string;
  attempts: number;
  max_attempts: number;
}

export function findActiveChallengeId(db: D1Database, email: string): Promise<string | null> {
  return db
    .prepare('SELECT id FROM auth_challenges WHERE email_normalized = ?1 AND consumed_at IS NULL')
    .bind(email)
    .first<{ id: string }>()
    .then((row) => row?.id ?? null);
}

/**
 * Atomically count one verification attempt and fetch the stored hash. Returns null when the
 * challenge is used, expired, superseded or out of attempts. Because the counter is bumped
 * inside the same statement that checks the limit, parallel guesses cannot exceed it.
 */
export function takeAttempt(
  db: D1Database,
  id: string,
  now: string,
): Promise<ActiveChallenge | null> {
  return db
    .prepare(
      `UPDATE auth_challenges SET attempts = attempts + 1
       WHERE id = ?1 AND consumed_at IS NULL AND expires_at > ?2 AND attempts < max_attempts
       RETURNING id, code_hash, attempts, max_attempts`,
    )
    .bind(id, now)
    .first<ActiveChallenge>();
}

/** Single-use guarantee: exactly one caller can flip consumed_at from NULL. */
export async function consumeChallenge(db: D1Database, id: string, now: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE auth_challenges SET consumed_at = ?1 WHERE id = ?2 AND consumed_at IS NULL')
    .bind(now, id)
    .run();
  return result.meta.changes === 1;
}

// ---- sessions ------------------------------------------------------------------------------

export interface NewSession {
  id: string;
  userId: string;
  tokenHash: string;
  now: string;
  expiresAt: string;
  sourceHash: string | null;
}

export interface SessionLookup {
  session_id: string;
  session_created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_id: string;
  email_normalized: string;
  display_name: string | null;
  role: Role;
  status: UserStatus;
  mailbox_kind: MailboxKind;
}

export async function createSession(db: D1Database, s: NewSession): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, source_hash)
         VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)`,
      )
      .bind(s.id, s.userId, s.tokenHash, s.now, s.expiresAt, s.sourceHash),
    db.prepare('UPDATE users SET last_login_at = ?1 WHERE id = ?2').bind(s.now, s.userId),
  ]);
}

/** Session and its user in one read, so role/status changes take effect on the very next request. */
export function lookupSession(db: D1Database, tokenHash: string): Promise<SessionLookup | null> {
  return db
    .prepare(
      `SELECT s.id AS session_id, s.created_at AS session_created_at, s.last_seen_at, s.expires_at,
              u.id AS user_id, u.email_normalized, u.display_name, u.role, u.status, u.mailbox_kind
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?1 AND s.revoked_at IS NULL`,
    )
    .bind(tokenHash)
    .first<SessionLookup>();
}

export function touchSession(db: D1Database, id: string, now: string): Promise<D1Result> {
  return db.prepare('UPDATE sessions SET last_seen_at = ?1 WHERE id = ?2').bind(now, id).run();
}

export function revokeSessionByTokenHash(
  db: D1Database,
  tokenHash: string,
  reason: 'logout',
  now: string,
): Promise<{ user_id: string } | null> {
  return db
    .prepare(
      `UPDATE sessions SET revoked_at = ?1, revoked_reason = ?2
       WHERE token_hash = ?3 AND revoked_at IS NULL RETURNING user_id`,
    )
    .bind(now, reason, tokenHash)
    .first<{ user_id: string }>();
}

export async function revokeAllSessionsForUser(
  db: D1Database,
  userId: string,
  reason: 'revoke_all' | 'admin_revoke',
  now: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE sessions SET revoked_at = ?1, revoked_reason = ?2
       WHERE user_id = ?3 AND revoked_at IS NULL`,
    )
    .bind(now, reason, userId)
    .run();
  return result.meta.changes;
}

// ---- rate limits ---------------------------------------------------------------------------

/**
 * Count one event in a fixed window. A single upsert whose DO UPDATE is guarded by the limit:
 * once a bucket is full, further requests change nothing, so a flood cannot burn the daily
 * D1 write quota. Returns false when the limit is already reached.
 */
export async function consumeRateLimit(
  db: D1Database,
  bucket: string,
  windowStart: number,
  limit: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1 WHERE count < ?3`,
    )
    .bind(bucket, windowStart, limit)
    .run();
  return result.meta.changes === 1;
}

/**
 * Opportunistic housekeeping (Milestone 04 moves this to a scheduled job). Deleting is bounded
 * by LIMIT-free age filters on indexed columns.
 */
export async function purgeExpired(
  db: D1Database,
  nowIso: string,
  nowSeconds: number,
): Promise<void> {
  const day = new Date(Date.parse(nowIso) - 86_400_000).toISOString();
  const week = new Date(Date.parse(nowIso) - 7 * 86_400_000).toISOString();
  await db.batch([
    db.prepare('DELETE FROM rate_limits WHERE window_start < ?1').bind(nowSeconds - 7200),
    db.prepare('DELETE FROM auth_challenges WHERE expires_at < ?1').bind(day),
    db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(week),
  ]);
}

// ---- audit read ----------------------------------------------------------------------------

export interface AuditRow {
  seq: number;
  created_at: string;
  event_type: string;
  outcome: string;
  actor_user_id: string | null;
  target_user_id: string | null;
  request_id: string | null;
  details: string | null;
}

export async function listAudit(
  db: D1Database,
  params: {
    limit: number;
    before?: number | undefined;
    eventType?: string | undefined;
    targetUserId?: string | undefined;
  },
): Promise<AuditRow[]> {
  const where: string[] = [];
  const binds: (string | number)[] = [];
  if (params.before !== undefined) {
    binds.push(params.before);
    where.push(`seq < ?${binds.length}`);
  }
  if (params.eventType !== undefined) {
    binds.push(params.eventType);
    where.push(`event_type = ?${binds.length}`);
  }
  if (params.targetUserId !== undefined) {
    binds.push(params.targetUserId);
    where.push(`target_user_id = ?${binds.length}`);
  }
  binds.push(params.limit);
  const sql = `SELECT seq, created_at, event_type, outcome, actor_user_id, target_user_id, request_id, details
    FROM audit_log ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY seq DESC LIMIT ?${binds.length}`;
  const result = await db
    .prepare(sql)
    .bind(...binds)
    .all<AuditRow>();
  return result.results;
}
