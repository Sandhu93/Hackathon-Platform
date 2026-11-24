#!/usr/bin/env node
// Creates the FIRST administrator. This is the only way to get an admin into an empty database:
// the HTTP API has no unauthenticated path to admin rights (by design).
//
//   pnpm admin:bootstrap --email you@institution.edu [--name "Your Name"]            (local D1)
//   pnpm admin:bootstrap --email ... --remote --env staging|production --yes         (deployed D1)
//
// Safety properties:
//  - It only acts when NO active personal-mailbox admin exists. The check and the write are one
//    SQL statement, so two operators running it at once cannot create two "first" admins.
//  - It never lowers anything: with an admin present it refuses and changes nothing. Use the
//    admin API (PUT /api/admin/users/:id/role) for every later change.
//  - Remote runs need --yes, and refuse a wrangler.jsonc that still has placeholders.
//  - The email goes through a deliberately narrow charset check before it is placed in SQL.
//  - Every run that changes something is recorded in the audit log (admin.bootstrap).
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { apiDir, root, wranglerBin, wranglerEnv } from './wrangler-bin.mjs';
import { join } from 'node:path';

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};

const rawEmail = value('email');
if (!rawEmail)
  fail(
    'Usage: admin:bootstrap --email <address> [--name <display name>] [--remote --env <staging|production> --yes]',
  );
const email = rawEmail.trim().toLowerCase();
// Conservative on purpose (this value is interpolated into SQL): letters, digits and . _ + - only.
if (
  email.length > 254 ||
  !/^[a-z0-9]+(?:[._+-][a-z0-9]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(
    email,
  )
) {
  fail(`"${rawEmail}" is not a plain email address (letters, digits and . _ + - only).`);
}
const name = value('name')?.trim() || null;
if (
  name !== null &&
  (name.length > 100 || [...name].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127))
)
  fail('--name must be 100 characters or fewer, with no control characters.');

const remote = flag('remote');
const environment = value('env');
if (remote) {
  if (environment !== 'staging' && environment !== 'production')
    fail('--remote requires --env staging|production.');
  const check = spawnSync(
    process.execPath,
    [join(root, 'scripts/check-deploy-config.mjs'), environment],
    { stdio: 'inherit' },
  );
  if (check.status !== 0) fail('Refusing to continue: fix wrangler.jsonc first.', 1);
  if (!flag('yes')) {
    fail(
      `This will create the first administrator ${email} in the REMOTE ${environment} database.\n` +
        'Re-run with --yes to confirm. (Nothing was changed.)',
    );
  }
} else if (environment) {
  fail('--env only applies with --remote. Local runs always use the local D1 database.');
}

const sql = (text) => `'${text.replaceAll("'", "''")}'`;
const target = remote ? ['--remote', '--env', environment] : ['--local'];

function execute(command) {
  const result = spawnSync(
    process.execPath,
    [wranglerBin, 'd1', 'execute', 'DB', ...target, '--json', '--command', command],
    { cwd: apiDir, env: wranglerEnv, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    fail(
      'wrangler failed (see above). Has the database been migrated? Run the migrations first.',
      1,
    );
  }
  const text = result.stdout.slice(result.stdout.indexOf('['));
  try {
    return JSON.parse(text);
  } catch {
    console.error(result.stdout);
    return fail('Could not read wrangler output.', 1);
  }
}

const rows = (output) => output.flatMap((part) => part.results ?? []);

const ADMIN_FILTER = "role = 'admin' AND status = 'active' AND mailbox_kind = 'personal'";
const before = rows(execute(`SELECT COUNT(*) AS n FROM users WHERE ${ADMIN_FILTER}`))[0]?.n ?? 0;
if (before > 0) {
  fail(
    `An active administrator already exists (${before}). Nothing was changed.\n` +
      'Use the admin API to manage roles; this script only bootstraps an empty system.',
    1,
  );
}

const now = new Date().toISOString();
const id = randomUUID();
execute(
  `INSERT INTO users (id, email_normalized, display_name, role, status, mailbox_kind, version, created_at, updated_at)
   SELECT ${sql(id)}, ${sql(email)}, ${name === null ? 'NULL' : sql(name)}, 'admin', 'active', 'personal', 1, ${sql(now)}, ${sql(now)}
   WHERE NOT EXISTS (SELECT 1 FROM users WHERE ${ADMIN_FILTER})
   ON CONFLICT (email_normalized) DO UPDATE SET
     role = 'admin', status = 'active', mailbox_kind = 'personal',
     version = users.version + 1, updated_at = ${sql(now)}`,
);

// Confirm what the database now says (never trust the statement's silence).
const after = rows(
  execute(`SELECT id, email_normalized, version FROM users WHERE ${ADMIN_FILTER}`),
);
const mine = after.find((row) => row.email_normalized === email);
if (!mine) {
  fail(
    'The administrator was not created: another one appeared at the same moment. Nothing else was changed.',
    1,
  );
}
execute(
  `INSERT INTO audit_log (created_at, event_type, outcome, target_user_id, details)
   VALUES (${sql(now)}, 'admin.bootstrap', 'success', ${sql(mine.id)}, ${sql(JSON.stringify({ via: 'bootstrap-admin', target: remote ? environment : 'local' }))})`,
);
console.log(
  `Administrator ready: ${email} (${remote ? environment : 'local'}). Sign in with an emailed code.`,
);
