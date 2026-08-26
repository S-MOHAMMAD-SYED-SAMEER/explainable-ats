import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, rankCandidates, type RankInput } from '../src/agent/rankRules.ts';
import type { Evaluation, JobRequirement, MatchVerdict, RequirementMatch } from '../src/domain/ats.ts';

// The ordering rules, on their own.
//
// No database: given evaluations and matches, these tests pin down exactly who
// is placed where and what the list says about it. The integration side is in
// rank.test.ts.

const REQUIREMENTS: JobRequirement[] = [
  {
    id: 'must-a',
    jobId: 'job-1',
    label: 'Node.js',
    criterion: 'Ships Node.js services',
    kind: 'must_have',
    weight: 3,
    position: 1,
    createdAt: '2026-06-01T00:00:00.000Z',
  },
  {
    id: 'must-b',
    jobId: 'job-1',
    label: 'PostgreSQL',
    criterion: 'Runs PostgreSQL at scale',
    kind: 'must_have',
    weight: 2,
    position: 2,
    createdAt: '2026-06-01T00:00:00.000Z',
  },
  {
    id: 'nice-c',
    jobId: 'job-1',
    label: 'Mentoring',
    criterion: 'Mentors junior engineers',
    kind: 'nice_to_have',
    weight: 1,
    position: 3,
    createdAt: '2026-06-01T00:00:00.000Z',
  },
];

let sequence = 0;

function evaluation(overrides: Partial<Evaluation> = {}): Evaluation {
  sequence += 1;
  return {
    id: `eval-${sequence}`,
    jobId: 'job-1',
    candidateId: 'cand-1',
    resumeId: 'resume-1',
    status: 'scored',
    model: 'mock',
    promptVersion: 'extract-v1',
    latencyMs: 0,
    scoreBasisPoints: 5_000,
    mustHavesMet: 2,
    mustHavesTotal: 2,
    failureReason: null,
    supersededBy: null,
    createdAt: `2026-06-01T00:00:0${sequence % 10}.000Z`,
    ...overrides,
  };
}

function match(requirementId: string, verdict: MatchVerdict): RequirementMatch {
  return {
    id: `match-${requirementId}-${verdict}`,
    evaluationId: 'eval-x',
    requirementId,
    verdict,
    confidence: 'high',
    weightApplied: 1,
    contributionBasisPoints: 0,
    rationale: 'because',
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

/** A candidate whose must-haves are both met. */
function passing(id: string, score: number, overrides: Partial<Evaluation> = {}): RankInput {
  return {
    candidate: { id, reference: id, displayName: `Name of ${id}` },
    evaluation: evaluation({
      candidateId: id,
      scoreBasisPoints: score,
      mustHavesMet: 2,
      mustHavesTotal: 2,
      ...overrides,
    }),
    matches: [match('must-a', 'met'), match('must-b', 'met'), match('nice-c', 'met')],
  };
}

function rank(inputs: readonly RankInput[]) {
  return rankCandidates('job-1', REQUIREMENTS, inputs);
}

// --- classification ----------------------------------------------------------

test('meeting every must-have is qualified', () => {
  const result = classify(
    evaluation({ mustHavesMet: 2, mustHavesTotal: 2 }),
    [match('must-a', 'met'), match('must-b', 'met')],
    REQUIREMENTS,
  );

  assert.equal(result.tier, 'qualified');
  assert.deepEqual(result.failedMustHaves, []);
  assert.deepEqual(result.unclearMustHaves, []);
});

test('a must-have the evidence did not demonstrate is gated', () => {
  const result = classify(
    evaluation({ mustHavesMet: 1, mustHavesTotal: 2 }),
    [match('must-a', 'met'), match('must-b', 'not_met')],
    REQUIREMENTS,
  );

  assert.equal(result.tier, 'gated');
  assert.deepEqual(result.failedMustHaves, ['PostgreSQL']);
  assert.deepEqual(result.unclearMustHaves, []);
});

test('a must-have the resume never addressed needs review, not gating', () => {
  // The distinction the whole tier system exists for. "Nothing was quoted" is
  // a gap in the reading; treating it as a failure is how a good candidate
  // disappears.
  const result = classify(
    evaluation({ mustHavesMet: 1, mustHavesTotal: 2 }),
    [match('must-a', 'met'), match('must-b', 'unclear')],
    REQUIREMENTS,
  );

  assert.equal(result.tier, 'needs_review');
  assert.deepEqual(result.unclearMustHaves, ['PostgreSQL']);
  assert.deepEqual(result.failedMustHaves, []);
});

test('a partial must-have is a failure, not an ambiguity', () => {
  // Something WAS found and it did not demonstrate the requirement. That is a
  // finding, and it belongs on the gated side of the line.
  const result = classify(
    evaluation({ mustHavesMet: 1, mustHavesTotal: 2 }),
    [match('must-a', 'met'), match('must-b', 'partial')],
    REQUIREMENTS,
  );

  assert.equal(result.tier, 'gated');
  assert.deepEqual(result.failedMustHaves, ['PostgreSQL']);
});

test('one failure outranks one ambiguity when both are present', () => {
  const result = classify(
    evaluation({ mustHavesMet: 0, mustHavesTotal: 2 }),
    [match('must-a', 'not_met'), match('must-b', 'unclear')],
    REQUIREMENTS,
  );

  assert.equal(result.tier, 'gated', 'the stronger signal decides the tier');
  assert.deepEqual(result.failedMustHaves, ['Node.js']);
  assert.deepEqual(result.unclearMustHaves, ['PostgreSQL'], 'but the ambiguity is still reported');
});

test('a nice-to-have never gates anyone', () => {
  const result = classify(
    evaluation({ mustHavesMet: 2, mustHavesTotal: 2 }),
    [match('must-a', 'met'), match('must-b', 'met'), match('nice-c', 'not_met')],
    REQUIREMENTS,
  );

  assert.equal(result.tier, 'qualified');
});

test('a missing match is treated as unaddressed, never as failed', () => {
  // Fails safe. If a match row is absent for any reason, the candidate is sent
  // for review rather than blamed for a row that was never written.
  const result = classify(
    evaluation({ mustHavesMet: 1, mustHavesTotal: 2 }),
    [match('must-a', 'met')],
    REQUIREMENTS,
  );

  assert.equal(result.tier, 'needs_review');
  assert.deepEqual(result.unclearMustHaves, ['PostgreSQL']);
});

test('an evaluation that was never scored is not evaluated', () => {
  for (const status of ['pending', 'extracted', 'failed'] as const) {
    const result = classify(evaluation({ status }), [], REQUIREMENTS);
    assert.equal(result.tier, 'not_evaluated', `status ${status}`);
  }

  assert.equal(classify(null, [], REQUIREMENTS).tier, 'not_evaluated');
});

// --- ordering ----------------------------------------------------------------

test('a higher score ranks higher when the gate treats both the same', () => {
  const result = rank([passing('c-low', 4_000), passing('c-high', 9_000), passing('c-mid', 6_000)]);

  assert.deepEqual(result.entries.map((entry) => entry.candidateId), ['c-high', 'c-mid', 'c-low']);
  assert.deepEqual(result.entries.map((entry) => entry.rank), [1, 2, 3]);
  assert.equal(result.rankedCount, 3);
});

test('a failed must-have ranks below a lower-scoring candidate who meets them all', () => {
  // The gate, doing the only thing it is for. "Strong overall but cannot do the
  // job" is a sentence a ranking must never produce.
  const strongButGated: RankInput = {
    candidate: { id: 'c-gated', reference: 'c-gated', displayName: null },
    evaluation: evaluation({ candidateId: 'c-gated', scoreBasisPoints: 9_500, mustHavesMet: 1, mustHavesTotal: 2 }),
    matches: [match('must-a', 'met'), match('must-b', 'not_met')],
  };

  const result = rank([strongButGated, passing('c-clean', 3_000)]);

  assert.deepEqual(result.entries.map((entry) => entry.candidateId), ['c-clean', 'c-gated']);
  assert.deepEqual(result.entries.map((entry) => entry.tier), ['qualified', 'gated']);
});

test('the gate moves the placement and leaves the stored score untouched', () => {
  const gated: RankInput = {
    candidate: { id: 'c-gated', reference: 'c-gated', displayName: null },
    evaluation: evaluation({ candidateId: 'c-gated', scoreBasisPoints: 9_500, mustHavesMet: 1, mustHavesTotal: 2 }),
    matches: [match('must-a', 'met'), match('must-b', 'not_met')],
  };

  const result = rank([gated, passing('c-clean', 3_000)]);
  const entry = result.entries.find((e) => e.candidateId === 'c-gated');

  assert.equal(entry?.scoreBasisPoints, 9_500, 'the number is reported exactly as the scorer committed it');
  assert.equal(entry?.rank, 2);
  assert.match(entry?.rationale ?? '', /the score itself is unchanged/);
});

test('needs-review sits between qualified and gated', () => {
  const review: RankInput = {
    candidate: { id: 'c-review', reference: 'c-review', displayName: null },
    evaluation: evaluation({ candidateId: 'c-review', scoreBasisPoints: 1_000, mustHavesMet: 1, mustHavesTotal: 2 }),
    matches: [match('must-a', 'met'), match('must-b', 'unclear')],
  };
  const gated: RankInput = {
    candidate: { id: 'c-gated', reference: 'c-gated', displayName: null },
    evaluation: evaluation({ candidateId: 'c-gated', scoreBasisPoints: 9_900, mustHavesMet: 1, mustHavesTotal: 2 }),
    matches: [match('must-a', 'met'), match('must-b', 'not_met')],
  };

  const result = rank([gated, review, passing('c-clean', 2_000)]);

  assert.deepEqual(result.entries.map((entry) => entry.tier), ['qualified', 'needs_review', 'gated']);
  assert.deepEqual(result.entries.map((entry) => entry.candidateId), ['c-clean', 'c-review', 'c-gated']);
});

test('an unevaluated candidate is listed, unranked, and explained', () => {
  // Visibly absent rather than silently missing: a list that quietly omits
  // someone looks complete and is not.
  const never: RankInput = {
    candidate: { id: 'c-none', reference: 'c-none', displayName: null },
    evaluation: null,
    matches: [],
  };
  const pending: RankInput = {
    candidate: { id: 'c-pending', reference: 'c-pending', displayName: null },
    evaluation: evaluation({ candidateId: 'c-pending', status: 'pending', scoreBasisPoints: null, mustHavesMet: null, mustHavesTotal: null }),
    matches: [],
  };

  const result = rank([never, pending, passing('c-clean', 5_000)]);

  assert.equal(result.rankedCount, 1);
  assert.equal(result.notEvaluatedCount, 2);
  assert.equal(result.entries[0]?.candidateId, 'c-clean', 'the evaluated candidate comes first');

  const unranked = result.entries.filter((entry) => entry.rank === null);
  assert.equal(unranked.length, 2);
  for (const entry of unranked) {
    assert.equal(entry.tier, 'not_evaluated');
    assert.equal(entry.scoreBasisPoints, null, 'an unscored candidate must not be given a number');
    assert.match(entry.rationale, /^Not ranked\./);
  }

  assert.match(
    result.entries.find((e) => e.candidateId === 'c-none')?.rationale ?? '',
    /no evaluation of this candidate for this job yet/,
  );
  assert.match(
    result.entries.find((e) => e.candidateId === 'c-pending')?.rationale ?? '',
    /has not been scored/,
  );
});

test('every entry gets a position, so the display order is always total', () => {
  const result = rank([
    passing('c-1', 5_000),
    { candidate: { id: 'c-2', reference: 'c-2', displayName: null }, evaluation: null, matches: [] },
    passing('c-3', 5_000),
  ]);

  assert.deepEqual(result.entries.map((entry) => entry.position), [1, 2, 3]);
});

// --- ties --------------------------------------------------------------------

test('a genuine tie is reported as a tie, not dressed up as a win', () => {
  // The final tie-break is the candidate id: arbitrary but stable. Because it
  // IS arbitrary, the list must not claim one of them came out ahead.
  const result = rank([passing('c-b', 7_000), passing('c-a', 7_000)]);

  assert.deepEqual(result.entries.map((entry) => entry.rank), [1, 1]);
  assert.deepEqual(result.entries.map((entry) => entry.tiedWith), [1, 1]);
  for (const entry of result.entries) {
    assert.match(entry.rationale, /tied with 1 other\./);
  }
});

test('competition ranking skips after a tie', () => {
  const result = rank([passing('c-a', 9_000), passing('c-b', 9_000), passing('c-c', 1_000)]);

  assert.deepEqual(result.entries.map((entry) => entry.rank), [1, 1, 3]);
  assert.deepEqual(result.entries.map((entry) => entry.tiedWith), [1, 1, 0]);
});

test('tie-breaking is deterministic and does not depend on input order', () => {
  const inputs = [passing('c-c', 5_000), passing('c-a', 5_000), passing('c-b', 5_000)];

  const forwards = rank(inputs);
  const backwards = rank([...inputs].reverse());
  const shuffled = rank([inputs[1] as RankInput, inputs[2] as RankInput, inputs[0] as RankInput]);

  assert.deepEqual(forwards.entries.map((e) => e.candidateId), backwards.entries.map((e) => e.candidateId));
  assert.deepEqual(forwards.entries.map((e) => e.candidateId), shuffled.entries.map((e) => e.candidateId));
  assert.deepEqual(forwards.entries.map((e) => e.rank), [1, 1, 1]);
});

test('an earlier evaluation breaks a tie before the candidate id does', () => {
  const early = passing('c-zzz', 5_000, { createdAt: '2026-06-01T00:00:00.000Z' });
  const late = passing('c-aaa', 5_000, { createdAt: '2026-06-02T00:00:00.000Z' });

  const result = rank([late, early]);

  assert.deepEqual(result.entries.map((entry) => entry.candidateId), ['c-zzz', 'c-aaa']);
  assert.deepEqual(result.entries.map((entry) => entry.rank), [1, 1], 'ordering is not a claim of superiority');
});

test('running twice gives a byte-identical ranking', () => {
  const inputs = [passing('c-a', 5_000), passing('c-b', 8_000), passing('c-c', 5_000)];

  assert.equal(JSON.stringify(rank(inputs)), JSON.stringify(rank(inputs)));
});

// --- what must not influence the order ---------------------------------------

test('the candidate display name cannot move anyone', () => {
  // The name is carried for display. Nothing in the ordering reads it, and
  // this is what says so.
  const withNames = [passing('c-a', 5_000), passing('c-b', 5_000), passing('c-c', 9_000)];
  const renamed = withNames.map((input, index) => ({
    ...input,
    candidate: { ...input.candidate, displayName: ['Zara Ahmed', 'Aaron Zeff', null][index] as string | null },
  }));

  const before = rank(withNames);
  const after = rank(renamed);

  assert.deepEqual(after.entries.map((e) => e.candidateId), before.entries.map((e) => e.candidateId));
  assert.deepEqual(after.entries.map((e) => e.rank), before.entries.map((e) => e.rank));

  // Positive control: the names really did change, so the invariance above is
  // not passing because nothing happened.
  assert.notDeepEqual(after.entries.map((e) => e.displayName), before.entries.map((e) => e.displayName));
});

test('an empty job ranks to an empty list rather than an error', () => {
  const result = rank([]);

  assert.deepEqual(result.entries, []);
  assert.equal(result.rankedCount, 0);
  assert.equal(result.notEvaluatedCount, 0);
});

// --- the explanation matches the decision ------------------------------------

test('every rationale states the tier it was actually given', () => {
  const gated: RankInput = {
    candidate: { id: 'c-gated', reference: 'c-gated', displayName: null },
    evaluation: evaluation({ candidateId: 'c-gated', scoreBasisPoints: 8_000, mustHavesMet: 1, mustHavesTotal: 2 }),
    matches: [match('must-a', 'met'), match('must-b', 'not_met')],
  };
  const review: RankInput = {
    candidate: { id: 'c-review', reference: 'c-review', displayName: null },
    evaluation: evaluation({ candidateId: 'c-review', scoreBasisPoints: 6_000, mustHavesMet: 1, mustHavesTotal: 2 }),
    matches: [match('must-a', 'met'), match('must-b', 'unclear')],
  };

  const result = rank([gated, review, passing('c-clean', 7_000)]);

  const byId = new Map(result.entries.map((entry) => [entry.candidateId, entry]));

  assert.match(byId.get('c-clean')?.rationale ?? '', /Ranked 1 of 3\. Meets all 2 must-haves, scoring 70%\./);
  assert.match(byId.get('c-review')?.rationale ?? '', /Ranked 2 of 3\./);
  assert.match(byId.get('c-review')?.rationale ?? '', /said nothing about "PostgreSQL"/);
  assert.match(byId.get('c-review')?.rationale ?? '', /unresolved rather than failed/);
  assert.match(byId.get('c-gated')?.rationale ?? '', /Ranked 3 of 3\./);
  assert.match(byId.get('c-gated')?.rationale ?? '', /does not demonstrate "PostgreSQL"/);
});

test('the rationale never claims a rank the entry does not have', () => {
  // The explanation and the decision are produced from the same object, and
  // this asserts they agree — a page whose text contradicts its own sort order
  // is worse than one with no explanation at all.
  const result = rank([
    passing('c-a', 9_000),
    passing('c-b', 9_000),
    passing('c-c', 1_000),
    { candidate: { id: 'c-d', reference: 'c-d', displayName: null }, evaluation: null, matches: [] },
  ]);

  for (const entry of result.entries) {
    if (entry.rank === null) {
      assert.match(entry.rationale, /^Not ranked\./);
      continue;
    }
    assert.match(entry.rationale, new RegExp(`^Ranked ${entry.rank} of ${result.rankedCount}[.,]`));

    if (entry.tiedWith > 0) assert.match(entry.rationale, /tied with/);
    else assert.ok(!/tied with/.test(entry.rationale), 'an untied entry must not claim a tie');
  }
});

test('the reported score in the rationale is the stored score, rounded only for display', () => {
  const result = rank([passing('c-a', 6_666)]);

  assert.equal(result.entries[0]?.scoreBasisPoints, 6_666, 'the stored value is reported unchanged');
  assert.match(result.entries[0]?.rationale ?? '', /scoring 67%/);
});

test('a ranked candidate carries a percentage that matches its stored score', () => {
  // The browser is forbidden from dividing a score, so the ranking has to
  // arrive with the rounding already done. Without this, the server could stop
  // populating it and every candidate would silently render as unassessed.
  const result = rank([passing('c-a', 6_666), passing('c-b', 10_000), passing('c-c', 0)]);

  assert.deepEqual(result.entries.map((entry) => entry.scorePercent), ['100%', '67%', '0%']);
  for (const entry of result.entries) {
    assert.equal(typeof entry.scorePercent, 'string');
    assert.match(entry.scorePercent as string, /^\d+%$/);
  }
});

test('an unassessed candidate carries no percentage, because there is no score', () => {
  const result = rank([
    { candidate: { id: 'c-none', reference: 'c-none', displayName: null }, evaluation: null, matches: [] },
    passing('c-a', 5_000),
  ]);

  const unranked = result.entries.find((entry) => entry.rank === null);
  assert.equal(unranked?.scorePercent, null, 'a number here would be a score nobody computed');
  assert.equal(unranked?.scoreBasisPoints, null);

  const ranked = result.entries.find((entry) => entry.rank !== null);
  assert.equal(ranked?.scorePercent, '50%');
});
