import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, rejects } from './helpers.ts';
import { hashContent } from '../src/db/repositories/candidates.ts';
import type { Repositories } from '../src/db/repositories/index.ts';

// The domain repositories.
//
// Nothing here extracts, matches, scores or ranks — that is P3-C onwards. What
// is being pinned is that the storage layer cannot be used to build a state the
// domain forbids: a requirement judged twice, a score with no evidence behind
// it, two current evaluations for one pair, or a protected attribute stored
// where the scorer could reach it.

/** A job with two must-haves and one nice-to-have — the shape P3-D will score. */
async function seedJob(repos: Repositories) {
  const job = await repos.jobs.create({ title: 'Senior Backend Engineer', seniority: 'senior' });

  const postgres = await repos.requirements.create({
    jobId: job.id,
    label: 'Postgres in production',
    criterion: 'Has run PostgreSQL in a production system, not only in a tutorial.',
    kind: 'must_have',
    weight: 3,
  });
  const python = await repos.requirements.create({
    jobId: job.id,
    label: 'Python',
    criterion: 'Has written production Python.',
    kind: 'must_have',
    weight: 3,
  });
  const aws = await repos.requirements.create({
    jobId: job.id,
    label: 'AWS',
    criterion: 'Has deployed to AWS.',
    kind: 'nice_to_have',
    weight: 1,
  });

  return { job, postgres, python, aws };
}

async function seedCandidate(repos: Repositories, reference: string, text: string) {
  const candidate = await repos.candidates.create({ reference, displayName: 'A Person', source: 'demo' });
  const { resume } = await repos.resumes.insertIfNew({
    candidateId: candidate.id,
    contentText: text,
    redactedText: text,
  });
  return { candidate, resume };
}

// ====================================================== jobs and requirements

test('a job keeps its requirements in the order they were written', async () => {
  const { repos, close } = await createTestContext();
  const { job } = await seedJob(repos);

  const requirements = await repos.requirements.listForJob(job.id);
  assert.deepEqual(
    requirements.map((r) => r.label),
    ['Postgres in production', 'Python', 'AWS'],
    'requirements came back in some order other than the one a recruiter wrote',
  );
  assert.deepEqual(requirements.map((r) => r.position), [1, 2, 3]);

  await close();
});

test('a requirement carries the sentence that decides whether it is met', async () => {
  // The criterion is the difference between this and a keyword filter: it is
  // what the model is asked and what the recruiter is shown.
  const { repos, close } = await createTestContext();
  const { postgres } = await seedJob(repos);

  assert.match(postgres.criterion, /production/);
  assert.equal(postgres.kind, 'must_have');
  assert.equal(postgres.weight, 3);
  await close();
});

test('the same requirement label cannot be added twice to one job', async () => {
  // Two "Postgres" rows would count the same thing twice in the arithmetic.
  const { repos, close } = await createTestContext();
  const { job } = await seedJob(repos);

  const err = await rejects(() =>
    repos.requirements.create({
      jobId: job.id,
      label: 'Postgres in production',
      criterion: 'Duplicate.',
      kind: 'must_have',
      weight: 3,
    }),
  );
  assert.match(err.message, /unique|constraint/i);
  await close();
});

test('a weight of zero is refused', async () => {
  // A zero-weight requirement would appear in the explanation contributing
  // nothing, which is a lie about why it is listed.
  const { repos, close } = await createTestContext();
  const { job } = await seedJob(repos);

  const err = await rejects(() =>
    repos.requirements.create({
      jobId: job.id,
      label: 'Weightless',
      criterion: 'Nothing.',
      kind: 'nice_to_have',
      weight: 0,
    }),
  );
  assert.match(err.message, /constraint|check/i);
  await close();
});

// ================================================== candidates and resumes

test('the same resume uploaded twice is one resume', async () => {
  // Every evidence offset indexes into one specific `content_text`. Two copies
  // would silently split one person's evidence across two records.
  const { repos, close } = await createTestContext();
  const text = 'Migrated a 40-table Postgres schema at Acme.';
  const { candidate, resume } = await seedCandidate(repos, 'C-001', text);

  const second = await repos.resumes.insertIfNew({
    candidateId: candidate.id,
    contentText: text,
    redactedText: text,
  });

  assert.equal(second.created, false, 'a duplicate upload created a second resume');
  assert.equal(second.resume.id, resume.id);
  assert.equal(await repos.resumes.count(), 1);

  // And the hash is content-derived, so the recognition is not accidental.
  assert.equal(resume.contentHash, hashContent(text));
  await close();
});

test('a different resume for the same candidate is a new record', async () => {
  // The positive control for the test above: without it, "one resume" could be
  // true because the repository never inserts anything.
  const { repos, close } = await createTestContext();
  const { candidate } = await seedCandidate(repos, 'C-001', 'First version.');

  const second = await repos.resumes.insertIfNew({
    candidateId: candidate.id,
    contentText: 'Second version, updated.',
    redactedText: 'Second version, updated.',
  });

  assert.equal(second.created, true);
  assert.equal(await repos.resumes.count(), 2);
  await close();
});

test('the quarantine records where a protected attribute was, never what it was', async () => {
  const { repos, db, close } = await createTestContext();
  const { resume } = await seedCandidate(repos, 'C-001', 'Jane Doe, age 34. Ten years of Postgres.');

  const finding = await repos.sensitiveFindings.record({
    resumeId: resume.id,
    category: 'age',
    charStart: 11,
    charEnd: 20,
  });

  assert.equal(finding.category, 'age');
  assert.equal(finding.charStart, 11);

  // Structural, not a substring hunt: the row is checked column by column.
  // A bare search for "34" matched a UUID that happened to contain those
  // digits, which would have made this pass or fail on the luck of an id.
  const rows = await db.query<Record<string, unknown>>('SELECT * FROM sensitive_findings');
  const row = rows[0] as Record<string, unknown>;

  assert.deepEqual(
    Object.keys(row).sort(),
    ['category', 'char_end', 'char_start', 'created_at', 'id', 'resume_id'],
    'sensitive_findings gained a column — check it cannot hold the value',
  );

  // And no column carries any part of the text it was pointing at.
  for (const [column, value] of Object.entries(row)) {
    if (typeof value !== 'string') continue;
    for (const secret of ['Jane', 'Doe', 'age 34']) {
      assert.ok(!value.includes(secret), `column "${column}" holds the value the quarantine was meant to exclude`);
    }
  }

  await close();
});

test('an empty span is refused', async () => {
  const { repos, close } = await createTestContext();
  const { resume } = await seedCandidate(repos, 'C-001', 'Some text.');

  const err = await rejects(() =>
    repos.sensitiveFindings.record({ resumeId: resume.id, category: 'name', charStart: 5, charEnd: 5 }),
  );
  assert.match(err.message, /constraint|check/i);
  await close();
});

// =============================================================== evaluations

test('re-evaluating supersedes rather than overwrites', async () => {
  // The previous evaluation keeps its evidence, its verdicts and its score
  // exactly as they were. That history is what makes a decision from last month
  // explainable.
  const { repos, close } = await createTestContext();
  const { job } = await seedJob(repos);
  const { candidate, resume } = await seedCandidate(repos, 'C-001', 'Postgres and Python.');

  const first = await repos.evaluations.create({ jobId: job.id, candidateId: candidate.id, resumeId: resume.id });
  assert.equal(first.supersededBy, null);
  assert.equal(first.status, 'pending');

  const second = await repos.evaluations.create({ jobId: job.id, candidateId: candidate.id, resumeId: resume.id });

  const refetchedFirst = await repos.evaluations.getById(first.id);
  assert.equal(refetchedFirst?.supersededBy, second.id, 'the first evaluation was not superseded');

  // Exactly one is current.
  const current = await repos.evaluations.getCurrent(job.id, candidate.id);
  assert.equal(current?.id, second.id);

  const currentForJob = await repos.evaluations.listCurrentForJob(job.id);
  assert.equal(currentForJob.length, 1, 'two evaluations for one pair both look current');

  // And the history keeps both.
  assert.equal((await repos.evaluations.listHistory(job.id, candidate.id)).length, 2);
  await close();
});

test('a score cannot be recorded without evidence having been extracted first', async () => {
  // The rule that keeps a number from existing with nothing behind it.
  const { repos, close } = await createTestContext();
  const { job } = await seedJob(repos);
  const { candidate, resume } = await seedCandidate(repos, 'C-001', 'Postgres.');
  const evaluation = await repos.evaluations.create({
    jobId: job.id,
    candidateId: candidate.id,
    resumeId: resume.id,
  });

  assert.equal(evaluation.status, 'pending');
  const refused = await repos.evaluations.recordScore(evaluation.id, {
    scoreBasisPoints: 9000,
    mustHavesMet: 2,
    mustHavesTotal: 2,
  });
  assert.equal(refused, null, 'a score was recorded for an evaluation that never extracted anything');
  assert.equal((await repos.evaluations.getById(evaluation.id))?.scoreBasisPoints, null);

  // POSITIVE CONTROL: once extraction is recorded, the same call succeeds — so
  // the refusal above is about ordering, not about the method being broken.
  await repos.evaluations.recordExtraction(evaluation.id, {
    model: 'mock',
    promptVersion: 'v1',
    latencyMs: 5,
  });
  const scored = await repos.evaluations.recordScore(evaluation.id, {
    scoreBasisPoints: 9000,
    mustHavesMet: 2,
    mustHavesTotal: 2,
  });
  assert.equal(scored?.status, 'scored');
  assert.equal(scored?.scoreBasisPoints, 9000);

  await close();
});

test('a score outside the basis-point range is refused', async () => {
  const { repos, close } = await createTestContext();
  const { job } = await seedJob(repos);
  const { candidate, resume } = await seedCandidate(repos, 'C-001', 'Postgres.');
  const evaluation = await repos.evaluations.create({
    jobId: job.id,
    candidateId: candidate.id,
    resumeId: resume.id,
  });
  await repos.evaluations.recordExtraction(evaluation.id, { model: 'mock', promptVersion: 'v1', latencyMs: 1 });

  const err = await rejects(() =>
    repos.evaluations.recordScore(evaluation.id, {
      scoreBasisPoints: 10_001,
      mustHavesMet: 0,
      mustHavesTotal: 0,
    }),
  );
  assert.match(err.message, /constraint|check/i);
  await close();
});

// ================================================================= evidence

test('evidence is unverified until something verifies it', async () => {
  // P3-C sets this only after finding the quote verbatim at those offsets.
  // Storing it unverified rather than discarding it means a fabrication is
  // visible in the audit trail — but nothing downstream may score or show it.
  const { repos, close } = await createTestContext();
  const { job, postgres } = await seedJob(repos);
  const { candidate, resume } = await seedCandidate(repos, 'C-001', 'Migrated a 40-table Postgres schema.');
  const evaluation = await repos.evaluations.create({
    jobId: job.id,
    candidateId: candidate.id,
    resumeId: resume.id,
  });

  const unverified = await repos.evidence.record({
    evaluationId: evaluation.id,
    resumeId: resume.id,
    requirementId: postgres.id,
    quote: 'Migrated a 40-table Postgres schema.',
    charStart: 0,
    charEnd: 35,
  });
  assert.equal(unverified.verified, false, 'evidence defaulted to verified');

  assert.equal((await repos.evidence.listForEvaluation(evaluation.id)).length, 1);
  assert.equal(
    (await repos.evidence.listVerifiedForEvaluation(evaluation.id)).length,
    0,
    'unverified evidence appeared in the list meant for display and scoring',
  );

  await repos.evidence.markVerified(unverified.id, true);
  assert.equal((await repos.evidence.listVerifiedForEvaluation(evaluation.id)).length, 1);

  await close();
});

// ======================================================= requirement matches

test('a requirement cannot be judged twice in one evaluation', async () => {
  // The UNIQUE that stops a requirement being counted twice in the arithmetic.
  const { repos, close } = await createTestContext();
  const { job, postgres } = await seedJob(repos);
  const { candidate, resume } = await seedCandidate(repos, 'C-001', 'Postgres.');
  const evaluation = await repos.evaluations.create({
    jobId: job.id,
    candidateId: candidate.id,
    resumeId: resume.id,
  });

  const record = () =>
    repos.matches.record({
      evaluationId: evaluation.id,
      requirementId: postgres.id,
      verdict: 'met',
      confidence: 'high',
      weightApplied: 3,
      contributionBasisPoints: 10_000,
      rationale: 'Ran Postgres in production at Acme.',
    });

  await record();
  const err = await rejects(record);
  assert.match(err.message, /unique|constraint/i);
  await close();
});

test('a match stores the weight as it was applied', async () => {
  // So an explanation shown next year still adds up even if the job spec has
  // since been edited.
  const { repos, close } = await createTestContext();
  const { job, postgres } = await seedJob(repos);
  const { candidate, resume } = await seedCandidate(repos, 'C-001', 'Postgres.');
  const evaluation = await repos.evaluations.create({
    jobId: job.id,
    candidateId: candidate.id,
    resumeId: resume.id,
  });

  const match = await repos.matches.record({
    evaluationId: evaluation.id,
    requirementId: postgres.id,
    verdict: 'partial',
    confidence: 'medium',
    weightApplied: 3,
    contributionBasisPoints: 5_000,
    rationale: 'MySQL, not Postgres — transferable but not the same.',
  });

  assert.equal(match.weightApplied, 3);
  assert.equal(match.contributionBasisPoints, 5_000);
  assert.equal(typeof match.weightApplied, 'number', 'a weight came back as something other than a number');
  await close();
});

test('matches for many evaluations come back in one query, grouped', async () => {
  const { repos, close } = await createTestContext();
  const { job, postgres } = await seedJob(repos);
  const a = await seedCandidate(repos, 'C-001', 'Postgres.');
  const b = await seedCandidate(repos, 'C-002', 'Also Postgres.');

  const ids: string[] = [];
  for (const person of [a, b]) {
    const evaluation = await repos.evaluations.create({
      jobId: job.id,
      candidateId: person.candidate.id,
      resumeId: person.resume.id,
    });
    ids.push(evaluation.id);
    await repos.matches.record({
      evaluationId: evaluation.id,
      requirementId: postgres.id,
      verdict: 'met',
      confidence: 'high',
      weightApplied: 3,
      contributionBasisPoints: 10_000,
      rationale: 'Found.',
    });
  }

  const grouped = await repos.matches.listForEvaluations(ids);
  assert.equal(grouped.size, 2);
  for (const id of ids) assert.equal(grouped.get(id)?.length, 1);
  await close();
});

// =============================================================== decisions

test('one evaluation carries at most one recruiter decision', async () => {
  const { repos, close } = await createTestContext();
  const { job } = await seedJob(repos);
  const { candidate, resume } = await seedCandidate(repos, 'C-001', 'Postgres.');
  const evaluation = await repos.evaluations.create({
    jobId: job.id,
    candidateId: candidate.id,
    resumeId: resume.id,
  });

  const decision = await repos.decisions.record({
    evaluationId: evaluation.id,
    outcome: 'shortlist',
    reason: 'Strong Postgres evidence, and the gap is trainable.',
    decidedBy: 'sameer',
  });
  assert.equal(decision.outcome, 'shortlist');
  assert.ok(decision.reason.length > 0, 'a decision was stored without a reason');

  const err = await rejects(() =>
    repos.decisions.record({
      evaluationId: evaluation.id,
      outcome: 'reject',
      reason: 'Changed my mind.',
      decidedBy: 'sameer',
    }),
  );
  assert.match(err.message, /unique|constraint/i);
  await close();
});
