import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seedDemoData } from '../src/demo/seed.ts';
import { DEMO_CANDIDATES } from '../src/demo/dataset.ts';
import type { AuditEvent } from '../src/domain/ats.ts';
import { rankJob } from '../src/agent/rank.ts';
import { handleEvaluationDetail } from '../src/handlers/evaluations.ts';
import { createTestContext, type TestContext } from './helpers.ts';

// The portfolio demo must agree with this project, or it is advertising
// something else.
//
// WHAT THIS FILE COMPARES
//
// The real pipeline — seeded into a database, extracted, verified, matched,
// scored, ranked through the repositories — against the portfolio's browser
// runner, which composes the same functions with no database at all. Same
// dataset in; every judgement out must be identical.
//
// This is the test that makes the vendoring honest. `--check` on the exporter
// proves the copied FILES match. This proves the copied SYSTEM matches: that
// substituting the repositories changed nothing about what the thing decides.
//
// WHY IT REACHES INTO A SIBLING CHECKOUT
//
// The runner lives in the portfolio repository, because that is where it is
// deployed from. There is no package to depend on, so the import is a relative
// path, and the test explains itself and skips rather than exploding when the
// sibling checkout is not there. It never skips a comparison it was able to
// make — an environment that cannot run it says so; one that can, must pass.

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Overridable, so a differently-arranged working copy can still run this. */
const PORTFOLIO_DEMO_DIR =
  process.env.PORTFOLIO_DEMO_DIR ??
  path.resolve(HERE, '../../../..', 'sameer-3d-portfolio', 'sameer-3d-portfolio', 'src', 'demo', 'p3');

const RUNNER = path.join(PORTFOLIO_DEMO_DIR, 'run.ts');
const available = fs.existsSync(RUNNER);
const skip = available
  ? false
  : `The portfolio demo runner was not found at ${RUNNER}. ` +
    'Set PORTFOLIO_DEMO_DIR to the portfolio\'s src/demo/p3 directory to run the parity check.';

type DemoModule = typeof import('../../../../sameer-3d-portfolio/sameer-3d-portfolio/src/demo/p3/run.ts');

async function loadRunner(): Promise<DemoModule> {
  // A file URL, not a path: an absolute Windows path is not a valid ESM
  // specifier, and the namespaced form (`\\?\C:\...`) is read as a package name.
  return (await import(pathToFileURL(RUNNER).href)) as DemoModule;
}

/** The real thing: a seeded database driven through the real stages. */
async function real(t: { after: (fn: () => unknown) => void }): Promise<{
  ctx: TestContext;
  jobId: string;
}> {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const result = await seedDemoData({ repos: ctx.repos });
  return { ctx, jobId: result.jobId };
}

/**
 * Rewrites the ids in a payload to canonical tokens.
 *
 * The two systems disagree about ids ON PURPOSE, and this is the one place that
 * has to say so out loud. The server mints UUIDs from `lib/ids.ts`; the demo
 * cannot, because that module is Node-only and because a random id would make
 * the demo non-deterministic — so it uses readable literals.
 *
 * Comparing those raw would be comparing the one field designed to differ, and
 * deleting the fields instead would stop checking that each event points at the
 * right THING. So both sides' ids are mapped to the same tokens by role, and
 * everything else in the payload is still compared strictly, character for
 * character. An event that referenced the wrong requirement still fails.
 */
function normaliseIds(value: unknown, ids: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => normaliseIds(item, ids));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        normaliseIds(item, ids),
      ]),
    );
  }
  return value;
}

/** Builds the id -> token map for one side of the comparison. */
function idTokens(parts: {
  jobId: string;
  candidateId: string;
  resumeId: string;
  evaluationId: string;
  requirementIds: readonly string[];
}): Map<string, string> {
  const map = new Map<string, string>([
    [parts.jobId, '<job>'],
    [parts.candidateId, '<candidate>'],
    [parts.resumeId, '<resume>'],
    [parts.evaluationId, '<evaluation>'],
  ]);
  parts.requirementIds.forEach((id, index) => map.set(id, `<requirement-${index + 1}>`));
  return map;
}

/** Every audit event for one candidate, from both correlation ids, in order. */
async function realAuditFor(
  ctx: TestContext,
  resumeId: string,
  evaluationId: string,
): Promise<
  Array<{
    stage: string;
    eventType: string;
    outcome: string;
    summary: string;
    payload: Record<string, unknown>;
  }>
> {
  const events = [
    ...(await ctx.repos.audit.listForCorrelation(resumeId)),
    ...(await ctx.repos.audit.listForCorrelation(evaluationId)),
  ];
  return events.map((event) => ({
    stage: event.stage,
    eventType: event.eventType,
    outcome: event.outcome,
    summary: event.summary,
    payload: event.payload,
  }));
}

// --- the headline: same order, same numbers, same words ----------------------

test('the demo runner produces the same ranking as the real pipeline', { skip }, async (t) => {
  const { ctx, jobId } = await real(t);
  const { runDemo } = await loadRunner();

  const realRanking = await rankJob({ repos: ctx.repos }, jobId);
  const demo = await runDemo();

  assert.equal(
    demo.ranking.entries.length,
    realRanking.entries.length,
    'both systems must list every candidate',
  );
  assert.equal(demo.ranking.rankedCount, realRanking.rankedCount);
  assert.equal(demo.ranking.notEvaluatedCount, realRanking.notEvaluatedCount);

  // The order itself, before any per-candidate detail. If this differs,
  // everything below is noise.
  assert.deepEqual(
    demo.ranking.entries.map((entry) => entry.reference),
    realRanking.entries.map((entry) => entry.reference),
    'the ranked order must be identical',
  );

  for (const realEntry of realRanking.entries) {
    const demoEntry = demo.ranking.entries.find((entry) => entry.reference === realEntry.reference);
    assert.ok(demoEntry, `${realEntry.reference} is missing from the demo ranking`);

    const where = realEntry.reference;
    assert.equal(demoEntry.tier, realEntry.tier, `${where}: tier`);
    assert.equal(demoEntry.scoreBasisPoints, realEntry.scoreBasisPoints, `${where}: score`);
    assert.equal(demoEntry.scorePercent, realEntry.scorePercent, `${where}: displayed score`);
    assert.equal(demoEntry.mustHavesMet, realEntry.mustHavesMet, `${where}: must-haves met`);
    assert.equal(demoEntry.mustHavesTotal, realEntry.mustHavesTotal, `${where}: must-haves total`);
    assert.deepEqual(demoEntry.failedMustHaves, realEntry.failedMustHaves, `${where}: failed must-haves`);
    assert.deepEqual(demoEntry.unclearMustHaves, realEntry.unclearMustHaves, `${where}: unclear must-haves`);
    assert.equal(demoEntry.position, realEntry.position, `${where}: position`);
    assert.equal(demoEntry.rank, realEntry.rank, `${where}: rank`);
    assert.equal(demoEntry.tiedWith, realEntry.tiedWith, `${where}: tied with`);
    // The sentence a recruiter reads. Generated by rankRules, so a difference
    // here means the two systems reached the same place for different reasons.
    assert.equal(demoEntry.rationale, realEntry.rationale, `${where}: rationale`);
  }
});

test('no placement depends on a tie-break the two systems cannot share', { skip }, async (t) => {
  // rankCandidates breaks a full tie on createdAt and then on candidate id.
  // The demo's ids and timestamps are deterministic literals; the real ones are
  // UUIDs and a wall clock. They cannot agree at that depth, so this asserts the
  // dataset never gets there — and fails loudly, with a reason, if a future
  // dataset change introduces such a tie rather than letting parity go flaky.
  const { ctx, jobId } = await real(t);
  const ranking = await rankJob({ repos: ctx.repos }, jobId);

  const keys = ranking.entries.map(
    (entry) => `${entry.tier}|${entry.scoreBasisPoints}|${entry.mustHavesMet}`,
  );
  assert.equal(
    new Set(keys).size,
    keys.length,
    'two candidates share a tier, score and must-have count, so their order is decided by ' +
      'createdAt/candidateId — values the demo cannot reproduce. Separate them in the dataset.',
  );
});

// --- per requirement ---------------------------------------------------------

test('every requirement gets the same verdict, confidence and contribution', { skip }, async (t) => {
  const { ctx, jobId } = await real(t);
  const { runDemo } = await loadRunner();

  const realRanking = await rankJob({ repos: ctx.repos }, jobId);
  const demo = await runDemo();

  let compared = 0;

  for (const realEntry of realRanking.entries) {
    if (!realEntry.evaluationId || realEntry.tier === 'not_evaluated') continue;

    const detail = await handleEvaluationDetail({ repos: ctx.repos }, realEntry.evaluationId);
    const demoRun = demo.candidates.find((run) => run.candidate.reference === realEntry.reference);
    assert.ok(demoRun, `${realEntry.reference} is missing from the demo run`);
    assert.ok(demoRun.score, `${realEntry.reference} has no score breakdown`);

    const where = realEntry.reference;

    // Both are in requirement/position order, so these line up index for index.
    // Compared by label rather than id: the ids differ by design (see
    // `normaliseIds`), the label is the requirement's semantic identity, and a
    // reordering would still be caught because the sequence must match.
    assert.deepEqual(
      demoRun.score.rows.map((row) => row.requirement.label),
      detail.body.requirements.map((requirement) => requirement.label),
      `${where}: requirement order`,
    );
    assert.deepEqual(
      demoRun.score.rows.map((row) => row.requirement.id),
      demoRun.matches.map((match) => match.requirementId),
      `${where}: the demo's own matches must follow its own requirement order`,
    );
    assert.deepEqual(
      demoRun.matches.map((match) => match.verdict),
      detail.body.requirements.map((requirement) => requirement.verdict),
      `${where}: verdicts`,
    );
    assert.deepEqual(
      demoRun.matches.map((match) => match.confidence),
      detail.body.requirements.map((requirement) => requirement.confidence),
      `${where}: confidence`,
    );
    assert.deepEqual(
      demoRun.matches.map((match) => match.contributionBasisPoints),
      detail.body.requirements.map((requirement) => requirement.contributionBasisPoints),
      `${where}: contributions`,
    );
    assert.deepEqual(
      demoRun.matches.map((match) => match.rationale),
      detail.body.requirements.map((requirement) => requirement.rationale),
      `${where}: per-requirement rationale`,
    );

    // The identity the explanation screen rests on, checked on both sides.
    const contributionTotal = demoRun.matches.reduce(
      (sum, match) => sum + match.contributionBasisPoints,
      0,
    );
    assert.equal(
      contributionTotal,
      demoRun.score.scoreBasisPoints,
      `${where}: contributions must sum to the headline score`,
    );

    assert.equal(demoRun.score.totalWeight, detail.body.requirements.reduce((sum, r) => sum + r.weight, 0));
    compared += 1;
  }

  assert.equal(compared, 4, 'four candidates should have been assessed and compared');
});

// --- redaction and verification ----------------------------------------------

test('the same protected attributes are found and masked', { skip }, async (t) => {
  const { ctx, jobId } = await real(t);
  const { runDemo } = await loadRunner();

  const realRanking = await rankJob({ repos: ctx.repos }, jobId);
  const demo = await runDemo();

  for (const realEntry of realRanking.entries) {
    if (!realEntry.evaluationId) continue;
    const detail = await handleEvaluationDetail({ repos: ctx.repos }, realEntry.evaluationId);

    const demoRun = demo.candidates.find((run) => run.candidate.reference === realEntry.reference);
    assert.ok(demoRun, `${realEntry.reference} is missing from the demo run`);

    const where = realEntry.reference;
    assert.equal(
      demoRun.resume.spans.length,
      detail.body.protectedAttributes.count,
      `${where}: number of masked spans`,
    );
    assert.deepEqual(
      [...new Set(demoRun.resume.spans.map((span) => span.category))].sort(),
      detail.body.protectedAttributes.categories,
      `${where}: masked categories`,
    );

    // And the masked copy really is masked, on the demo side too.
    const evaluation = await ctx.repos.evaluations.getById(realEntry.evaluationId);
    assert.ok(evaluation);
    const resume = await ctx.repos.resumes.getById(evaluation.resumeId);
    assert.ok(resume);
    assert.equal(demoRun.resume.redactedText, resume.redactedText, `${where}: redacted text`);
    assert.equal(demoRun.resume.contentText, resume.contentText, `${where}: original text`);
  }
});

test('the same evidence is verified, and the same amount rejected', { skip }, async (t) => {
  const { ctx, jobId } = await real(t);
  const { runDemo } = await loadRunner();

  const realRanking = await rankJob({ repos: ctx.repos }, jobId);
  const demo = await runDemo();

  for (const realEntry of realRanking.entries) {
    if (!realEntry.evaluationId || realEntry.tier === 'not_evaluated') continue;

    const detail = await handleEvaluationDetail({ repos: ctx.repos }, realEntry.evaluationId);
    const demoRun = demo.candidates.find((run) => run.candidate.reference === realEntry.reference);
    assert.ok(demoRun, `${realEntry.reference} is missing from the demo run`);

    const where = realEntry.reference;

    assert.equal(
      demoRun.evidence.length - demoRun.verifiedEvidence.length,
      detail.body.evidenceRejectedCount,
      `${where}: rejected evidence count`,
    );

    // Quote for quote, in the order both systems present them.
    const realQuotes = detail.body.requirements
      .flatMap((requirement) => requirement.evidence)
      .map((item) => item.quote)
      .sort();
    const demoQuotes = demoRun.verifiedEvidence.map((item) => item.quote).sort();
    assert.deepEqual(demoQuotes, realQuotes, `${where}: verified quotes`);

    // Every verified quote must genuinely be in the CV, on the demo side too.
    for (const item of demoRun.verifiedEvidence) {
      assert.equal(
        demoRun.resume.contentText.slice(item.charStart, item.charEnd),
        item.quote,
        `${where}: "${item.quote.slice(0, 40)}" is not at the offsets recorded for it`,
      );
    }
  }
});

// --- audit -------------------------------------------------------------------

test('the audit trail has the same stages, events and outcomes', { skip }, async (t) => {
  const { ctx, jobId } = await real(t);
  const { runDemo } = await loadRunner();

  const realRanking = await rankJob({ repos: ctx.repos }, jobId);
  const realRequirements = await ctx.repos.requirements.listForJob(jobId);
  const demo = await runDemo();

  for (const realEntry of realRanking.entries) {
    if (!realEntry.evaluationId) continue;

    const evaluation = await ctx.repos.evaluations.getById(realEntry.evaluationId);
    assert.ok(evaluation);

    const realEvents = await realAuditFor(ctx, evaluation.resumeId, evaluation.id);
    const demoRun = demo.candidates.find((run) => run.candidate.reference === realEntry.reference);
    assert.ok(demoRun, `${realEntry.reference} is missing from the demo run`);

    const where = realEntry.reference;

    assert.deepEqual(
      demoRun.audit.map((event) => [event.stage, event.eventType, event.outcome]),
      realEvents.map((event) => [event.stage, event.eventType, event.outcome]),
      `${where}: audit stage/event/outcome sequence`,
    );

    const realTokens = idTokens({
      jobId: evaluation.jobId,
      candidateId: evaluation.candidateId,
      resumeId: evaluation.resumeId,
      evaluationId: evaluation.id,
      requirementIds: realRequirements.map((requirement) => requirement.id),
    });
    const demoTokens = idTokens({
      jobId: demo.job.id,
      candidateId: demoRun.candidate.id,
      resumeId: demoRun.resume.id,
      evaluationId: demoRun.evaluation.id,
      requirementIds: demo.requirements.map((requirement) => requirement.id),
    });

    // The payloads that carry the numbers and the verdicts, not just the labels.
    // Only ids are tokenised; every other value is compared as it stands.
    for (const [index, realEvent] of realEvents.entries()) {
      // Annotated rather than inferred: `assert.ok` is an assertion signature,
      // and TypeScript refuses to narrow a const whose own type it is still
      // working out (TS7022). The demo's event type is the vendored copy of
      // this one, so they are the same shape by construction.
      const demoEvent: AuditEvent | undefined = demoRun.audit[index];
      assert.ok(demoEvent, `${where}: demo audit is missing event ${index}`);
      assert.deepEqual(
        normaliseIds(demoEvent.payload, demoTokens),
        normaliseIds(realEvent.payload, realTokens),
        `${where}: payload of "${realEvent.eventType}"`,
      );
      assert.equal(demoEvent.summary, realEvent.summary, `${where}: summary of "${realEvent.eventType}"`);
    }
  }
});

test('audit sequence numbers restart per correlation id, as the repository does', { skip }, async () => {
  const { runDemo } = await loadRunner();
  const demo = await runDemo();

  const seen = new Map<string, number[]>();
  for (const event of demo.audit) {
    const list = seen.get(event.correlationId) ?? [];
    list.push(event.sequence);
    seen.set(event.correlationId, list);
  }

  for (const [correlationId, sequences] of seen) {
    assert.deepEqual(
      sequences,
      sequences.map((_, index) => index + 1),
      `${correlationId}: sequences must run 1..n with no gaps`,
    );
  }

  // There is no rank event, by design: ranking is derived on read and writes
  // nothing. If one ever appears here, the demo has invented an event the real
  // system does not record.
  assert.equal(
    demo.audit.some((event) => event.stage === ('rank' as never)),
    false,
    'ranking must not emit an audit event',
  );
});

// --- determinism -------------------------------------------------------------

test('two runs of the demo runner are byte-identical', { skip }, async () => {
  const { runDemo } = await loadRunner();

  const first = await runDemo();
  const second = await runDemo();

  // The whole result, not a chosen subset — if any id, timestamp or ordering
  // were non-deterministic it would show up here rather than being excluded.
  assert.equal(
    JSON.stringify(second),
    JSON.stringify(first),
    'the demo runner returned a different result on the second run',
  );
});

test('the demo runner carries no wall-clock or random values', { skip }, async () => {
  const { runDemo, DEMO_TIMESTAMP } = await loadRunner();
  const demo = await runDemo();

  const serialised = JSON.stringify(demo);

  // Every timestamp in the result is the fixed one.
  const timestamps = serialised.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g) ?? [];
  assert.ok(timestamps.length > 0, 'expected the result to carry timestamps');
  for (const value of timestamps) {
    assert.equal(value, DEMO_TIMESTAMP, 'a timestamp other than the fixed one reached the result');
  }

  // And no UUID-shaped id, which is what a stray randomUUID() would look like.
  assert.equal(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialised),
    false,
    'a UUID reached the demo result, so something generated an id at run time',
  );
});

// --- the dataset's own promises still hold on the demo side ------------------

test('the demo reproduces every outcome the dataset says it will', { skip }, async () => {
  const { runDemo } = await loadRunner();
  const demo = await runDemo();

  for (const candidate of DEMO_CANDIDATES) {
    const entry = demo.ranking.entries.find((item) => item.reference === candidate.reference);
    assert.ok(entry, `${candidate.displayName} is missing from the demo ranking`);

    assert.equal(entry.tier, candidate.expected.tier, `${candidate.displayName}: tier`);
    assert.equal(
      entry.scoreBasisPoints,
      candidate.expected.scoreBasisPoints,
      `${candidate.displayName}: score`,
    );

    if (candidate.expected.verdicts.length > 0) {
      const run = demo.candidates.find((item) => item.candidate.reference === candidate.reference);
      assert.ok(run);
      assert.deepEqual(
        run.matches.map((match) => match.verdict),
        candidate.expected.verdicts,
        `${candidate.displayName}: verdicts`,
      );
    }
  }
});

test('the gate is visible in the demo too: same score, one tier apart', { skip }, async () => {
  // The single thing this dataset exists to show, asserted against the demo
  // rather than the server — because the demo is what a client will look at.
  const { runDemo } = await loadRunner();
  const demo = await runDemo();

  const devi = demo.ranking.entries.find((entry) => entry.reference === 'demo-002');
  const marcus = demo.ranking.entries.find((entry) => entry.reference === 'demo-003');
  assert.ok(devi && marcus);

  assert.equal(devi.scoreBasisPoints, marcus.scoreBasisPoints, 'the two must score the same');
  assert.equal(devi.scorePercent, marcus.scorePercent, 'and must read the same on screen');
  assert.equal(devi.tier, 'qualified');
  assert.equal(marcus.tier, 'gated');
  assert.ok(devi.position < marcus.position, 'the qualified candidate must be placed higher');
  assert.deepEqual(marcus.failedMustHaves, ['PostgreSQL']);
  assert.match(marcus.rationale, /does not demonstrate "PostgreSQL"/);
  assert.match(marcus.rationale, /the score itself is unchanged/);
});
