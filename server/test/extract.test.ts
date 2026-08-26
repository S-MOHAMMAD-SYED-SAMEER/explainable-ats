import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractEvidence, openEvaluation } from '../src/agent/extract.ts';
import { EXTRACTION_PROMPT_VERSION } from '../src/agent/extractionSchema.ts';
import { createDeterministicExtractor } from '../src/agent/mockExtractor.ts';
import { MASK_CHAR } from '../src/agent/redact.ts';
import { createTestContext, rejects } from './helpers.ts';
import { seedScenario, RESUME_TEXT, SENSITIVE_VALUES, CANDIDATE_NAME } from './fixtures.ts';
import type { LlmRequest } from '../src/adapters/llm/types.ts';

// The extraction stage, end to end.
//
// Two guarantees are load-bearing and everything else here supports them:
//
//   1. Nothing protected reaches the model.
//   2. Nothing unverified becomes usable evidence.

/** Concatenates everything the provider was actually sent. */
function everythingSent(calls: readonly LlmRequest[]): string {
  return calls.map((call) => `${call.systemPrompt}\n${call.messages.map((m) => m.content).join('\n')}`).join('\n');
}

// --- the fairness boundary ---------------------------------------------------

test('no protected attribute reaches the model', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos);
  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  assert.equal(scenario.provider.calls.length, 1, 'precondition: the model was actually called');
  const sent = everythingSent(scenario.provider.calls);

  for (const value of SENSITIVE_VALUES) {
    // Precondition on every iteration: the value is in the document that was
    // ingested, so "absent from the prompt" means it was removed rather than
    // never there.
    assert.ok(RESUME_TEXT.includes(value), `precondition: the resume contains ${value}`);
    assert.ok(!sent.includes(value), `${value} was sent to the model`);
  }

  // Negative control. The same search against the ORIGINAL text finds every
  // value, so the assertions above are capable of failing.
  for (const value of SENSITIVE_VALUES) {
    assert.ok(RESUME_TEXT.includes(value));
  }

  assert.ok(sent.includes(MASK_CHAR), 'the model should see that something was removed');
});

test('the model is sent the redacted copy, and nothing else from the resume', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos);
  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  const message = scenario.provider.calls[0]?.messages.at(-1)?.content ?? '';

  assert.ok(message.includes(scenario.resume.redactedText));
  assert.ok(!message.includes(scenario.resume.contentText));
  assert.notEqual(scenario.resume.redactedText, scenario.resume.contentText, 'precondition: the two differ');
});

test('the candidate name is nowhere in the request, not even as a label', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos);
  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  assert.equal(scenario.candidate.displayName, CANDIDATE_NAME, 'precondition: the system knows the name');
  assert.ok(!JSON.stringify(scenario.provider.calls).includes(CANDIDATE_NAME));
});

// --- the happy path ----------------------------------------------------------

test('every stored piece of evidence is present in the resume at its recorded offsets', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos);
  const outcome = await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  assert.ok(outcome.verified > 0, 'precondition: the stand-in found something');
  assert.equal(outcome.rejected, 0);
  assert.equal(outcome.malformed, 0);

  const evidence = await ctx.repos.evidence.listVerifiedForEvaluation(scenario.evaluation.id);
  assert.equal(evidence.length, outcome.verified);

  for (const item of evidence) {
    assert.equal(
      scenario.resume.contentText.slice(item.charStart, item.charEnd),
      item.quote,
      `evidence ${item.id} does not sit where it says it does`,
    );
    assert.ok(!item.quote.includes(MASK_CHAR));
    assert.ok(item.requirementId, 'evidence must cite a requirement');
  }
});

test('the offsets index the original and the redacted copy identically', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  // The payoff of length-preserving masking: an offset produced against
  // `redacted_text` addresses the same characters in `content_text`, with no
  // mapping table to build and no off-by-one to get wrong.
  const scenario = await seedScenario(ctx.repos);
  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  const evidence = await ctx.repos.evidence.listVerifiedForEvaluation(scenario.evaluation.id);
  assert.ok(evidence.length > 0);

  for (const item of evidence) {
    assert.equal(scenario.resume.redactedText.slice(item.charStart, item.charEnd), item.quote);
  }
});

test('an indented line is quoted without its indentation, and the offset accounts for it', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos);
  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  const indented = 'Led the migration from a single PostgreSQL instance to a replicated cluster.';
  assert.ok(RESUME_TEXT.includes(`\n  ${indented}`), 'precondition: the fixture line is indented');

  const evidence = await ctx.repos.evidence.listVerifiedForEvaluation(scenario.evaluation.id);
  const item = evidence.find((entry) => entry.quote === indented);

  assert.ok(item, 'the indented line should have been quoted');
  assert.equal(scenario.resume.contentText.slice(item.charStart, item.charEnd), indented);
});

test('the evaluation moves pending -> extracted and records how it was produced', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos);
  assert.equal(scenario.evaluation.status, 'pending', 'precondition');
  assert.equal(scenario.evaluation.model, null);

  const outcome = await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  assert.equal(outcome.evaluation.status, 'extracted');
  assert.equal(outcome.evaluation.model, 'mock');
  assert.equal(outcome.evaluation.promptVersion, EXTRACTION_PROMPT_VERSION);
  assert.equal(outcome.evaluation.scoreBasisPoints, null, 'scoring is a later stage and must not happen here');
});

test('extraction writes the audit trail a recruiter can read back', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos);
  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  const events = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  const types = events.map((event) => event.eventType);

  assert.deepEqual(types, ['evaluation_opened', 'evidence_verified', 'extraction_recorded']);

  const recorded = events.find((event) => event.eventType === 'extraction_recorded');
  assert.equal(recorded?.actor, 'ai');
  assert.equal(recorded?.actorId, 'mock');
  assert.equal(recorded?.payload.promptVersion, EXTRACTION_PROMPT_VERSION);

  const verified = events.find((event) => event.eventType === 'evidence_verified');
  assert.equal(verified?.stage, 'verify');
  assert.ok((verified?.payload.verified as number) > 0);
  assert.equal(verified?.payload.rejected, 0);

  // Sequence numbers are contiguous from 1: the trail is append-only and has
  // no gap where an event could have been removed.
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
});

// --- determinism -------------------------------------------------------------

test('the stand-in model gives byte-identical answers to the same prompt', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos);
  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  const request = scenario.provider.calls[0] as LlmRequest;
  const extractor = createDeterministicExtractor();

  const first = extractor(request);
  const second = extractor(request);

  assert.ok((first.findings as unknown[]).length > 0, 'precondition: there is something to compare');
  assert.equal(JSON.stringify(second), JSON.stringify(first), 'order or content varied between calls');
});

test('two runs over the same inputs store the same evidence', async (t) => {
  // Determinism at the level that matters: the whole pipeline, in two separate
  // databases, producing the same quotes at the same offsets.
  const runs = [];
  for (let i = 0; i < 2; i += 1) {
    const ctx = await createTestContext();
    t.after(() => ctx.close());

    const scenario = await seedScenario(ctx.repos);
    await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

    const evidence = await ctx.repos.evidence.listVerifiedForEvaluation(scenario.evaluation.id);
    runs.push(evidence.map((item) => [item.requirementId, item.quote, item.charStart, item.charEnd]));
  }

  assert.ok((runs[0] as unknown[]).length > 0);
  assert.deepEqual(runs[1], runs[0]);
});

// --- the model misbehaving ---------------------------------------------------

test('a fabricated quote is stored unverified and can never be read as evidence', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos, { deterministicExtractor: false });
  const invented = 'Led a team of twelve engineers across three continents.';
  assert.ok(!RESUME_TEXT.includes(invented), 'precondition: the resume does not contain it');

  scenario.provider.register('extract_evidence', {
    findings: [
      {
        requirementId: scenario.requirements[0]?.id,
        quote: invented,
        charStart: 0,
        charEnd: invented.length,
        reasoning: 'Sounds like leadership.',
      },
    ],
  });

  const outcome = await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  assert.equal(outcome.verified, 0);
  assert.equal(outcome.rejected, 1);

  // Stored, so the fabrication is visible in the audit view...
  const all = await ctx.repos.evidence.listForEvaluation(scenario.evaluation.id);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.verified, false);

  // ...but invisible to everything that shows or scores.
  const usable = await ctx.repos.evidence.listVerifiedForEvaluation(scenario.evaluation.id);
  assert.deepEqual(usable, []);

  const events = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  const rejection = events.find((event) => event.eventType === 'unverifiable_evidence_rejected');
  assert.equal(rejection?.outcome, 'blocked');
  assert.deepEqual(rejection?.payload.reasons, ['not_found_in_resume']);

  // The evaluation still completes: a model that invented one quote has still
  // been run, and "extracted, with nothing usable" is the honest state.
  assert.equal(outcome.evaluation.status, 'extracted');
});

test('a quote lifted from a masked region is rejected, not laundered back in', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos, { deterministicExtractor: false });
  const email = 'priya.raman@example.com';
  const at = RESUME_TEXT.indexOf(email);

  // The quote IS in content_text. Only the redaction span makes it impossible.
  assert.notEqual(at, -1, 'precondition: the email is in the original');
  assert.ok(!scenario.resume.redactedText.includes(email), 'precondition: the model was not shown it');

  scenario.provider.register('extract_evidence', {
    findings: [
      {
        requirementId: scenario.requirements[0]?.id,
        quote: email,
        charStart: at,
        charEnd: at + email.length,
        reasoning: 'Contact details.',
      },
    ],
  });

  const outcome = await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  assert.equal(outcome.verified, 0);
  assert.equal(outcome.rejected, 1);

  const events = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  const rejection = events.find((event) => event.eventType === 'unverifiable_evidence_rejected');
  assert.deepEqual(rejection?.payload.reasons, ['quotes_redacted_text']);
});

test('malformed findings are dropped with a reason, and their neighbours survive', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos, { deterministicExtractor: false });
  const real = 'Mentored three junior engineers through their first production deployments.';
  const at = RESUME_TEXT.indexOf(real);
  assert.notEqual(at, -1);

  scenario.provider.register('extract_evidence', {
    findings: [
      { requirementId: scenario.requirements[0]?.id, quote: real, charStart: at, charEnd: at + real.length, reasoning: 'ok' },
      { requirementId: scenario.requirements[0]?.id, quote: '', charStart: 0, charEnd: 5, reasoning: 'empty' },
      { requirementId: 'a-requirement-from-another-job', quote: real, charStart: at, charEnd: at + real.length, reasoning: 'wrong job' },
      'not even an object',
    ],
  });

  const outcome = await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  assert.equal(outcome.verified, 1, 'the well-formed finding must survive');
  assert.equal(outcome.malformed, 3);

  const events = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  const dropped = events.find((event) => event.eventType === 'malformed_findings_dropped');
  assert.equal(dropped?.outcome, 'blocked');
  assert.deepEqual(dropped?.payload.reasons, ['empty_quote', 'unknown_requirement', 'not_an_object']);
});

test('output that is not the agreed shape at all leaves the evaluation with no evidence', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos, { deterministicExtractor: false });
  scenario.provider.register('extract_evidence', { results: 'the candidate looks strong' });

  const outcome = await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  assert.equal(outcome.verified, 0);
  assert.equal(outcome.malformed, 1);
  assert.equal(await ctx.repos.evidence.count(), 0);
});

test('a provider outage is recorded as a failure, never as an empty result', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  // "The model found nothing" and "the model could not be reached" are
  // different facts, and only one of them says anything about the candidate.
  const scenario = await seedScenario(ctx.repos, { deterministicExtractor: false });
  scenario.provider.registerFailure('extract_evidence', 'connection reset');

  const err = await rejects(() =>
    extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id),
  );
  assert.match(err.message, /could not be reached/);

  const evaluation = await ctx.repos.evaluations.getById(scenario.evaluation.id);
  assert.equal(evaluation?.status, 'failed');
  assert.equal(await ctx.repos.evidence.count(), 0);

  const events = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  const failure = events.find((event) => event.eventType === 'extraction_failed');
  assert.equal(failure?.outcome, 'failed');

  // The provider's own message stays internal: it can carry a URL, a host name
  // or a key fragment, and none of that belongs in a recruiter-facing trail.
  assert.ok(!JSON.stringify(events).includes('connection reset'));
});

// --- lifecycle ---------------------------------------------------------------

test('an evaluation that already ran cannot be re-extracted in place', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos);
  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  const err = await rejects(() =>
    extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id),
  );

  assert.match(err.message, /already been extracted/);
  assert.equal(scenario.provider.calls.length, 1, 'the model must not be called a second time');
});

test('re-running means opening a new evaluation, and the old one keeps its evidence', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos);
  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);
  const before = await ctx.repos.evidence.listVerifiedForEvaluation(scenario.evaluation.id);
  assert.ok(before.length > 0, 'precondition');

  const second = await openEvaluation({ repos: ctx.repos }, {
    jobId: scenario.job.id,
    candidateId: scenario.candidate.id,
    resume: scenario.resume,
  });
  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, second.id);

  const superseded = await ctx.repos.evaluations.getById(scenario.evaluation.id);
  assert.equal(superseded?.supersededBy, second.id);

  // History is what makes a decision from last month explainable, so the
  // superseded evaluation must keep everything it had.
  const after = await ctx.repos.evidence.listVerifiedForEvaluation(scenario.evaluation.id);
  assert.deepEqual(after.map((item) => item.quote), before.map((item) => item.quote));

  const current = await ctx.repos.evaluations.getCurrent(scenario.job.id, scenario.candidate.id);
  assert.equal(current?.id, second.id);
});

test('extracting an evaluation that does not exist is a not-found, not a crash', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const scenario = await seedScenario(ctx.repos);
  const err = await rejects(() =>
    extractEvidence({ repos: ctx.repos, provider: scenario.provider }, 'no-such-evaluation'),
  );

  assert.match(err.message, /does not exist/);
  assert.equal(scenario.provider.calls.length, 0);
});

test('a job with no requirements refuses to extract rather than finding nothing', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  // `createJob` refuses this, so it is built through the repositories to prove
  // the extraction stage does not rely on that guard alone.
  const scenario = await seedScenario(ctx.repos);
  const bare = await ctx.repos.jobs.create({
    title: 'Unspecified',
    seniority: 'mid',
    description: '',
    status: 'open',
  });
  assert.deepEqual(await ctx.repos.requirements.listForJob(bare.id), [], 'precondition');

  const evaluation = await openEvaluation({ repos: ctx.repos }, {
    jobId: bare.id,
    candidateId: scenario.candidate.id,
    resume: scenario.resume,
  });

  const err = await rejects(() =>
    extractEvidence({ repos: ctx.repos, provider: scenario.provider }, evaluation.id),
  );

  assert.match(err.message, /no requirements/);
  assert.equal(scenario.provider.calls.length, 0);
});
