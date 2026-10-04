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
| Anthropic / Claude provider | **Implemented, not yet verified against the real API.** `LLM_PROVIDER=anthropic` builds an adapter that forces a `record_evidence` tool call, with a timeout and bounded retries. It is tested against a fake client and a local stub server only: **no call to the live Anthropic API has been made**, whether the configured model accepts the request as built is unconfirmed, and **extraction quality has not been evaluated**. The public demo always uses the mock. |
| Resume input | **Plain text only**, through the existing pipeline. There is no upload endpoint and no PDF or DOCX parsing. |
| Job requirements | **Structured and typed** (label, criterion, must-have or nice-to-have, weight). They are not extracted from a free-text job description. |
| Public demo | Two layers. A **visitor-scoped demo session** (`/#/demo`, no sign-in): each visitor gets a private, in-memory copy of the five invented candidates, scored by the real deterministic pipeline, that no other visitor can see. And the older read-only dashboard over the canonical seeded data, plus a **demo-run endpoint** that runs one candidate in a shared, temporary, isolated in-memory sandbox. A visitor can record a demo decision in their own session only. See Sections 5 and 6. |
| Evaluation harness / accuracy metrics | **None.** |
| Docker / deployment configuration | **None** in this repository. CI exists (Section 11). |

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

**The current demo experience** is a dashboard over a fixed dataset. A visitor
can open `/#/demo` with no sign-in and get a private copy of it, browse a job, its
ranked candidates, and the full evidence and audit trail behind any evaluation,
run one of five fixed demo candidates to see a temporary result, and record a
**demo decision** that is saved only to their own private session. A signed-in
operator can additionally record a real recruiter decision. **There is no HTTP endpoint that
accepts an uploaded or pasted resume.** The pipeline runs on the seeded dataset
(`npm run seed:demo`) and on the five fixed demo scenarios, never on a visitor's
own document. See Section 5.

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

- The demo runs against a **fixed, synthetic dataset**
  (`server/src/demo/dataset.ts::DEMO_JOB`, `DEMO_CANDIDATES`: one job, five
  invented candidates), not arbitrary user-submitted resumes.
- The demo's extraction stage uses the **deterministic mock provider**
  (`adapters/llm/mock.ts`) together with a deterministic extractor responder
  (`agent/mockExtractor.ts`) that is a pure function of the prompt it is given
  — the same input always produces the same output, with `latencyMs: 0` and no
  network call. **No language model is involved anywhere in the demo.**
- The demo runs **without any API key**: `LLM_PROVIDER=mock` is the default and
  nothing in the demo path reads `ANTHROPIC_API_KEY`.
- **The canonical data is seeded by a script**, run once by an operator:

  ```
  npm run seed:demo
  ```

  This calls `ingestResume` → `openEvaluation`/`extractEvidence` →
  `matchAndScore` for each demo candidate (`server/src/demo/seed.ts`) — the
  same functions a live evaluation would use — rather than inserting
  pre-computed rows directly into the database. The seeded evaluations are the
  ones the ranking shows, and the ones a recruiter can decide on.
- **The demo-run endpoint** is `POST /api/demo/scenarios/:scenario/run`, where
  `:scenario` is one of `demo-001` … `demo-005` (a literal allow-list in
  `demo/runScenario.ts`). It accepts no body.
  - It runs the same pipeline functions on that one fixed candidate, but inside
    an **isolated, in-memory SQLite sandbox** (`demo/sandbox.ts`): same
    migrations, same fixed demo job, a fixed clock and ids derived from the
    scenario name. **It does not write to the canonical database** and so cannot
    create, supersede or displace a canonical evaluation or a recruiter's
    decision.
  - It returns `201 {"evaluationId": "..."}`. That id is readable through the
    existing `GET /api/evaluations/:id` and `/audit` routes, subject to the same
    access rules as any evaluation (Section 6). It cannot be decided on: the
    decision route looks ids up in the canonical database, where a sandbox id
    does not exist.
  - **Sandbox results are ephemeral.** They live in server memory only. A restart
    — including a free-tier host going to sleep — discards them, and a link to a
    result then returns "not found" until the scenario is run again.
  - **It is deterministic and bounded.** Each scenario is run once per process
    and then reused: a repeat run returns the same evaluation instead of stacking
    another. There are at most five sandboxed evaluations, however many requests
    arrive.
  - It is available whenever the database contains the demo job (the endpoint
    looks it up, read-only, and answers "not available" if it is missing). It is
    **not** controlled by `DEMO_PUBLIC_READONLY`.
- **The visitor-scoped demo session** (`demo/sessions.ts`, `routes/demoSession.ts`)
  is the public entry. A visitor opens `/#/demo`, with no sign-in, and meets a
  landing screen ("Interactive ATS Demo") that says what the product does, what
  can be explored, that the data is synthetic and private, that no key or AI
  service is needed, and walks through the seven stages a CV goes through. Nothing
  starts until they press **Start Demo**, which starts a session — or resumes the
  one the browser already holds ("Resume demo", with an explicit "Start over").
  No AI provider, key or network call is involved.
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
    **timeline** replaces the history list in a visitor's session — one item per
    event, in recorded order, with the arithmetic behind the score and the evidence
    verification behind an expander and the demo decision as its final event.
    Pipeline events carry the demo's fixed clock; a decision carries the real time.
  - **The demo's wording** is one pure module (`web/src/demo/copy.ts`), so every
    sentence is testable. It claims no model and names no vendor: the keyword
    matcher that picks passages is described as one, the history says
    "Deterministic demo extraction (no AI model)" for it, and a real model is still
    labelled as one. Inside the demo, the first screen is an overview (role,
    requirements with kind and weight, candidate count, what each ranking label
    means) built from the visitor's own session data, and a "How this demo works"
    panel in the header lists the path through a candidate and what Reset and Exit
    do.
  - **What a session is.** A private in-memory SQLite database, built by the same
    `seedDemoData` the canonical seeder runs (ingest, redact, extract, verify,
    match, score) over the same fixed dataset, with the deterministic stand-in for
    the model. A fixed clock and sequential ids make every session start
    byte-identical. It does not read, copy or depend on the canonical database,
    and the canonical repositories are never passed to it, so a session works even
    on a deployment where `npm run seed:demo` was never run.
  - **How it is named.** An opaque random token (32 bytes, base64url) in an
    `ats_demo` cookie: `HttpOnly`, `SameSite=Strict`, `Secure` unless
    `COOKIE_SECURE=false`. It carries no identity and nothing decodable, is never
    in a response body or a URL, and is stored server-side only as its SHA-256. The
    cookie is not an operator session: `req.session` and `req.operator` stay
    unset, and each cookie is looked up only in its own store.
  - **Routes** (all anonymous, all under `/api/demo/session`): `POST` start or
    resume, `GET` status (never an error), `POST /reset`, `DELETE` end, the
    dashboard's reads (`/jobs`, `/jobs/:id`, `/jobs/:id/ranking`,
    `/evaluations/:id`, `/evaluations/:id/audit`, `/evaluations/:id/resume`) and
    `POST /scenarios/:scenario/run` and `POST /evaluations/:id/decision`. These are
    served from the visitor's own database; they are **not** on the
    `PUBLIC_DEMO_READS` allow-list, which is unchanged.
  - **A visitor's decision** (`POST /api/demo/session/evaluations/:id/decision`)
    is a separate route from the recruiter's and shares nothing with it but the
    handler logic. It needs the `ats_demo` cookie and nothing else (a token in a
    URL, header or body is never read), looks the evaluation up **only in the
    caller's own database** (a canonical id is "not found"), and records it as the
    fixed actor `demo-visitor`, which the request cannot override. It reuses the
    recruiter's `handleDecision`, so the outcomes (`shortlist`, `reject`, `hold`),
    the reason rule (at least 10 characters), the one-decision-per-assessment rule
    and the audit event (`decision_recorded`) are the same code, not a copy; the
    validation errors are the one difference — they say what was wrong without
    quoting what was sent. A decision is stamped with the real time (the seeded
    data stays on its fixed clock), appears in that session's history, and is
    removed by Reset. It never touches the canonical database.
  - **Reset** rebuilds only the caller's own database from the fixed dataset. It
    takes no body and no target: the session is whichever the cookie names.
  - **Bounded and ephemeral.** A session lapses after two hours without use (use
    slides the window), at most 100 exist (the least recently used is evicted), and
    a restart discards them all. Starting one is the most expensive anonymous
    request, so it has its own rate-limit class (`demoSession`, 10 per minute).
  - **Survives a reload** because the browser keeps the cookie and the app asks the
    server at startup; nothing is kept in localStorage or the URL. Because every
    session starts identical, its ids are identical: an id is only meaningful
    inside the session whose cookie accompanies it.
- **A visitor's run does not appear in the ranking.** The ranking, and every
  number on the job page, is the canonical seeded data and is unaffected.
- The web dashboard says so next to the "Run demo" button: demo results are
  temporary and do not change the recruiter's saved evaluations.
- **There is no public endpoint that accepts a resume.** The demo-run endpoint
  takes a scenario name from a fixed list and nothing else.

## 6. Public Demo Safety

Documented from source (`server/src/auth/middleware.ts`, `server/src/app.ts`,
`server/src/config/env.ts`, `server/src/http/rateLimit.ts`):

- **Anonymous read-only access** is gated behind `DEMO_PUBLIC_READONLY`
  (default `false`). Off means every route except health, the auth routes
  (sign-in, sign-out, session) and the demo-run endpoint requires a session.
- **Public-demo read allow-list**: a literal, anchored list of five GET patterns
  (`PUBLIC_DEMO_READS`) — `/jobs`, `/jobs/:id`, `/jobs/:id/ranking`,
  `/evaluations/:id`, `/evaluations/:id/audit`. Matched on method and full
  path; nothing outside this list is reachable anonymously, even when the flag
  is on. Sandbox results are read through the same two evaluation routes and so
  are only as readable as any other evaluation: anonymously only while the flag
  is on, otherwise only with a session.
- **The anonymous writes are the demo's, and only those**: the shared-sandbox
  demo-run endpoint and the visitor session's start, reset, end, scenario run and
  demo decision
  (Section 5). None writes to the canonical database; each takes no body, accepts
  only five fixed scenario names, issues no session and no cookie, and has its
  own rate-limit class (10 per minute). **Every other write requires a real
  authenticated session**, and the one that matters — recording a recruiter
  decision — also requires a CSRF token.
- **Recruiter decisions are protected.** `POST /evaluations/:id/decision` needs a
  session and a CSRF token, takes the decider from the session rather than a
  header, and can only target a canonical, scored, non-superseded evaluation.
  Anonymous demo runs cannot change that state (see `test/demo-isolation.test.ts`).
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
- **Synthetic data only**: the allow-listed reads expose only what
  `npm run seed:demo` populated, and the sandbox only ever holds the five fixed
  demo scenarios.
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
    and the public demo and the seed script build their own mock provider
    whatever `LLM_PROVIDER` is set to.
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
- The demo sandbox (Section 5) is a separate in-memory SQLite database that
  exists only inside the server process, whichever driver the canonical
  database uses.

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
- A demo-run (sandbox) evaluation id is not found by this route, so it cannot be
  decided on. A visitor's session ids are not found here either; a visitor decides
  through the demo's own route (Section 5), which this route never serves.

## 10. Running Locally

Requires **Node 24 or newer** (`server/package.json` `engines`): the server runs
TypeScript directly through Node's native type stripping, with no build step, and
uses `node:sqlite`.

```bash
# Server
cd server
npm install
npm run migrate        # applies server/migrations/*.sql
npm run hash-password  # reads a password from stdin; prints a hash for OPERATOR_PASSWORD_HASH
npm run seed:demo      # runs the pipeline over the fixed demo dataset
npm run dev            # http://localhost:3200 (or PORT), restarts on change
npm run start          # the same, without watching
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
  `DATABASE_URL` (selects Postgres), `OPERATOR_PASSWORD_HASH` (**required for
  anyone to sign in**; there is no built-in default password) and
  `DEMO_PUBLIC_READONLY=true` (opens the anonymous read window, Section 6).
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
- To try the demo end to end: `migrate`, `seed:demo`, then start the server with
  `DEMO_PUBLIC_READONLY=true`.
- No credential or secret value is included in this README or in `.env.example`.

## 11. Testing

Tests use Node's built-in runner (`node --test`) on both sides. No test calls a
paid API or needs a credential or a database server: the server's suite runs on
an in-memory SQLite database. The Anthropic provider is tested against a fake
client and a loopback stub server (the real SDK pointed at `127.0.0.1`), so no
test contacts Anthropic and none needs a key.

**Counts, as run in the verified workspace** (the portfolio checked out beside
this repository): **423 server + 56 web = 479 tests,
479 passing, 0 failing, 0 skipped.** Server `typecheck`, web
`typecheck`, server `lint`, web `lint` and web `build` all pass with no errors.
(Node's runner counts each of the three helper modules in `server/test/` as one
passing test, so the server figure includes 3 that are not test cases; there are
420 `test(...)` cases on the server.)

What the server suite covers (`server/test/`):

- **Deterministic units** — scoring arithmetic and apportionment, matching
  verdict thresholds, ranking tiers and ordering, redaction masking, evidence
  verification, extraction schema and prompt contract.
- **Pipeline integration** — ingest, extract, match and rank against a real
  (in-memory) database, the append-only audit trail, repositories and schema
  parity with the domain enums.
- **HTTP/API** — health, sign-in, CSRF, CORS, rate limiting, the public read
  allow-list, the recruiter endpoints, and the demo-run endpoint.
- **Demo isolation** (`demo-isolation.test.ts`) — a public run cannot supersede a
  canonical evaluation or displace a recruiter decision, adds no persistent
  rows, and the decision route stays protected by session and CSRF.
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
  that no canonical row changes under any of it, that a demo cookie cannot reach
  the recruiter decision route, that no response carries a credential or a real
  record, rate limiting, expiry and eviction, and that building a session makes no
  network call.
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
send, "no screen recomputes what the server decided", the demo runner (including
its temporary-results note), session handling, the demo decision form (`demo-decision.test.ts`), the demo entry
(`demo-entry.test.ts`: the `/#/demo` route, where each call is sent in the demo scope,
and that the browser holds no demo token) and the landing (`demo-landing.test.ts`: its
content, the pure Start/Resume logic, that the seven stages are ones the server has, that
no wording claims live AI, and static accessibility and responsive conventions), the
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
  saved anywhere durable. The demo has a landing, a short guide, the redacted resume
  with highlighted evidence, a pipeline and an audit timeline, but no what-if controls.
  Those sections exist only in a visitor's own session, not in the recruiter's screens
  or the read-only window.
- **No evaluation harness or accuracy metrics** exist.
- **Matching is term coverage, not comprehension.** It is deliberately crude and
  explainable, and it has not been measured against real resumes.
- **Redaction is pattern-based** and tuned for the synthetic dataset, not for
  arbitrary real resumes.
- **Single operator, in-memory rate limiting, no prompt-injection defence**
  (Section 6).
- **PostgreSQL is unverified** for this schema (Section 8).
- **No Docker or Compose configuration, and no deployment configuration** (no
  `render.yaml` or equivalent) in this repository. A public instance may be
  deployed separately; nothing here guarantees it is running this commit.
- **The web tests do not render components** (Section 11).

## 13. Project Status

Based on source verification: the ingest → redact → extract → verify → match →
score → rank pipeline, the recruiter-decision write path, the append-only audit
trail, session-based authentication, the credential-free public read window and
the isolated demo-run sandbox are implemented and present in source, with the
test results stated in Section 11. Extraction is a deterministic mock by default;
an Anthropic provider is implemented but unverified against the real API. The
project does **not** currently expose a resume-upload workflow, parse PDF or DOCX
files, parse job descriptions, or run a language model from any HTTP route. No
claim of "production-ready" is made.
