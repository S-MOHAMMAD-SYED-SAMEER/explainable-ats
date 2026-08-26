import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OUTCOMES,
  OUTCOME_WORDING,
  TIERS,
  TIER_WORDING,
  VERDICTS,
  VERDICT_WORDING,
  tierWording,
  verdictWording,
  outcomeWording,
} from '../src/copy.ts';
import { ROUTES, parseRoute, routeToHash } from '../src/router.ts';

// The recruiter workflow's client-side guarantees (P3-F).
//
// NFR-9 rules out jsdom, Playwright and Cypress, so nothing here renders a
// component. What can still be proved without a browser is the part that
// actually goes wrong: that the words a recruiter reads exist for every value
// the server can send, and that no screen quietly recomputes something the
// server already decided.

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

function screenFiles(): string[] {
  const dir = path.join(SRC, 'screens');
  return fs.readdirSync(dir).map((name) => path.join(dir, name));
}

/** Reads a `const NAME = [...] as const` list out of a server module. */
function serverEnum(file: string, name: string): string[] {
  const source = read(path.join(SERVER, file));
  const block = new RegExp(`${name} = \\[([\\s\\S]*?)\\] as const`).exec(source);
  assert.ok(block, `could not find ${name} in ${file} — the parity check below would be vacuous`);
  return [...(block[1] as string).matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as string);
}

// --- the words exist for every value the server can send ---------------------

test('every verdict the server can produce has recruiter wording', () => {
  // Cross-package parity, the same idea as the server's schema-parity test: a
  // value the server can emit and the UI has no words for would reach a
  // recruiter as a raw identifier like "not_met".
  const fromServer = serverEnum('domain/ats.ts', 'MATCH_VERDICTS');

  assert.deepEqual([...fromServer].sort(), [...VERDICTS].sort());
  for (const verdict of fromServer) {
    const wording = VERDICT_WORDING[verdict as (typeof VERDICTS)[number]];
    assert.ok(wording, `no wording for verdict "${verdict}"`);
    assert.ok(wording.label.length > 0 && !wording.label.includes('_'), `"${verdict}" reads as an identifier`);
    assert.ok(wording.detail.length > 20, `"${verdict}" has no explanation`);
  }
});

test('every decision outcome has recruiter wording', () => {
  const fromServer = serverEnum('domain/ats.ts', 'DECISION_OUTCOMES');

  assert.deepEqual([...fromServer].sort(), [...OUTCOMES].sort());
  for (const outcome of fromServer) {
    assert.ok(OUTCOME_WORDING[outcome as (typeof OUTCOMES)[number]], `no wording for outcome "${outcome}"`);
  }

  // The three buttons a recruiter actually sees.
  assert.equal(OUTCOME_WORDING.shortlist.label, 'Advance');
  assert.equal(OUTCOME_WORDING.reject.label, 'Reject');
  assert.equal(OUTCOME_WORDING.hold.label, 'Review');
});

test('every ranking tier has recruiter wording', () => {
  const fromServer = serverEnum('agent/rankRules.ts', 'RANK_TIERS');

  assert.deepEqual([...fromServer].sort(), [...TIERS].sort());
  for (const tier of fromServer) {
    assert.ok(TIER_WORDING[tier as (typeof TIERS)[number]], `no wording for tier "${tier}"`);
  }
});

test('"does not meet" and "not demonstrated" stay two different answers', () => {
  // The distinction the product turns on. `not_met` means we looked and what we
  // found fell short; `unclear` means the CV is silent. Collapsing them would
  // report an absence of evidence as evidence of absence.
  const notMet = VERDICT_WORDING.not_met;
  const unclear = VERDICT_WORDING.unclear;

  assert.notEqual(notMet.label, unclear.label);
  assert.notEqual(notMet.detail, unclear.detail);
  assert.match(notMet.detail, /found relevant text/i);
  assert.match(unclear.detail, /nothing in the cv/i);

  // And they are not both rendered as a flat failure.
  assert.equal(notMet.tone, 'bad');
  assert.equal(unclear.tone, 'warn');
});

test('an unknown value degrades to something readable rather than throwing', () => {
  // Fails safe. If the server ever sends a value this build has never seen, the
  // screen shows the raw word instead of blanking the page.
  assert.equal(tierWording('brand_new_tier').label, 'brand_new_tier');
  assert.equal(verdictWording(null).label, 'Not assessed');
  assert.equal(outcomeWording('unknown').label, 'unknown');
});

// --- the browser does not decide anything ------------------------------------

test('no screen computes a score', () => {
  // The rule: the server sends `scorePercent` already rounded. A screen that
  // divided basis points would be a second implementation of the arithmetic,
  // able to disagree with the number in the audit trail.
  const offenders: string[] = [];

  for (const file of screenFiles()) {
    const source = code(read(file));
    const name = path.basename(file);

    if (/scoreBasisPoints\s*\/|\/\s*100\b/.test(source)) offenders.push(`${name} divides a score`);
    if (/Math\.(round|floor|ceil)\s*\(/.test(source)) offenders.push(`${name} rounds a number`);
    if (/contributionBasisPoints\s*[+\-*/]/.test(source)) offenders.push(`${name} does arithmetic on a contribution`);
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('NEGATIVE CONTROL — the score scan catches the shape it is looking for', () => {
  // Without this, the assertion above could be passing because the patterns
  // never match anything at all.
  const cheating = code('const shown = Math.round(entry.scoreBasisPoints / 100);');

  assert.match(cheating, /scoreBasisPoints\s*\//);
  assert.match(cheating, /Math\.(round|floor|ceil)\s*\(/);
});

test('no screen sorts or re-orders the ranking', () => {
  // `entries` arrives in display order, with ranks and ties already decided.
  const offenders: string[] = [];

  for (const file of screenFiles()) {
    const source = code(read(file));
    const name = path.basename(file);

    if (/\.sort\s*\(/.test(source)) offenders.push(`${name} sorts a list`);
    if (/\.reverse\s*\(/.test(source)) offenders.push(`${name} reverses a list`);
    // Comparing two candidates' scores is ranking, whatever it is called.
    if (/scoreBasisPoints\s*[<>]/.test(source)) offenders.push(`${name} compares scores`);
    // `=(?!=)` is assignment. Without the lookahead this matched `rank === null`,
    // which is a read — and a scan that flags correct code is a scan someone
    // switches off.
    if (/\brank\s*=(?!=)|position\s*\+\s*1/.test(source)) offenders.push(`${name} assigns a rank`);
  }

  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('NEGATIVE CONTROL — the ordering scan fires on ordering and not on reading', () => {
  const reordering = 'const ordered = entries.sort((a, b) => b.scoreBasisPoints - a.scoreBasisPoints);';
  const reading = 'const label = entry.rank === null ? undefined : entry.rank;';

  assert.match(reordering, /\.sort\s*\(/);
  assert.ok(!/\brank\s*=(?!=)/.test(reading), 'reading a rank must not be mistaken for assigning one');
  assert.ok(/\brank\s*=(?!=)/.test('let rank = 1;'), 'an actual assignment must still be caught');
});

test('the candidate screen renders only what the server called evidence', () => {
  // The server sends verified passages only. This asserts the screen has no
  // second source for a quote — it reads `requirement.evidence` and nothing
  // else, so there is no path by which a rejected quote could be rendered.
  const source = code(read(path.join(SRC, 'screens/CandidateDetail.tsx')));

  assert.match(source, /requirement\.evidence\.map/, 'precondition: the screen renders evidence at all');

  // `evidenceRejectedCount` is a number for the details area. The rejected
  // quotes themselves are never sent, so nothing can render them.
  assert.ok(!/rejected.*\.quote/i.test(source), 'the screen appears to render a rejected quote');
  assert.ok(!/listForEvaluation/.test(source), 'the screen must not reach for unverified rows');
});

test('the candidate screen shows protected attributes as categories, never values', () => {
  const source = code(read(path.join(SRC, 'screens/CandidateDetail.tsx')));

  assert.match(source, /protectedAttributes\.categories/, 'precondition: the screen reports the categories');
  assert.match(source, /protectedAttributes\.count/);
  // There is no `values` field to read — the quarantine table has no column for
  // one — and this asserts the screen never invents a reference to it.
  assert.ok(!/protectedAttributes\.values?/.test(source));
});

// --- routing -----------------------------------------------------------------

test('every screen the app switches on is a real route', () => {
  const source = code(read(path.join(SRC, 'App.tsx')));
  const switched = [...source.matchAll(/route\.name === '([a-z]+)'/g)].map((match) => match[1] as string);

  assert.ok(switched.length >= 3, `only ${switched.length} route branches found`);
  for (const name of switched) {
    assert.ok((ROUTES as readonly string[]).includes(name), `App switches on "${name}", which is not a route`);
  }
});

test('a candidate link round-trips through the hash', () => {
  const hash = routeToHash({ name: 'candidates', id: 'eval-123' });
  assert.equal(hash, '#/candidates/eval-123');
  assert.deepEqual(parseRoute(hash), { name: 'candidates', id: 'eval-123' });

  const job = routeToHash({ name: 'jobs', id: 'job-abc' });
  assert.deepEqual(parseRoute(job), { name: 'jobs', id: 'job-abc' });
});

test('an unrecognised hash falls back rather than dead-ending', () => {
  assert.deepEqual(parseRoute('#/nonsense'), { name: 'overview', id: null });
  assert.deepEqual(parseRoute(''), { name: 'overview', id: null });
});

// --- the API client ----------------------------------------------------------

test('every recruiter endpoint the screens call exists on the client', () => {
  const client = code(read(path.join(SRC, 'api/client.ts')));
  const calls = new Set<string>();

  for (const file of [...screenFiles(), path.join(SRC, 'App.tsx')]) {
    for (const match of code(read(file)).matchAll(/\bapi\.([a-zA-Z]+)\s*\(/g)) {
      calls.add(match[1] as string);
    }
  }

  assert.ok(calls.size >= 4, `only ${calls.size} api calls found across the screens`);
  for (const call of calls) {
    assert.match(client, new RegExp(`\\n\\s*${call}:`), `api.${call}() is called but not defined`);
  }
});

test('the decision call sends both an outcome and a reason', () => {
  // A mandatory reason is only mandatory if the client actually carries one.
  const client = code(read(path.join(SRC, 'api/client.ts')));
  const decide = /decide:[\s\S]*?\}\),/.exec(client)?.[0] ?? '';

  assert.notEqual(decide, '', 'precondition: the client defines decide()');
  assert.match(decide, /method: 'POST'/);
  assert.match(decide, /outcome/);
  assert.match(decide, /reason/);
});
