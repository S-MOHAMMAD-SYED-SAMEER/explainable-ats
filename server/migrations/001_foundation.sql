-- P3-A — the foundation.
--
-- Only what sign-in needs. The domain tables (job, requirement, candidate,
-- resume, evidence, evaluation, requirement_match, recruiter_decision,
-- audit_event) arrive in P3-B and get their own migration, so this one stays
-- the thing that never changes.
--
-- Written in PostgreSQL dialect and translated for SQLite by `db/dialect.ts`,
-- so one file describes both. Migrations are immutable once applied: the
-- runner stores a checksum and refuses a file that has been edited.

CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY,
  csrf_token   TEXT NOT NULL,
  operator     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

-- Looked up on every authenticated request.
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);
