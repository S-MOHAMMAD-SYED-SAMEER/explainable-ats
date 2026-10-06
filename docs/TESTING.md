# Testing

This project makes a claim that a recruiter can check: *every score is built from quotes that really are in the CV, and the arithmetic can be redone by hand.* The tests exist to keep that claim true. Each one protects a specific way it could silently stop being true.

## The numbers

Run from a clean checkout, with the portfolio repository checked out beside this one so the parity tests run:

| Suite | `npm test` reports | Test cases | Passed | Failed | Skipped |
|---|---|---|---|---|---|
| Server (`server/test/`) | 500 | 496 | 500 | 0 | 0 |
| Web (`web/test/`) | 189 | 188 | 189 | 0 | 0 |
| **Total** | **689** | **684** | **689** | **0** | **0** |

Node's runner treats every `.ts` file under `test/` as a test file and counts a helper module that loads cleanly as one passing test. Five such modules (`fixtures.ts`, `helpers.ts`, `demoHarness.ts` and `portfolioFixture.ts` on the server, `jsxScan.ts` on the web side) are in the reported totals. The real number of test cases is 496 and 188, so 684.

Typecheck, lint and the web build also pass. There are no browser or end-to-end tests: the web tests run as plain Node, over pure modules and static scans of the source.

No test calls a paid API or needs a credential or a database server. The server suite runs on in-memory SQLite. The Anthropic adapter is tested against a fake client and against a loopback stub server (the real SDK pointed at `127.0.0.1`), so no test contacts Anthropic.

## How to run it

```bash
# Server
cd server
npm install
npm test                          # everything
node --test test/score.test.ts    # one file
npm run typecheck && npm run lint

# Web
cd web
npm install
npm test
npm run typecheck && npm run lint && npm run build
```

### The portfolio parity test

`server/test/demo-parity.test.ts` runs the real pipeline and the portfolio's browser-demo runner over the same dataset and checks that they agree: the same ranking, the same verdict, confidence and contribution for every requirement, the same masked attributes and the same audit trail. It needs the runner from the `sameer-3d-portfolio` repository. It is found in this order (`server/test/portfolioFixture.ts`):

1. `PORTFOLIO_DEMO_DIR`, an explicit override (relative to this repository's root if not absolute). If it is set it is authoritative: a value that does not contain `run.ts` fails the suite instead of skipping.
2. `../sameer-3d-portfolio/src/demo/p3`, with the two repositories side by side.
3. `../../sameer-3d-portfolio/sameer-3d-portfolio/src/demo/p3`, the old monorepo layout.

```bash
PORTFOLIO_DEMO_DIR=../sameer-3d-portfolio/src/demo/p3 npm test
```

If none of them holds `run.ts`, the 11 parity tests are reported as **skipped**, not failed, and the message lists every place searched. That is what happens in CI, where the portfolio is not checked out. The lookup logic itself (`portfolio-fixture.test.ts`, 9 tests) always runs.

## What the tests protect

Thirty-eight test files, in seven groups.

| Group | Files | Test cases |
|---|---|---|
| [Trust and safety](#trust-and-safety) | 5 | 60 |
| [Pipeline stages](#pipeline-stages) | 6 | 111 |
| [Data integrity](#data-integrity) | 4 | 53 |
| [API and auth](#api-and-auth) | 4 | 74 |
| [LLM provider behaviour](#llm-provider-behaviour) | 2 | 55 |
| [Demo and UI](#demo-and-ui) | 16 (6 server, 10 web) | 318 |
| [Repo hygiene](#repo-hygiene) | 1 | 13 |
| **Total** | **38** | **684** |

### Trust and safety

These protect the two guarantees the product is built on: nothing protected reaches the model, and nothing the model invents reaches a score.

| File | Tests | What it proves | Why it matters |
|---|---|---|---|
| `verify-evidence.test.ts` | 10 | A quote is accepted only if it is in the original text. Fabricated and near-miss quotes are rejected. A case change is rejected. A quote touching a masked span is refused. Wrong offsets are corrected, not trusted. | This is the control that makes a made-up citation impossible to show or score. |
| `redact.test.ts` | 12 | The redacted copy is exactly as long as the original. Every protected value is present before and gone after. Labels stay. Unmasked characters are identical position for position. Spans never overlap. | Equal length is what lets offsets work across both copies. |
| `extraction-schema.test.ts` | 12 | The model's tool has no way to give a verdict or a score. Malformed findings, wrong types, unknown requirement ids and impossible offsets are dropped with a reason, and good neighbours survive. | The model can only cite. Bad output fails closed rather than being coerced into evidence. |
| `extraction-prompt.test.ts` | 7 | A built prompt parses back to exactly what went in. A resume containing a section marker doesn't confuse the parser. The system prompt forbids quoting masks. | The mock reads the same prompt a real model would. If the two drifted, the mock would quietly extract nothing. |
| `extract.test.ts` | 19 | No protected attribute reaches the model, and the candidate's name is nowhere in the request. A fabricated quote is stored unverified and unreachable by anything that shows or scores. A quote from a masked region is rejected. A provider outage is a recorded failure, never an empty result. | The extraction stage's whole contract, tested through the real pipeline. |

### Pipeline stages

| File | Tests | What it proves | Why it matters |
|---|---|---|---|
| `ingest.test.ts` | 12 | A resume is stored with both copies. The quarantine records where something was, never what. The same document twice is one resume. Empty and oversized resumes are refused. A job needs requirements. | Redaction happens before anything is stored, and re-ingesting can't duplicate evidence. |
| `match-rules.test.ts` | 16 | The verdict ladder: all terms is `met`, two of three is `partial`, one of three is `not_met`. No evidence is `unclear`, never `not_met`. Unverified evidence is ignored even if handed in directly. | The core judgement, as rules that can be read. |
| `match.test.ts` | 22 | A scored evaluation records the score, the counts and one match per requirement. Unverified evidence is excluded and reported as excluded. Scoring twice, scoring an unextracted or superseded evaluation is refused. The scoring stage imports no model provider. The audit trail contains everything needed to recompute the score. | The "deterministic code judges" claim, made structural and tested. |
| `score.test.ts` | 20 | The arithmetic: everything met is 10000, nothing met is 0, one partial is halfway. Contributions sum exactly to the score. No secret cap for missed must-haves. Identical inputs give a byte-identical breakdown. | A score a recruiter can recompute. |
| `rank-rules.test.ts` | 26 | Tiers (`qualified`, `needs_review`, `gated`, `not_evaluated`), ordering, ties, competition ranks, and that the candidate's name can't move anyone. | Placement is explainable and total. |
| `rank.test.ts` | 15 | Ranking from a real database: a gated candidate sits below a weaker one who clears the gate, with the score unchanged. Superseded evaluations are ignored. Unverified evidence can't lift anyone. The ranking writes nothing. | Ranking is a pure view over what was already committed. |

### Data integrity

| File | Tests | What it proves | Why it matters |
|---|---|---|---|
| `audit.test.ts` | 11 | The audit repository exposes no way to change or remove an event (and a negative control proves the scan would catch one). Sequences start at one, are unique per correlation, and are refused by the database if duplicated. | An audit trail you can edit isn't one. |
| `repositories.test.ts` | 16 | Requirements keep their order. A zero weight and an empty span are refused. Re-evaluating supersedes rather than overwrites. A score can't be recorded without extraction first. A requirement can't be judged twice. One decision per evaluation. | The database enforces what the code must never do. |
| `driver-parity.test.ts` | 16 | JSON columns round-trip identically. The PostgreSQL driver is configured to return raw JSON text. A `Date` and a text timestamp read the same. Migrations apply once, are immutable once applied, and are no-ops the second time. | One migration set must behave the same under two drivers. |
| `schema-parity.test.ts` | 10 | Every domain enum in code matches its `CHECK` constraint in the migrations. There are ten domain tables and no ranking table. The quarantine has no column that could hold a value. Scores are integers. | A value the code can produce and the database rejects is a runtime error waiting for one input. |

### API and auth

| File | Tests | What it proves | Why it matters |
|---|---|---|---|
| `recruiter-api.test.ts` | 25 | Every recruiter route is 401 without a session and 200 with one. A decision without a CSRF token is 403 and writes nothing. Quotes sent to the browser are verbatim and verified only. Protected attributes never appear in any response. A decision needs a reason, an assessed and current evaluation, and happens once. | The write path and the privacy boundary. |
| `app.test.ts` | 15 | Health is public. A wrong password sets no cookie. Cookies carry the right attributes. A session opens the gate and CSRF still guards writes. Rate limiting is on sign-in. A cross-origin POST is refused. | The security middleware, together. |
| `app-mode.test.ts` | 28 | `APP_MODE` is read strictly. Demo mode refuses each forbidden setting by name and never prints a value. In demo mode no recruiter route exists; in app mode no demo route exists. The real server entry point is booted in each mode as a child process. | The two-product boundary. |
| `cookies.test.ts` | 6 | Cookies are named for this application and nothing else is issued. | Stops residue from another project's cookie names. |

### LLM provider behaviour

| File | Tests | What it proves | Why it matters |
|---|---|---|---|
| `llm-mock.test.ts` | 9 | The mock replays exactly what was registered and raises on anything unregistered. Asking for Anthropic without a key fails loudly instead of falling back to the mock. | A mock that invents answers hides bugs. |
| `anthropic-provider.test.ts` | 46 | The request forces the tool. Exactly one well-formed tool call is accepted; refusals, truncation, extra or misnamed tool calls and malformed payloads are failures. Client errors are never retried; transient ones are, boundedly. Timeouts are enforced, including a real SDK timeout against a server that never answers. Only redacted text is sent. The key is never exposed. | The adapter has never touched the real API, so it is tested hard against everything that can be simulated. |

### Demo and UI

| File | Tests | What it proves | Why it matters |
|---|---|---|---|
| `demo-session.test.ts` (server) | 41 | A visitor enters with no sign-in. The `ats_demo` cookie is `HttpOnly` and `SameSite=Strict`. One visitor's state is invisible to another. Forged, malformed and expired tokens reach nothing. Rate limiting, expiry and eviction work. | The public demo can't reach anything real. |
| `demo-decision.test.ts` (server) | 31 | A visitor's decision lands in their own sandbox only. The canonical database is byte-for-byte unchanged. A demo session satisfies neither recruiter auth nor CSRF. Two simultaneous decisions record exactly one. | The one anonymous write is safely contained. |
| `demo-evidence.test.ts` (server) | 21 | The resume endpoint returns only the redacted text. Hostile markup is returned as inert text. Every verified quote is highlighted exactly. Timeline arithmetic adds up to the real score. | What a visitor reads is the real pipeline's output. |
| `demo-dataset.test.ts` | 17 | The synthetic dataset really produces the outcomes it declares: every candidate lands in the declared tier, with the declared verdicts. Seeding twice gives byte-identical rankings. | The demo's story is derived, not asserted. |
| `demo-parity.test.ts` | 11 | The portfolio's browser demo gives the same ranking, verdicts, contributions and audit trail as the real pipeline. Needs the sibling checkout. | The portfolio demo can't drift from the system it describes. |
| `portfolio-fixture.test.ts` | 9 | The lookup for the parity runner. | A misconfigured override fails loudly, not silently. |
| `demo-landing`, `demo-entry`, `demo-session`, `demo-decision`, `demo-evidence`, `demo-insights`, `demo-pipeline` (web) | 150 | The demo's first page, entry, session state, decision form, evidence highlighter, pipeline and timeline builders: wording, routes, accessibility conventions, hostile input, and that no wording claims a live model. | The demo says only what is true of it. |
| `recruiter-ui`, `deployment-mode`, `hook-order` (web) | 38 | Every verdict, outcome and tier has recruiter wording. No screen computes a score or re-sorts the ranking. The mode is read from the server and never guessed. No component calls a hook after an early return. | The browser shows what the server decided and nothing else. |

### Repo hygiene

| File | Tests | What it proves | Why it matters |
|---|---|---|---|
| `repo-hygiene.test.ts` | 13 | Every file the README names exists. Every `npm run` command in it is a real script. It doesn't repeat claims that were once true. It states the things that are true now. The CI workflow runs real commands and needs no secrets. No source names another project's cookies or routes. | Documentation fails when it describes something that isn't there. |

## Eight tests explained

### 1. A fabricated quote is rejected

`verify-evidence.test.ts`, *"a fabricated quote is rejected"*.

- **Scenario.** The model returns a well-written sentence that is nowhere in the CV.
- **Input.** The finding quotes *"Led a team of twelve engineers across three continents."*. The test first asserts the fixture CV does not contain it.
- **Expected.** Nothing is verified, and the rejection reason is `not_found_in_resume`.
- **Bug it catches.** A verifier that matches loosely or trusts the model. A hallucinated claim would then reach the recruiter attributed to the candidate. A companion test (*"a quote that is almost right is still rejected"*) uses a near-miss, "billing service" for "settlement service", because that is the shape a real hallucination takes.

### 2. A quote overlapping a redacted span

`verify-evidence.test.ts`, *"a quote overlapping a masked attribute is refused even though it is genuinely in the resume"*, and `extract.test.ts`, *"a quote lifted from a masked region is rejected, not laundered back in"*.

- **Scenario.** The model quotes the candidate's email address. The email really is in the original CV, but the model was never shown it, because redaction masked it.
- **Input.** A finding whose quote is `priya.raman@example.com`, at the email's real offset.
- **Expected.** Rejected with reason `quotes_redacted_text`. As a negative control, the same finding with no redaction spans declared *does* verify, so the rejection is caused by the mask and not by the text.
- **Bug it catches.** A verifier that only asks "is it in the document?". A quote the model could not have seen means it guessed or a protected detail leaked, and either way it must not become evidence.

### 3. Contributions sum exactly to the total

`score.test.ts`, *"the contributions sum to exactly the score, even when the division is not clean"* and *"contributions always sum to the score across many shapes"*.

- **Scenario.** Three requirements of equal weight with verdicts `met`, `partial` and `not_met`.
- **Input.** The score is `(10000 + 5000 + 0) / 3 = 5000`. The raw shares are 3333.33, 1666.67 and 0.
- **Expected.** Score 5000, contributions `[3333, 1667, 0]`, summing to 5000. A second test gives three equal `met` requirements and expects `[3334, 3333, 3333]`: the one leftover basis point goes to the first requirement, every time. A sweep over weights and verdict combinations checks the identity for all of them.
- **Bug it catches.** Plain flooring, which would show a column that comes up one point short of the headline. The one thing a reader checks is whether it adds up.

### 4. Silence (`unclear`) and shortfall (`not_met`) rank differently

`rank-rules.test.ts`, *"a must-have the evidence did not demonstrate is gated"* and *"a must-have the resume never addressed needs review, not gating"*.

- **Scenario.** Two candidates each meet one of two must-haves. For the other, one has a quote that falls short; the other has no quote at all.
- **Input.** Verdicts `[met, not_met]` against `[met, unclear]` for the PostgreSQL requirement.
- **Expected.** The first is `gated` with `failedMustHaves = ['PostgreSQL']`; the second is `needs_review` with `unclearMustHaves = ['PostgreSQL']`, and a different sentence on screen. `recruiter-api.test.ts` checks that "does not meet" and "not demonstrated" are two different answers on the wire.
- **Bug it catches.** Collapsing "the CV says nothing" into "the CV says no". That is how a good candidate is filtered out for a gap in the reading rather than a gap in their experience.

### 5. The gate moves placement and leaves the score alone

`rank-rules.test.ts`, *"a failed must-have ranks below a lower-scoring candidate who meets them all"* and *"the gate moves the placement and leaves the stored score untouched"*.

- **Scenario.** A candidate scores 9500 but meets only 1 of 2 must-haves; another scores 3000 and meets both.
- **Expected.** The order is the 3000 candidate first, then the 9500 one. The 9500 candidate's reported score is still exactly 9500, their rank is 2, and the rationale says *"the score itself is unchanged"*.
- **Bug it catches.** A ranking that edits the score to explain its order, so two screens show two different numbers. The demo dataset shows the same thing live: Devi and Marcus both score 71%, and only Devi clears the gate.

### 6. An anonymous write is refused

`recruiter-api.test.ts`, *"every recruiter endpoint is behind the session gate"* and *"a decision without a CSRF token is refused"*.

- **Scenario.** Someone calls the recruiter API with no session, and a signed-in client posts a decision without the CSRF token.
- **Input.** Five read paths with no cookie. Then `POST /api/evaluations/:id/decision` with a valid session but `x-csrf-token` left out.
- **Expected.** Every read path answers 401 anonymously and 200 with a session (the positive control, so the 401s come from the gate and not a missing route). The decision without the token answers 403, and the decision count is still zero.
- **Bug it catches.** A route added later that forgets its check. Auth is enforced by position (everything after `requireSession`), and this test lists the routes. Related tests in `demo-decision.test.ts` check that a demo cookie satisfies neither the recruiter's auth nor its CSRF check.

### 7. SQLite and PostgreSQL behave the same

`driver-parity.test.ts`: *"every JSON shape survives the round trip a column takes"*, *"the PostgreSQL driver asks pg for raw JSON text"*, *"a migration is immutable once applied"* and *"migrating twice changes nothing"*; and `schema-parity.test.ts`: *"every domain enum matches its CHECK constraint"*.

- **Scenario.** Every automated test runs on SQLite, but the application is meant to run on PostgreSQL too, and the two drivers disagree about how a JSON column comes back (`node:sqlite` returns text, `pg` returns a parsed value).
- **Input.** JSON values of every shape, including scalars (`24`, `false`, `'senior'`); the source of the PostgreSQL driver; the migration table; the enums in code and in the SQL.
- **Expected.** All shapes survive the round trip. The driver registers raw-text parsers for `JSON` and `JSONB`. Applied migrations match their on-disk checksums and a second run applies nothing. Every enum in `domain/ats.ts` equals its `CHECK` list.
- **Bug it catches.** A value that works on SQLite and fails only on PostgreSQL, a mistake that is easy to make and only shows up in a deployment. **This test does not run PostgreSQL.** It pins the contract from the SQLite side and checks that the PostgreSQL driver is configured to honour it. I ran the PostgreSQL path by hand (migrate twice, seed, sign in, rank, decide); there is no automated test for it.

### 8. A provider outage is not an empty result

`extract.test.ts`, *"a provider outage is recorded as a failure, never as an empty result"*.

- **Scenario.** The extraction provider is unreachable.
- **Input.** The mock is told to fail the `extract_evidence` call with `"connection reset"`.
- **Expected.** The call raises an error containing "could not be reached". The evaluation is `failed`, zero evidence rows exist, and an `extraction_failed` audit event with outcome `failed` is recorded. The provider's own message, `connection reset`, appears nowhere in the audit trail.
- **Bug it catches.** Treating "the model could not be reached" as "the model found nothing", which would score the candidate zero for an outage. It also catches a provider error message (which can carry a hostname or a key fragment) leaking into a recruiter-facing trail.

## What isn't tested yet

- **Extraction quality.** There is no labelled set of CVs with the passages a good extractor should find, so nothing measures recall or precision. The mock extractor is a keyword matcher, so the pipeline's *mechanics* are tested, not the *accuracy* of a real model.
- **The live Anthropic API.** No call to it has been made. The adapter is tested against a fake client and a local stub server only. `server/scripts/live-smoke-anthropic.ts` is an opt-in script that makes one real request, but it sits outside `test/`, never runs in CI, and I have not run it. Whether the configured model accepts a forced tool call is unconfirmed.
- **PostgreSQL in CI.** The PostgreSQL path has no automated test.
- **Real CVs.** Everything runs on five invented candidates. Redaction is pattern-based and has not been run against real resumes.
- **Prompt injection.** No test feeds a CV containing instructions to a model. The verifier limits the damage (a model can only cite text that really is in the CV, and it cannot score), but the prompt layer has no defence and no tests.
- **Rendered components.** The web tests don't render components, with one exception: the evidence highlighter, which is written without JSX so React's string renderer can run it. There are no browser tests.

What I'd add first is an evaluation set: a few dozen redacted CVs with hand-marked passages per requirement, scored on how many true passages the extractor finds. A missed passage becomes `unclear`, not `not_met`, so recall is the number that matters most.
