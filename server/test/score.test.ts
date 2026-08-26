import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreEvaluation, formatScore } from '../src/agent/score.ts';
import { BASIS_POINTS_MAX, VERDICT_BASIS_POINTS } from '../src/domain/ats.ts';
import type { EvidenceLike } from '../src/agent/matchRules.ts';
import type { JobRequirement } from '../src/domain/ats.ts';

// The arithmetic, on its own.
//
// A recruiter has to be able to redo this on paper, so every number below is
// written out by hand in a comment and then asserted. If a test here needs a
// calculator, the scoring model is too clever.

function requirement(id: string, overrides: Partial<JobRequirement> = {}): JobRequirement {
  return {
    id,
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

/** Evidence engineered to produce one exact verdict, so the arithmetic is isolated. */
const QUOTES = {
  met: 'Runs Kubernetes in production across two regions.',
  partial: 'Kubernetes clusters serving production traffic.',
  not_met: 'Kubernetes was mentioned at a conference I attended.',
} as const;

function evidenceFor(requirementId: string, verdict: keyof typeof QUOTES, verified = true): EvidenceLike {
  return { requirementId, quote: QUOTES[verdict], verified };
}

test('the verdict values are the ones every calculation below assumes', () => {
  assert.equal(VERDICT_BASIS_POINTS.met, 10_000);
  assert.equal(VERDICT_BASIS_POINTS.partial, 5_000);
  assert.equal(VERDICT_BASIS_POINTS.not_met, 0);
  assert.equal(VERDICT_BASIS_POINTS.unclear, 0);
  assert.equal(BASIS_POINTS_MAX, 10_000);
});

// --- boundaries --------------------------------------------------------------

test('everything met scores exactly 10000', () => {
  // Three equal weights, all met: (10000+10000+10000) / 3 = 10000 exactly.
  const requirements = [requirement('r1'), requirement('r2'), requirement('r3')];
  const evidence = requirements.map((r) => evidenceFor(r.id, 'met'));

  const result = scoreEvaluation(requirements, evidence);

  assert.equal(result.scoreBasisPoints, BASIS_POINTS_MAX);
  assert.deepEqual(result.rows.map((row) => row.decision.verdict), ['met', 'met', 'met']);
});

test('everything not met scores exactly 0', () => {
  const requirements = [requirement('r1'), requirement('r2')];
  const evidence = requirements.map((r) => evidenceFor(r.id, 'not_met'));

  const result = scoreEvaluation(requirements, evidence);

  assert.equal(result.scoreBasisPoints, 0);
  assert.deepEqual(result.rows.map((row) => row.decision.verdict), ['not_met', 'not_met']);
  assert.deepEqual(result.rows.map((row) => row.contributionBasisPoints), [0, 0]);
});

test('a resume with no evidence at all scores 0, and says why', () => {
  // 0 is the right number, but "unclear" is the right reason: nothing was
  // quoted, which is not the same as failing.
  const requirements = [requirement('r1'), requirement('r2')];

  const result = scoreEvaluation(requirements, []);

  assert.equal(result.scoreBasisPoints, 0);
  assert.deepEqual(result.rows.map((row) => row.decision.verdict), ['unclear', 'unclear']);
  assert.equal(result.mustHavesUnclear, 2);
  assert.equal(result.mustHavesMet, 0);
});

test('one partial on its own scores exactly halfway', () => {
  const requirements = [requirement('r1')];

  const result = scoreEvaluation(requirements, [evidenceFor('r1', 'partial')]);

  assert.equal(result.rows[0]?.decision.verdict, 'partial');
  assert.equal(result.scoreBasisPoints, 5_000);
});

// --- weights -----------------------------------------------------------------

test('weight decides how much a requirement moves the score', () => {
  // Same two verdicts, weights swapped, so the ONLY difference is the weight.
  //   heavy-met:  (3x10000 + 1x0) / 4 = 7500
  //   heavy-miss: (1x10000 + 3x0) / 4 = 2500
  const heavyMet = scoreEvaluation(
    [requirement('r1', { weight: 3 }), requirement('r2', { weight: 1 })],
    [evidenceFor('r1', 'met'), evidenceFor('r2', 'not_met')],
  );
  const heavyMiss = scoreEvaluation(
    [requirement('r1', { weight: 1 }), requirement('r2', { weight: 3 })],
    [evidenceFor('r1', 'met'), evidenceFor('r2', 'not_met')],
  );

  assert.equal(heavyMet.scoreBasisPoints, 7_500);
  assert.equal(heavyMiss.scoreBasisPoints, 2_500);

  // Both runs produced identical verdicts, so nothing but the weighting moved.
  assert.deepEqual(
    heavyMet.rows.map((row) => row.decision.verdict),
    heavyMiss.rows.map((row) => row.decision.verdict),
  );
});

test('equal weights are a plain average', () => {
  // (10000 + 0) / 2 = 5000.
  const result = scoreEvaluation(
    [requirement('r1'), requirement('r2')],
    [evidenceFor('r1', 'met'), evidenceFor('r2', 'not_met')],
  );

  assert.equal(result.scoreBasisPoints, 5_000);
  assert.equal(result.totalWeight, 2);
});

test('the weight is recorded as it was applied', () => {
  // So an explanation shown next year still adds up even if the spec was
  // edited since.
  const result = scoreEvaluation(
    [requirement('r1', { weight: 5 }), requirement('r2', { weight: 2 })],
    [evidenceFor('r1', 'met'), evidenceFor('r2', 'met')],
  );

  assert.deepEqual(result.rows.map((row) => row.weightApplied), [5, 2]);
  assert.equal(result.totalWeight, 7);
});

// --- the contributions add up ------------------------------------------------

test('the contributions sum to exactly the score, even when the division is not clean', () => {
  // Three equal weights, verdicts met / partial / not met:
  //   score = (10000 + 5000 + 0) / 3 = 5000
  //   naive shares = 3333.33, 1666.67, 0 -> flooring alone loses a basis point
  const requirements = [requirement('r1'), requirement('r2'), requirement('r3')];
  const result = scoreEvaluation(requirements, [
    evidenceFor('r1', 'met'),
    evidenceFor('r2', 'partial'),
    evidenceFor('r3', 'not_met'),
  ]);

  assert.equal(result.scoreBasisPoints, 5_000);
  assert.deepEqual(result.rows.map((row) => row.contributionBasisPoints), [3_333, 1_667, 0]);

  const total = result.rows.reduce((sum, row) => sum + row.contributionBasisPoints, 0);
  assert.equal(total, result.scoreBasisPoints, 'the column must total the headline figure');
});

test('the leftover basis point is handed out in a fixed order when remainders tie', () => {
  // Three equal weights, all met. Each share is 10000/3 = 3333 remainder 1, so
  // all three remainders tie and exactly one basis point has to be placed. It
  // goes to the first requirement, every time.
  const requirements = [requirement('r1'), requirement('r2'), requirement('r3')];
  const evidence = requirements.map((r) => evidenceFor(r.id, 'met'));

  const result = scoreEvaluation(requirements, evidence);

  assert.deepEqual(result.rows.map((row) => row.contributionBasisPoints), [3_334, 3_333, 3_333]);
  assert.equal(
    result.rows.reduce((sum, row) => sum + row.contributionBasisPoints, 0),
    BASIS_POINTS_MAX,
  );
});

test('contributions always sum to the score across many shapes', () => {
  // A sweep rather than one case: apportionment is exactly the kind of code
  // that is right for the example it was written against and wrong elsewhere.
  const verdicts = ['met', 'partial', 'not_met'] as const;
  let checked = 0;

  for (const w1 of [1, 2, 3, 7]) {
    for (const w2 of [1, 3, 5]) {
      for (const w3 of [1, 4, 11]) {
        for (const v1 of verdicts) {
          for (const v2 of verdicts) {
            for (const v3 of verdicts) {
              const requirements = [
                requirement('r1', { weight: w1 }),
                requirement('r2', { weight: w2 }),
                requirement('r3', { weight: w3 }),
              ];
              const result = scoreEvaluation(requirements, [
                evidenceFor('r1', v1),
                evidenceFor('r2', v2),
                evidenceFor('r3', v3),
              ]);

              const total = result.rows.reduce((sum, row) => sum + row.contributionBasisPoints, 0);
              assert.equal(total, result.scoreBasisPoints, `weights ${w1}/${w2}/${w3}, verdicts ${v1}/${v2}/${v3}`);
              assert.ok(result.scoreBasisPoints >= 0 && result.scoreBasisPoints <= BASIS_POINTS_MAX);
              for (const row of result.rows) {
                assert.ok(row.contributionBasisPoints >= 0, 'a contribution can never be negative');
              }
              checked += 1;
            }
          }
        }
      }
    }
  }

  assert.equal(checked, 4 * 3 * 3 * 27, 'the sweep must actually have run');
});

// --- unverified evidence -----------------------------------------------------

test('unverified evidence cannot move the score', () => {
  const requirements = [requirement('r1'), requirement('r2')];

  // Positive control first: with both marked verified the score is 10000, so
  // the evidence below is unambiguously strong enough to matter.
  const counted = scoreEvaluation(requirements, [evidenceFor('r1', 'met'), evidenceFor('r2', 'met')]);
  assert.equal(counted.scoreBasisPoints, BASIS_POINTS_MAX);

  // The same quotes, marked unverified, are worth nothing at all.
  const ignored = scoreEvaluation(requirements, [
    evidenceFor('r1', 'met', false),
    evidenceFor('r2', 'met', false),
  ]);

  assert.equal(ignored.scoreBasisPoints, 0);
  assert.deepEqual(ignored.rows.map((row) => row.decision.verdict), ['unclear', 'unclear']);
});

test('a fabricated quote mixed in with real evidence changes nothing', () => {
  const requirements = [requirement('r1'), requirement('r2')];
  const honest = [evidenceFor('r1', 'met'), evidenceFor('r2', 'partial')];

  const clean = scoreEvaluation(requirements, honest);
  const poisoned = scoreEvaluation(requirements, [
    ...honest,
    { requirementId: 'r2', quote: 'Runs Kubernetes in production at global scale.', verified: false },
  ]);

  assert.ok(clean.scoreBasisPoints > 0, 'precondition: there is a real score to disturb');
  assert.equal(poisoned.scoreBasisPoints, clean.scoreBasisPoints);
  assert.deepEqual(
    poisoned.rows.map((row) => row.decision.verdict),
    clean.rows.map((row) => row.decision.verdict),
  );

  // Negative control: the identical quote, marked verified, DOES lift r2 to
  // met — so the fabricated one was capable of moving the score and was
  // stopped by the flag rather than by being harmless.
  const ifTrusted = scoreEvaluation(requirements, [
    ...honest,
    { requirementId: 'r2', quote: 'Runs Kubernetes in production at global scale.', verified: true },
  ]);
  assert.notEqual(ifTrusted.scoreBasisPoints, clean.scoreBasisPoints);
});

// --- must-haves --------------------------------------------------------------

test('must-haves are counted, and nice-to-haves are not counted among them', () => {
  const requirements = [
    requirement('r1', { kind: 'must_have' }),
    requirement('r2', { kind: 'must_have' }),
    requirement('r3', { kind: 'nice_to_have' }),
  ];

  const result = scoreEvaluation(requirements, [
    evidenceFor('r1', 'met'),
    evidenceFor('r2', 'not_met'),
    evidenceFor('r3', 'met'),
  ]);

  assert.equal(result.mustHavesTotal, 2);
  assert.equal(result.mustHavesMet, 1);
  assert.equal(result.mustHavesUnclear, 0);
});

test('a partial must-have is not a met must-have', () => {
  const result = scoreEvaluation([requirement('r1')], [evidenceFor('r1', 'partial')]);

  assert.equal(result.rows[0]?.decision.verdict, 'partial');
  assert.equal(result.mustHavesMet, 0, 'partially met is not met');
  assert.equal(result.mustHavesTotal, 1);
});

test('a missed must-have does not secretly cap the score', () => {
  // Deliberate: capping here would break the identity that the contributions
  // sum to the score, and the arithmetic would stop being checkable. The counts
  // are stored instead, and ranking applies the gate on read.
  const result = scoreEvaluation(
    [requirement('r1', { kind: 'must_have', weight: 1 }), requirement('r2', { kind: 'nice_to_have', weight: 9 })],
    [evidenceFor('r1', 'not_met'), evidenceFor('r2', 'met')],
  );

  assert.equal(result.scoreBasisPoints, 9_000, '(1x0 + 9x10000) / 10');
  assert.equal(result.mustHavesMet, 0);
  assert.equal(result.mustHavesTotal, 1);
});

// --- determinism and guards --------------------------------------------------

test('the same inputs give a byte-identical breakdown', () => {
  const requirements = [requirement('r1', { weight: 3 }), requirement('r2', { weight: 4 })];
  const evidence = [evidenceFor('r1', 'met'), evidenceFor('r2', 'partial')];

  const first = scoreEvaluation(requirements, evidence);
  const second = scoreEvaluation(requirements, evidence);

  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test('there is one row per requirement, in the requirements own order', () => {
  const requirements = [requirement('r1'), requirement('r2'), requirement('r3')];

  const result = scoreEvaluation(requirements, [evidenceFor('r2', 'met')]);

  assert.deepEqual(result.rows.map((row) => row.requirement.id), ['r1', 'r2', 'r3']);
  assert.equal(new Set(result.rows.map((row) => row.requirement.id)).size, 3);
});

test('scoring against no requirements is refused rather than returning zero', () => {
  // Zero out of zero renders as a rejection, and no candidate may be rejected
  // by an empty job spec.
  assert.throws(() => scoreEvaluation([], []), /at least one requirement/);
});

test('formatScore is display only and never feeds back into arithmetic', () => {
  assert.equal(formatScore(0), '0%');
  assert.equal(formatScore(10_000), '100%');
  assert.equal(formatScore(6_666), '67%');
  assert.equal(formatScore(-5), '0%', 'clamped');
  assert.equal(formatScore(99_999), '100%', 'clamped');
});
