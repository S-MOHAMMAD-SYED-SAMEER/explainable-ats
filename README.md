# Explainable ATS

An evidence-cited resume screening system. Every score it produces is built from
passages quoted from the candidate's own resume, and every quote is verified
against the source document before it can count for anything. The design is
organized around a small set of guarantees rather than a feature list:
protected-attribute redaction before a model ever sees the text, evidence
extraction, verbatim evidence verification, deterministic requirement matching,
deterministic scoring and ranking, a mandatory-reason recruiter decision, and an
append-only audit trail that ties all of it together.

## Status at a glance

What exists today, stated plainly:

| | State |
|---|---|
| Redaction, verification, matching, scoring, ranking, audit trail, recruiter decision | **Implemented and tested.** Deterministic. |
| Evidence extraction | **Deterministic mock by default** — a keyword matcher (`agent/mockExtractor.ts`), and the only thing the demo, the seed script and the tests run. An Anthropic provider exists behind the same interface (next row), but nothing runs it unless `LLM_PROVIDER=anthropic` is set, and no HTTP route triggers extraction. |
| Anthropic / Claude provider | **Implemented, not yet verified against the real API.** `LLM_PROVIDER=anthropic` builds an adapter that forces a `record_evidence` tool call, with a timeout and bounded retries. It is tested against a fake client and a local stub server only: **no call to the live Anthropic API has been made**, whether the configured model accepts the request as built is unconfirmed, and **extraction quality has not been evaluated**. The demo deployment always uses the mock, and refuses to start with a key. |
| Resume input | **Plain text only**, through the existing pipeline. There is no upload endpoint and no PDF or DOCX parsing. |
| Job requirements | **Structured and typed** (label, criterion, must-have or nice-to-have, weight). They are not extracted from a free-text job description. |
| Deployment modes and the demo | **One codebase, two deployments.** `APP_MODE=app` (the default) is the real application: recruiter sign-in, the recruiter routes, a canonical database, and no demo routes at all. `APP_MODE=demo` is the portfolio demo: no sign-in, no canonical database, no credentials, the mock provider only, and a private in-memory copy of five invented candidates per visitor (`/#/demo`: a project explanation, then the interactive demo). A route that does not belong to the running mode is never registered. See Sections 5, 6 and 14. |
| Evaluation harness / accuracy metrics | **None.** |
| Docker / deployment configuration | **None** in this repository: there is no `render.yaml`. Section 14 documents how the two deployments are meant to be configured; nothing has been configured on any host. CI exists (Section 11). |

## 1. What It Does

The system evaluates a candidate's resume against a job's requirements and
produces a score, a per-requirement verdict, and the cited evidence behind each
verdict — so a recruiter (or the candidate, in principle) can see exactly why an
evaluation came out the way it did, rather than trusting a single number.

**The implemented ATS pipeline** covers the path from a resume's text to a
scored, ranked, decided evaluation: ingest → redact → extract → verify → match →
score → rank → recruiter decision → audit (see Architecture, below). Every stage
after extraction is deterministic. Extraction is the one stage behind a model
boundary. By default a deterministic mock stands in for the model; an Anthropic
provider is implemented behind the same interface but has not been run against
the real API.

**The demo experience** is the second deployment (`APP_MODE=demo`). A visitor opens
it with no sign-in, reads a short explanation of the project, and presses
*Explore the Interactive Demo* to get a private copy of a fixed synthetic dataset:
they can browse a job and its ranked candidates, read the redacted CV with the
verified evidence highlighted, follow the pipeline and the audit timeline, and
record a **demo decision** that is saved only to their own session. The real
application is a separate deployment that has none of this, and its signed-in
operator can record a real recruiter decision. **There is no HTTP endpoint that
accepts an uploaded or pasted resume.** The pipeline runs on the seeded dataset
(`npm run seed:demo`) and, in the demo, on a private copy of that dataset built for
each visitor, never on a visitor's own document. See Section 5.

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
3. **Extract** (`agent/extract.ts`) — the one stage behind a model boundary
   (`adapters/llm/`). The provider is shown `redactedText` only; the original
   text never enters this scope. The provider's output is a forced tool call
   against a fixed schema (`agent/extractionSchema.ts`); shape-invalid findings
   are dropped and counted as `malformed`. **Two providers exist: the deterministic
   mock (the default) and an Anthropic provider that has not yet been verified
   against the real API (Section 7).**
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
   policy. The rule is crude by design: it measures how many of the
   requirement's significant terms appear in the verified quotes (75% or more is
   `met`, 35% or more is `partial`), and every rationale states what was counted.
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
   machine-checkable payload. (With the mock provider, the `ai` actor is the
   mock.)

## 3. Explainability / Evidence Model

- **Cited passages**: every requirement verdict is backed by quoted text from
  the resume, or by none at all — there is no verdict with an invented
  justification.
- **Verification**: a quote is only usable evidence once it has been found
  verbatim, at a specific offset, in the real document (`agent/verifyEvidence.ts`).
- **Rejection of unverifiable evidence**: a quote the extraction stage returned
  that cannot be found in the resume is stored (so the audit trail can show a
  fabrication occurred) but is excluded from every downstream computation —
  the API layer also never sends an unverified quote to the browser
  (`handlers/evaluations.ts`).
- **Requirement-level verdicts**: `met`, `partial`, `not_met`, `unclear`, each
  with a `confidence` (`high`/`medium`/`low`) and a `rationale` string, all
  produced by the deterministic matcher.
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
to be a formal fairness or bias-audit guarantee beyond what is described above,
and nothing here has been measured against real resumes.

## 4. Privacy / Redaction

Redaction happens **before** the extraction stage's provider ever sees the
resume — it is given `redactedText`, never `contentText`. This is structural
rather than instructional: a protected attribute cannot influence extraction
because it is not present in the input the provider receives.

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

## 5. The Demo: Deterministic, Synthetic, Temporary

The demo is its own deployment: `APP_MODE=demo` (Section 14). Everything below
describes that deployment, and none of it exists in the real application.

- The demo runs against a **fixed, synthetic dataset**
  (`server/src/demo/dataset.ts::DEMO_JOB`, `DEMO_CANDIDATES`: one job, five
  invented candidates), not arbitrary user-submitted resumes.
- The demo's extraction stage uses the **deterministic mock provider**
  (`adapters/llm/mock.ts`) together with a deterministic extractor responder
  (`agent/mockExtractor.ts`) that is a pure function of the prompt it is given
  — the same input always produces the same output, with `latencyMs: 0` and no
  network call. **No language model is involved anywhere in the demo.**
- The demo runs **without any credential, and refuses to start with one**: it has
  no canonical database, no sign-in and no API key (Section 14 lists exactly what it
  refuses). It does not read or write the server's data directory, it never runs migrations
  against a persistent database, and it seeds nothing at boot.
- **The first page** (`/#/demo`, and wherever a visitor with no session lands) is a
  project explanation, not a login and not a dashboard: what the system is, the
  problem it addresses, the seven-stage workflow, evidence-first matching,
  deterministic scoring and ranking, redaction and privacy, how model-produced
  evidence is verified, the recruiter decision and audit trail, the architecture, the
  security boundaries, how it is tested and the tech stack — and, plainly, what the
  demo is not (no CV upload and no PDF or DOCX parsing, no language model running,
  not a multi-user production system). It carries one call to action,
  **Explore the Interactive Demo**, which starts a session — or resumes the one the
  browser already holds, with an explicit "Start over". Nothing starts until they
  press it. No AI provider, key or network call is involved. The page's wording is
  one pure module (`web/src/demo/copy.ts`), so every sentence is testable.
- **The second page** is the interactive demo: the same screens a recruiter would
  use, drawn from the visitor's own session. It has no navigation menu and no Status
  screen; **Exit demo** returns to the first page.
  - **Evidence in context, the pipeline and the timeline** explain why a candidate
    landed where they did, from data the backend already produced. A candidate's
    page shows the **redacted resume** (`GET /api/demo/session/evaluations/:id/resume`
    returns the redacted text and nothing else; the original is never selected, and
    the recruiter API has no resume route) with the verified evidence highlighted in
    it. Redaction preserves length and the verifier refuses any quote overlapping a
    mask, so the stored offsets index the redacted text exactly; the screen still
    checks each span (in bounds, the text there is the quote, no mask) and reports
    what it refuses instead of highlighting it. Resume text is rendered as text.
    Each requirement shows its verdict, its quotes and the line they sit on. A
    **pipeline** of eight stages is built from the recorded audit events: a stage
    with no event is "Not run", ranking (which is derived on read, not recorded) is
    "Derived on read", and nothing is given a timestamp it was not stored with. The
    **timeline** shows one item per event, in recorded order, with the arithmetic
    behind the score and the evidence verification behind an expander and the demo
    decision as its final event. Pipeline events carry the demo's fixed clock; a
    decision carries the real time.
  - **The demo's wording** claims no model and names no vendor: the keyword matcher
    that picks passages is described as one, the history says "Deterministic demo
    extraction (no AI model)" for it, and a real model is still labelled as one.
    Inside the demo, the first screen is an overview (role, requirements with kind
    and weight, candidate count, what each ranking label means) built from the
    visitor's own session data, and a "How this demo works" panel lists the path
    through a candidate and what Reset and Exit do.
  - **What a session is.** A private in-memory SQLite database, built by the same
    `seedDemoData` the canonical seeder runs (ingest, redact, extract, verify,
    match, score) over the same fixed dataset, with the deterministic stand-in for
    the model. A fixed clock and sequential ids make every session start
    byte-identical. The demo process has no canonical database to read or copy, and
    no canonical repositories exist in it to be passed to a session.
  - **How it is named.** An opaque random token (32 bytes, base64url) in an
    `ats_demo` cookie: `HttpOnly`, `SameSite=Strict`, `Secure` unless
    `COOKIE_SECURE=false`. It carries no identity and nothing decodable, is never
    in a response body or a URL, and is stored server-side only as its SHA-256. The
    demo has no operator sessions, so the cookie cannot be mistaken for one.
  - **Routes** (all anonymous, all under `/api/demo/session`, all registered in demo
    mode only): `POST` start or resume, `GET` status (never an error), `POST /reset`,
    `DELETE` end, the dashboard's reads (`/jobs`, `/jobs/:id`, `/jobs/:id/ranking`,
    `/evaluations/:id`, `/evaluations/:id/audit`, `/evaluations/:id/resume`) and
    `POST /evaluations/:id/decision`. They are served from the visitor's own
    database. There is no run endpoint: a session already holds every scenario.
  - **A visitor's decision** (`POST /api/demo/session/evaluations/:id/decision`)
    needs the `ats_demo` cookie and nothing else (a token in a URL, header or body
    is never read), looks the evaluation up **only in the caller's own database**,
    and records it as the fixed actor `demo-visitor`, which the request cannot
    override. It reuses the recruiter's `handleDecision`, so the outcomes
    (`shortlist`, `reject`, `hold`), the reason rule (at least 10 characters), the
    one-decision-per-assessment rule and the audit event (`decision_recorded`) are
    the same code, not a copy; the validation errors are the one difference — they
    say what was wrong without quoting what was sent. A decision is stamped with the
    real time (the seeded data stays on its fixed clock), appears in that session's
    history, and is removed by Reset.
  - **Reset** rebuilds only the caller's own database from the fixed dataset. It
    takes no body and no target: the session is whichever the cookie names.
  - **Bounded and ephemeral.** A session lapses after two hours without use (use
    slides the window), at most 100 exist (the least recently used is evicted), and
    a restart discards them all — including a free-tier host going to sleep. Starting
    one is the most expensive anonymous request, so it has its own rate-limit class
    (`demoSession`, 10 per minute).
  - **Survives a reload** because the browser keeps the cookie and the app asks the
    server at startup; nothing is kept in localStorage or the URL. Because every
    session starts identical, its ids are identical: an id is only meaningful inside
    the session whose cookie accompanies it.
- **There is no public endpoint that accepts a resume.** The session routes take no
  document, only the visitor's own decision.

## 6. Deployment Boundaries and Safety

Documented from source (`server/src/config/mode.ts`, `server/src/app.ts`,
`server/src/config/env.ts`, `server/src/http/rateLimit.ts`):

- **The boundary is structural.** `APP_MODE` decides which routes exist. A route
  that does not belong to the running mode is never registered, so there is no
  handler to refuse it and no flag to flip: it answers like any other path the
  server has never heard of.
  - **Application mode** registers health, the sign-in routes and the recruiter
    routes behind the session gate. It registers no demo route, builds no demo
    session store and offers no anonymous read. A stranger asking for a demo path
    gets the same sign-in refusal as for a path that never existed; a signed-in
    operator gets the same 404.
  - **Demo mode** registers health and the demo-session routes. It registers no
    sign-in route, no operator session, no CSRF layer and no recruiter route, and
    is never handed a database: building the app refuses one.
- **Anonymous access is the demo's alone.** In the real application every route but
  health and sign-in needs a session; **there is no anonymous read window** (the old
  public read list, the `DEMO_PUBLIC_READONLY` switch, the shared demo-run sandbox
  and its run endpoint were removed in Phase 3C.8, and setting the old variable now
  changes nothing).
- **The anonymous writes are the demo's session lifecycle and a visitor's own
  decision** (Section 5), and exist only in the demo deployment. None can reach a
  canonical record, because that deployment has none; each takes no body (except
  the decision), issues no operator session, and has a rate-limit class.
- **Recruiter decisions are protected.** `POST /evaluations/:id/decision` exists in
  the application only, needs a session and a CSRF token, takes the decider from
  the session rather than a header, and can only target a canonical, scored,
  non-superseded evaluation.
- **Session cookies** are named `ats_session` (HttpOnly) and `ats_csrf` (readable,
  so the front end can echo it in `x-csrf-token`). Both are `SameSite=Strict`, and
  `Secure` unless `COOKIE_SECURE=false`.
- **Rate limiting** is present (`http/rateLimit.ts`), fixed-window, keyed by
  session identity when authenticated and by remote address otherwise, never
  by a client-supplied header. It is explicitly **in-memory and
  single-process** — the module's own documentation states this is not
  distributed rate limiting, and a restart or a second instance would not
  share counters. There is no model-call rate class because no HTTP route calls a
  model.
- **Synthetic data only in the demo**: a demo process can only hold what a session
  seeds from the five fixed demo scenarios.
- **The front end learns the mode from the server.** One built client is served by
  both deployments, so it asks `/api/health` (which reports `mode`) before drawing
  anything, and draws only that mode's screens. A missing or unrecognised answer is
  an error with a retry, never a guess.
- **Prompt injection is not specifically handled.** Resume text is placed into
  the extraction prompt under plain section markers. The verifier limits the
  damage — a provider can only cite text that really exists in the resume — but
  there is no prompt-layer defence and no tests for it. With the mock provider
  this is moot. It matters now that an Anthropic provider exists, although
  nothing yet sends a visitor-supplied resume to it.

## 7. Providers and Dependencies

- **LLM providers** (`config/env.ts::LLM_PROVIDERS`): `mock` and `anthropic`,
  both behind the one `LlmProvider` interface (`adapters/llm/types.ts`).
  - `mock` is the default: it replays registered fixtures/responders and raises
    loudly on anything unregistered rather than fabricating a plausible-looking
    answer. It is what the public demo, `npm run seed:demo` and every test use.
  - **`anthropic`** (`adapters/llm/anthropic.ts`) is selected with
    `LLM_PROVIDER=anthropic` and needs `ANTHROPIC_API_KEY`; with it selected and
    no key the server refuses to start, and it never falls back to the mock. It:
    - sends the extraction request the pipeline built — **redacted resume text
      only** — through the official `@anthropic-ai/sdk`, to the model named by
      `ANTHROPIC_MODEL` (default `claude-sonnet-5`), passed through verbatim: the
      adapter names no model of its own;
    - **forces the `record_evidence` tool** and accepts exactly one well-formed
      call. Free text, no tool call, several calls, a refusal, a truncated
      answer, or a payload that is not an object with a `findings` array are
      provider failures, never empty results;
    - applies a **hard timeout** (`ANTHROPIC_TIMEOUT_MS`, default 60000, maximum
      300000) and **bounded retries** (`ANTHROPIC_MAX_RETRIES`, default 2, maximum
      5) for transient failures only — a timeout, a dropped connection, HTTP
      408/429/5xx — with a fixed exponential delay. A bad request, a bad key or a
      malformed answer is never retried;
    - maps every failure to the project's `LlmError`. The pipeline already records
      that as a failed evaluation (an `extraction_failed` audit event) and returns
      `PROVIDER_UNAVAILABLE`; the key and the provider's own error text never
      reach a client, the audit trail or the health endpoint;
    - **does not score, match, rank or explain.** Its output is only a set of
      candidate quotes, checked by the same schema validation and the same
      verbatim verification against the original resume as the mock's.
  - **Token usage** the provider reports is recorded in the `extraction_recorded`
    audit event (`usage`: input and output token counts) when present. Nothing is
    priced: there is **no cost calculation and no cost tracking**.
  - **What is unverified.** No call to the live Anthropic API has been made by
    this project; the provider has been exercised only against a fake client and a
    local stub server. Specifically unconfirmed: that the default model accepts
    the request exactly as built (**some newer models reject a forced tool call
    with a 400**; if `ANTHROPIC_MODEL` names one, extraction fails with a clear,
    non-retried error), real latency, real token counts, and **extraction quality**
    — there is no evaluation dataset or metric.
  - **Nothing connects the provider to a user.** No HTTP route runs extraction,
    and the demo deployment refuses to start with a non-mock provider or a key.
  - The `@anthropic-ai/sdk` dependency is imported in exactly one file, the
    adapter.
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
- **The Postgres path has not been verified against a live server for this
  project's schema.** Every test runs on SQLite, and `test/driver-parity.test.ts`
  checks the contract from the SQLite side only.
- Migrations live in `server/migrations/` (`001_foundation.sql`,
  `002_domain.sql`) and are applied with `npm run migrate`.
- **Demo seeding** (`npm run seed:demo`, `server/src/demo/seed.ts`) writes
  through the same repositories the live pipeline uses, and is guarded: it
  refuses to run against a non-empty database without `--reset`, refuses to
  target PostgreSQL without `--allow-remote`, and its deletion path
  (`clearDemoData`) only ever removes rows matching the demo candidate
  reference prefix or the demo job's title.
- **Audit persistence** is append-only: the audit repository
  (`db/repositories/audit.ts`) has an `append` method and read methods and no
  update or delete, and a sequence number unique per correlation id.
- The demo deployment (Section 5) has no canonical database at all. Its visitors'
  sessions are separate in-memory SQLite databases that exist only inside that
  process and are never written to disk.

Consult `server/migrations/` directly for exact column definitions.

## 9. Recruiter Decision

```
POST /evaluations/:id/decision
```

The only mutation route that requires a session
(`server/src/handlers/evaluations.ts::handleDecision`,
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
- **CSRF**: a request without the per-session `x-csrf-token` is refused (403).
- The decision is recorded and audited (`eventType: 'decision_recorded'`,
  actor `human`), and the caller is handed back the resulting state rather than
  asked to re-fetch it.
- The route exists in the application only. A visitor decides through the demo's
  own route (Section 5), which the application never registers, and which shares
  nothing with this one but the handler logic.

## 10. Running Locally

Requires **Node 24 or newer** (`server/package.json` `engines`): the server runs
TypeScript directly through Node's native type stripping, with no build step, and
uses `node:sqlite`.

```bash
# Server — the real application (APP_MODE=app, the default)
cd server
npm install
npm run migrate        # applies server/migrations/*.sql
npm run hash-password  # reads a password from stdin; prints a hash for OPERATOR_PASSWORD_HASH
npm run seed:demo      # runs the pipeline over the fixed demo dataset
npm run dev            # http://localhost:3200 (or PORT), restarts on change
npm run start          # the same, without watching

# Server — the demo (APP_MODE=demo): no database, no migrations, no password, no key
APP_MODE=demo npm run dev
npm test               # node --test
npm run typecheck      # tsc --noEmit
npm run lint           # oxlint

# Web
cd web
npm install
npm run dev            # Vite dev server on :5275, proxying /api to :3200
npm test               # node --test
npm run typecheck      # tsc --noEmit
npm run lint           # oxlint
npm run build          # tsc --noEmit && vite build -> web/dist
```

Notes on running the server:

- Per `server/.env.example`, it runs with **no `.env` file at all**, using a local
  SQLite file and the `mock` provider. The variables that change behavior are
  `APP_MODE` (`app` or `demo`, Section 14), `DATABASE_URL` (selects Postgres) and
  `OPERATOR_PASSWORD_HASH` (**required for anyone to sign in**; there is no
  built-in default password).
- `APP_MODE=demo` **refuses to start** if `DATABASE_URL`, `OPERATOR_PASSWORD_HASH`
  or `ANTHROPIC_API_KEY` is set, if `LLM_PROVIDER` is anything but `mock`, or if
  `SQLITE_PATH` is anything but `:memory:` — and says which, never the value. On a
  machine that has `ANTHROPIC_API_KEY` in its environment, unset it for that shell
  before starting the demo.
- To select the Anthropic provider, set `LLM_PROVIDER=anthropic` and
  `ANTHROPIC_API_KEY` (and optionally `ANTHROPIC_MODEL`, `ANTHROPIC_TIMEOUT_MS`,
  `ANTHROPIC_MAX_RETRIES`; see `.env.example`). That provider has not been
  verified against the real API, a call costs real money, and nothing in the
  dashboard or HTTP API calls it yet. Leave the default for the demo.
- Session cookies are `Secure` by default, which browsers refuse over plain HTTP.
  For `http://localhost`, set `COOKIE_SECURE=false`; the server reports this at
  every boot.
- To serve the dashboard from the API, run `npm run build` in `web/` first; the
  server serves `web/dist` from the same origin.
- To try the demo end to end: build the web app, then run
  `APP_MODE=demo npm run start` in `server/` and open `/#/demo`. It needs no
  `migrate`, no `seed:demo` and no environment beyond that. To try the application:
  `migrate`, `seed:demo` (optional), set `OPERATOR_PASSWORD_HASH`, and start it with
  no `APP_MODE`.
- Under `npm run dev` in `web/` the Vite server proxies `/api` to whichever server is
  running on `:3200`, so the page shows whichever mode that server was started in.
- No credential or secret value is included in this README or in `.env.example`.

## 11. Testing

Tests use Node's built-in runner (`node --test`) on both sides. No test calls a
paid API or needs a credential or a database server: the server's suite runs on
an in-memory SQLite database. The Anthropic provider is tested against a fake
client and a loopback stub server (the real SDK pointed at `127.0.0.1`), so no
test contacts Anthropic and none needs a key.

**Counts, as run in the verified workspace** (the portfolio checked out beside
this repository): **500 server + 189 web = 689 tests, 689 passing,
0 failing, 0 skipped.** Server `typecheck`, web `typecheck`, server `lint`,
web `lint` and web `build` all pass with no errors. (Node's runner counts each of
the helper modules in `server/test/` as one passing test, so the server figure
includes a few that are not test cases.)

What the server suite covers (`server/test/`):

- **Deterministic units** — scoring arithmetic and apportionment, matching
  verdict thresholds, ranking tiers and ordering, redaction masking, evidence
  verification, extraction schema and prompt contract.
- **Pipeline integration** — ingest, extract, match and rank against a real
  (in-memory) database, the append-only audit trail, repositories and schema
  parity with the domain enums.
- **HTTP/API** — health, sign-in, CSRF, CORS, rate limiting, and the recruiter
  endpoints.
- **Deployment modes** (`app-mode.test.ts`) — `APP_MODE` is read strictly (an invalid
  value stops the process); demo mode refuses each forbidden setting by name without
  printing a value; every recruiter and sign-in path is a 404 on the demo and every
  demo path is absent from the application, answering exactly as a path that never
  existed does; an app is refused the wrong dependencies; health reports the mode; the
  wiring is scanned so the demo's router is never given a repository; and the real
  server entry point is started as a child process in each mode (a bad mode and a
  demo with a database URL, a hash and a key both exit non-zero with a message and no
  secret value; the demo boots with no database and no file in the server's data directory).
- **Demo evidence and audit** (`demo-evidence.test.ts`) — the resume endpoint returns
  only the redacted text and no personal detail, needs the demo cookie, cannot reach
  canonical evaluations and is not a canonical route; hostile markup in a resume is
  returned inert; and the web's evidence, pipeline and timeline builders are run over
  the real pipeline's output for every demo candidate (every verified quote
  highlighted exactly, stages and times only from real events, the score's parts
  adding up, no ids or personal details in anything a visitor reads), including a
  decision appearing as the final event and reset and other visitors leaving it alone.
- **Visitor demo decisions** (`demo-decision.test.ts`) — a visitor decides in their
  own sandbox only: another visitor's candidate, the canonical database and the
  recruiter route are unchanged byte for byte; canonical ids are not found through
  the demo route and demo ids are not found through the recruiter's; missing,
  forged and operator cookies are refused; a demo session satisfies neither
  recruiter authentication nor CSRF; invalid outcomes and reasons are safe errors;
  a second or concurrent decision is a conflict, not a server error; the decision
  appears in that session's audit history and is removed by reset and by ending
  the session.
- **Visitor demo sessions** (`demo-session.test.ts`) — direct entry with no
  sign-in or key, cookie attributes, an opaque token, one visitor's state invisible
  to another, forged, malformed, duplicated and expired tokens, reset and end,
  that the retired run endpoints are gone, that no canonical row changes under any
  of it (the harness runs a demo and an application side by side), that a demo
  cookie cannot reach the recruiter decision route, that no response carries a
  credential or a real record, rate limiting, expiry and eviction.
- **Provider** — the mock provider, and the Anthropic adapter
  (`anthropic-provider.test.ts`): the forced tool call and the request it
  sends, redacted text only, malformed, missing and multiple tool calls,
  refusals, API and authentication errors, bounded retries, timeouts (including
  a real SDK timeout against a server that never answers), usage mapping,
  configuration and key handling, and that a provider failure is recorded as a
  failed evaluation rather than as empty evidence. They also check that
  evidence is still verified against the original resume and that the provider
  has no part in scoring, matching or ranking.
- **Repository hygiene** (`repo-hygiene.test.ts`) — the README's file paths and
  commands exist, the CI workflow runs real commands, and no source names another
  project's cookies or routes.

What the web suite covers (`web/test/`): **static source scans only**, not
rendered components — hook order, the wording for every value the server can
send, "no screen recomputes what the server decided", session handling, the deployment
mode (`deployment-mode.test.ts`: the mode is read strictly from health and never
guessed, each half draws only its own screens, the application has no demo link and the
demo no sign-in, nothing of the retired read-only demo is left), the demo decision form
(`demo-decision.test.ts`), the demo entry (`demo-entry.test.ts`: each deployment's
routes, where each call is sent in the demo scope, and that the browser holds no demo
token) and the first page (`demo-landing.test.ts`: its twelve topics and the plain
statement of limits, the pure call-to-action logic, that the seven stages are ones the
server has, that no wording claims live AI or a capability the system lacks, and static
accessibility and responsive conventions), the
evidence highlighter (`demo-evidence.test.ts`: bounds, overlaps, rejected and mismatched
evidence, and hostile text rendered through the real component by React's string renderer),
the pipeline and timeline builders (`demo-pipeline.test.ts`) and the structure of the new
sections (`demo-insights.test.ts`). There are no browser or end-to-end tests in the
repository: components are not rendered, with the one exception of the highlighter, which
is written without JSX precisely so it can be. The rendered layout was checked by hand in
a real browser at 375, 768 and 1366px.

**Not covered:** the PostgreSQL driver against a live server; prompt injection;
the live Anthropic API (no call has been made to it); accuracy on real resumes
(there is no evaluation dataset or metric).

### Portfolio parity (optional, needs a sibling checkout)

`server/test/demo-parity.test.ts` compares this pipeline with the demo runner in
the separate `sameer-3d-portfolio` repository, so the portfolio's browser demo
cannot drift from the real system (11 tests). The runner is located by
`server/test/portfolioFixture.ts`, in this order:

1. `PORTFOLIO_DEMO_DIR` — an explicit override, relative to this repository's root
   if not absolute. If it is set, it is authoritative: a value that does not
   contain `run.ts` **fails** the suite instead of skipping.
2. `../sameer-3d-portfolio/src/demo/p3`, relative to this repository's root — the
   two repositories checked out side by side.
3. `../../sameer-3d-portfolio/sameer-3d-portfolio/src/demo/p3` — the layout from
   when this project lived inside a monorepo.

If none of them holds `run.ts`, the 11 parity tests **skip** (reported as skipped,
not failed) and the skip message lists every place that was searched. So in a
checkout without the portfolio — including CI — the suite reports 11 skipped; the
lookup logic itself is tested (`portfolio-fixture.test.ts`) and always runs.

### Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests, in two
independent jobs on Node 24 using `npm ci`: **server** (tests, typecheck, lint) and
**web** (tests, typecheck, lint, build). It needs no secrets. The portfolio
fixture is not available on the runner, so the parity tests skip there; nothing is
faked to make them run.

## 12. Current Scope / Known Limitations

- **Extraction is a deterministic keyword mock by default.** The Anthropic
  provider exists but has never been run against the real API, its extraction
  quality has not been evaluated, and nothing but code calls it (Section 7).
- **No resume upload, no PDF or DOCX parsing, no public resume endpoint.** Resume
  input is plain text through the existing pipeline, and in practice only the
  seeded and demo datasets run.
- **No job-description parsing.** Requirements are structured input; there is no
  HTTP route that creates a job.
- **The demo uses seeded, synthetic data** and demo results are temporary
  (Section 5). A visitor's demo decision lives only in their session and is not
  saved anywhere durable. The demo has a project explanation, a short guide, the
  redacted resume with highlighted evidence, a pipeline and an audit timeline, but no
  what-if controls. Those sections exist only in a visitor's own session, not in the
  recruiter's screens.
- **No evaluation harness or accuracy metrics** exist.
- **Matching is term coverage, not comprehension.** It is deliberately crude and
  explainable, and it has not been measured against real resumes.
- **Redaction is pattern-based** and tuned for the synthetic dataset, not for
  arbitrary real resumes.
- **Single operator, in-memory rate limiting, no prompt-injection defence**
  (Section 6).
- **PostgreSQL is unverified** for this schema (Section 8).
- **No Docker or Compose configuration, and no deployment configuration** (no
  `render.yaml` or equivalent) in this repository. Section 14 describes the intended
  two-service layout; it has not been applied to any host, and nothing here
  guarantees that a public instance is running this commit or this boundary.
- **The web tests do not render components** (Section 11).

## 13. Project Status

Based on source verification: the ingest → redact → extract → verify → match →
score → rank pipeline, the recruiter-decision write path, the append-only audit
trail, session-based authentication, the two deployment modes and the visitor-scoped
demo sessions are implemented and present in source, with the test results stated
in Section 11. Extraction is a deterministic mock by default; an Anthropic provider
is implemented but unverified against the real API. The project does **not**
currently expose a resume-upload workflow, parse PDF or DOCX files, parse job
descriptions, or run a language model from any HTTP route. No claim of
"production-ready" is made.

## 14. Deployment Modes

One codebase, one built client, two deployments. `APP_MODE` (read once at startup by
`server/src/config/env.ts`, defined in `server/src/config/mode.ts`) says which.

| | `APP_MODE=app` (default) | `APP_MODE=demo` |
|---|---|---|
| What it is | The real application | The portfolio demo |
| Sign-in | Required for everything but health | None — and no sign-in route exists |
| Database | Canonical (SQLite file, or Postgres via `DATABASE_URL`); migrated before start | **None.** Each visitor's session is a private in-memory database |
| Routes | Health, sign-in, the recruiter API | Health and `/api/demo/session/*` |
| Demo routes / session store | Not registered, not built | Registered, built on demand |
| Model provider | `mock` or `anthropic` (unverified) | `mock` only |
| `/api/health` | `mode: "app"`, database reachability | `mode: "demo"`, `database: null` |
| Front end | Sign-in, then Roles and Status | Project explanation, then the interactive demo; no sign-in, no Status |

**Failing fast.** An `APP_MODE` other than `app` or `demo` stops the process with a
message naming the variable and the allowed values; it is never defaulted. In demo
mode the process also **refuses to start** — naming each variable, never printing
a value — if any of these is set:

- `DATABASE_URL`
- `OPERATOR_PASSWORD_HASH`
- `ANTHROPIC_API_KEY`
- `LLM_PROVIDER` other than `mock`
- `SQLITE_PATH` other than `:memory:`

That is deliberate: a demo service created from the real service's settings should fail
at boot, where it is seen, rather than run with a database or a key it must not have.

**Health.** `GET /api/health` is the one route both modes register and always answers
HTTP 200; the body's `status` is `degraded` when the application's database is
unreachable, so a platform health check against it is a liveness check only.

**Intended hosting layout (documentation only).** This repository contains no
`render.yaml`, and nothing below has been applied to any host. The plan is two
separate Render web services built from the same repository and commit:

- *Live application* — `APP_MODE=app`, `OPERATOR_PASSWORD_HASH` (from
  `npm run hash-password`), a database (`DATABASE_URL`, or `SQLITE_PATH` on a
  persistent disk), `TRUST_PROXY=1`, migrations applied before start
  (`npm run migrate`). Cookies stay `Secure`.
- *Live demo* — `APP_MODE=demo` and `TRUST_PROXY=1`, and **nothing else from the list
  above**: no database, no password hash, no key, no provider, no disk. Sessions are
  lost whenever the service restarts or a free instance sleeps; that is by design.
- Both: Node 24 or newer, the web app built (`npm run build` in `web/`) so the server
  can serve `web/dist` from the same origin, start with `npm run start` in `server/`,
  health check path `/api/health`. Do not share an environment group between the two
  services — the demo would (correctly) refuse to start with the application's
  variables.

