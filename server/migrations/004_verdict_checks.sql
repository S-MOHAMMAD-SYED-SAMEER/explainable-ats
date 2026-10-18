-- The model's verdict for each requirement, and what the code did with it.
--
-- In `model_checked` mode the model proposes a verdict per requirement with the passages it relies on,
-- the code enforces the rules (a verdict needs a verified quote), and the deterministic matcher
-- computes its own verdict from the same verified passages as a second opinion. This table keeps
-- all of it apart from `requirement_matches`, which holds the verdict that was SCORED: one row per
-- evaluation and requirement, so a recruiter can see what the model said, what survived, and where
-- the second opinion disagreed.
--
-- Nothing here is read by the scorer except through the match stage, and nothing here can raise a
-- score: `scored_verdict` is never above `enforced_verdict`, and `enforced_verdict` is never above
-- `model_verdict` (a verdict is only ever downgraded). The model's wording (`model_reason`) is shown
-- to a person, never used as evidence.
--
-- Written in PostgreSQL dialect and translated for SQLite by `db/dialect.ts`.

CREATE TABLE verdict_checks (
  id               UUID PRIMARY KEY,
  evaluation_id    UUID NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  requirement_id   UUID NOT NULL REFERENCES job_requirements(id) ON DELETE CASCADE,
  -- 'model_checked' or 'matcher': which mode produced the scored verdict.
  verdict_mode     TEXT NOT NULL CHECK (verdict_mode IN ('model_checked','matcher')),
  -- What the model said. NULL when it gave no answer for this requirement.
  model_verdict    TEXT CHECK (model_verdict IN ('met','partial','not_met','unclear')),
  model_reason     TEXT,
  -- After the code's rules: never above the model's.
  enforced_verdict TEXT NOT NULL CHECK (enforced_verdict IN ('met','partial','not_met','unclear')),
  -- Why the code lowered it, or NULL when it did not.
  downgrade_reason TEXT CHECK (downgrade_reason IN ('no_verified_passage','no_answer')),
  -- The matcher's own verdict from the same verified passages, and its mode.
  matcher_verdict  TEXT CHECK (matcher_verdict IN ('met','partial','not_met','unclear')),
  matcher_mode     TEXT CHECK (matcher_mode IN ('strict','folded')),
  -- How far apart the two are: 0 steps agree, 1 differ but are shown, 2 or more route the candidate to a person.
  disagreement     TEXT NOT NULL CHECK (disagreement IN ('none','one_step','two_plus')),
  -- The verdict the score used. Equal to enforced_verdict unless a two-step disagreement capped it.
  scored_verdict   TEXT NOT NULL CHECK (scored_verdict IN ('met','partial','not_met','unclear')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (evaluation_id, requirement_id)
);

CREATE INDEX idx_verdict_checks_evaluation ON verdict_checks (evaluation_id);
