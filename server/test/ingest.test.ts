import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJob, ingestResume } from '../src/agent/ingest.ts';
import { createTestContext, rejects } from './helpers.ts';
import { RESUME_TEXT, SENSITIVE_VALUES, CANDIDATE_NAME, JOB_INPUT } from './fixtures.ts';
import { MASK_CHAR } from '../src/agent/redact.ts';

// Ingestion. The rule that shapes the whole stage: a resume is redacted before
// it is stored, so there is no window in which a resume exists with no
// redaction and something reading it hands the model the original.

async function ingest(repos: Parameters<typeof ingestResume>[0]['repos'], text = RESUME_TEXT) {
  return ingestResume({ repos }, {
    reference: 'cand-001',
    displayName: CANDIDATE_NAME,
    text,
    source: 'upload',
  });
}

test('a resume is stored with both copies, and the redacted one is genuinely different', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { resume, created, redactedCount } = await ingest(ctx.repos);

  assert.equal(created, true);
  assert.ok(redactedCount > 0, 'the fixture carries protected attributes to find');
  assert.equal(resume.contentText, RESUME_TEXT, 'the original is kept verbatim');
  assert.notEqual(resume.redactedText, RESUME_TEXT);
  assert.equal(resume.redactedText.length, RESUME_TEXT.length, 'offsets must survive');
  assert.equal(resume.charCount, RESUME_TEXT.length);
});

test('no protected value survives into the copy the model will be shown', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { resume } = await ingest(ctx.repos);

  for (const value of SENSITIVE_VALUES) {
    assert.ok(resume.contentText.includes(value), `precondition: ${value} is in the original`);
    assert.ok(!resume.redactedText.includes(value), `${value} reached redacted_text`);
  }
  assert.ok(resume.redactedText.includes(MASK_CHAR));
});

test('the quarantine records where a protected attribute was, and never what it said', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { resume } = await ingest(ctx.repos);
  const findings = await ctx.repos.sensitiveFindings.listForResume(resume.id);

  assert.ok(findings.length > 0);

  // Structural, not textual: searching the row for each protected string would
  // pass for the wrong reason the moment a value happened not to appear. The
  // guarantee is that there is nowhere to put a value.
  const rows = await ctx.db.query('SELECT * FROM sensitive_findings LIMIT 1');
  assert.ok(rows[0], 'precondition: a row exists to inspect');
  assert.deepEqual(Object.keys(rows[0] as object).sort(), [
    'category',
    'char_end',
    'char_start',
    'created_at',
    'id',
    'resume_id',
  ]);

  // And the spans really do point at the protected text in the original.
  for (const finding of findings) {
    const original = resume.contentText.slice(finding.charStart, finding.charEnd);
    const masked = resume.redactedText.slice(finding.charStart, finding.charEnd);
    assert.ok(original.length > 0);
    assert.equal(masked, MASK_CHAR.repeat(original.length));
  }
});

test('every category the fixture carries is detected', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { resume } = await ingest(ctx.repos);
  const findings = await ctx.repos.sensitiveFindings.listForResume(resume.id);
  const categories = new Set(findings.map((finding) => finding.category));

  for (const expected of ['name', 'contact', 'age', 'nationality', 'gender', 'address']) {
    assert.ok(categories.has(expected as never), `${expected} was not detected`);
  }
});

test('ingestion writes an audit trail that is safe to read', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { resume } = await ingest(ctx.repos);
  const events = await ctx.repos.audit.listForCorrelation(resume.id);
  const types = events.map((event) => event.eventType);

  assert.deepEqual(types.sort(), ['resume_ingested', 'sensitive_attributes_masked']);

  const masked = events.find((event) => event.eventType === 'sensitive_attributes_masked');
  assert.equal(masked?.stage, 'redact');
  assert.ok(Array.isArray(masked?.payload.categories));
  assert.ok((masked?.payload.count as number) > 0);

  // The event that proves the boundary was applied has to be safe to read, or
  // the audit trail becomes the leak.
  const serialised = JSON.stringify(events);
  for (const value of SENSITIVE_VALUES) {
    assert.ok(!serialised.includes(value), `${value} leaked into the audit trail`);
  }
});

test('a resume with nothing protected in it says so explicitly', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const clean = 'SUMMARY\nDesigned and shipped a Node.js settlement service.\n';
  const { resume, redactedCount } = await ingestResume({ repos: ctx.repos }, {
    reference: 'cand-clean',
    displayName: null,
    text: clean,
  });

  assert.equal(redactedCount, 0);
  assert.equal(resume.redactedText, clean, 'nothing was masked');

  const events = await ctx.repos.audit.listForCorrelation(resume.id);
  assert.ok(events.some((event) => event.eventType === 'no_sensitive_attributes_found'));
  assert.ok(!events.some((event) => event.eventType === 'sensitive_attributes_masked'));
});

test('the same document twice is one resume, with the quarantine recorded once', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const first = await ingest(ctx.repos);
  const findingsAfterFirst = await ctx.repos.sensitiveFindings.count();
  assert.ok(findingsAfterFirst > 0, 'precondition: the first ingest recorded findings');

  const second = await ingest(ctx.repos);

  assert.equal(second.created, false);
  assert.equal(second.resume.id, first.resume.id);
  assert.equal(second.redactedCount, first.redactedCount);
  assert.equal(await ctx.repos.resumes.count(), 1);
  assert.equal(await ctx.repos.candidates.count(), 1);
  assert.equal(await ctx.repos.sensitiveFindings.count(), findingsAfterFirst, 'the quarantine was duplicated');

  const events = await ctx.repos.audit.listForCorrelation(first.resume.id);
  const skipped = events.find((event) => event.eventType === 'resume_already_present');
  assert.equal(skipped?.outcome, 'skipped');
});

test('a genuinely different document for the same candidate is a second resume', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const first = await ingest(ctx.repos);
  const second = await ingest(ctx.repos, `${RESUME_TEXT}\nAWS Certified Solutions Architect.`);

  assert.equal(second.created, true);
  assert.notEqual(second.resume.id, first.resume.id);
  assert.equal(second.resume.candidateId, first.resume.candidateId);
  assert.equal(await ctx.repos.resumes.count(), 2);
});

test('an empty resume is refused', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const err = await rejects(() => ingestResume({ repos: ctx.repos }, { reference: 'cand-x', text: '   \n\n ' }));

  assert.match(err.message, /cannot be empty/);
  assert.equal(await ctx.repos.resumes.count(), 0);
  assert.equal(await ctx.repos.candidates.count(), 0, 'a refused ingest must not leave a candidate behind');
});

test('an absurdly large resume is refused before it is redacted', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const err = await rejects(() =>
    ingestResume({ repos: ctx.repos }, { reference: 'cand-x', text: 'a'.repeat(200_001) }),
  );

  assert.match(err.message, /cannot exceed/);
  assert.equal(await ctx.repos.resumes.count(), 0);
});

test('a job is created together with its requirements', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const { job, requirements } = await createJob({ repos: ctx.repos }, JOB_INPUT);

  assert.equal(requirements.length, JOB_INPUT.requirements.length);
  assert.equal(job.status, 'open');

  const events = await ctx.repos.audit.listForCorrelation(job.id);
  const created = events.find((event) => event.eventType === 'job_created');
  assert.equal(created?.actor, 'human');
  assert.equal(created?.payload.mustHaves, 2);
  assert.equal(created?.payload.niceToHaves, 1);
});

test('a job with no requirements is refused', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  // Otherwise it would produce an evaluation scoring zero out of zero, which
  // reads exactly like a rejection.
  const err = await rejects(() =>
    createJob({ repos: ctx.repos }, { ...JOB_INPUT, requirements: [] }),
  );

  assert.match(err.message, /at least one requirement/);
  assert.equal(await ctx.repos.jobs.count(), 0);
});
