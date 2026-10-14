-- The record of each extraction: what was asked of the model and what came back.
--
-- One row per evaluation, written whether the extraction succeeded or failed, so
-- that a failed run still says which model it went to, what it cost and how long it
-- took, and a successful one can be re-read exactly as the model returned it. The
-- `evaluations` row keeps its own `model` and `latency_ms` for the success path;
-- this is the fuller record, kept apart so a list of evaluations never loads a
-- model's raw answer.
--
-- `raw_output` is the tool input exactly as received, as JSON text. The model was
-- shown only the redacted resume, so this holds redacted text and nothing the
-- redaction removed. It is the model's answer BEFORE validation and verification:
-- findings that were later dropped or rejected are still in it, which is the point.
-- For a cut-off answer it holds whatever had arrived, which may be incomplete.
--
-- Written in PostgreSQL dialect and translated for SQLite by `db/dialect.ts`.

CREATE TABLE evaluation_records (
  evaluation_id    UUID PRIMARY KEY REFERENCES evaluations(id) ON DELETE CASCADE,
  -- How the extraction ended: 'succeeded', or the kind of failure.
  result           TEXT NOT NULL CHECK (result IN ('succeeded','refusal','truncated','malformed','unavailable','rejected','unexpected')),
  model            TEXT,
  -- The output limit that was requested, so a cut-off answer can be read against it.
  max_tokens       INTEGER CHECK (max_tokens > 0),
  -- Reported by the provider, never estimated. NULL when it did not say, or when no
  -- reply arrived (a timeout has no usage).
  input_tokens     INTEGER CHECK (input_tokens >= 0),
  output_tokens    INTEGER CHECK (output_tokens >= 0),
  latency_ms       INTEGER CHECK (latency_ms >= 0),
  -- How many entries the model's `findings` array had, before any were validated. 0
  -- is "the model found nothing", which is not the same thing as a failure.
  findings_returned INTEGER CHECK (findings_returned >= 0),
  raw_output       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
