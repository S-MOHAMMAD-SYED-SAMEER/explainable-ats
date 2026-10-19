import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SECOND_OPINION, verdictWording } from '../src/copy.ts';

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
