import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEEDS_REVIEW_REASONS, SECOND_OPINION, TIER_WORDING, tierExplanation, verdictWording } from '../src/copy.ts';

// The candidate page for an assessment the model's verdicts were checked on: what the model said and why, the verified quote, the matcher's
// verdict, and a flag where the second opinion disagrees. The component is TSX, which the test runner does not load, so what is pinned here is the
// wording it reads from `copy.ts` and the places it uses it.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const detail = fs.readFileSync(path.join(SRC, 'screens/CandidateDetail.tsx'), 'utf8');
const types = fs.readFileSync(path.join(SRC, 'api/types.ts'), 'utf8');

test('the wording says what a disagreement is and what happens to the score', () => {
  assert.match(SECOND_OPINION.banner, /^Quote shares no words with the requirement; a person should check\./);
  assert.match(SECOND_OPINION.banner, /has not been changed/);
  assert.equal(SECOND_OPINION.quoteNoOverlap, 'Quote shares no words with the requirement; a person should check.');
  assert.match(SECOND_OPINION.shownOnly, /Shown, not acted on/);
  assert.match(SECOND_OPINION.banner, /must-have/);
  assert.match(SECOND_OPINION.oneStep, /one step/);
  assert.match(SECOND_OPINION.oneStep, /not acted on/i);
  assert.equal(SECOND_OPINION.lowered('Unclear'), 'Lowered to unclear by the code: no passage the model quoted for this was found in the CV.');
});

test('every verdict the model can propose has a plain-language label', () => {
  for (const verdict of ['met', 'partial', 'not_met', 'unclear']) assert.ok(verdictWording(verdict).label.length > 0, verdict);
});

test('the page shows, for each requirement, the model\'s verdict and reason, the matcher\'s verdict and the flag, and a banner for the candidate', () => {
  assert.match(detail, /function VerdictCheckPanel/);
  assert.match(detail, /Model&apos;s verdict: /);
  assert.match(detail, /Matcher&apos;s verdict/);
  assert.match(detail, /check\.modelReason/);
  assert.match(detail, /data-quote-no-overlap/);
  assert.match(detail, /data-second-opinion-shown-only/);
  assert.match(detail, /check\.quoteNoOverlap/);
  assert.match(detail, /data-second-opinion-banner/);
  assert.match(detail, /detail\.needsReview/);
  assert.match(detail, /requirement\.check \? <VerdictCheckPanel check=\{requirement\.check\} \/> : null/, 'nothing is drawn for an assessment the matcher alone judged');
  // The verified quotes are the ones already listed for the requirement; the panel adds no second copy of them.
  assert.match(detail, /From the CV/);
});

test('the types say the new fields are optional, so an assessment made the old way and the demo still type-check', () => {
  assert.match(types, /check\?: VerdictCheck \| null/);
  assert.match(types, /needsReview\?: boolean/);
  assert.match(types, /verdictMode\?: 'model_checked' \| 'matcher'/);
  assert.match(types, /disagreement: 'none' \| 'one_step' \| 'two_plus'/);
  assert.match(types, /routed: boolean/);
});

test('the tier explanation says WHY a candidate is "worth a look": silent, flagged, or both', () => {
  // The CV is silent about an essential requirement: the gap-in-the-CV text, as before.
  assert.equal(tierExplanation('needs_review', { unclearMustHaves: ['PostgreSQL'], flaggedMustHaves: [] }), NEEDS_REVIEW_REASONS.silent);
  assert.match(NEEDS_REVIEW_REASONS.silent, /says nothing either way about an essential requirement/);
  // A credited quote shares no word with the requirement: NOT "the CV says nothing".
  const flagged = tierExplanation('needs_review', { unclearMustHaves: [], flaggedMustHaves: ['PostgreSQL'] });
  assert.equal(flagged, 'A quote credited on an essential requirement shares no words with it, so a person should check it before relying on the score.');
  assert.doesNotMatch(flagged, /says nothing/);
  // Both.
  const both = tierExplanation('needs_review', { unclearMustHaves: ['PostgreSQL'], flaggedMustHaves: ['Node.js'] });
  assert.match(both, /says nothing either way/);
  assert.match(both, /shares no words/);
  // An old reply with neither field keeps the old text; every other tier keeps its own.
  assert.equal(tierExplanation('needs_review'), NEEDS_REVIEW_REASONS.silent);
  for (const tier of ['qualified', 'gated', 'not_evaluated'] as const) assert.equal(tierExplanation(tier, { flaggedMustHaves: ['X'] }), TIER_WORDING[tier].detail);
});

test('the candidate page takes its tier explanation from the reasons, not from the tier alone', () => {
  const detail = fs.readFileSync(new URL('../src/screens/CandidateDetail.tsx', import.meta.url), 'utf8');
  assert.match(detail, /data-tier-explanation/);
  assert.match(detail, /tierExplanation\(detail\.tier, \{ unclearMustHaves: detail\.unclearMustHaves, flaggedMustHaves: detail\.flaggedMustHaves/);
  const headline = detail.slice(detail.indexOf('function Headline'), detail.indexOf('function NothingFound'));
  assert.doesNotMatch(headline, /\{wording\.detail\}/, 'the headline must not print the tier fixed sentence');
});
