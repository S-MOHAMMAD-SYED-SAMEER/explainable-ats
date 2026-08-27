import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_CANDIDATES, demoPersonalDetails, demoCandidateNames } from '../src/demo/dataset.ts';
import { seedDemoData, clearDemoData, containsOnlyDemoData, isEmpty } from '../src/demo/seed.ts';
import { rankJob } from '../src/agent/rank.ts';
import { handleEvaluationDetail } from '../src/handlers/evaluations.ts';
import { MASK_CHAR } from '../src/agent/redact.ts';
import { createTestContext, type TestContext } from './helpers.ts';

// The demo dataset earns its place or it does not ship.
//
// A demo whose candidates all land in the same tier demonstrates nothing, and
// that is exactly what the first attempt at this dataset did — every candidate
// came out gated, because the wording of one criterion missed the wording of
// the CVs by a single letter. So the dataset states what each candidate is
// meant to show, and this file runs the REAL pipeline and checks it does.
//
// Nothing here reads `expected` to decide an outcome. It reads it to compare
// against one.

async function seeded(t: { after: (fn: () => unknown) => void }): Promise<TestContext & { jobId: string }> {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const result = await seedDemoData({ repos: ctx.repos });
  return Object.assign(ctx, { jobId: result.jobId });
}

// --- the four cases are all present and all distinct -------------------------

test('the dataset declares all four outcomes the product distinguishes', () => {
  // A precondition on the dataset itself, before anything runs. If someone
  // removes a candidate, this says so rather than the demo quietly losing a
  // case nobody notices until a client is watching.
  const tiers = new Set(DEMO_CANDIDATES.map((candidate) => candidate.expected.tier));

  assert.ok(tiers.has('qualified'), 'no qualified candidate');
  assert.ok(tiers.has('needs_review'), 'no needs-review candidate');
  assert.ok(tiers.has('gated'), 'no gated candidate');
  assert.ok(tiers.has('not_evaluated'), 'no unevaluated candidate');
});

test('every candidate lands in the tier the dataset says they will', async (t) => {
  const ctx = await seeded(t);
  const ranking = await rankJob({ repos: ctx.repos }, ctx.jobId);

  assert.equal(ranking.entries.length, DEMO_CANDIDATES.length, 'every candidate is listed');

  const byReference = new Map(ranking.entries.map((entry) => [entry.reference, entry]));
  for (const candidate of DEMO_CANDIDATES) {
    const entry = byReference.get(candidate.reference);
    assert.ok(entry, `${candidate.displayName} is missing from the ranking`);
    assert.equal(
      entry.tier,
      candidate.expected.tier,
      `${candidate.displayName} landed in "${entry.tier}", not "${candidate.expected.tier}"`,
    );
    assert.equal(
      entry.scoreBasisPoints,
      candidate.expected.scoreBasisPoints,
      `${candidate.displayName} scored ${entry.scoreBasisPoints}`,
    );
  }
});

test('every requirement gets the verdict the dataset says it will', async (t) => {
  const ctx = await seeded(t);
  const ranking = await rankJob({ repos: ctx.repos }, ctx.jobId);

  for (const candidate of DEMO_CANDIDATES) {
    if (candidate.expected.verdicts.length === 0) continue;

    const entry = ranking.entries.find((e) => e.reference === candidate.reference);
    const detail = await handleEvaluationDetail({ repos: ctx.repos }, entry?.evaluationId as string);

    assert.deepEqual(
      detail.body.requirements.map((requirement) => requirement.verdict),
      candidate.expected.verdicts,
      `${candidate.displayName}'s verdicts`,
    );
  }
});

// --- the centrepiece ---------------------------------------------------------

test('the gate is visible: the same score, one tier apart', async (t) => {
  // The single thing this dataset exists to show. Devi and Marcus score
  // identically; Devi is placed above Marcus because Marcus's CV does not
  // demonstrate an essential requirement. If a change ever separates their
  // scores, the demo silently degrades into ordinary sorting and this fails.
  const ctx = await seeded(t);
  const ranking = await rankJob({ repos: ctx.repos }, ctx.jobId);

  const devi = ranking.entries.find((entry) => entry.reference === 'demo-002');
  const marcus = ranking.entries.find((entry) => entry.reference === 'demo-003');
  assert.ok(devi && marcus);

  assert.equal(devi.scoreBasisPoints, marcus.scoreBasisPoints, 'the two must score the same');
  assert.equal(devi.scorePercent, marcus.scorePercent, 'and must READ the same on screen');

  assert.equal(devi.tier, 'qualified');
  assert.equal(marcus.tier, 'gated');
  assert.ok(devi.position < marcus.position, 'the qualified candidate must be placed higher');

  // And the reason is stated, not left to be inferred from the order.
  assert.deepEqual(marcus.failedMustHaves, ['PostgreSQL']);
  assert.match(marcus.rationale, /does not demonstrate "PostgreSQL"/);
  assert.match(marcus.rationale, /the score itself is unchanged/);
});

test('needs-review and gated are told apart, and worded differently', async (t) => {
  const ctx = await seeded(t);
  const ranking = await rankJob({ repos: ctx.repos }, ctx.jobId);

  const ines = ranking.entries.find((entry) => entry.reference === 'demo-004');
  const marcus = ranking.entries.find((entry) => entry.reference === 'demo-003');
  assert.ok(ines && marcus);

  // Both miss the same essential requirement. Only the reason differs.
  assert.equal(ines.mustHavesMet, marcus.mustHavesMet, 'precondition: both meet the same count');
  assert.deepEqual(ines.unclearMustHaves, ['PostgreSQL']);
  assert.deepEqual(ines.failedMustHaves, []);
  assert.deepEqual(marcus.failedMustHaves, ['PostgreSQL']);
  assert.deepEqual(marcus.unclearMustHaves, []);

  assert.match(ines.rationale, /said nothing about "PostgreSQL"/);
  assert.match(ines.rationale, /unresolved rather than failed/);
  assert.ok(ines.position < marcus.position, 'silence is not treated as a finding against someone');
});

test('the unassessed candidate is listed, unranked, and given no number', async (t) => {
  const ctx = await seeded(t);
  const ranking = await rankJob({ repos: ctx.repos }, ctx.jobId);

  const toby = ranking.entries.find((entry) => entry.reference === 'demo-005');
  assert.ok(toby);

  assert.equal(toby.tier, 'not_evaluated');
  assert.equal(toby.rank, null);
  assert.equal(toby.scoreBasisPoints, null, 'a number here would be a score nobody computed');
  assert.equal(toby.scorePercent, null);
  assert.ok(toby.evaluationId, 'an evaluation exists — it just has not been run');
  assert.equal(toby.position, DEMO_CANDIDATES.length, 'placed last, after everyone assessed');
  assert.equal(ranking.notEvaluatedCount, 1);
});

test('the list opens on a candidate who meets everything', async (t) => {
  // A demo that opened on a rejection would be a strange thing to show anyone.
  const ctx = await seeded(t);
  const ranking = await rankJob({ repos: ctx.repos }, ctx.jobId);

  assert.equal(ranking.entries[0]?.reference, 'demo-001');
  assert.equal(ranking.entries[0]?.tier, 'qualified');
  assert.equal(ranking.entries[0]?.scorePercent, '100%');
});

// --- the guarantees still hold on this data ----------------------------------

test('no personal detail from any demo CV reaches the model or the API', async (t) => {
  const ctx = await seeded(t);
  const values = demoPersonalDetails();
  assert.ok(values.length >= 20, `only ${values.length} personal details found in the dataset`);

  const ranking = await rankJob({ repos: ctx.repos }, ctx.jobId);
  const details = [];
  for (const entry of ranking.entries) {
    if (entry.evaluationId) {
      details.push((await handleEvaluationDetail({ repos: ctx.repos }, entry.evaluationId)).body);
    }
  }

  const wire = JSON.stringify({ ranking, details });
  for (const value of values) {
    // Precondition on every iteration: the value really is in a CV, so absence
    // from the wire means removal rather than never having been there.
    const inSomeResume = DEMO_CANDIDATES.some((candidate) => candidate.resume.includes(value));
    assert.ok(inSomeResume, `"${value}" is not actually in any demo CV`);
    assert.ok(!wire.includes(value), `"${value}" reached the client`);
  }

  // And it is gone from the copy the model reads, together with the names.
  for (const candidate of DEMO_CANDIDATES) {
    const record = await ctx.repos.candidates.findByReference(candidate.reference);
    const resume = await ctx.repos.resumes.latestForCandidate(record?.id as string);
    assert.ok(resume, `${candidate.displayName} has no stored CV`);
    assert.ok(resume.redactedText.includes(MASK_CHAR), `${candidate.displayName}'s CV was not masked`);
    for (const value of [...values, ...demoCandidateNames()]) {
      assert.ok(!resume.redactedText.includes(value), `"${value}" survived into redacted_text`);
    }
  }
});

test('a candidate name is hidden from the model and shown to the recruiter', async (t) => {
  // Two different rules, deliberately. The name cannot influence a reading
  // because it is not in the input; a recruiter still gets a list of people
  // rather than a list of reference codes.
  const ctx = await seeded(t);
  const ranking = await rankJob({ repos: ctx.repos }, ctx.jobId);

  for (const name of demoCandidateNames()) {
    assert.ok(
      ranking.entries.some((entry) => entry.displayName === name),
      `${name} is not shown to the recruiter`,
    );
  }

  for (const candidate of DEMO_CANDIDATES) {
    const record = await ctx.repos.candidates.findByReference(candidate.reference);
    const resume = await ctx.repos.resumes.latestForCandidate(record?.id as string);
    assert.ok(!resume?.redactedText.includes(candidate.displayName), 'the model was shown a name');
  }
});

test('every quote shown came verbatim from the CV it is attributed to', async (t) => {
  // The seeder runs the real pipeline, so this is the verifier's guarantee
  // holding on the actual demo data rather than on a test fixture.
  const ctx = await seeded(t);
  const ranking = await rankJob({ repos: ctx.repos }, ctx.jobId);

  let checked = 0;
  for (const entry of ranking.entries) {
    if (!entry.evaluationId) continue;
    const detail = await handleEvaluationDetail({ repos: ctx.repos }, entry.evaluationId);
    const resume = await ctx.repos.resumes.getById(
      (await ctx.repos.evaluations.getById(entry.evaluationId))?.resumeId as string,
    );
    assert.ok(resume, 'precondition: the CV behind this assessment is still stored');

    for (const requirement of detail.body.requirements) {
      for (const item of requirement.evidence) {
        assert.ok(resume.contentText.includes(item.quote), `not in the CV: ${item.quote}`);
        assert.ok(!item.quote.includes(MASK_CHAR), 'a masked run was quoted');
        checked += 1;
      }
    }
  }

  assert.ok(checked >= 8, `only ${checked} quotes checked — the dataset should produce more`);
});

test('nothing unverified was produced, so nothing had to be hidden', async (t) => {
  // The demo should not be quietly carrying rejected evidence. If the stand-in
  // ever starts producing quotes the verifier refuses, that is a real change and
  // the demo is the wrong place to discover it.
  const ctx = await seeded(t);
  const ranking = await rankJob({ repos: ctx.repos }, ctx.jobId);

  for (const entry of ranking.entries) {
    if (!entry.evaluationId) continue;
    const all = await ctx.repos.evidence.listForEvaluation(entry.evaluationId);
    const verified = await ctx.repos.evidence.listVerifiedForEvaluation(entry.evaluationId);
    assert.equal(all.length, verified.length, `${entry.reference} carries unverified evidence`);
  }
});

test('every assessed candidate has a full audit trail behind them', async (t) => {
  const ctx = await seeded(t);
  const ranking = await rankJob({ repos: ctx.repos }, ctx.jobId);

  let assessed = 0;
  for (const entry of ranking.entries) {
    if (!entry.evaluationId) continue;
    const evaluation = await ctx.repos.evaluations.getById(entry.evaluationId);
    const events = [
      ...(await ctx.repos.audit.listForCorrelation(evaluation?.resumeId as string)),
      ...(await ctx.repos.audit.listForCorrelation(entry.evaluationId)),
    ].map((event) => event.eventType);

    // Everyone's CV was ingested and redacted, including the one still queued —
    // the fairness step happens at intake, not at assessment time.
    for (const required of ['resume_ingested', 'sensitive_attributes_masked', 'evaluation_opened']) {
      assert.ok(events.includes(required), `${entry.reference} is missing "${required}"`);
    }

    if (entry.tier === 'not_evaluated') {
      // And the queued one stops exactly there. A verification or scoring event
      // here would mean work was recorded that never happened.
      assert.ok(!events.includes('evidence_verified'), `${entry.reference} claims evidence it never gathered`);
      assert.ok(!events.includes('score_computed'), `${entry.reference} claims a score it never computed`);
      continue;
    }

    for (const required of ['extraction_recorded', 'evidence_verified', 'requirements_matched', 'score_computed']) {
      assert.ok(events.includes(required), `${entry.reference} is missing "${required}"`);
    }
    assessed += 1;
  }

  assert.equal(assessed, 4, 'four candidates should have been assessed');
});

// --- determinism -------------------------------------------------------------

test('seeding twice produces byte-identical rankings', async (t) => {
  // A demo that varies between runs cannot be rehearsed.
  const runs: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const ctx = await seeded(t);
    const ranking = await rankJob({ repos: ctx.repos }, ctx.jobId);
    runs.push(
      JSON.stringify(
        ranking.entries.map((entry) => [entry.reference, entry.tier, entry.scoreBasisPoints, entry.rank, entry.rationale]),
      ),
    );
  }

  assert.equal(runs[1], runs[0]);
});

// --- the seeder's own safety -------------------------------------------------

test('a fresh database reads as empty, and a seeded one as demo-only', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  assert.equal(await isEmpty(ctx.repos), true);
  await seedDemoData({ repos: ctx.repos });
  assert.equal(await isEmpty(ctx.repos), false);
  assert.equal(await containsOnlyDemoData(ctx.repos), true);
});

test('one non-demo candidate is enough to make a database not demo-only', async (t) => {
  // The check that stops a reset touching a database holding real people.
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  await seedDemoData({ repos: ctx.repos });
  assert.equal(await containsOnlyDemoData(ctx.repos), true, 'precondition');

  await ctx.repos.candidates.create({ reference: 'real-applicant-1', displayName: null, source: 'upload' });

  assert.equal(await containsOnlyDemoData(ctx.repos), false);
});

test('clearing removes the demo dataset and leaves anything else alone', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  await seedDemoData({ repos: ctx.repos });
  const outsider = await ctx.repos.candidates.create({
    reference: 'real-applicant-1',
    displayName: null,
    source: 'upload',
  });

  const before = await ctx.repos.candidates.count();
  assert.equal(before, DEMO_CANDIDATES.length + 1, 'precondition');

  const removed = await clearDemoData({ repos: ctx.repos });

  assert.equal(removed.candidates, DEMO_CANDIDATES.length);
  assert.equal(removed.jobs, 1);
  assert.equal(await ctx.repos.candidates.count(), 1, 'the non-demo candidate survived');
  assert.equal((await ctx.repos.candidates.list())[0]?.id, outsider.id);

  // Cascades did their job: nothing is orphaned.
  assert.equal(await ctx.repos.evaluations.count(), 0);
  assert.equal(await ctx.repos.evidence.count(), 0);
  assert.equal(await ctx.repos.resumes.count(), 0);
});

test('seeding is repeatable: clear then seed gives the same dataset back', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const first = await seedDemoData({ repos: ctx.repos });
  const before = await rankJob({ repos: ctx.repos }, first.jobId);

  await clearDemoData({ repos: ctx.repos });
  const second = await seedDemoData({ repos: ctx.repos });
  const after = await rankJob({ repos: ctx.repos }, second.jobId);

  assert.deepEqual(
    after.entries.map((entry) => [entry.reference, entry.tier, entry.scoreBasisPoints]),
    before.entries.map((entry) => [entry.reference, entry.tier, entry.scoreBasisPoints]),
  );
});
