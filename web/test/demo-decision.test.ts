import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, setApiScope } from '../src/api/client.ts';
import { OUTCOMES, MIN_REASON_CHARS, outcomeWording } from '../src/copy.ts';

// A visitor's decision in the public demo (Phase 3C.2), from the browser's side.
//
// NFR-9 rules out jsdom and Playwright, so nothing here renders a component.
// What can be proved without a browser is what matters: the form is drawn for a
// visitor's own session and for nobody else, the recruiter's screen is exactly
// what it was, the demo says honestly what it is, and the decision goes where
// the scope says and nowhere near the recruiter's route.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
/** Strips comments, so a scan matches code rather than the note explaining it. */
const code = (source: string): string => source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
/** Collapses JSX line-wrapping, so a sentence can be matched as a sentence. */
const flat = (source: string): string => code(source).replace(/\s+/g, ' ');

const DETAIL = () => code(read('screens/CandidateDetail.tsx'));

// ===================================================================== the words

test('the demo decision area says what it is, in the words the demo promises', () => {
  const text = flat(read('screens/CandidateDetail.tsx'));

  assert.ok(text.includes('Demo recruiter decision'));
  assert.ok(
    text.includes('This decision is saved only to your private demo session and does not affect real recruiter records.'),
    'the demo form does not carry the required sentence',
  );
  assert.ok(text.includes('Record demo decision'));
  assert.ok(text.includes('Demo decision recorded'));
  assert.ok(text.includes('This is demo data'));
});

test('the demo never tells a visitor an operator sign-in is required', () => {
  const source = DETAIL();

  // The only place that sentence lives is a branch the visitor's own session
  // cannot reach: the read-only window, which still cannot decide.
  const at = source.indexOf('needs an operator');
  assert.notEqual(at, -1, 'precondition: the read-only note is still there');
  const guard = source.slice(Math.max(0, at - 400), at);
  assert.match(guard, /demo && !demoSession && detail\.decision === null/);

  // And nothing in any demo-only string says it.
  for (const [name, snippet] of [
    ['the demo form', /demo \? \(\s*<>[\s\S]*?<\/>\s*\) : \(/.exec(source)?.[0] ?? ''],
    ['the demo result', /if \(demo\) \{[\s\S]*?\n  \}\n/.exec(source)?.[0] ?? ''],
  ] as const) {
    assert.notEqual(snippet, '', `precondition: found ${name}`);
    assert.doesNotMatch(snippet, /sign-in|sign in|operator/i, `${name} still mentions signing in`);
  }
});

test('the demo result shows the decision, its reason, the demo actor, a timestamp, and that it is demo data', () => {
  const source = DETAIL();
  const block = /if \(demo\) \{[\s\S]*?\n  \}\n/.exec(source)?.[0] ?? '';
  assert.notEqual(block, '', 'precondition: the demo branch of DecisionRecorded exists');

  assert.match(block, /wording\.label/, 'the outcome is not shown');
  assert.match(block, /decision\.reason/, 'the reason is not shown');
  assert.match(block, /decision\.decidedBy/, 'the demo actor is not shown');
  assert.match(block, /decision\.decidedAt/, 'the timestamp is not shown');
  assert.match(block, /demo data/i);
  assert.match(block, /Reset demo/, 'it does not say how to start over');

  // No internal identifier is rendered.
  assert.doesNotMatch(block, /evaluationId|candidate\.id|\.id\b|supersededBy/);
});

// ============================================================ who sees the form

test('the visitor\'s form is drawn only for a visitor\'s own session; the recruiter\'s only for a signed-in recruiter', () => {
  const source = DETAIL();

  // The recruiter's condition is exactly what it was.
  assert.match(source, /const decidable =\s*!demo && detail\.decision === null && detail\.isCurrent && detail\.status === 'scored';/);
  // The visitor's is the same conditions, for the session only.
  assert.match(source, /const demoDecidable =\s*demoSession && detail\.decision === null && detail\.isCurrent && detail\.status === 'scored';/);

  assert.match(source, /\{decidable \? <DecisionForm detail=\{detail\} onDecided=\{set\} \/> : null\}/);
  // The visitor's form also re-reads the audit trail once the decision lands.
  assert.match(source, /\{demoDecidable \? \(\s*<DecisionForm\s+detail=\{detail\}\s+onDecided=\{\(updated\) => \{\s*set\(updated\);\s*(?:\/\/[^\n]*\s*)*audit\.reload\(\);\s*\}\}\s+demo\s*\/>\s*\) : null\}/);

  // `demoSession` defaults to false, so every existing caller is unchanged.
  assert.match(source, /demoSession = false,/);
});

test('only the visitor\'s own session enables it: the read-only window and the recruiter do not', () => {
  const app = code(read('App.tsx'));

  // The prop is the derived "in a demo session" value, never the broader `demo`.
  assert.match(app, /<CandidateDetail evaluationId=\{route\.id\} demo=\{demo\} demoSession=\{inDemoSession\} \/>/);
  assert.match(app, /const inDemoSession = demoSessionInUse\(/);

  // `demo` stays true in a session, which is what keeps the recruiter's form out.
  assert.match(app, /const demo = session\.state\.status === 'anonymous' \|\| inDemoSession;/);

  // JobDetail is given the same derived value, for the overview — and nothing on it
  // can decide: it never calls the decision endpoint.
  assert.match(app, /<JobDetail jobId=\{route\.id\} demo=\{demo\} demoSession=\{inDemoSession\} \/>/);
  assert.doesNotMatch(code(read('screens/JobDetail.tsx')), /api\.decide|DecisionForm/);
});

test('the recruiter\'s decision screen is exactly the words it was', () => {
  const text = flat(read('screens/CandidateDetail.tsx'));

  for (const original of [
    'Your decision',
    'Record decision',
    'Decision recorded',
    'Every decision needs a reason. It is kept on the record permanently',
    'A decision cannot be edited or removed. To decide differently, assess the candidate again',
    'Recorded by {decision.decidedBy} on {new Date(decision.decidedAt).toLocaleString()}.',
  ]) {
    assert.ok(text.includes(original), `the recruiter's wording changed: ${original}`);
  }
});

test('a visitor\'s timeline is re-read when their decision lands, and the recruiter\'s history is exactly as it was', () => {
  const source = DETAIL();
  // The recruiter's history: unkeyed, unconditional on the demo, as originally written.
  assert.match(source, /<History evaluationId=\{evaluationId\} \/>/);
  assert.doesNotMatch(source, /<History key=/);
  // The visitor's decision reloads the one audit load both the pipeline and the timeline read.
  assert.match(source, /audit\.reload\(\);/);
});

// ================================================================ how it is sent

test('both forms send through the one api.decide call, with an outcome and a reason and nothing else', () => {
  const source = DETAIL();

  assert.equal(source.split('api.decide(').length - 1, 1, 'there must be exactly one decision call site');
  assert.match(source, /api\.decide\(detail\.evaluationId, outcome, trimmed\)/);
  assert.doesNotMatch(source, /\bfetch\s*\(/, 'the screen must not call fetch directly');
  // No hand-built demo URL, no actor and no token anywhere in the screen.
  assert.doesNotMatch(source, /demo\/session|ats_demo|decidedBy:|actor:|token/i);
});

test('the demo form offers exactly the outcomes the server supports and the same reason rule', () => {
  assert.deepEqual([...OUTCOMES], ['shortlist', 'reject', 'hold']);
  assert.equal(MIN_REASON_CHARS, 10);
  for (const outcome of OUTCOMES) assert.ok(outcomeWording(outcome).label.length > 0);

  // One form component, so the demo cannot drift from the recruiter's rule.
  const source = DETAIL();
  assert.equal(source.split('function DecisionForm(').length - 1, 1);
  assert.match(source, /const ready = outcome !== null && trimmed\.length >= MIN_REASON_CHARS && !submitting;/);
});

type Call = { url: string; method: string; body: unknown };

async function withFetch(status: number, respond: unknown, fn: () => Promise<void>): Promise<Call[]> {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body ?? null });
    return new Response(JSON.stringify(respond), { status });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
    setApiScope('recruiter');
  }
  return calls;
}

test('in a demo session a decision is posted to the demo route, and never to the recruiter\'s', async () => {
  const calls = await withFetch(201, { decision: {}, evaluation: {} }, async () => {
    setApiScope('demo');
    await api.decide('e1', 'shortlist', 'A synthetic reason that is long enough.');
  });

  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['POST /api/demo/session/evaluations/e1/decision']);
  // Exactly an outcome and a reason: the actor and the time are the server's to set.
  assert.deepEqual(JSON.parse(String(calls[0]?.body)), { outcome: 'shortlist', reason: 'A synthetic reason that is long enough.' });
});

test('for a recruiter the same call still goes to the canonical decision route', async () => {
  const calls = await withFetch(201, { decision: {}, evaluation: {} }, async () => {
    setApiScope('recruiter');
    await api.decide('e1', 'hold', 'A real recruiter\'s considered reason.');
  });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['POST /api/evaluations/e1/decision']);
});

test('no credential is introduced: the decision is authorised by the demo cookie alone', () => {
  for (const rel of ['screens/CandidateDetail.tsx', 'api/client.ts', 'App.tsx']) {
    const source = code(read(rel));
    assert.doesNotMatch(source, /ats_demo|document\.cookie|localStorage|sessionStorage/, `${rel} handles the demo credential`);
    assert.doesNotMatch(source, /sk-ant-|api[_-]?key|anthropic/i, `${rel} names a key or a provider`);
  }
});
