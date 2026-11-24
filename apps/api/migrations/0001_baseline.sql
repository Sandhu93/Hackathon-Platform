-- Migration 0001: baseline.
-- Milestone 00 deliberately has no business tables. This table gives the migration
-- workflow something real to apply, and records which schema line the database follows.
-- Timestamps are UTC ISO-8601 strings (see docs/database.md).
CREATE TABLE app_metadata (
  key        TEXT NOT NULL PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 64),
  value      TEXT NOT NULL CHECK (length(value) <= 1024),
  updated_at TEXT NOT NULL CHECK (updated_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z')
) STRICT;

INSERT INTO app_metadata (key, value, updated_at)
VALUES ('schema_baseline', '1', '2026-11-24T00:00:00Z');
