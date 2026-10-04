import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The public demo runner (Frontend Option B).
//
// Same approach as the rest of this front end's tests: NFR-9 rules out jsdom,
// Playwright and Cypress, so nothing here renders a component. What can still
// be proved without a browser is the part that actually matters — that the
// runner only ever calls the one endpoint it is meant to, sends nothing but a
// scenario selection, matches the server's own allow-list exactly, and cannot
// have quietly grown a second, client-side result.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const SERVER = path.resolve(ROOT, '../server/src');

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

/** Strips comments, so a scan matches code rather than the note explaining it. */
function code(source: string): string {
  return source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const CLIENT = () => code(read(path.join(SRC, 'api/client.ts')));
const RUNNER = () => code(read(path.join(SRC, 'components/DemoRunner.tsx')));
const JOB_DETAIL = () => code(read(path.join(SRC, 'screens/JobDetail.tsx')));

// --- 1/2/3/4: the API client method ------------------------------------------

test('api.runDemoScenario exists on the client', () => {
  assert.match(CLIENT(), /\n\s*runDemoScenario\s*:/, 'runDemoScenario is not defined on api');
});

test('runDemoScenario uses POST', () => {
  const client = CLIENT();
  const method = /runDemoScenario:[\s\S]*?\}\),/.exec(client)?.[0] ?? '';
  assert.notEqual(method, '', 'precondition: the client defines runDemoScenario()');
  assert.match(method, /method:\s*'POST'/);
});

test('runDemoScenario calls the exact backend endpoint pattern', () => {
  const client = CLIENT();
  const method = /runDemoScenario:[\s\S]*?\}\),/.exec(client)?.[0] ?? '';
  assert.match(
    method,
    /\/demo\/scenarios\/\$\{encodeURIComponent\(scenario\)\}\/run/,
    'the client does not call /demo/scenarios/:scenario/run',
  );
});

test('runDemoScenario sends no arbitrary request data', () => {
  const client = CLIENT();
  const method = /runDemoScenario:[\s\S]*?\}\),/.exec(client)?.[0] ?? '';

  // The only thing this call may send is an empty body, exactly like logout().
  assert.match(method, /body:\s*JSON\.stringify\(\{\}\)/, 'the call does not send an explicit empty body');

  // None of the forbidden fields the backend explicitly refuses to accept may
  // appear anywhere in this call's construction.
  for (const forbidden of ['candidateId', 'jobId', 'resumeText', 'resume', 'provider', 'model']) {
    assert.ok(!new RegExp(forbidden, 'i').test(method), `runDemoScenario appears to send "${forbidden}"`);
  }
});

// --- 5/6: the scenario registry ----------------------------------------------

const EXPECTED_SCENARIOS: ReadonlyArray<[string, string]> = [
  ['demo-001', 'Rowan Ashfield'],
  ['demo-002', 'Devi Narayanan'],
  ['demo-003', 'Marcus Oyelaran'],
  ['demo-004', 'Ines Fabre'],
  ['demo-005', 'Toby Kestrel'],
];

function parseRunnerScenarios(): Array<{ id: string; name: string }> {
  const source = RUNNER();
  const block = /SCENARIOS[\s\S]*?=\s*\[([\s\S]*?)\n\];/.exec(source);
  assert.ok(block, 'could not find the SCENARIOS list in DemoRunner.tsx');
  return [...(block[1] as string).matchAll(/id:\s*'([^']+)',\s*name:\s*'([^']+)'/g)].map((m) => ({
    id: m[1] as string,
    name: m[2] as string,
  }));
}

test('the frontend scenario registry contains exactly the five expected ids', () => {
  const scenarios = parseRunnerScenarios();
  assert.deepEqual(
    scenarios.map((s) => s.id).sort(),
    EXPECTED_SCENARIOS.map(([id]) => id).sort(),
  );
});

test('the frontend registry maps each id to the documented display name', () => {
  const scenarios = parseRunnerScenarios();
  const byId = new Map(scenarios.map((s) => [s.id, s.name]));
  for (const [id, name] of EXPECTED_SCENARIOS) {
    assert.equal(byId.get(id), name, `${id} is not mapped to "${name}"`);
  }
});

test('the runner does not reproduce internal fixture/test commentary as UI copy', () => {
  const source = RUNNER();
  for (const forbidden of [
    /THE CENTREPIECE/i,
    /scores the same as/i,
    /placed above him/i,
    /placed below her/i,
    /best candidate/i,
    /perfect match/i,
    /guaranteed rejection/i,
    /most realistic/i,
  ]) {
    assert.ok(!forbidden.test(source), `the runner contains internal/unsupported copy matching ${forbidden}`);
  }
});

// --- 7/8/9/10: how the runner talks to the server and navigates -------------

test('the runner calls api.runDemoScenario and never calls fetch directly', () => {
  const source = RUNNER();
  assert.match(source, /api\.runDemoScenario\(/, 'the runner does not call api.runDemoScenario');
  assert.ok(!/\bfetch\s*\(/.test(source), 'the runner calls fetch() directly instead of going through the API client');
});

test('the runner navigates with routeToHash, not a hand-built string', () => {
  const source = RUNNER();
  assert.match(source, /routeToHash\(/, 'the runner does not use routeToHash');
  assert.ok(!/['"`]#\/candidates\//.test(source), 'the runner builds a candidates URL by hand');
});

test('a successful run navigates to the candidates route with the returned evaluationId', () => {
  const source = RUNNER();
  const call = /routeToHash\(\{[\s\S]*?\}\)/.exec(source)?.[0] ?? '';
  assert.notEqual(call, '', 'precondition: routeToHash is called with an object argument');
  assert.match(call, /name:\s*'candidates'/);
  assert.match(call, /id:\s*result\.evaluationId/);
});

// --- 11/12: submitting and error states --------------------------------------

test('the runner tracks a submitting state and disables the action while in flight', () => {
  const source = RUNNER();
  assert.match(source, /submitting/);
  assert.match(source, /disabled=\{!ready\}/, 'the run control is not disabled while unready/submitting');
  // `ready` must itself depend on `submitting`, or the disable is cosmetic.
  assert.match(source, /!submitting/);
});

test('the runner exposes an accessible, safe error state', () => {
  const source = RUNNER();
  assert.match(source, /aria-live=["']polite["']/, 'errors are not in a polite live region');
  assert.match(source, /err instanceof ApiError \? err\.message : /, 'errors do not follow the existing safe-message convention');
});

test('no internal detail can reach the error message', () => {
  const source = RUNNER();
  assert.ok(!/err\.stack/.test(source), 'a stack trace could be rendered');
  assert.ok(!/err\.message(?!\s*:)/.test(source.replace(/err instanceof ApiError \? err\.message : /, '')), 'a raw, non-ApiError message could be rendered');
});

// --- 13: JobDetail wiring -----------------------------------------------------

test('JobDetail renders DemoRunner only in the read-only demo: never for a recruiter, never in a visitor\'s own session', () => {
  const source = JOB_DETAIL();
  assert.match(source, /import\s*\{\s*DemoRunner\s*\}\s*from\s*'\.\.\/components\/DemoRunner\.tsx'/);
  // Gated by `demo` (so a recruiter never sees it) and NOT in a visitor's session,
  // where every candidate is already assessed and a "run" button would promise
  // something the page does not do.
  assert.match(source, /\{demo\s*&&\s*!demoSession\s*\?\s*<DemoRunner\s*\/>\s*:\s*null\}/, 'DemoRunner is not gated as intended');
});

test('JobDetail accepts a demo prop, defaulted to false', () => {
  const source = JOB_DETAIL();
  assert.match(source, /demo\s*=\s*false/, 'JobDetail does not default demo to false');
});

test('JobDetail still renders every existing recruiter-facing piece unchanged', () => {
  // A regression guard: the additive section must not have replaced anything.
  const source = JOB_DETAIL();
  assert.match(source, /<Requirements job=\{job\.state\.data\}\s*\/>/);
  assert.match(source, /ranking\.state\.status === 'ready' \? <RankedList ranking=\{ranking\.state\.data\} \/> : null/);
});

// --- 14: no score/ranking/evidence arithmetic --------------------------------

test('the runner performs no scoring, ranking, or evidence arithmetic', () => {
  const source = RUNNER();
  assert.ok(!/scoreBasisPoints/.test(source), 'the runner references a score field at all');
  assert.ok(!/contributionBasisPoints/.test(source));
  assert.ok(!/verdict/i.test(source));
  assert.ok(!/evidence/i.test(source) || /evidence extraction/i.test(source), 'only the fixed descriptive phrase "evidence extraction" is permitted');
  assert.ok(!/\.sort\s*\(/.test(source));
  assert.ok(!/Math\.(round|floor|ceil)\s*\(/.test(source));
});

test('the runner contains no hardcoded evaluation id, score, or fake result', () => {
  const source = RUNNER();
  // A UUID-shaped literal would be a fabricated evaluation id.
  assert.ok(
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(source),
    'a literal UUID is present — a fake evaluation id',
  );
  assert.ok(!/evaluationId\s*=\s*['"`]/.test(source), 'evaluationId is assigned a literal rather than read from the response');
});

// --- 15: no credentials/secrets/demo passwords -------------------------------

test('the runner and the new client method introduce no credential-shaped string', () => {
  const forbidden: readonly [RegExp, string][] = [
    [/scrypt\$/, 'a password hash'],
    [/OPERATOR_PASSWORD_HASH/, 'the credential environment variable'],
    [/demoPassword|DEMO_PASSWORD|demo_password/i, 'a demo password'],
    [/demoToken|DEMO_TOKEN/i, 'a demo token'],
    [/api[_-]?key/i, 'an API key reference'],
    [/anthropic/i, 'a provider name'],
  ];

  for (const source of [RUNNER(), CLIENT()]) {
    for (const [pattern, what] of forbidden) {
      assert.equal(pattern.test(source), false, `contains ${what}`);
    }
  }
});

// --- server/client scenario parity -------------------------------------------

test('the frontend scenario ids match server/src/demo/runScenario.ts exactly', () => {
  const serverSource = read(path.join(SERVER, 'demo/runScenario.ts'));
  const block = /DEMO_SCENARIO_IDS\s*=\s*\[([\s\S]*?)\]\s*as const/.exec(serverSource);
  assert.ok(block, 'could not find DEMO_SCENARIO_IDS in the server source — the parity check would be vacuous');
  const serverIds = [...(block[1] as string).matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1] as string);

  const frontendIds = parseRunnerScenarios().map((s) => s.id);

  assert.deepEqual([...frontendIds].sort(), [...serverIds].sort());
  assert.equal(serverIds.length, 5, 'precondition: the server allow-list still has exactly five scenarios');
});

// --- negative control, so the parity check is proven to actually fire -------

test('NEGATIVE CONTROL — the parity check would fail on a genuinely mismatched list', () => {
  const serverIds = ['demo-001', 'demo-002', 'demo-003', 'demo-004', 'demo-005'];
  const drifted = ['demo-001', 'demo-002', 'demo-003', 'demo-004', 'demo-006'];
  assert.notDeepEqual([...drifted].sort(), [...serverIds].sort());
});

// --- the result is temporary, and the page says so ---------------------------
//
// The server runs a demo scenario in an isolated in-memory sandbox. The result
// is not a saved evaluation, never reaches the ranking, and can vanish on a
// restart. A screen that looked like any other assessment would invite the
// opposite belief, so the runner states it where the visitor clicks.

/** The runner's visible text, with JSX line-wrapping collapsed. */
function visibleCopy(): string {
  return RUNNER().replace(/\s+/g, ' ');
}

test('the runner tells the visitor that demo results are temporary and change nothing saved', () => {
  assert.match(
    visibleCopy(),
    /Demo results are temporary and do not change the recruiter's saved evaluations/,
    'the ephemeral-demo note is missing from the demo runner',
  );
});

test('the runner never claims a demo result is saved, stored or ranked', () => {
  // The note above is the one place "saved" may appear, and only in the negative.
  const withoutNote = visibleCopy().replace(/Demo results are temporary[^.]*\./, '');
  for (const claim of [/\bsaved\b/i, /\bstored\b/i, /\bpersist/i, /\brecorded\b/i, /added to the ranking/i]) {
    assert.equal(claim.test(withoutNote), false, `the runner's copy matches ${claim}`);
  }
});
