import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { rankJob } from '../src/agent/rank.ts';
import { matchAndScore } from '../src/agent/match.ts';
import { openEvaluation } from '../src/agent/extract.ts';
import { createJob, ingestResume } from '../src/agent/ingest.ts';
import { createTestContext, rejects, MIGRATIONS_DIR, type TestContext } from './helpers.ts';
import { JOB_INPUT, RESUME_TEXT } from './fixtures.ts';
import type { Repositories } from '../src/db/repositories/index.ts';

// Ranking, against the database.
//
// The ordering rules are pinned in rank-rules.test.ts. What is checked here is
// what the loader actually reads — current evaluations only, verified evidence
// only, and nothing written back.

// Quotes engineered to produce one exact verdict against the seeded job's
// requirements. Term counts are asserted as preconditions in the first test.
const QUOTES = {
  nodeMet: 'Designed and shipped production Node.js services.',
  nodeNotMet: 'Node.js.',
  postgresMet: 'Run PostgreSQL migrations at scale.',
  mentoringMet: 'Mentoring: mentored junior engineers.',
} as const;

type Plan = {
  reference: string;
  /** Requirement index -> quote. Anything omitted is left unaddressed. */
  evidence: Array<{ requirement: 0 | 1 | 2; quote: string; verified?: boolean }>;
  /** Leave the evaluation unscored, to exercise the not-evaluated tier. */
  skipScoring?: boolean;
};

async function seedJob(repos: Repositories) {
  return createJob({ repos }, JOB_INPUT);
}

/** Ingests a candidate, extracts the given evidence by hand, and scores them. */
async function seedCandidate(
  ctx: TestContext,
  job: Awaited<ReturnType<typeof seedJob>>,
  plan: Plan,
) {
  const { candidate, resume } = await ingestResume({ repos: ctx.repos }, {
    reference: plan.reference,
    displayName: `Name of ${plan.reference}`,
    // A distinct document per candidate, so each gets its own resume row.
    text: `${RESUME_TEXT}\nReference: ${plan.reference}`,
  });

  const evaluation = await openEvaluation({ repos: ctx.repos }, {
    jobId: job.job.id,
    candidateId: candidate.id,
    resume,
  });

  await ctx.repos.evaluations.recordExtraction(evaluation.id, {
    model: 'mock',
    promptVersion: 'extract-v1',
    latencyMs: 0,
  });

  for (const item of plan.evidence) {
    const requirement = job.requirements[item.requirement];
    assert.ok(requirement, 'precondition: the seeded job has that requirement');
    await ctx.repos.evidence.record({
      evaluationId: evaluation.id,
      resumeId: resume.id,
      requirementId: requirement.id,
      quote: item.quote,
      charStart: 0,
      charEnd: item.quote.length,
      verified: item.verified ?? true,
    });
  }

  if (!plan.skipScoring) await matchAndScore({ repos: ctx.repos }, evaluation.id);

  return { candidate, resume, evaluation };
}

// --- ordering, end to end ----------------------------------------------------

test('a stronger candidate ranks above a weaker one when both clear the gate', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const job = await seedJob(ctx.repos);
  assert.deepEqual(job.requirements.map((r) => r.kind), ['must_have', 'must_have', 'nice_to_have'], 'precondition');

  // Both meet every must-have; only the nice-to-have differs.
  await seedCandidate(ctx, job, {
    reference: 'weaker',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet },
      { requirement: 1, quote: QUOTES.postgresMet },
    ],
  });
  await seedCandidate(ctx, job, {
    reference: 'stronger',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet },
      { requirement: 1, quote: QUOTES.postgresMet },
      { requirement: 2, quote: QUOTES.mentoringMet },
    ],
  });

  const ranking = await rankJob({ repos: ctx.repos }, job.job.id);

  assert.deepEqual(ranking.entries.map((entry) => entry.reference), ['stronger', 'weaker']);
  assert.deepEqual(ranking.entries.map((entry) => entry.tier), ['qualified', 'qualified']);
  assert.equal(ranking.entries[0]?.scoreBasisPoints, 10_000);
  assert.equal(ranking.entries[1]?.scoreBasisPoints, 8_333, '(3x10000 + 2x10000 + 1x0) / 6');
  assert.ok((ranking.entries[0]?.scoreBasisPoints ?? 0) > (ranking.entries[1]?.scoreBasisPoints ?? 0));
});

test('a failed must-have is gated below a much weaker candidate, with the score reported unchanged', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const job = await seedJob(ctx.repos);

  // Aces the two heavy requirements, fails the lighter must-have.
  const gated = await seedCandidate(ctx, job, {
    reference: 'high-but-gated',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet },
      { requirement: 1, quote: QUOTES.nodeNotMet },
      { requirement: 2, quote: QUOTES.mentoringMet },
    ],
  });
  await seedCandidate(ctx, job, {
    reference: 'modest-but-clear',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet },
      { requirement: 1, quote: QUOTES.postgresMet },
    ],
  });

  const stored = await ctx.repos.evaluations.getById(gated.evaluation.id);
  assert.equal(stored?.scoreBasisPoints, 6_666, 'precondition: (3x10000 + 2x0 + 1x10000) / 6');

  const ranking = await rankJob({ repos: ctx.repos }, job.job.id);
  const gatedEntry = ranking.entries.find((entry) => entry.reference === 'high-but-gated');
  const clearEntry = ranking.entries.find((entry) => entry.reference === 'modest-but-clear');

  assert.equal(gatedEntry?.tier, 'gated');
  assert.equal(clearEntry?.tier, 'qualified');
  assert.ok((gatedEntry?.position ?? 0) > (clearEntry?.position ?? 0), 'the gated candidate is placed lower');

  // The number is untouched — only the placement moved.
  assert.equal(gatedEntry?.scoreBasisPoints, 6_666);
  assert.equal(
    (await ctx.repos.evaluations.getById(gated.evaluation.id))?.scoreBasisPoints,
    6_666,
    'ranking must not have written to the evaluation',
  );
  assert.deepEqual(gatedEntry?.failedMustHaves, ['PostgreSQL']);
});

test('unclear evidence is a different tier and a different sentence from failed evidence', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const job = await seedJob(ctx.repos);

  // One candidate had a passage quoted for PostgreSQL that did not demonstrate
  // it. The other had nothing quoted for PostgreSQL at all. Same missing
  // must-have, different reason, different answer.
  await seedCandidate(ctx, job, {
    reference: 'evidence-fell-short',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet },
      { requirement: 1, quote: QUOTES.nodeNotMet },
    ],
  });
  await seedCandidate(ctx, job, {
    reference: 'nothing-was-said',
    evidence: [{ requirement: 0, quote: QUOTES.nodeMet }],
  });

  const ranking = await rankJob({ repos: ctx.repos }, job.job.id);
  const fellShort = ranking.entries.find((entry) => entry.reference === 'evidence-fell-short');
  const nothingSaid = ranking.entries.find((entry) => entry.reference === 'nothing-was-said');

  assert.equal(fellShort?.tier, 'gated');
  assert.equal(nothingSaid?.tier, 'needs_review');

  assert.deepEqual(fellShort?.failedMustHaves, ['PostgreSQL']);
  assert.deepEqual(fellShort?.unclearMustHaves, []);
  assert.deepEqual(nothingSaid?.unclearMustHaves, ['PostgreSQL']);
  assert.deepEqual(nothingSaid?.failedMustHaves, []);

  assert.match(nothingSaid?.rationale ?? '', /unresolved rather than failed/);
  assert.match(fellShort?.rationale ?? '', /does not demonstrate/);

  // Both missed the same must-have, and the one worth a second look is placed
  // above the one with a finding against them.
  assert.equal(fellShort?.mustHavesMet, nothingSaid?.mustHavesMet, 'precondition: the counts are identical');
  assert.ok((nothingSaid?.position ?? 0) < (fellShort?.position ?? 0));
});

// --- what ranking must not read ----------------------------------------------

test('a superseded evaluation is ignored, and the replacement is what ranks', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const job = await seedJob(ctx.repos);
  const first = await seedCandidate(ctx, job, {
    reference: 'reassessed',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet },
      { requirement: 1, quote: QUOTES.postgresMet },
      { requirement: 2, quote: QUOTES.mentoringMet },
    ],
  });
  await seedCandidate(ctx, job, {
    reference: 'steady',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet },
      { requirement: 1, quote: QUOTES.postgresMet },
    ],
  });

  const before = await rankJob({ repos: ctx.repos }, job.job.id);
  assert.equal(before.entries[0]?.reference, 'reassessed', 'precondition: it currently leads on 10000');
  assert.equal(before.entries[0]?.scoreBasisPoints, 10_000);

  // A second look, with weaker evidence this time.
  const replacement = await openEvaluation({ repos: ctx.repos }, {
    jobId: job.job.id,
    candidateId: first.candidate.id,
    resume: first.resume,
  });
  await ctx.repos.evaluations.recordExtraction(replacement.id, {
    model: 'mock',
    promptVersion: 'extract-v1',
    latencyMs: 0,
  });
  await ctx.repos.evidence.record({
    evaluationId: replacement.id,
    resumeId: first.resume.id,
    requirementId: job.requirements[0]?.id,
    quote: QUOTES.nodeMet,
    charStart: 0,
    charEnd: QUOTES.nodeMet.length,
    verified: true,
  });
  await matchAndScore({ repos: ctx.repos }, replacement.id);

  const after = await rankJob({ repos: ctx.repos }, job.job.id);

  // The superseded evaluation still exists, still scores 10000, and takes no
  // part in the ranking.
  const superseded = await ctx.repos.evaluations.getById(first.evaluation.id);
  assert.equal(superseded?.scoreBasisPoints, 10_000, 'history is intact');
  assert.equal(superseded?.supersededBy, replacement.id);

  const entry = after.entries.find((e) => e.reference === 'reassessed');
  assert.equal(entry?.evaluationId, replacement.id);
  assert.equal(entry?.tier, 'needs_review', 'the replacement leaves a must-have unaddressed');
  assert.equal(after.entries[0]?.reference, 'steady', 'the ranking followed the current evaluation');

  // Each candidate appears exactly once, whatever their history.
  assert.equal(after.entries.length, 2);
  assert.equal(new Set(after.entries.map((e) => e.candidateId)).size, 2);
});

test('unverified evidence cannot lift a candidate up the ranking', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const job = await seedJob(ctx.repos);

  await seedCandidate(ctx, job, {
    reference: 'fabricated',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet, verified: false },
      { requirement: 1, quote: QUOTES.postgresMet, verified: false },
      { requirement: 2, quote: QUOTES.mentoringMet, verified: false },
    ],
  });
  await seedCandidate(ctx, job, {
    reference: 'honest',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet },
      { requirement: 1, quote: QUOTES.postgresMet },
    ],
  });

  const ranking = await rankJob({ repos: ctx.repos }, job.job.id);
  const fabricated = ranking.entries.find((entry) => entry.reference === 'fabricated');

  assert.equal(fabricated?.scoreBasisPoints, 0);
  assert.equal(fabricated?.tier, 'needs_review', 'nothing was quoted that could be checked');
  assert.equal(ranking.entries[0]?.reference, 'honest');
  assert.ok((fabricated?.position ?? 0) > 1);
});

test('the identical evidence, verified, takes that candidate to the top', async (t) => {
  // The positive control for the test above. Without it, "the fabricated
  // candidate ranked last" could equally mean the quotes were too weak to
  // matter to anyone.
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const job = await seedJob(ctx.repos);
  await seedCandidate(ctx, job, {
    reference: 'fabricated',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet, verified: true },
      { requirement: 1, quote: QUOTES.postgresMet, verified: true },
      { requirement: 2, quote: QUOTES.mentoringMet, verified: true },
    ],
  });
  await seedCandidate(ctx, job, {
    reference: 'honest',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet },
      { requirement: 1, quote: QUOTES.postgresMet },
    ],
  });

  const ranking = await rankJob({ repos: ctx.repos }, job.job.id);

  assert.equal(ranking.entries[0]?.reference, 'fabricated');
  assert.equal(ranking.entries[0]?.scoreBasisPoints, 10_000);
  assert.equal(ranking.entries[0]?.tier, 'qualified');
});

test('the ranking loader never reads evidence, resumes or the quarantine', async () => {
  // Structural, not a promise in a comment. Everything ranking needs was
  // committed by the scorer from verified evidence only; re-deriving any of it
  // here would create a second answer able to disagree with the first.
  const dir = path.resolve(import.meta.dirname, '../src/agent');
  for (const file of ['rank.ts', 'rankRules.ts']) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    const withoutComments = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    for (const forbidden of ['repos.evidence', 'repos.resumes', 'repos.sensitiveFindings', 'adapters/llm']) {
      assert.ok(!withoutComments.includes(forbidden), `${file} references ${forbidden}`);
    }
  }
});

// --- candidates without a current evaluation ---------------------------------

test('a candidate whose evaluation was never scored is listed but not ranked', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const job = await seedJob(ctx.repos);
  await seedCandidate(ctx, job, {
    reference: 'still-running',
    evidence: [{ requirement: 0, quote: QUOTES.nodeMet }],
    skipScoring: true,
  });
  await seedCandidate(ctx, job, {
    reference: 'finished',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet },
      { requirement: 1, quote: QUOTES.postgresMet },
    ],
  });

  const ranking = await rankJob({ repos: ctx.repos }, job.job.id);

  assert.equal(ranking.entries.length, 2, 'the unscored candidate is still listed');
  assert.equal(ranking.rankedCount, 1);
  assert.equal(ranking.notEvaluatedCount, 1);

  const pending = ranking.entries.find((entry) => entry.reference === 'still-running');
  assert.equal(pending?.tier, 'not_evaluated');
  assert.equal(pending?.rank, null);
  assert.equal(pending?.scoreBasisPoints, null, 'an unscored candidate must never be shown a number');
  assert.equal(pending?.position, 2, 'placed after everyone who was actually evaluated');
});

test('a candidate with no evaluation for this job appears only when named', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const job = await seedJob(ctx.repos);
  await seedCandidate(ctx, job, {
    reference: 'applied',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet },
      { requirement: 1, quote: QUOTES.postgresMet },
    ],
  });

  // Ingested, but never put forward for this job.
  const outsider = await ingestResume({ repos: ctx.repos }, {
    reference: 'never-submitted',
    displayName: 'Outsider',
    text: `${RESUME_TEXT}\nReference: never-submitted`,
  });

  const withoutThem = await rankJob({ repos: ctx.repos }, job.job.id);
  assert.deepEqual(withoutThem.entries.map((e) => e.reference), ['applied'], 'not invented into the list');

  const withThem = await rankJob({ repos: ctx.repos }, job.job.id, {
    includeCandidateIds: [outsider.candidate.id],
  });

  assert.equal(withThem.entries.length, 2);
  const entry = withThem.entries.find((e) => e.reference === 'never-submitted');
  assert.equal(entry?.tier, 'not_evaluated');
  assert.equal(entry?.evaluationId, null);
  assert.match(entry?.rationale ?? '', /no evaluation of this candidate for this job yet/);
});

test('a candidate id that does not resolve is skipped rather than shown anonymously', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const job = await seedJob(ctx.repos);
  await seedCandidate(ctx, job, {
    reference: 'applied',
    evidence: [{ requirement: 0, quote: QUOTES.nodeMet }],
  });

  const ranking = await rankJob({ repos: ctx.repos }, job.job.id, {
    includeCandidateIds: ['no-such-candidate'],
  });

  assert.deepEqual(ranking.entries.map((entry) => entry.reference), ['applied']);
});

test('an empty job ranks to an empty list, and a missing job is a not-found', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const job = await seedJob(ctx.repos);
  const ranking = await rankJob({ repos: ctx.repos }, job.job.id);

  assert.deepEqual(ranking.entries, []);
  assert.equal(ranking.rankedCount, 0);

  const err = await rejects(() => rankJob({ repos: ctx.repos }, 'no-such-job'));
  assert.match(err.message, /does not exist/);
});

// --- ranking is a pure read --------------------------------------------------

test('ranking writes nothing, anywhere', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const job = await seedJob(ctx.repos);
  await seedCandidate(ctx, job, {
    reference: 'a',
    evidence: [
      { requirement: 0, quote: QUOTES.nodeMet },
      { requirement: 1, quote: QUOTES.postgresMet },
    ],
  });
  await seedCandidate(ctx, job, { reference: 'b', evidence: [{ requirement: 0, quote: QUOTES.nodeMet }] });

  const tables = [
    'jobs', 'job_requirements', 'candidates', 'resumes', 'sensitive_findings',
    'evaluations', 'evidence', 'requirement_matches', 'recruiter_decisions', 'audit_events',
  ];
  const countAll = async () => {
    const counts: Record<string, number> = {};
    // Every table is counted, so a write to any of them shows up here.
    for (const table of tables) {
      const rows = await ctx.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      counts[table] = Number(rows[0]?.n ?? 0);
    }
    return counts;
  };

  const before = await countAll();
  assert.ok((before.audit_events ?? 0) > 0, 'precondition: there is a trail that could have been appended to');
  assert.ok((before.requirement_matches ?? 0) > 0, 'precondition: there are matches that could have been rewritten');

  await rankJob({ repos: ctx.repos }, job.job.id);
  await rankJob({ repos: ctx.repos }, job.job.id);

  assert.deepEqual(await countAll(), before, 'a ranking is a view, not an event');
});

test('ranking twice returns the identical list', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const job = await seedJob(ctx.repos);
  for (const reference of ['c', 'a', 'b']) {
    await seedCandidate(ctx, job, {
      reference,
      evidence: [
        { requirement: 0, quote: QUOTES.nodeMet },
        { requirement: 1, quote: QUOTES.postgresMet },
      ],
    });
  }

  const first = await rankJob({ repos: ctx.repos }, job.job.id);
  const second = await rankJob({ repos: ctx.repos }, job.job.id);

  assert.equal(first.entries.length, 3);
  assert.deepEqual(first.entries.map((e) => e.rank), [1, 1, 1], 'all three genuinely tie');
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

// --- ranking stays derived ---------------------------------------------------

test('P3-E added no table, and nothing stores a rank', async (t) => {
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

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql'));
  assert.equal(files.length, 2, 'P3-E must not have added a migration');
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(/--[^\n]*/g, '');
    assert.ok(!/CREATE TABLE\s+\w*rank/i.test(sql), `${file} creates a ranking table`);
    assert.ok(!/\brank\w*\s+(INTEGER|TEXT|NUMERIC)/i.test(sql), `${file} stores a rank column`);
  }
});

test('the scoring formula was not touched by the ranking layer', async () => {
  // The gate changes placement, never the arithmetic. If a ranking concern ever
  // leaks into the scorer, the number on the list and the number on the
  // evaluation page start to disagree.
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../src/agent/score.ts'), 'utf8');
  const withoutComments = source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  assert.ok(withoutComments.includes('Math.floor(numerator / totalWeight)'), 'the formula is still one division');
  for (const forbidden of ['rank', 'tier', 'gate']) {
    assert.ok(!new RegExp(`\\b${forbidden}`, 'i').test(withoutComments), `score.ts mentions ${forbidden}`);
  }
});
