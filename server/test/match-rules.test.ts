import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  criterionTerms,
  decideMatch,
  significantTerms,
  MET_COVERAGE_PERCENT,
  PARTIAL_COVERAGE_PERCENT,
  type EvidenceLike,
} from '../src/agent/matchRules.ts';
import type { JobRequirement } from '../src/domain/ats.ts';

// The verdict rules, on their own.
//
// No database and no model: given a requirement and some evidence, these tests
// pin down exactly which verdict comes out and why. Everything the scorer does
// rests on this, so it is checked here in isolation rather than inferred from a
// score at the far end of the pipeline.

function requirement(overrides: Partial<JobRequirement> = {}): JobRequirement {
  return {
    id: 'req-1',
    jobId: 'job-1',
    label: 'Kubernetes',
    criterion: 'Runs Kubernetes in production',
    kind: 'must_have',
    weight: 1,
    position: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function evidence(quote: string, options: { verified?: boolean; requirementId?: string | null } = {}): EvidenceLike {
  return {
    requirementId: options.requirementId === undefined ? 'req-1' : options.requirementId,
    quote,
    verified: options.verified ?? true,
  };
}

// The fixture requirement asks for exactly three terms, which makes the
// coverage ladder checkable by hand: 3/3 = 100%, 2/3 = 67%, 1/3 = 33%.
const TERMS = ['kubernetes', 'production', 'runs'];

test('the terms of a criterion are exactly what a reader would call the concrete words', () => {
  // The precondition every other test in this file rests on. If the tokenizer
  // changes, the hand-computed coverage ladder below stops meaning what it says
  // and this assertion is what says so.
  assert.deepEqual(criterionTerms(requirement()), TERMS);
});

test('common words are not terms, and duplicates are counted once', () => {
  assert.deepEqual(significantTerms('has the and with for'), []);
  assert.deepEqual(significantTerms('React react REACT hooks'), ['hooks', 'react']);
  assert.deepEqual(significantTerms('Node.js and node.js'), ['node.js']);
});

test('the thresholds are the ones the ladder assumes', () => {
  assert.equal(MET_COVERAGE_PERCENT, 75);
  assert.equal(PARTIAL_COVERAGE_PERCENT, 35);
});

// --- the coverage ladder -----------------------------------------------------

test('evidence covering every term is met', () => {
  const decision = decideMatch(requirement(), [evidence('Runs Kubernetes in production across two regions.')]);

  assert.equal(decision.verdict, 'met');
  assert.equal(decision.confidence, 'high');
  assert.deepEqual(decision.matchedTerms, TERMS);
  assert.deepEqual(decision.missingTerms, []);
  assert.equal(decision.evidenceCount, 1);
});

test('evidence covering two of three terms is partial', () => {
  // 2/3 is 67%: above the partial threshold, below the met threshold.
  const decision = decideMatch(requirement(), [evidence('Kubernetes clusters serving production traffic.')]);

  assert.equal(decision.verdict, 'partial');
  assert.deepEqual(decision.matchedTerms, ['kubernetes', 'production']);
  assert.deepEqual(decision.missingTerms, ['runs']);
  assert.match(decision.rationale, /covers 2 of 3/);
  assert.match(decision.rationale, /"runs"/);
});

test('evidence covering one of three terms is not met', () => {
  // 1/3 is 33%, below the partial threshold. The reader looked and quoted its
  // best passage, and the passage does not demonstrate the criterion.
  const decision = decideMatch(requirement(), [evidence('Kubernetes was mentioned at a conference I attended.')]);

  assert.equal(decision.verdict, 'not_met');
  assert.equal(decision.confidence, 'low');
  assert.deepEqual(decision.matchedTerms, ['kubernetes']);
});

test('no evidence at all is unclear, never not met', () => {
  // "The resume says nothing about this" is an absence of evidence. Reporting
  // it as evidence of absence is how a good candidate gets filtered out for a
  // gap in the reading rather than a gap in their experience.
  const decision = decideMatch(requirement(), []);

  assert.equal(decision.verdict, 'unclear');
  assert.equal(decision.confidence, 'low');
  assert.equal(decision.evidenceCount, 0);
  assert.deepEqual(decision.missingTerms, TERMS);
  assert.match(decision.rationale, /not a finding against the candidate/);
});

test('a criterion made only of common words is unclear, and blames the spec not the candidate', () => {
  const vague = requirement({ label: 'The', criterion: 'Has been able to work with them' });

  // Precondition: this criterion really does give nothing concrete to look
  // for, so the verdict below is about the spec and not about the evidence.
  assert.deepEqual(criterionTerms(vague), []);

  const decision = decideMatch(vague, [evidence('Runs Kubernetes in production.')]);

  assert.equal(decision.verdict, 'unclear');
  assert.match(decision.rationale, /worded too loosely/);
});

// --- what counts, and what does not -----------------------------------------

test('unverified evidence is ignored even when it is handed straight to the rule', () => {
  // The second lock. The caller already passes verified-only evidence; this
  // proves the rule does not depend on the caller getting that right.
  const fabricated = evidence('Runs Kubernetes in production across two regions.', { verified: false });

  const decision = decideMatch(requirement(), [fabricated]);

  assert.equal(decision.verdict, 'unclear');
  assert.equal(decision.evidenceCount, 0);

  // Positive control: the identical quote, marked verified, is met. So the
  // rejection above is caused by the flag and nothing else.
  const verified = decideMatch(requirement(), [{ ...fabricated, verified: true }]);
  assert.equal(verified.verdict, 'met');
});

test('evidence quoted against another requirement does not count for this one', () => {
  const decision = decideMatch(requirement(), [
    evidence('Runs Kubernetes in production across two regions.', { requirementId: 'req-2' }),
  ]);

  assert.equal(decision.verdict, 'unclear');
  assert.equal(decision.evidenceCount, 0);
});

test('evidence with no requirement at all does not count', () => {
  const decision = decideMatch(requirement(), [
    evidence('Runs Kubernetes in production.', { requirementId: null }),
  ]);

  assert.equal(decision.evidenceCount, 0);
});

test('several passages are read together, so partial evidence can add up to met', () => {
  const decision = decideMatch(requirement(), [
    evidence('Kubernetes across two regions.'),
    evidence('Runs the production cluster.'),
  ]);

  assert.equal(decision.verdict, 'met');
  assert.equal(decision.evidenceCount, 2);
  assert.equal(decision.confidence, 'high', 'two independent passages is a stronger basis than one');
});

test('confidence reflects how much evidence there is, not how good the candidate is', () => {
  const one = decideMatch(requirement(), [evidence('Kubernetes clusters serving production traffic.')]);
  assert.equal(one.verdict, 'partial');
  assert.equal(one.confidence, 'medium', 'one passage, partial coverage');

  const two = decideMatch(requirement(), [
    evidence('Kubernetes clusters serving production traffic.'),
    evidence('Kubernetes upgrades in production.'),
  ]);
  assert.equal(two.verdict, 'partial', 'still partial: neither passage adds the missing term');
  assert.equal(two.confidence, 'high', 'but two passages agree');
});

// --- determinism -------------------------------------------------------------

test('the same requirement and evidence always give the same decision', () => {
  const items = [
    evidence('Kubernetes clusters serving production traffic.'),
    evidence('Runs upgrades quarterly.'),
  ];

  const first = decideMatch(requirement(), items);
  const second = decideMatch(requirement(), items);

  assert.deepEqual(second, first);
});

test('the order the evidence arrives in does not change the decision', () => {
  const a = evidence('Kubernetes clusters serving production traffic.');
  const b = evidence('Runs upgrades quarterly.');

  const forwards = decideMatch(requirement(), [a, b]);
  const backwards = decideMatch(requirement(), [b, a]);

  assert.equal(backwards.verdict, forwards.verdict);
  assert.deepEqual(backwards.matchedTerms, forwards.matchedTerms);
  assert.deepEqual(backwards.missingTerms, forwards.missingTerms);
});

test('every verdict carries a rationale that names what was counted', () => {
  // The rationale is the product. A verdict a recruiter cannot interrogate is
  // the thing this system exists to replace.
  const cases = [
    decideMatch(requirement(), [evidence('Runs Kubernetes in production.')]),
    decideMatch(requirement(), [evidence('Kubernetes in production.')]),
    decideMatch(requirement(), [evidence('Kubernetes.')]),
    decideMatch(requirement(), []),
  ];

  assert.deepEqual(cases.map((c) => c.verdict), ['met', 'partial', 'not_met', 'unclear']);
  for (const decision of cases) {
    assert.ok(decision.rationale.length > 30, `rationale too thin: ${decision.rationale}`);
    assert.match(decision.rationale, /^(Met|Partially met|Not met|Unclear)\./);
  }
});
