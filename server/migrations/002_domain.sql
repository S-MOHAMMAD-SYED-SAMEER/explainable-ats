-- P3-B — the domain.
--
-- Ten tables, and one that is deliberately absent: there is no `ranking`.
-- A ranking is a pure function of the evaluations that exist, so storing it
-- would create a second source of truth that can drift from the first. It is
-- computed on read in P3-E.
--
-- TWO DECISIONS WORTH READING BEFORE THE SCHEMA
--
-- Scores are INTEGER BASIS POINTS (0-10000), never a float and never NUMERIC.
-- A float would make the same inputs produce different last digits on different
-- machines, and `pg` returns NUMERIC as a *string*, so a weight that arrived as
-- "3" would concatenate rather than add. Scoring is arithmetic a recruiter must
-- be able to reproduce by hand, so it is integer arithmetic all the way down.
--
-- `sensitive_findings` records WHERE a protected attribute was found and what
-- KIND it was — never its value. The point of the table is to prove such data
-- was detected and excluded, and storing the value again would defeat the
-- purpose of excluding it.
--
-- Written in PostgreSQL dialect and translated for SQLite by `db/dialect.ts`.

-- ============================================================ the job spec

CREATE TABLE jobs (
  id          UUID PRIMARY KEY,
  title       TEXT NOT NULL,
  seniority   TEXT NOT NULL CHECK (seniority IN ('junior','mid','senior','lead')),
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What the job actually asks for. `criterion` is the sentence a recruiter would
-- use to decide whether something counts — it is shown to the model as the
-- question to answer, and shown to the recruiter as the question that was asked.
CREATE TABLE job_requirements (
  id         UUID PRIMARY KEY,
  job_id     UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  criterion  TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('must_have','nice_to_have')),
  -- Positive by constraint: a zero-weight requirement would sit in the
  -- explanation contributing nothing, which is a lie about why it is listed.
  weight     INTEGER NOT NULL CHECK (weight > 0),
  position   INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One requirement per label per job: two "Postgres" rows would double-count.
  UNIQUE (job_id, label)
);

CREATE INDEX idx_job_requirements_job ON job_requirements (job_id, position);

-- ============================================================= candidates

-- `reference` is what the system calls a person; `display_name` is what a
-- recruiter reads. They are separate columns because the reference is safe to
-- put in a log or a filename and the name is not.
CREATE TABLE candidates (
  id           UUID PRIMARY KEY,
  reference    TEXT NOT NULL UNIQUE,
  display_name TEXT,
  source       TEXT NOT NULL CHECK (source IN ('upload','demo','manual')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- `content_text` is the canonical text every quote cites into, and the offsets
-- on `evidence` are offsets into THIS column. `redacted_text` is the same text
-- with protected spans removed and is what the model is shown — the model never
-- sees the original.
CREATE TABLE resumes (
  id            UUID PRIMARY KEY,
  candidate_id  UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  content_text  TEXT NOT NULL,
  redacted_text TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  char_count    INTEGER NOT NULL CHECK (char_count >= 0),
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The same document uploaded twice is one resume, not two candidates.
  UNIQUE (candidate_id, content_hash)
);

-- The quarantine. Nothing here is ever joined into scoring; it exists so the
-- system can show a recruiter what it found and deliberately did not use.
CREATE TABLE sensitive_findings (
  id         UUID PRIMARY KEY,
  resume_id  UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  category   TEXT NOT NULL CHECK (category IN
               ('name','age','gender','nationality','photo','address',
                'marital_status','religion','contact','other')),
  char_start INTEGER NOT NULL CHECK (char_start >= 0),
  char_end   INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_end > char_start)
);

CREATE INDEX idx_sensitive_findings_resume ON sensitive_findings (resume_id);

-- ============================================================ evaluations

-- One job against one candidate's resume. Re-running supersedes rather than
-- overwrites: history is never rewritten, which is the whole point of being
-- able to explain a decision made last month.
CREATE TABLE evaluations (
  id             UUID PRIMARY KEY,
  job_id         UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  candidate_id   UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  resume_id      UUID NOT NULL REFERENCES resumes(id),
  status         TEXT NOT NULL CHECK (status IN ('pending','extracted','scored','failed')),
  -- Which model produced the evidence, and under which prompt. Without both,
  -- a score from six weeks ago cannot be explained or reproduced.
  model          TEXT,
  prompt_version TEXT,
  latency_ms     INTEGER,
  -- Basis points, 0-10000. NULL until the deterministic scorer has run: a
  -- number present before scoring would be a number nobody computed.
  score_basis_points INTEGER CHECK (score_basis_points BETWEEN 0 AND 10000),
  must_haves_met     INTEGER CHECK (must_haves_met >= 0),
  must_haves_total   INTEGER CHECK (must_haves_total >= 0),
  failure_reason TEXT,
  superseded_by  UUID REFERENCES evaluations(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_evaluations_job ON evaluations (job_id, created_at DESC);
CREATE INDEX idx_evaluations_candidate ON evaluations (candidate_id, created_at DESC);

-- What the model found, quoted. `verified` is set only once the quote has been
-- found verbatim at those offsets in the resume; unverified evidence is never
-- shown and never scored. `requirement_id` is nullable because a quote can be
-- relevant without answering any single requirement.
CREATE TABLE evidence (
  id             UUID PRIMARY KEY,
  evaluation_id  UUID NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  resume_id      UUID NOT NULL REFERENCES resumes(id) ON DELETE CASCADE,
  requirement_id UUID REFERENCES job_requirements(id) ON DELETE CASCADE,
  quote          TEXT NOT NULL,
  char_start     INTEGER NOT NULL CHECK (char_start >= 0),
  char_end       INTEGER NOT NULL,
  verified       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (char_end > char_start)
);

CREATE INDEX idx_evidence_evaluation ON evidence (evaluation_id, requirement_id);

-- One judgement per requirement per evaluation. The UNIQUE is what stops a
-- requirement being counted twice in the arithmetic.
CREATE TABLE requirement_matches (
  id             UUID PRIMARY KEY,
  evaluation_id  UUID NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  requirement_id UUID NOT NULL REFERENCES job_requirements(id) ON DELETE CASCADE,
  verdict        TEXT NOT NULL CHECK (verdict IN ('met','partial','not_met','unclear')),
  confidence     TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  -- The weight and the contribution are stored as they were applied, so an
  -- explanation shown next year still adds up even if the job spec has since
  -- been edited.
  weight_applied            INTEGER NOT NULL CHECK (weight_applied > 0),
  contribution_basis_points INTEGER NOT NULL CHECK (contribution_basis_points >= 0),
  rationale      TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (evaluation_id, requirement_id)
);

-- =================================================== the human's decision

-- The system ranks; a person decides. One decision per evaluation, and a
-- reason is mandatory — an unexplained rejection is the thing this product
-- exists to make impossible.
CREATE TABLE recruiter_decisions (
  id            UUID PRIMARY KEY,
  evaluation_id UUID NOT NULL UNIQUE REFERENCES evaluations(id) ON DELETE CASCADE,
  outcome       TEXT NOT NULL CHECK (outcome IN ('shortlist','reject','hold')),
  reason        TEXT NOT NULL,
  decided_by    TEXT NOT NULL,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =========================================================== the audit log

-- Append-only. There is no UPDATE and no DELETE anywhere in the repository,
-- and the sequence is unique per correlation so a gap or a duplicate is a
-- constraint violation rather than something to notice later.
CREATE TABLE audit_events (
  id             UUID PRIMARY KEY,
  correlation_id UUID NOT NULL,
  sequence       INTEGER NOT NULL CHECK (sequence > 0),
  stage          TEXT NOT NULL CHECK (stage IN
                   ('job','ingest','redact','extract','verify','match','score','decide','system')),
  event_type     TEXT NOT NULL,
  actor          TEXT NOT NULL CHECK (actor IN ('system','ai','human')),
  actor_id       TEXT,
  outcome        TEXT NOT NULL CHECK (outcome IN ('ok','blocked','failed','skipped')),
  summary        TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}',
  entity_type    TEXT,
  entity_id      UUID,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (correlation_id, sequence)
);

CREATE INDEX idx_audit_events_correlation ON audit_events (correlation_id, sequence);
CREATE INDEX idx_audit_events_entity ON audit_events (entity_type, entity_id);
