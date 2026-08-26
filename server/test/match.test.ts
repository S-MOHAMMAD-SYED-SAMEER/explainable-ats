import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { matchAndScore } from '../src/agent/match.ts';
import { extractEvidence, openEvaluation } from '../src/agent/extract.ts';
import { createTestContext, rejects, MIGRATIONS_DIR, type TestContext } from './helpers.ts';
import { seedScenario } from './fixtures.ts';

// Matching and scoring, against the database.
//
// The pure rules are pinned in match-rules.test.ts and score.test.ts. What is
// checked here is everything those cannot see: what gets read, what gets
// written, what happens when it goes wrong, and the trail left behind.

// Quotes engineered to produce one exact verdict against the seeded job. The
// term counts are hand-checked in the preconditions of the first test.
const QUOTES = {
  nodeMet: 'Designed and shipped production Node.js services.',
  nodePartial: 'Shipped a Node.js tool.',
  nodeNotMet: 'Node.js.',
  postgresMet: 'Run PostgreSQL migrations at scale.',
  mentoringMet: 'Mentoring: mentored junior engineers.',
} as const;

type EvidenceSpec = { requirement: 0 | 1 | 2; quote: string; verified?: boolean };

/** A scenario advanced to `extracted`, carrying exactly the evidence asked for. */
async function seedExtracted(ctx: TestContext, evidence: readonly EvidenceSpec[]) {
  const scenario = await seedScenario(ctx.repos, { deterministicExtractor: false });

  const extracted = await ctx.repos.evaluations.recordExtraction(scenario.evaluation.id, {
    model: 'mock',
    promptVersion: 'extract-v1',
    latencyMs: 0,
  });
  assert.ok(extracted, 'precondition: the evaluation reached extracted');

  for (const item of evidence) {
    const requirement = scenario.requirements[item.requirement];
    assert.ok(requirement, 'precondition: the seeded job has that requirement');
    await ctx.repos.evidence.record({
      evaluationId: scenario.evaluation.id,
      resumeId: scenario.resume.id,
      requirementId: requirement.id,
      quote: item.quote,
      charStart: 0,
      charEnd: item.quote.length,
      verified: item.verified ?? true,
    });
  }

  return scenario;
}

// --- the arithmetic, end to end ----------------------------------------------

test('a scored evaluation records the number, the counts and one match per requirement', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  // Seeded weights are 3 (must), 2 (must), 1 (nice), totalling 6.
  //   met / not met / met  ->  (3x10000 + 2x0 + 1x10000) / 6 = 6666
  const scenario = await seedExtracted(ctx, [
    { requirement: 0, quote: QUOTES.nodeMet },
    { requirement: 1, quote: QUOTES.nodeNotMet },
    { requirement: 2, quote: QUOTES.mentoringMet },
  ]);
  assert.deepEqual(scenario.requirements.map((r) => r.weight), [3, 2, 1], 'precondition');
  assert.deepEqual(scenario.requirements.map((r) => r.kind), ['must_have', 'must_have', 'nice_to_have']);

  const outcome = await matchAndScore({ repos: ctx.repos }, scenario.evaluation.id);

  assert.deepEqual(outcome.breakdown.rows.map((row) => row.decision.verdict), ['met', 'not_met', 'met']);
  assert.equal(outcome.breakdown.scoreBasisPoints, 6_666);
  assert.equal(outcome.evaluation.status, 'scored');
  assert.equal(outcome.evaluation.scoreBasisPoints, 6_666);
  assert.equal(outcome.evaluation.mustHavesMet, 1);
  assert.equal(outcome.evaluation.mustHavesTotal, 2);

  const matches = await ctx.repos.matches.listForEvaluation(scenario.evaluation.id);
  assert.equal(matches.length, 3, 'exactly one match per requirement');
  assert.equal(new Set(matches.map((m) => m.requirementId)).size, 3);
  assert.deepEqual(matches.map((m) => m.contributionBasisPoints), [5_000, 0, 1_666]);
  assert.equal(
    matches.reduce((sum, m) => sum + m.contributionBasisPoints, 0),
    6_666,
    'the stored contributions must total the stored score',
  );

  for (const match of matches) {
    assert.ok(match.rationale.length > 30, 'every match must carry an explanation');
    assert.ok(match.weightApplied > 0);
  }
});

test('every requirement gets a match, including ones the resume never addressed', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  // Only one requirement has evidence. The other two must still be explained.
  const scenario = await seedExtracted(ctx, [{ requirement: 0, quote: QUOTES.nodeMet }]);

  await matchAndScore({ repos: ctx.repos }, scenario.evaluation.id);
  const matches = await ctx.repos.matches.listForEvaluation(scenario.evaluation.id);

  assert.equal(matches.length, 3);
  assert.deepEqual(
    scenario.requirements.map((r) => r.id).sort(),
    matches.map((m) => m.requirementId).sort(),
  );

  const silent = matches.filter((m) => m.verdict === 'unclear');
  assert.equal(silent.length, 2);
  for (const match of silent) {
    assert.match(match.rationale, /not a finding against the candidate/);
  }
});

test('the score follows the evidence, not the candidate name', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  // Same evidence, different display name. The name is a column the scorer has
  // no reason to read, and this is what says so.
  const scores: number[] = [];
  for (const displayName of ['Priya Raman', 'John Smith']) {
    const inner = await createTestContext();
    t.after(() => inner.close());

    const scenario = await seedScenario(inner.repos, { deterministicExtractor: false });
    await inner.repos.db.execute('UPDATE candidates SET display_name = ? WHERE id = ?', [
      displayName,
      scenario.candidate.id,
    ]);
    await inner.repos.evaluations.recordExtraction(scenario.evaluation.id, {
      model: 'mock',
      promptVersion: 'extract-v1',
      latencyMs: 0,
    });
    await inner.repos.evidence.record({
      evaluationId: scenario.evaluation.id,
      resumeId: scenario.resume.id,
      requirementId: scenario.requirements[0]?.id,
      quote: QUOTES.nodeMet,
      charStart: 0,
      charEnd: QUOTES.nodeMet.length,
      verified: true,
    });

    const outcome = await matchAndScore({ repos: inner.repos }, scenario.evaluation.id);
    scores.push(outcome.breakdown.scoreBasisPoints);
  }

  assert.ok((scores[0] as number) > 0, 'precondition: there is a real score to compare');
  assert.equal(scores[1], scores[0]);
});

// --- verified evidence only --------------------------------------------------

test('unverified evidence is excluded from the score and reported as excluded', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedExtracted(ctx, [
    { requirement: 0, quote: QUOTES.nodeMet, verified: true },
    { requirement: 1, quote: QUOTES.postgresMet, verified: false },
  ]);

  const outcome = await matchAndScore({ repos: ctx.repos }, scenario.evaluation.id);

  assert.equal(outcome.evidenceIgnored, 1);
  assert.deepEqual(outcome.breakdown.rows.map((row) => row.decision.verdict), ['met', 'unclear', 'unclear']);

  // (3x10000 + 2x0 + 1x0) / 6 = 5000
  assert.equal(outcome.breakdown.scoreBasisPoints, 5_000);

  const events = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  const ignored = events.find((event) => event.eventType === 'unverified_evidence_ignored');
  assert.equal(ignored?.outcome, 'blocked');
  assert.equal(ignored?.payload.ignored, 1);
  assert.equal(ignored?.payload.counted, 1);
});

test('the identical quote counts once it is verified — so exclusion is the flag, not the text', async (t) => {
  // The positive control for the test above. Without it, "unverified evidence
  // scored 0" could equally mean the quote was too weak to score.
  const unverified = await createTestContext();
  const verified = await createTestContext();
  t.after(() => Promise.all([unverified.close(), verified.close()]));

  const a = await seedExtracted(unverified, [{ requirement: 1, quote: QUOTES.postgresMet, verified: false }]);
  const b = await seedExtracted(verified, [{ requirement: 1, quote: QUOTES.postgresMet, verified: true }]);

  const scoreA = await matchAndScore({ repos: unverified.repos }, a.evaluation.id);
  const scoreB = await matchAndScore({ repos: verified.repos }, b.evaluation.id);

  assert.equal(scoreA.breakdown.rows[1]?.decision.verdict, 'unclear');
  assert.equal(scoreB.breakdown.rows[1]?.decision.verdict, 'met');
  assert.equal(scoreA.breakdown.scoreBasisPoints, 0);
  assert.equal(scoreB.breakdown.scoreBasisPoints, 3_333, '(3x0 + 2x10000 + 1x0) / 6');
});

test('a fabrication that survived into the table cannot reach the score', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  // This is the shape P3-C leaves behind: the rejected quote is deliberately
  // stored so it stays visible in the audit view. Scoring it would be the single
  // most damaging bug this codebase could contain.
  const scenario = await seedScenario(ctx.repos, { deterministicExtractor: false });
  const invented = 'Ran Kubernetes and PostgreSQL migrations at scale for twelve teams.';
  scenario.provider.register('extract_evidence', {
    findings: [
      {
        requirementId: scenario.requirements[1]?.id,
        quote: invented,
        charStart: 0,
        charEnd: invented.length,
        reasoning: 'Sounds like scale.',
      },
    ],
  });

  const extraction = await extractEvidence(
    { repos: ctx.repos, provider: scenario.provider },
    scenario.evaluation.id,
  );
  assert.equal(extraction.rejected, 1, 'precondition: the quote was rejected as unverifiable');
  assert.equal((await ctx.repos.evidence.listForEvaluation(scenario.evaluation.id)).length, 1);

  const outcome = await matchAndScore({ repos: ctx.repos }, scenario.evaluation.id);

  assert.equal(outcome.breakdown.scoreBasisPoints, 0);
  assert.equal(outcome.evidenceIgnored, 1);
  assert.deepEqual(outcome.breakdown.rows.map((row) => row.decision.verdict), ['unclear', 'unclear', 'unclear']);
});

test('the full pipeline scores a real resume from verified evidence alone', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos);
  const extraction = await extractEvidence(
    { repos: ctx.repos, provider: scenario.provider },
    scenario.evaluation.id,
  );
  assert.ok(extraction.verified > 0, 'precondition: extraction found something');
  assert.equal(extraction.rejected, 0);

  const outcome = await matchAndScore({ repos: ctx.repos }, scenario.evaluation.id);

  assert.equal(outcome.evidenceIgnored, 0);
  assert.equal(outcome.evaluation.status, 'scored');
  assert.ok(outcome.breakdown.scoreBasisPoints > 0);
  assert.ok(outcome.breakdown.scoreBasisPoints <= 10_000);
  assert.equal(
    outcome.breakdown.rows.reduce((sum, row) => sum + row.contributionBasisPoints, 0),
    outcome.breakdown.scoreBasisPoints,
  );
});

// --- determinism -------------------------------------------------------------

test('two runs over identical inputs produce the identical score and matches', async (t) => {
  const runs: Array<Array<[string, number, number]>> = [];
  const scores: number[] = [];

  for (let i = 0; i < 2; i += 1) {
    const ctx = await createTestContext();
    t.after(() => ctx.close());

    const scenario = await seedExtracted(ctx, [
      { requirement: 0, quote: QUOTES.nodePartial },
      { requirement: 1, quote: QUOTES.postgresMet },
    ]);
    const outcome = await matchAndScore({ repos: ctx.repos }, scenario.evaluation.id);

    scores.push(outcome.breakdown.scoreBasisPoints);
    const matches = await ctx.repos.matches.listForEvaluation(scenario.evaluation.id);
    runs.push(matches.map((m) => [m.verdict, m.weightApplied, m.contributionBasisPoints]));
  }

  assert.ok((scores[0] as number) > 0, 'precondition');
  assert.equal(scores[1], scores[0]);
  assert.deepEqual(runs[1], runs[0]);
});

test('the order evidence was inserted in does not change the outcome', async (t) => {
  const forwards = await createTestContext();
  const backwards = await createTestContext();
  t.after(() => Promise.all([forwards.close(), backwards.close()]));

  const spec: EvidenceSpec[] = [
    { requirement: 0, quote: QUOTES.nodeMet },
    { requirement: 1, quote: QUOTES.postgresMet },
    { requirement: 2, quote: QUOTES.mentoringMet },
  ];

  const a = await seedExtracted(forwards, spec);
  const b = await seedExtracted(backwards, [...spec].reverse());

  const first = await matchAndScore({ repos: forwards.repos }, a.evaluation.id);
  const second = await matchAndScore({ repos: backwards.repos }, b.evaluation.id);

  assert.equal(first.breakdown.scoreBasisPoints, 10_000);
  assert.equal(second.breakdown.scoreBasisPoints, first.breakdown.scoreBasisPoints);
  assert.deepEqual(
    second.breakdown.rows.map((row) => row.decision.verdict),
    first.breakdown.rows.map((row) => row.decision.verdict),
  );
});

// --- the model cannot reach this stage ---------------------------------------

test('the scoring stage imports no model provider at all', async () => {
  // Structural, not a promise in a comment. The claim of the whole product is
  // that the model cites and deterministic code judges; a provider import here
  // would be the first step to breaking it, and a test is cheaper than
  // vigilance.
  const dir = path.resolve(import.meta.dirname, '../src/agent');
  for (const file of ['match.ts', 'score.ts', 'matchRules.ts']) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const imports = [...source.matchAll(/^import[\s\S]*?from '([^']+)';/gm)].map((m) => m[1] as string);

    for (const specifier of imports) {
      assert.ok(!/adapters\/llm|anthropic/i.test(specifier), `${file} imports ${specifier}`);
    }
    assert.ok(!/\bcomplete\(/.test(source), `${file} appears to call a provider`);
  }
});

// --- lifecycle and superseding ----------------------------------------------

test('an evaluation that never extracted cannot be scored', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  // A number with nothing behind it is the one thing this system must not be
  // able to produce.
  const scenario = await seedScenario(ctx.repos, { deterministicExtractor: false });
  assert.equal(scenario.evaluation.status, 'pending', 'precondition');

  const err = await rejects(() => matchAndScore({ repos: ctx.repos }, scenario.evaluation.id));

  assert.match(err.message, /must be extracted/);
  assert.equal(await ctx.repos.matches.count(), 0);
  const untouched = await ctx.repos.evaluations.getById(scenario.evaluation.id);
  assert.equal(untouched?.scoreBasisPoints, null);
});

test('scoring twice is refused rather than silently rewriting the number', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedExtracted(ctx, [{ requirement: 0, quote: QUOTES.nodeMet }]);
  await matchAndScore({ repos: ctx.repos }, scenario.evaluation.id);

  const err = await rejects(() => matchAndScore({ repos: ctx.repos }, scenario.evaluation.id));

  assert.match(err.message, /already been scored/);
  assert.equal(await ctx.repos.matches.count(), 3, 'no second set of matches was written');
});

test('a superseded evaluation cannot be scored, so one candidate never has two current answers', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedExtracted(ctx, [{ requirement: 0, quote: QUOTES.nodeMet }]);

  // Opening a new evaluation supersedes the old one before it was ever scored.
  const replacement = await openEvaluation({ repos: ctx.repos }, {
    jobId: scenario.job.id,
    candidateId: scenario.candidate.id,
    resume: scenario.resume,
  });
  const stale = await ctx.repos.evaluations.getById(scenario.evaluation.id);
  assert.equal(stale?.supersededBy, replacement.id, 'precondition');
  assert.equal(stale?.status, 'extracted', 'precondition: it would otherwise be scorable');

  const err = await rejects(() => matchAndScore({ repos: ctx.repos }, scenario.evaluation.id));

  assert.match(err.message, /superseded/);
  assert.equal(await ctx.repos.matches.count(), 0);
});

test('re-evaluating supersedes cleanly, and the old score and matches survive intact', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const first = await seedExtracted(ctx, [{ requirement: 0, quote: QUOTES.nodePartial }]);
  const before = await matchAndScore({ repos: ctx.repos }, first.evaluation.id);
  const beforeMatches = await ctx.repos.matches.listForEvaluation(first.evaluation.id);
  assert.ok(before.breakdown.scoreBasisPoints > 0, 'precondition');

  // A second look at the same candidate, with better evidence this time.
  const second = await openEvaluation({ repos: ctx.repos }, {
    jobId: first.job.id,
    candidateId: first.candidate.id,
    resume: first.resume,
  });
  await ctx.repos.evaluations.recordExtraction(second.id, {
    model: 'mock',
    promptVersion: 'extract-v1',
    latencyMs: 0,
  });
  await ctx.repos.evidence.record({
    evaluationId: second.id,
    resumeId: first.resume.id,
    requirementId: first.requirements[0]?.id,
    quote: QUOTES.nodeMet,
    charStart: 0,
    charEnd: QUOTES.nodeMet.length,
    verified: true,
  });

  const after = await matchAndScore({ repos: ctx.repos }, second.id);

  assert.ok(after.breakdown.scoreBasisPoints > before.breakdown.scoreBasisPoints);

  // History is what makes a decision from last month explainable, so the
  // superseded evaluation keeps its own number and its own explanations.
  const old = await ctx.repos.evaluations.getById(first.evaluation.id);
  assert.equal(old?.supersededBy, second.id);
  assert.equal(old?.scoreBasisPoints, before.breakdown.scoreBasisPoints);
  assert.deepEqual(
    (await ctx.repos.matches.listForEvaluation(first.evaluation.id)).map((m) => m.verdict),
    beforeMatches.map((m) => m.verdict),
  );

  // And only one evaluation is current.
  const current = await ctx.repos.evaluations.getCurrent(first.job.id, first.candidate.id);
  assert.equal(current?.id, second.id);
  assert.equal((await ctx.repos.evaluations.listCurrentForJob(first.job.id)).length, 1);
});

test('scoring an evaluation that does not exist is a not-found, not a crash', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const err = await rejects(() => matchAndScore({ repos: ctx.repos }, 'no-such-evaluation'));
  assert.match(err.message, /does not exist/);
});

test('a failed match write leaves no score and no half-written explanation', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedExtracted(ctx, [{ requirement: 0, quote: QUOTES.nodeMet }]);

  // A match already exists for the SECOND requirement, so the loop writes the
  // first, then collides on the unique constraint. A score without its matches
  // is an unexplainable number, so both must roll back together.
  await ctx.repos.matches.record({
    evaluationId: scenario.evaluation.id,
    requirementId: scenario.requirements[1]?.id as string,
    verdict: 'met',
    confidence: 'high',
    weightApplied: 2,
    contributionBasisPoints: 0,
    rationale: 'planted by the test',
  });

  await rejects(() => matchAndScore({ repos: ctx.repos }, scenario.evaluation.id));

  const evaluation = await ctx.repos.evaluations.getById(scenario.evaluation.id);
  assert.equal(evaluation?.status, 'extracted', 'the status must not have advanced');
  assert.equal(evaluation?.scoreBasisPoints, null);

  const matches = await ctx.repos.matches.listForEvaluation(scenario.evaluation.id);
  assert.equal(matches.length, 1, 'only the planted row remains');
  assert.equal(matches[0]?.rationale, 'planted by the test');
});

// --- the audit trail ---------------------------------------------------------

test('scoring writes a trail the number can be recomputed from', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedExtracted(ctx, [
    { requirement: 0, quote: QUOTES.nodeMet },
    { requirement: 1, quote: QUOTES.postgresMet },
  ]);
  const outcome = await matchAndScore({ repos: ctx.repos }, scenario.evaluation.id);

  const events = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  const types = events.map((event) => event.eventType);

  assert.deepEqual(types, ['evaluation_opened', 'requirements_matched', 'score_computed']);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3], 'append-only, with no gaps');

  const matched = events.find((event) => event.eventType === 'requirements_matched');
  assert.ok(matched, 'the match event must exist before it can be inspected');
  assert.equal(matched.stage, 'match');
  assert.equal(matched.actor, 'system', 'no model took part in this decision');
  assert.equal((matched.payload.verdicts as unknown[]).length, 3);

  const scored = events.find((event) => event.eventType === 'score_computed');
  assert.ok(scored, 'the score event must exist before it can be inspected');
  assert.equal(scored.stage, 'score');
  assert.equal(scored.actor, 'system');
  assert.equal(scored.payload.scoreBasisPoints, outcome.breakdown.scoreBasisPoints);
  assert.equal(scored.payload.totalWeight, 6);

  // The payload has to be enough to redo the arithmetic without the database.
  const contributions = scored.payload.contributions as Array<{ contributionBasisPoints: number }>;
  assert.equal(contributions.length, 3);
  assert.equal(
    contributions.reduce((sum, row) => sum + row.contributionBasisPoints, 0),
    outcome.breakdown.scoreBasisPoints,
  );
});

test('the audit trail carries no candidate name and no resume text', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedExtracted(ctx, [{ requirement: 0, quote: QUOTES.nodeMet }]);
  await matchAndScore({ repos: ctx.repos }, scenario.evaluation.id);

  const events = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  const serialised = JSON.stringify(events);

  assert.ok(scenario.candidate.displayName, 'precondition: the system knows a name');
  assert.ok(!serialised.includes(scenario.candidate.displayName));
  assert.ok(!serialised.includes('priya.raman@example.com'));
});

test('there is no way to update or delete an audit event', async () => {
  // Append-only by absence: the repository simply has no such method. A trail
  // that can be edited is not a trail.
  const { createAuditRepository } = await import('../src/db/repositories/audit.ts');
  const methods = Object.keys(createAuditRepository({} as never));

  assert.ok(methods.includes('append'), 'precondition: the repository was actually inspected');
  for (const forbidden of ['update', 'delete', 'remove', 'set', 'edit']) {
    assert.ok(!methods.includes(forbidden), `audit repository exposes ${forbidden}`);
  }
});

// --- ranking stays derived ---------------------------------------------------

test('no ranking table exists, and P3-D added no table at all', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const rows = await ctx.db.query<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const tables = rows.map((row) => row.name);

  assert.ok(tables.length > 0, 'precondition: the schema was actually read');
  assert.deepEqual(tables, [
    'audit_events',
    'candidates',
    'evaluations',
    'evidence',
    'job_requirements',
    'jobs',
    'recruiter_decisions',
    'requirement_matches',
    'resumes',
    'schema_migrations',
    'sensitive_findings',
    'sessions',
  ]);
});

test('nothing in the schema stores a rank or a position in a list', async () => {
  // A stored ranking is a second source of truth that drifts the moment one
  // evaluation is superseded and the other is not. It is computed on read.
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql'));
  assert.ok(files.length > 0, 'precondition: migrations were found');

  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const withoutComments = sql.replace(/--[^\n]*/g, '');

    assert.ok(!/CREATE TABLE\s+\w*rank/i.test(withoutComments), `${file} creates a ranking table`);
    assert.ok(!/\brank\w*\s+(INTEGER|TEXT|NUMERIC)/i.test(withoutComments), `${file} stores a rank column`);
  }
});

test('the scorer writes only to requirement_matches and evaluations', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedExtracted(ctx, [{ requirement: 0, quote: QUOTES.nodeMet }]);

  const before = {
    evidence: await ctx.repos.evidence.count(),
    resumes: await ctx.repos.resumes.count(),
    candidates: await ctx.repos.candidates.count(),
    findings: await ctx.repos.sensitiveFindings.count(),
  };
  assert.ok(before.evidence > 0, 'precondition: there is evidence that could have been mutated');

  await matchAndScore({ repos: ctx.repos }, scenario.evaluation.id);

  assert.equal(await ctx.repos.evidence.count(), before.evidence, 'evidence must be read-only here');
  assert.equal(await ctx.repos.resumes.count(), before.resumes);
  assert.equal(await ctx.repos.candidates.count(), before.candidates);
  assert.equal(await ctx.repos.sensitiveFindings.count(), before.findings);
  assert.equal(await ctx.repos.decisions.count(), 0, 'no recruiter decision was invented');
});
