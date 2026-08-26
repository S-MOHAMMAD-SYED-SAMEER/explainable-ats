import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { hashPassword } from '../src/lib/password.ts';
import { CSRF_HEADER } from '../src/auth/csrf.ts';
import { createJob, ingestResume } from '../src/agent/ingest.ts';
import { extractEvidence, openEvaluation } from '../src/agent/extract.ts';
import { createMockLlmProvider } from '../src/adapters/llm/mock.ts';
import { installDeterministicExtractor } from '../src/agent/mockExtractor.ts';
import { matchAndScore } from '../src/agent/match.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import { JOB_INPUT, RESUME_TEXT, SENSITIVE_VALUES } from './fixtures.ts';
import type { Repositories } from '../src/db/repositories/index.ts';

// The recruiter API, over real HTTP.
//
// The handlers are exercised directly elsewhere; what only a server can prove
// is that these routes sit behind the session gate, that a decision needs a
// CSRF token, and that what actually crosses the wire carries no protected
// value and no unverified quote.

const PASSWORD = 'p3f-operator-password-2026';

const QUOTES = {
  nodeMet: 'Designed and shipped production Node.js services.',
  nodeNotMet: 'Node.js.',
  postgresMet: 'Run PostgreSQL migrations at scale.',
} as const;

type Client = {
  base: string;
  /** Signed-in GET. */
  get: <T>(path: string) => Promise<{ status: number; body: T }>;
  post: <T>(path: string, body: unknown, options?: { csrf?: boolean }) => Promise<{ status: number; body: T }>;
  /** No cookies at all. */
  anonymous: (path: string) => Promise<Response>;
};

type Seeded = {
  job: Awaited<ReturnType<typeof createJob>>;
  scored: string;
  /** Built by the real extraction pipeline, so its quotes went through the verifier. */
  pipeline: string;
  unscored: string;
  superseded: string;
  replacement: string;
};

async function seed(repos: Repositories): Promise<Seeded> {
  const job = await createJob({ repos }, JOB_INPUT);

  const build = async (reference: string, evidence: Array<{ requirement: number; quote: string; verified?: boolean }>) => {
    const { candidate, resume } = await ingestResume({ repos }, {
      reference,
      displayName: `Name of ${reference}`,
      text: `${RESUME_TEXT}\nReference: ${reference}`,
    });
    const evaluation = await openEvaluation({ repos }, { jobId: job.job.id, candidateId: candidate.id, resume });
    await repos.evaluations.recordExtraction(evaluation.id, {
      model: 'mock',
      promptVersion: 'extract-v1',
      latencyMs: 0,
    });
    for (const item of evidence) {
      await repos.evidence.record({
        evaluationId: evaluation.id,
        resumeId: resume.id,
        requirementId: job.requirements[item.requirement]?.id,
        quote: item.quote,
        charStart: 0,
        charEnd: item.quote.length,
        verified: item.verified ?? true,
      });
    }
    return { candidate, resume, evaluation };
  };

  // Scored, all must-haves met, plus one fabricated quote that was rejected at
  // verification and must never leave the server.
  const strong = await build('strong', [
    { requirement: 0, quote: QUOTES.nodeMet },
    { requirement: 1, quote: QUOTES.postgresMet },
    { requirement: 2, quote: 'Never written by anyone.', verified: false },
  ]);
  await matchAndScore({ repos }, strong.evaluation.id);

  // Scored, one must-have found and not demonstrated.
  const gated = await build('gated', [
    { requirement: 0, quote: QUOTES.nodeMet },
    { requirement: 1, quote: QUOTES.nodeNotMet },
  ]);
  await matchAndScore({ repos }, gated.evaluation.id);

  // Extracted but never scored.
  const pending = await build('pending', [{ requirement: 0, quote: QUOTES.nodeMet }]);

  // Scored and then replaced.
  const old = await build('replaced', [{ requirement: 0, quote: QUOTES.nodeMet }]);
  await matchAndScore({ repos }, old.evaluation.id);
  const replacement = await openEvaluation({ repos }, {
    jobId: job.job.id,
    candidateId: old.candidate.id,
    resume: old.resume,
  });
  await repos.evaluations.recordExtraction(replacement.id, {
    model: 'mock',
    promptVersion: 'extract-v1',
    latencyMs: 0,
  });
  await repos.evidence.record({
    evaluationId: replacement.id,
    resumeId: old.resume.id,
    requirementId: job.requirements[0]?.id,
    quote: QUOTES.nodeMet,
    charStart: 0,
    charEnd: QUOTES.nodeMet.length,
    verified: true,
  });
  await matchAndScore({ repos }, replacement.id);

  // One candidate assessed the way production would: the stand-in model picks
  // passages out of the redacted resume and the verifier checks each one
  // against the original. The hand-built candidates above pin down exact
  // verdicts; this one pins down that the pipeline's own output survives to the
  // wire intact.
  const real = await ingestResume({ repos }, {
    reference: 'pipeline',
    displayName: 'Name of pipeline',
    text: `${RESUME_TEXT}
Reference: pipeline`,
  });
  const realEvaluation = await openEvaluation({ repos }, {
    jobId: job.job.id,
    candidateId: real.candidate.id,
    resume: real.resume,
  });
  const provider = createMockLlmProvider();
  installDeterministicExtractor(provider);
  await extractEvidence({ repos, provider }, realEvaluation.id);
  await matchAndScore({ repos }, realEvaluation.id);

  return {
    job,
    scored: strong.evaluation.id,
    pipeline: realEvaluation.id,
    unscored: pending.evaluation.id,
    superseded: old.evaluation.id,
    replacement: replacement.id,
  };
}

async function withApi(
  fn: (client: Client, seeded: Seeded, ctx: TestContext) => Promise<void>,
): Promise<void> {
  const ctx = await createTestContext();
  const config: AppConfig = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    cookieSecure: false,
  };

  const seeded = await seed(ctx.repos);

  const app = createApp({ db: ctx.db, config, logger: createMemoryLogger().logger });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  // Sign in once and reuse the cookie pair, exactly as a browser would.
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200, 'precondition: the harness could sign in');

  const cookies = (login.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0] ?? '').join('; ');
  const csrf = /inbox_csrf=([^;]+)/.exec(cookies)?.[1] ?? '';
  assert.notEqual(csrf, '', 'precondition: a CSRF token was issued');

  const client: Client = {
    base,
    async get(path) {
      const response = await fetch(`${base}${path}`, { headers: { cookie: cookies } });
      return { status: response.status, body: (await response.json()) as never };
    },
    async post(path, body, options = {}) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          cookie: cookies,
          'content-type': 'application/json',
          ...(options.csrf === false ? {} : { [CSRF_HEADER]: csrf }),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as never };
    },
    anonymous: (path) => fetch(`${base}${path}`),
  };

  try {
    await fn(client, seeded, ctx);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.close();
  }
}

// --- the gate ----------------------------------------------------------------

test('every recruiter endpoint is behind the session gate', async () => {
  await withApi(async (client, seeded) => {
    const paths = [
      '/api/jobs',
      `/api/jobs/${seeded.job.job.id}`,
      `/api/jobs/${seeded.job.job.id}/ranking`,
      `/api/evaluations/${seeded.scored}`,
      `/api/evaluations/${seeded.scored}/audit`,
    ];

    for (const path of paths) {
      const response = await client.anonymous(path);
      assert.equal(response.status, 401, `${path} answered ${response.status} without a session`);
    }

    // Positive control: the same paths answer with a session, so the 401s above
    // are the gate and not a missing route.
    for (const path of paths) {
      const { status } = await client.get(path);
      assert.equal(status, 200, `${path} answered ${status} WITH a session`);
    }
  });
});

test('a decision without a CSRF token is refused', async () => {
  await withApi(async (client, seeded, ctx) => {
    const refused = await client.post(
      `/api/evaluations/${seeded.scored}/decision`,
      { outcome: 'shortlist', reason: 'Strong on both must-haves.' },
      { csrf: false },
    );

    assert.equal(refused.status, 403);
    assert.equal(await ctx.repos.decisions.count(), 0, 'nothing was recorded');
  });
});

// --- jobs --------------------------------------------------------------------

test('the jobs list reports counts the browser does not have to work out', async () => {
  await withApi(async (client) => {
    const { status, body } = await client.get<{ jobs: Array<Record<string, unknown>> }>('/api/jobs');

    assert.equal(status, 200);
    assert.equal(body.jobs.length, 1);
    const job = body.jobs[0] as Record<string, unknown>;
    assert.equal(job.title, JOB_INPUT.title);
    assert.equal(job.requirementCount, 3);
    assert.equal(job.mustHaveCount, 2);
    assert.equal(job.candidateCount, 5, 'five candidates, each counted once despite one being re-assessed');
  });
});

test('job detail carries the requirements a decision will be explained against', async () => {
  await withApi(async (client, seeded) => {
    const { body } = await client.get<{ requirements: Array<Record<string, unknown>> }>(
      `/api/jobs/${seeded.job.job.id}`,
    );

    assert.equal(body.requirements.length, 3);
    assert.deepEqual(body.requirements.map((r) => r.kind), ['must_have', 'must_have', 'nice_to_have']);
    assert.deepEqual(body.requirements.map((r) => r.weight), [3, 2, 1]);
    for (const requirement of body.requirements) {
      assert.ok(typeof requirement.criterion === 'string' && (requirement.criterion as string).length > 0);
    }
  });
});

test('a job that does not exist is a 404, not an empty page', async () => {
  await withApi(async (client) => {
    const { status } = await client.get('/api/jobs/no-such-job');
    assert.equal(status, 404);
  });
});

// --- ranking -----------------------------------------------------------------

test('the ranking arrives finished — order, ranks and sentences all decided', async () => {
  await withApi(async (client, seeded) => {
    const { body } = await client.get<{
      entries: Array<Record<string, unknown>>;
      rankedCount: number;
      notEvaluatedCount: number;
    }>(`/api/jobs/${seeded.job.job.id}/ranking`);

    assert.equal(body.entries.length, 5);
    assert.equal(body.notEvaluatedCount, 1, 'the unscored candidate');

    // Positions are contiguous and already in display order, so the browser has
    // nothing to sort.
    assert.deepEqual(body.entries.map((entry) => entry.position), [1, 2, 3, 4, 5]);
    assert.equal(body.entries[0]?.reference, 'strong');

    for (const entry of body.entries) {
      assert.ok(typeof entry.rationale === 'string' && (entry.rationale as string).length > 20);
      assert.ok(['qualified', 'needs_review', 'gated', 'not_evaluated'].includes(entry.tier as string));

      // The rounding arrives done. The browser is not allowed to divide a
      // score, so a null here for an assessed candidate would blank the list.
      if (entry.scoreBasisPoints === null) assert.equal(entry.scorePercent, null);
      else assert.match(entry.scorePercent as string, /^\d+%$/);
    }

    assert.ok(
      body.entries.some((entry) => typeof entry.scorePercent === 'string'),
      'precondition: at least one candidate was assessed, so the check above ran',
    );

    const gated = body.entries.find((entry) => entry.reference === 'gated');
    assert.equal(gated?.tier, 'gated');
    assert.deepEqual(gated?.failedMustHaves, ['PostgreSQL']);
  });
});

test('the ranking shows the current assessment, never the superseded one', async () => {
  await withApi(async (client, seeded) => {
    const { body } = await client.get<{ entries: Array<Record<string, unknown>> }>(
      `/api/jobs/${seeded.job.job.id}/ranking`,
    );

    const replaced = body.entries.find((entry) => entry.reference === 'replaced');
    assert.equal(replaced?.evaluationId, seeded.replacement);
    assert.notEqual(replaced?.evaluationId, seeded.superseded);
    assert.equal(body.entries.filter((entry) => entry.reference === 'replaced').length, 1);
  });
});

// --- candidate detail --------------------------------------------------------

test('candidate detail explains every requirement and shows only verified quotes', async () => {
  await withApi(async (client, seeded, ctx) => {
    const { body } = await client.get<Record<string, unknown>>(`/api/evaluations/${seeded.scored}`);

    assert.equal(body.tier, 'qualified');
    assert.equal(body.scoreBasisPoints, 8_333);
    assert.equal(body.scorePercent, '83%', 'the rounding is done here, not in the browser');
    assert.equal(body.mustHavesMet, 2);
    assert.equal(body.mustHavesTotal, 2);
    assert.equal(body.isCurrent, true);

    const requirements = body.requirements as Array<Record<string, unknown>>;
    assert.equal(requirements.length, 3, 'every requirement is explained, including the unmet one');
    for (const requirement of requirements) {
      assert.ok(typeof requirement.rationale === 'string' && (requirement.rationale as string).length > 20);
      assert.ok(['met', 'partial', 'not_met', 'unclear'].includes(requirement.verdict as string));
      assert.ok(typeof requirement.contributionPercent === 'string');
    }

    // The rejected quote is in the database and must not be in the response.
    const stored = await ctx.repos.evidence.listForEvaluation(seeded.scored);
    assert.equal(stored.length, 3, 'precondition: three rows were stored');
    assert.equal(stored.filter((row) => !row.verified).length, 1, 'precondition: one of them is unverified');

    const quotes = requirements.flatMap((requirement) =>
      (requirement.evidence as Array<{ quote: string }>).map((item) => item.quote),
    );
    assert.equal(quotes.length, 2, 'only the two verified passages');
    assert.ok(!quotes.includes('Never written by anyone.'));
    assert.ok(!JSON.stringify(body).includes('Never written by anyone.'));

    // It is still reported as a number, so the details area can say the check
    // ran and what it caught.
    assert.equal(body.evidenceRejectedCount, 1);
  });
});

test('every quote sent to the browser is verbatim from the resume', async () => {
  // Deliberately the pipeline-built candidate. The hand-seeded ones insert
  // evidence directly, which bypasses the verifier — asserting this against
  // them would prove nothing about the guarantee.
  await withApi(async (client, seeded, ctx) => {
    const { body } = await client.get<Record<string, unknown>>(`/api/evaluations/${seeded.pipeline}`);

    const evaluation = await ctx.repos.evaluations.getById(seeded.pipeline);
    const resume = await ctx.repos.resumes.getById(evaluation?.resumeId as string);
    assert.ok(resume, 'precondition');

    const quotes = (body.requirements as Array<Record<string, unknown>>).flatMap((requirement) =>
      (requirement.evidence as Array<{ quote: string }>).map((item) => item.quote),
    );
    assert.ok(quotes.length > 0, 'precondition: there are quotes to check');

    for (const quote of quotes) {
      assert.ok(resume.contentText.includes(quote), `not in the resume: ${quote}`);
    }
  });
});

test('a protected attribute never reaches the browser, in any response', async () => {
  await withApi(async (client, seeded) => {
    const responses = await Promise.all([
      client.get(`/api/jobs/${seeded.job.job.id}/ranking`),
      client.get(`/api/evaluations/${seeded.scored}`),
      client.get(`/api/evaluations/${seeded.scored}/audit`),
    ]);

    const wire = JSON.stringify(responses);
    for (const value of SENSITIVE_VALUES) {
      // Precondition on every iteration: the value really is in the resume that
      // was ingested, so "absent from the wire" means removed rather than never
      // present.
      assert.ok(RESUME_TEXT.includes(value), `precondition: the resume contains ${value}`);
      assert.ok(!wire.includes(value), `${value} was sent to the browser`);
    }
  });
});

test('the quarantine is reported as categories and a count, with no values to send', async () => {
  await withApi(async (client, seeded) => {
    const { body } = await client.get<Record<string, unknown>>(`/api/evaluations/${seeded.scored}`);
    const protectedAttributes = body.protectedAttributes as { categories: string[]; count: number };

    assert.ok(protectedAttributes.count > 0, 'the fixture carries protected attributes');
    assert.ok(protectedAttributes.categories.includes('contact'));
    assert.ok(protectedAttributes.categories.includes('name'));

    // Categories are a closed vocabulary. Anything that is not one of them
    // would be a value that escaped.
    const allowed = ['name', 'age', 'gender', 'nationality', 'photo', 'address', 'contact', 'marital_status', 'religion'];
    for (const category of protectedAttributes.categories) {
      assert.ok(allowed.includes(category), `unexpected category: ${category}`);
    }
  });
});

test('not demonstrated and does not meet are two different answers on the wire', async () => {
  await withApi(async (client, seeded) => {
    const ranking = await client.get<{ entries: Array<Record<string, unknown>> }>(
      `/api/jobs/${seeded.job.job.id}/ranking`,
    );

    const gated = ranking.body.entries.find((entry) => entry.reference === 'gated');
    const strong = ranking.body.entries.find((entry) => entry.reference === 'strong');

    assert.deepEqual(gated?.failedMustHaves, ['PostgreSQL'], 'evidence was found and fell short');
    assert.deepEqual(gated?.unclearMustHaves, []);
    assert.deepEqual(strong?.failedMustHaves, []);

    const detail = await client.get<Record<string, unknown>>(`/api/evaluations/${gated?.evaluationId as string}`);
    assert.equal(detail.body.tier, 'gated');

    // Per requirement, the verdict distinguishes them too: `not_met` is a
    // finding, `unclear` is a silence.
    const verdicts = (detail.body.requirements as Array<Record<string, unknown>>).map((r) => r.verdict);
    assert.deepEqual(verdicts, ['met', 'not_met', 'unclear']);
  });
});

test('a superseded assessment is readable and says so', async () => {
  await withApi(async (client, seeded) => {
    const { status, body } = await client.get<Record<string, unknown>>(`/api/evaluations/${seeded.superseded}`);

    assert.equal(status, 200, 'history stays readable');
    assert.equal(body.isCurrent, false);
    assert.equal(body.supersededBy, seeded.replacement);
  });
});

// --- the audit trail ---------------------------------------------------------

test('the history covers the whole journey, from redaction onwards', async () => {
  await withApi(async (client, seeded) => {
    const { body } = await client.get<{ events: Array<Record<string, unknown>> }>(
      `/api/evaluations/${seeded.scored}/audit`,
    );

    const types = body.events.map((event) => event.eventType);

    // Ingestion and redaction are correlated to the resume; everything else to
    // the evaluation. A history that started at extraction would omit the step
    // a candidate would most want to see.
    assert.ok(types.includes('resume_ingested'));
    assert.ok(types.includes('sensitive_attributes_masked'));
    assert.ok(types.includes('evaluation_opened'));
    assert.ok(types.includes('requirements_matched'));
    assert.ok(types.includes('score_computed'));

    // In time order, and every entry carries a sentence.
    const times = body.events.map((event) => event.createdAt as string);
    assert.deepEqual([...times].sort(), times);
    for (const event of body.events) {
      assert.ok(typeof event.summary === 'string' && (event.summary as string).length > 10);
    }
  });
});

// --- the decision ------------------------------------------------------------

test('a decision is recorded, audited, and returned with the resulting state', async () => {
  await withApi(async (client, seeded, ctx) => {
    const { status, body } = await client.post<{
      decision: Record<string, unknown>;
      evaluation: Record<string, unknown>;
    }>(`/api/evaluations/${seeded.scored}/decision`, {
      outcome: 'shortlist',
      reason: 'Meets both must-haves with quoted evidence for each.',
    });

    assert.equal(status, 201);
    assert.equal(body.decision.outcome, 'shortlist');
    assert.equal(body.decision.decidedBy, 'operator', 'attributed to the signed-in operator');

    // The resulting state comes back with the decision, so the screen renders
    // what the server actually holds rather than a guess.
    assert.equal((body.evaluation.decision as Record<string, unknown>).outcome, 'shortlist');
    assert.equal(body.evaluation.scoreBasisPoints, 8_333, 'a decision does not touch the score');

    const stored = await ctx.repos.decisions.getForEvaluation(seeded.scored);
    assert.equal(stored?.outcome, 'shortlist');

    const events = await ctx.repos.audit.listForCorrelation(seeded.scored);
    const recorded = events.find((event) => event.eventType === 'decision_recorded');
    assert.equal(recorded?.actor, 'human');
    assert.equal(recorded?.actorId, 'operator');
    assert.equal(recorded?.stage, 'decide');
    assert.equal(recorded?.payload.reason, 'Meets both must-haves with quoted evidence for each.');
  });
});

test('all three outcomes are accepted', async () => {
  await withApi(async (client, seeded) => {
    const targets: Array<[string, string]> = [
      [seeded.scored, 'shortlist'],
      [seeded.replacement, 'reject'],
    ];

    for (const [evaluationId, outcome] of targets) {
      const { status, body } = await client.post<{ decision: { outcome: string } }>(
        `/api/evaluations/${evaluationId}/decision`,
        { outcome, reason: `Recorded as ${outcome} after reading the quoted evidence.` },
      );
      assert.equal(status, 201, `${outcome} was refused`);
      assert.equal(body.decision.outcome, outcome);
    }

    // And the third, on a separate evaluation.
    const gatedRanking = await client.get<{ entries: Array<Record<string, unknown>> }>(
      `/api/jobs/${seeded.job.job.id}/ranking`,
    );
    const gated = gatedRanking.body.entries.find((entry) => entry.reference === 'gated');
    const { status } = await client.post(`/api/evaluations/${gated?.evaluationId as string}/decision`, {
      outcome: 'hold',
      reason: 'Missing PostgreSQL evidence; worth a conversation before deciding.',
    });
    assert.equal(status, 201);
  });
});

test('a decision without a reason is refused', async () => {
  await withApi(async (client, seeded, ctx) => {
    for (const reason of [undefined, '', '   ', 'no']) {
      const { status, body } = await client.post<{ error: { code: string; details: { problems: string[] } } }>(
        `/api/evaluations/${seeded.scored}/decision`,
        { outcome: 'reject', reason },
      );

      assert.equal(status, 400, `reason ${JSON.stringify(reason)} was accepted`);
      assert.equal(body.error.code, 'VALIDATION_ERROR');
      assert.ok(body.error.details.problems.some((problem) => problem.includes('reason')));
    }

    assert.equal(await ctx.repos.decisions.count(), 0);

    // Positive control: a real reason on the same evaluation is accepted, so
    // the refusals above are about the reason and nothing else.
    const { status } = await client.post(`/api/evaluations/${seeded.scored}/decision`, {
      outcome: 'reject',
      reason: 'No PostgreSQL evidence anywhere in the resume.',
    });
    assert.equal(status, 201);
  });
});

test('an unrecognised outcome is refused', async () => {
  await withApi(async (client, seeded, ctx) => {
    const { status, body } = await client.post<{ error: { code: string } }>(
      `/api/evaluations/${seeded.scored}/decision`,
      { outcome: 'maybe', reason: 'Undecided about this candidate for now.' },
    );

    assert.equal(status, 400);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(await ctx.repos.decisions.count(), 0);
  });
});

test('a candidate who has not been assessed cannot be decided on', async () => {
  await withApi(async (client, seeded, ctx) => {
    const { status, body } = await client.post<{ error: { code: string; message: string } }>(
      `/api/evaluations/${seeded.unscored}/decision`,
      { outcome: 'reject', reason: 'Looks weak from the resume at a glance.' },
    );

    assert.equal(status, 409);
    assert.match(body.error.message, /not been assessed/);
    assert.equal(await ctx.repos.decisions.count(), 0, 'a decision with no evidence behind it is not recorded');
  });
});

test('a superseded assessment cannot be decided on', async () => {
  await withApi(async (client, seeded, ctx) => {
    const { status, body } = await client.post<{ error: { message: string } }>(
      `/api/evaluations/${seeded.superseded}/decision`,
      { outcome: 'shortlist', reason: 'Strong on the first must-have from the earlier read.' },
    );

    assert.equal(status, 409);
    assert.match(body.error.message, /replaced by a newer one/);
    assert.equal(await ctx.repos.decisions.count(), 0);

    // Positive control: the replacement accepts the identical decision.
    const ok = await client.post(`/api/evaluations/${seeded.replacement}/decision`, {
      outcome: 'shortlist',
      reason: 'Strong on the first must-have from the earlier read.',
    });
    assert.equal(ok.status, 201);
  });
});

test('a second decision on the same assessment is refused, not silently overwritten', async () => {
  await withApi(async (client, seeded, ctx) => {
    const first = await client.post(`/api/evaluations/${seeded.scored}/decision`, {
      outcome: 'shortlist',
      reason: 'Meets both must-haves with quoted evidence for each.',
    });
    assert.equal(first.status, 201);

    const second = await client.post<{ error: { code: string } }>(
      `/api/evaluations/${seeded.scored}/decision`,
      { outcome: 'reject', reason: 'Changed my mind after a second look at this.' },
    );

    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'CONFLICT');

    const stored = await ctx.repos.decisions.getForEvaluation(seeded.scored);
    assert.equal(stored?.outcome, 'shortlist', 'the first decision stands');
    assert.equal(await ctx.repos.decisions.count(), 1);
  });
});

test('a decision does not disturb the ranking or the score', async () => {
  await withApi(async (client, seeded) => {
    const before = await client.get<{ entries: Array<Record<string, unknown>> }>(
      `/api/jobs/${seeded.job.job.id}/ranking`,
    );

    await client.post(`/api/evaluations/${seeded.scored}/decision`, {
      outcome: 'reject',
      reason: 'Rejected despite the score, for reasons outside this assessment.',
    });

    const after = await client.get<{ entries: Array<Record<string, unknown>> }>(
      `/api/jobs/${seeded.job.job.id}/ranking`,
    );

    // Ranking is derived from evaluations, and a decision is not one. The list
    // does not reorder itself because someone made up their mind.
    assert.deepEqual(after.body, before.body);
  });
});
