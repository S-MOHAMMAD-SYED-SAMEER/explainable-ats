-- A credited verdict whose quote shares no word with the requirement.
--
-- In `model_checked` mode the model's verified verdict is what is scored. When a verdict that credits the
-- candidate (met or partial) rests on quotes that share no word with the requirement, the match stage
-- flags it here so a person is told: the page shows "Quote shares no words with the requirement, a person
-- should check", the audit trail records `quote_no_overlap_flagged`, and a candidate with such a flag on a
-- MUST-HAVE is routed to `needs_review`. The flag changes nothing in the score.
--
-- `scored_verdict` (migration 004) is now always equal to `enforced_verdict`: no verdict is lowered
-- automatically any more. The column stays because a column cannot be dropped portably.
--
-- Written in PostgreSQL dialect and translated for SQLite by `db/dialect.ts`.

ALTER TABLE verdict_checks ADD COLUMN quote_no_overlap BOOLEAN NOT NULL DEFAULT FALSE;
