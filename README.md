# Explainable ATS

An evidence-cited resume screening system. Every score it produces is built from
passages quoted from the candidate's own resume, and every quote is verified
against the source document before it can count for anything. The design is
organized around a small set of guarantees rather than a feature list:
protected-attribute redaction before a model ever sees the text, evidence
extraction, verbatim evidence verification, deterministic requirement matching,
deterministic scoring and ranking, a mandatory-reason recruiter decision, and an
append-only audit trail that ties all of it together.

## 1. What It Does

The system evaluates a candidate's resume against a job's requirements and
produces a score, a per-requirement verdict, and the cited evidence behind each
verdict — so a recruiter (or the candidate, in principle) can see exactly why an
evaluation came out the way it did, rather than trusting a single number.

**The implemented ATS pipeline** covers the full path from a resume to a scored,
ranked, decided evaluation: ingest → redact → extract → verify → match → score →
rank → recruiter decision → audit (see Architecture, below). Every stage after
extraction is deterministic; extraction is the only stage that calls a model.

**The current demo experience** is a read/explore/decision surface over a fixed,
seeded dataset. The dashboard lets a visitor browse a job, its ranked
candidates, and the full evidence and audit trail behind any evaluation, and
lets a signed-in operator record a recruiter decision. **There is currently no
live HTTP endpoint that accepts an uploaded resume and runs it through the
pipeline.** The pipeline is exercised for the demo by running it programmatically
against a fixed dataset (`npm run seed:demo`), not by a visitor submitting a
document. See Section 5 for the full distinction.

## 2. Architecture

The pipeline, in the order it runs (`server/src/agent/`, `server/src/domain/ats.ts`):

1. **Ingest** (`agent/ingest.ts`) — stores the resume's canonical text
   (`contentText`) and produces its redacted counterpart.
2. **Redact** (`agent/redact.ts`) — runs before anything else touches the
   resume. Protected-attribute spans (see Section 4) are masked in place with a
   run of `█` characters of the *same length* as what they replace, so
   `redactedText` and `contentText` share identical character offsets — an
   offset produced against the redacted text indexes the original directly,
   with no mapping step.
3. **Extract** (`agent/extract.ts`) — the one stage that calls a model. The
   provider is shown `redactedText` only; the original text never enters this
   scope. The model's output is a forced tool call against a fixed schema
   (`agent/extractionSchema.ts`); shape-invalid findings are dropped and
   counted as `malformed`.
4. **Verify evidence** (`agent/verifyEvidence.ts`) — every accepted quote is
   checked verbatim against the real `contentText`. A quote that cannot be
   found there is recorded with `verified: false` rather than discarded
   silently, so a fabrication stays visible in the audit trail — but it is
   **never trusted downstream**: scoring reads only `listVerifiedForEvaluation`,
   never the full list, and re-checks `verified` a second time.
5. **Match** (`agent/match.ts`, `agent/matchRules.ts`) — a deterministic
   verdict per requirement (`met` / `partial` / `not_met` / `unclear`) computed
   from verified evidence only. No model is imported by this file at all —
   "the model cites, deterministic code judges" is structural here, not a
   policy.
6. **Score** (`agent/score.ts`) — integer arithmetic: `score = floor(Σ(weight ×
   verdictBasisPoints) / Σweight)`, in basis points (0–10000, never a float or
   a driver-dependent numeric type). Each requirement's contribution is
   apportioned by largest-remainder so the displayed contributions sum exactly
   to the total score. **A missed must-have does not reduce the score itself**
   — it is counted (`mustHavesMet` / `mustHavesTotal`) and affects placement in
   ranking instead, so the arithmetic stays checkable by hand.
7. **Rank** (`agent/rankRules.ts`) — computed on read, never stored. Candidates
   are classified into one of four tiers (`qualified`, `needs_review`, `gated`,
   `not_evaluated`) from the stored must-have counts; a missed must-have the
   resume never addressed (`unclear`) is ranked differently from one the
   evidence actively contradicts (`gated`), because the two are different
   findings.
8. **Recruiter decision** — a human records `shortlist`, `reject`, or `hold`
   with a mandatory reason (see Section 9). Only a `scored`, non-superseded
   evaluation can receive one, and only once.
9. **Audit** (`domain/ats.ts::AUDIT_STAGES`) — every stage above writes to an
   append-only audit trail (`job`, `ingest`, `redact`, `extract`, `verify`,
   `match`, `score`, `decide`, `system`), recording actor (`system` / `ai` /
   `human`), outcome (`ok` / `blocked` / `failed` / `skipped`), and a
   machine-checkable payload.

## 3. Explainability / Evidence Model

- **Cited passages**: every requirement verdict is backed by quoted text from
  the resume, or by none at all — there is no verdict with an invented
  justification.
- **Verification**: a quote is only usable evidence once it has been found
  verbatim, at a specific offset, in the real document (`agent/verifyEvidence.ts`).
- **Rejection of unverifiable evidence**: a quote the model returned that
  cannot be found in the resume is stored (so the audit trail can show a
  fabrication occurred) but is excluded from every downstream computation —
  the API layer also never sends an unverified quote to the browser
  (`handlers/evaluations.ts`).
- **Requirement-level verdicts**: `met`, `partial`, `not_met`, `unclear`, each
  with a `confidence` (`high`/`medium`/`low`) and a `rationale` string.
- **Score calculation**: a weighted average in integer basis points, with the
  exact apportionment described in Section 2 — a recruiter can recompute the
  headline number from the per-requirement contributions shown on screen.
- **Ranking**: derived, not stored, from the same stored must-have counts the
  score itself was computed from, so a ranking and its underlying evaluation
  cannot disagree.
- **Audit trail**: append-only, and merges both the resume's history
  (ingestion, redaction) and the evaluation's (extraction, verification,
  matching, scoring, the decision) into one ordered view
  (`handlers/evaluations.ts::handleEvaluationAudit`).

This is what the code supports today: explainability at the level of "which
quote, at which offset, verified how, contributing how much." It is not claimed
to be a formal fairness or bias-audit guarantee beyond what is described above.

## 4. Privacy / Redaction

Redaction happens **before** the model ever sees the resume — the extraction
stage's model call is given `redactedText`, never `contentText`. This is
structural rather than instructional: a protected attribute cannot influence
extraction because it is not present in the input the model receives.

Protected categories (`domain/ats.ts::SENSITIVE_CATEGORIES`): `name`, `age`,
`gender`, `nationality`, `photo`, `address`, `marital_status`, `religion`,
`contact`, `other`.

What is recorded is a **category and a character range** (`SensitiveFinding`:
`category`, `charStart`, `charEnd`) — never the underlying value. The API layer
reflects this directly: `handleEvaluationDetail` reports `protectedAttributes`
as a list of categories and a count, because there is no column to hold a value
in the first place (`handlers/evaluations.ts`).

The redaction rules themselves (`agent/redact.ts`) are pattern-based (email,
phone, and a set of labelled-field patterns like "Date of birth:", "Address:")
plus a caller-supplied list of known names. The module's own documentation is
explicit about scope: this is a demonstrable boundary over a synthetic dataset,
not a general-purpose PII scrubber for arbitrary real-world resumes.

## 5. Deterministic Demo

This distinction matters and is stated explicitly:

- The public demo runs against a **fixed, synthetic dataset**
  (`server/src/demo/dataset.ts::DEMO_JOB`, `DEMO_CANDIDATES`), not arbitrary
  user-submitted resumes.
- The demo's model stage uses the **deterministic mock provider**
  (`adapters/llm/mock.ts`) together with a deterministic extractor responder
  (`agent/mockExtractor.ts`) that is a pure function of the prompt it is given
  — the same input always produces the same output, with `latencyMs: 0` and no
  network call.
- The demo pipeline runs **without any external API key** — `LLM_PROVIDER=mock`
  is the default in `.env.example`, and nothing in the demo path requires
  `ANTHROPIC_API_KEY`.
- Demo data is loaded by running the real pipeline against the fixed dataset:

  ```
  npm run seed:demo
  ```

  This calls `ingestResume` → `openEvaluation`/`extractEvidence` →
  `matchAndScore` for each demo candidate (`server/src/demo/seed.ts`) — the
  same functions a live evaluation would use — rather than inserting
  pre-computed rows directly into the database.
- **The current web demo is a read-only exploration experience.** A visitor can
  browse the seeded job, its ranking, and any evaluation's full evidence and
  audit trail.
- **There is currently no public HTTP endpoint that accepts an uploaded resume.**
  The only way the pipeline runs today is via `npm run seed:demo` against the
  fixed dataset, or (for a signed-in operator, if such a route existed) — no
  such live-ingest route exists in the current codebase (`server/src/routes/`
  contains only `auth.ts`, `health.ts`, and `recruiter.ts`, and `recruiter.ts`
  exposes no ingest/upload route).
- Because of the above, this project is **not** presented as an "upload a
  resume and get a score" live workflow — that HTTP capability does not
  currently exist, regardless of how the demo is described elsewhere.

## 6. Public Demo Safety

Documented strictly from source (`server/src/auth/middleware.ts`,
`server/src/config/env.ts`):

- **Anonymous read-only access** is gated behind `DEMO_PUBLIC_READONLY`
  (default `false`). Off means the system behaves exactly as it did before the
  flag existed — every route requires a session.
- **Public-demo allow-list**: a literal, anchored list of five GET patterns
  (`PUBLIC_DEMO_READS`) — `/jobs`, `/jobs/:id`, `/jobs/:id/ranking`,
  `/evaluations/:id`, `/evaluations/:id/audit`. Matched on method and full
  path; nothing outside this list is reachable anonymously, even when the flag
  is on.
- **The one write route requires a real authenticated session.** An allowed
  anonymous read is granted no session and no cookie — `req.session` and
  `req.operator` stay unset — so `POST /evaluations/:id/decision` is refused
  both because it is not a GET and because no pattern in the allow-list
  matches it.
- **No public mutation route exists** under any configuration.
- **Rate limiting** is present (`http/rateLimit.ts`), fixed-window, keyed by
  session identity when authenticated and by remote address otherwise, never
  by a client-supplied header. It is explicitly **in-memory and
  single-process** — the module's own documentation states this is not
  distributed rate limiting, and a restart or a second instance would not
  share counters.
- **Synthetic data only**: the allow-listed reads expose only what
  `npm run seed:demo` populated.

## 7. Providers and Dependencies

- **LLM providers** (`config/env.ts::LLM_PROVIDERS`): `mock` and `anthropic`.
  `mock` is the default and is **the credential-free demo path** — it replays
  registered fixtures/responders and raises loudly on anything unregistered
  rather than fabricating a plausible-looking answer.
- **Anthropic provider**: requires `ANTHROPIC_API_KEY`. If `LLM_PROVIDER` is
  set to `anthropic` without a key present, configuration loading records a
  startup problem rather than silently falling back to mock. The model is
  pinned to `claude-sonnet-5` by default (`.env.example`).
- **No embedding or vector-search provider** exists anywhere in this codebase.
  Matching is rule-based over verified, extracted evidence — there is no
  similarity search.
- **No external ATS integration** (no Greenhouse/Lever/etc.), **no email
  provider**, and no other third-party service of any kind.

## 8. Data / Persistence

- Two database drivers behind one interface: `sqlite` (via Node's built-in
  driver) and `postgres` (via `pg`) — `server/src/db/index.ts::createDatabase()`.
- **Driver selection is derived from `DATABASE_URL`**, not a separate
  configuration flag: a `postgres://` value selects Postgres, its absence
  selects the local SQLite file. `pg` is imported dynamically, so a machine
  with no `DATABASE_URL` never loads it.
- Migrations live in `server/migrations/` (`001_foundation.sql`,
  `002_domain.sql`) and are applied with `npm run migrate`.
- **Demo seeding** (`npm run seed:demo`, `server/src/demo/seed.ts`) writes
  through the same repositories the live pipeline uses, and is guarded: it
  refuses to run against a non-empty database without `--reset`, refuses to
  target PostgreSQL without `--allow-remote`, and its deletion path
  (`clearDemoData`) only ever removes rows matching the demo candidate
  reference prefix or the demo job's title.
- **Audit persistence** is append-only — the audit repository is not
  documented here beyond that property, since its exact interface was not
  re-verified line-by-line in this pass.

No further schema detail is asserted here beyond what is stated above; consult
`server/migrations/` directly for exact column definitions.

## 9. Recruiter Decision

```
POST /evaluations/:id/decision
```

The only mutation route in the system (`server/src/handlers/evaluations.ts::handleDecision`,
`server/src/routes/recruiter.ts`).

- **Outcome** — one of `shortlist`, `reject`, `hold` (`domain/ats.ts::DECISION_OUTCOMES`).
- **Reason** — mandatory, 10–2000 characters. An empty or too-short reason is
  rejected before anything is written: "a decision on a person needs a reason
  someone can read back."
- The evaluation must be in status `scored` and must not have been superseded
  by a newer evaluation; a decision can be recorded **only once** per
  evaluation (a second attempt returns a conflict).
- **Authenticated operator identity**: `decidedBy` comes from `operatorOf(req)`,
  which reads only the session the auth middleware attached — never a
  request header. There is no way to attribute a decision to anyone other than
  the signed-in operator who made it.
- The decision is recorded and audited (`eventType: 'decision_recorded'`,
  actor `human`) in the same transaction as the response, so the caller is
  handed back the resulting state rather than asked to re-fetch it.

## 10. Running Locally

Commands as they appear in the repository (`server/package.json`,
`web/package.json`, `server/.env.example`). **These commands have not been
executed in the current environment** — dependencies (`node_modules`) are not
installed here, and this milestone did not install them or run anything beyond
reading source.

Commands available in the repository:

```bash
# Server
cd explainable-ats/server
npm install
npm run migrate       # applies server/migrations/*.sql
npm run hash-password # generates a scrypt hash for OPERATOR_PASSWORD_HASH
npm run seed:demo     # runs the real pipeline against the fixed demo dataset
npm run dev            # http://localhost:3200 (or PORT)
npm test               # node --test
npm run typecheck       # tsc --noEmit
npm run lint             # oxlint

# Web
cd explainable-ats/web
npm install
npm run dev      # Vite dev server
npm test          # node --test
npm run typecheck # tsc --noEmit
npm run build     # tsc --noEmit && vite build
```

Per `.env.example`, the server runs with **no `.env` file at all** using a
local SQLite database and the `mock` provider — the two variables that change
behavior are `DATABASE_URL` (enables Postgres) and `OPERATOR_PASSWORD_HASH`
(required for anyone to sign in; there is no built-in default password). No
credential or secret value is included in this README.

## 11. Testing

The repository contains a test suite: 24 test files across
`server/test/` (21 files) and `web/test/` (3 files), using Node's built-in test
runner (`node --test`) on both sides.

Portfolio/project history documents **346 tests** (per commit `1952f30` and the
portfolio's project data); **this figure has not been independently reproduced
in the current environment because dependencies were unavailable** — no
`node_modules` are installed for either `server` or `web`, and this milestone
did not install them or run the suite. A source-level count of `test(` call
sites across the 24 files finds a number close to, but not confirmed identical
to, the documented figure.

There is **no formal evaluation harness** in this project (no `eval:*` scripts,
no `src/eval/` directory) — unlike the documented-scoring claim in the
portfolio, there is no evaluation dataset or metric to report here, and none is
invented in this document.

## 12. Current Scope / Known Limitations

- **No live HTTP resume-ingestion endpoint exists.** The pipeline runs only
  via `npm run seed:demo` against a fixed dataset.
- **The demo uses seeded, synthetic data** — not arbitrary user-submitted
  resumes.
- **No formal evaluation harness exists** for this project.
- **No Docker, Compose, or CI configuration is currently present** anywhere in
  this project.
- **The Anthropic provider requires `ANTHROPIC_API_KEY`**; the mock provider is
  the only credential-free path.
- **The public demo is read-only** — every mutation requires a real
  authenticated session, under any configuration.
- **Real deployment reachability has not been verified in this environment.**
  A live instance is referenced elsewhere (portfolio), but this environment's
  outbound network access is restricted, and no connectivity check performed
  here should be read as confirmation either way.

## 13. Project Status

Based on source verification: the ingest → redact → extract → verify → match →
score → rank pipeline, the recruiter-decision write path, the append-only audit
trail, session-based authentication, and the credential-free public read-only
demo mode are all implemented and present in source. The project does **not**
currently expose a live resume-upload workflow over HTTP — the pipeline is
exercised today only through the demo-seeding script against a fixed dataset.
No claim of "production-ready" is made here, since that was not verified as
part of this documentation pass.
