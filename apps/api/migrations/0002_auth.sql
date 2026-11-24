-- Migration 0002: institutional email authentication (Milestone 01).
-- Conventions (docs/database.md): STRICT tables, UTC ISO-8601 timestamps, constraints as the
-- last line of defence. Secrets (OTPs, session tokens) are stored ONLY as keyed hashes.

-- Users double as the eligibility roster: a row with status 'active' and mailbox_kind
-- 'personal' is an approved account. `version` is an optimistic-concurrency token so two
-- administrators cannot silently overwrite each other's changes.
CREATE TABLE users (
  id               TEXT    NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 64),
  email_normalized TEXT    NOT NULL UNIQUE
                   CHECK (length(email_normalized) BETWEEN 3 AND 254 AND email_normalized = lower(email_normalized)),
  display_name     TEXT    CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 100),
  role             TEXT    NOT NULL DEFAULT 'participant' CHECK (role IN ('participant', 'admin')),
  status           TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  mailbox_kind     TEXT    NOT NULL DEFAULT 'personal' CHECK (mailbox_kind IN ('personal', 'shared')),
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at       TEXT    NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  updated_at       TEXT    NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  last_login_at    TEXT    CHECK (last_login_at IS NULL OR last_login_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z')
) STRICT;

CREATE INDEX users_role_status ON users (role, status, mailbox_kind);

-- One-time email codes. Keyed by email (not user) so that "domain" eligibility mode can
-- challenge an address that has no users row yet. Only the HMAC of the code is stored.
CREATE TABLE auth_challenges (
  id               TEXT    NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 64),
  email_normalized TEXT    NOT NULL CHECK (length(email_normalized) BETWEEN 3 AND 254),
  code_hash        TEXT    NOT NULL CHECK (length(code_hash) = 64),
  created_at       TEXT    NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  expires_at       TEXT    NOT NULL CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts     INTEGER NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
  -- Set when the code was used, superseded by a newer one, invalidated by an account change,
  -- or its delivery failed. NULL means the challenge is still usable.
  consumed_at      TEXT    CHECK (consumed_at IS NULL OR consumed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  delivery_status  TEXT    NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'sent', 'failed')),
  source_hash      TEXT    CHECK (source_hash IS NULL OR length(source_hash) = 64)
) STRICT;

-- At most one usable challenge per address, enforced by the database (not just application code).
CREATE UNIQUE INDEX auth_challenges_one_active ON auth_challenges (email_normalized) WHERE consumed_at IS NULL;
CREATE INDEX auth_challenges_expires ON auth_challenges (expires_at);

-- Server-side sessions. The cookie carries a random token; only its HMAC is stored here.
CREATE TABLE sessions (
  id             TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 64),
  user_id        TEXT NOT NULL REFERENCES users (id),
  token_hash     TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  created_at     TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  last_seen_at   TEXT NOT NULL CHECK (last_seen_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  expires_at     TEXT NOT NULL CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  revoked_at     TEXT CHECK (revoked_at IS NULL OR revoked_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  revoked_reason TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN ('logout', 'revoke_all', 'admin_revoke', 'account_status')),
  source_hash    TEXT CHECK (source_hash IS NULL OR length(source_hash) = 64)
) STRICT;

CREATE INDEX sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires ON sessions (expires_at);

-- Append-only audit trail of security-relevant events. Holds categories and identifiers only:
-- never an OTP, a session token, a cookie or a plaintext address for unknown accounts
-- (those are recorded as keyed hashes in subject_hash).
CREATE TABLE audit_log (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT NOT NULL CHECK (created_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z'),
  event_type     TEXT NOT NULL CHECK (length(event_type) BETWEEN 3 AND 64),
  outcome        TEXT NOT NULL CHECK (length(outcome) BETWEEN 1 AND 64),
  actor_user_id  TEXT,
  target_user_id TEXT,
  subject_hash   TEXT CHECK (subject_hash IS NULL OR length(subject_hash) = 64),
  source_hash    TEXT CHECK (source_hash IS NULL OR length(source_hash) = 64),
  request_id     TEXT CHECK (request_id IS NULL OR length(request_id) <= 64),
  details        TEXT CHECK (details IS NULL OR length(details) <= 1000)
) STRICT;

CREATE INDEX audit_log_created ON audit_log (created_at);
CREATE INDEX audit_log_target ON audit_log (target_user_id) WHERE target_user_id IS NOT NULL;

-- Fixed-window counters for throttling. Buckets are keyed hashes, so no address or IP is stored.
CREATE TABLE rate_limits (
  bucket       TEXT    NOT NULL CHECK (length(bucket) BETWEEN 1 AND 128),
  window_start INTEGER NOT NULL CHECK (window_start >= 0),
  count        INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (bucket, window_start)
) STRICT;

CREATE INDEX rate_limits_window ON rate_limits (window_start);
