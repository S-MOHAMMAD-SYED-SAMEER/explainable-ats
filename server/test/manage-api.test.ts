import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { hashPassword } from '../src/lib/password.ts';
import { CSRF_HEADER } from '../src/auth/csrf.ts';
import { CSRF_COOKIE } from '../src/auth/cookies.ts';
import { createMockLlmProvider } from '../src/adapters/llm/mock.ts';
import { installDeterministicExtractor } from '../src/agent/mockExtractor.ts';
import { createTestContext, type TestContext } from './helpers.ts';
import { JOB_INPUT, RESUME_TEXT, SENSITIVE_VALUES } from './fixtures.ts';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from '../src/adapters/llm/types.ts';
import { LlmFailure } from '../src/adapters/llm/failures.ts';
import { FAILURE_WORDING } from '../src/agent/failures.ts';

// The recruiter's write routes, over real HTTP, with the deterministic provider.
//
// What only a server can show: that each write sits behind the session and the
// CSRF check, that a bad body is refused with every problem named, that starting
// an assessment answers 202 while the work is still running, and that a failure
// leaves a record and can be re-run without losing the first attempt. No model is
// called anywhere in this file.

const PASSWORD = 'b2-operator-password-2026';

/** A provider the test controls: it can hold a call open, or fail it. */
type ControlledProvider = LlmProvider & {
  inner: ReturnType<typeof createMockLlmProvider>;
  /** While set, calls wait for `release()` and then proceed. */
  hold(): void;
  release(): void;
  /** While set, calls fail as an outage would. */
  failing: boolean;
  /** While set, calls fail with exactly this. Takes precedence over `failing`. */
  failWith: Error | null;
  started: number;
  /** The most calls that were ever in flight at once. */
  peak: number;
};

function createControlledProvider(): ControlledProvider {
  const inner = createMockLlmProvider();
  installDeterministicExtractor(inner);

  let gate: Promise<void> | null = null;
  let open: (() => void) | null = null;
  let inFlight = 0;

  const provider: ControlledProvider = {
    name: 'controlled',
    configured: true,
    inner,
    failing: false,
    failWith: null,
    started: 0,
    peak: 0,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
    },
    release() {
      open?.();
      gate = null;
      open = null;
    },
    async complete(request: LlmRequest): Promise<LlmResponse> {
      provider.started += 1;
      inFlight += 1;
      provider.peak = Math.max(provider.peak, inFlight);
      try {
        if (gate) await gate;
        if (provider.failWith) throw provider.failWith;
        if (provider.failing) throw new LlmError('controlled', 'simulated outage');
        return await inner.complete(request);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return provider;
}

type Client = {
  base: string;
  get: <T>(path: string) => Promise<{ status: number; body: T }>;
  post: <T>(path: string, body: unknown, options?: { csrf?: boolean }) => Promise<{ status: number; body: T }>;
  anonymousPost: (path: string, body: unknown) => Promise<Response>;
};

async function withApi(
  fn: (client: Client, ctx: TestContext, provider: ControlledProvider) => Promise<void>,
  options: { env?: Record<string, string>; defaultProvider?: boolean } = {},
): Promise<void> {
  const ctx = await createTestContext();
  const config: AppConfig = {
    ...loadConfig(options.env ?? {}).config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    cookieSecure: false,
    // These tests drive the quotes-only path with their own `extract_evidence` stand-ins, so they ask for the matcher to judge.
    verdictMode: 'matcher',
  };
  const provider = createControlledProvider();

  // `defaultProvider` builds the app the way a real start does, from configuration alone.
  const app = createApp({
    db: ctx.db,
    config,
    ...(options.defaultProvider ? {} : { provider }),
    logger: createMemoryLogger().logger,
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200, 'precondition: the harness could sign in');
  const cookies = (login.headers.getSetCookie?.() ?? []).map((entry) => entry.split(';')[0] ?? '').join('; ');
  const csrf = new RegExp(`${CSRF_COOKIE}=([^;]+)`).exec(cookies)?.[1] ?? '';
  assert.notEqual(csrf, '', 'precondition: a CSRF token was issued');

  const client: Client = {
    base,
    async get(p) {
      const response = await fetch(`${base}${p}`, { headers: { cookie: cookies } });
      return { status: response.status, body: (await response.json()) as never };
    },
    async post(p, body, opts = {}) {
      const response = await fetch(`${base}${p}`, {
        method: 'POST',
        headers: {
          cookie: cookies,
          'content-type': 'application/json',
          origin: base,
          ...(opts.csrf === false ? {} : { [CSRF_HEADER]: csrf }),
        },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as never };
    },
    anonymousPost: (p, body) =>
      fetch(`${base}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify(body),
      }),
  };

  try {
    // Release anything a test left held, so a failed assertion cannot hang the close.
    await fn(client, ctx, provider);
  } finally {
    provider.release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.close();
  }
}

type StatusBody = { status: string; isCurrent: boolean; failureReason: string | null; supersededBy: string | null };

async function waitForStatus(client: Client, evaluationId: string, wanted: string): Promise<StatusBody> {
  const deadline = Date.now() + 5000;
  let last: StatusBody | null = null;
  while (Date.now() < deadline) {
    const { body } = await client.get<StatusBody>(`/api/evaluations/${evaluationId}/status`);
    last = body;
    if (body.status === wanted) return body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Evaluation ${evaluationId} never reached "${wanted}"; last seen ${JSON.stringify(last)}`);
}

async function createJobViaApi(client: Client): Promise<{ id: string }> {
  const { status, body } = await client.post<{ id: string }>('/api/jobs', JOB_INPUT);
  assert.equal(status, 201, 'precondition: the job was created');
  return body;
}

type Added = { evaluationId: string; status: string; redactedCount: number; candidate: { reference: string } };

async function addCandidate(client: Client, jobId: string, reference: string, text = RESUME_TEXT) {
  return client.post<Added>(`/api/jobs/${jobId}/candidates`, { reference, displayName: 'Priya Raman', text });
}

// --- the gate ----------------------------------------------------------------

test('every write route refuses a caller with no session, and then one with no CSRF token', async () => {
  await withApi(async (client) => {
    const job = await createJobViaApi(client);
    const added = await addCandidate(client, job.id, 'gate-1');

    const targets: Array<[string, unknown]> = [
      ['/api/jobs', JOB_INPUT],
      [`/api/jobs/${job.id}/candidates`, { reference: 'x', text: 'y' }],
      [`/api/evaluations/${added.body.evaluationId}/run`, {}],
      [`/api/evaluations/${added.body.evaluationId}/rerun`, {}],
    ];

    for (const [target, body] of targets) {
      const anonymous = await client.anonymousPost(target, body);
      assert.equal(anonymous.status, 401, `${target} answered ${anonymous.status} with no session`);

      const noCsrf = await client.post(target, body, { csrf: false });
      assert.equal(noCsrf.status, 403, `${target} answered ${noCsrf.status} with no CSRF token`);
    }

    // The status poll is a read, behind the same gate.
    const poll = await fetch(`${client.base}/api/evaluations/${added.body.evaluationId}/status`);
    assert.equal(poll.status, 401);
  });
});

// --- create a job ------------------------------------------------------------

test('a job is created with its requirements, and the audit trail names the operator', async () => {
  await withApi(async (client, ctx) => {
    const created = await client.post<{ id: string; title: string; requirements: Array<Record<string, unknown>> }>(
      '/api/jobs',
      { ...JOB_INPUT, title: '  Platform Engineer  ' },
    );

    assert.equal(created.status, 201);
    assert.equal(created.body.title, 'Platform Engineer', 'trimmed');
    assert.deepEqual(created.body.requirements.map((r) => [r.kind, r.weight]), [
      ['must_have', 3],
      ['must_have', 2],
      ['nice_to_have', 1],
    ]);

    const events = await ctx.repos.audit.listForCorrelation(created.body.id);
    const event = events.find((entry) => entry.eventType === 'job_created');
    assert.ok(event, 'a job_created event exists');
    assert.equal(event.actor, 'human');
    assert.ok(event.actorId, 'it names who did it');

    const list = await client.get<{ jobs: Array<{ id: string }> }>('/api/jobs');
    assert.ok(list.body.jobs.some((job) => job.id === created.body.id));
  });
});

test('a bad job is refused with every problem named, and nothing is written', async () => {
  await withApi(async (client, ctx) => {
    const bad = await client.post<{ error: { code: string; details: { problems: string[] } } }>('/api/jobs', {
      title: '',
      seniority: 'wizard',
      requirements: [
        { label: 'ok', criterion: 'fine', kind: 'must_have', weight: '3' },
        { label: '', criterion: 'fine', kind: 'sometimes', weight: 0 },
        'not an object',
      ],
    });

    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
    const problems = bad.body.error.details.problems.join('\n');
    for (const expected of ['"title"', '"seniority"', 'requirements[0].weight', 'requirements[1].label', 'requirements[1].kind', 'requirements[1].weight', 'requirements[2]']) {
      assert.ok(problems.includes(expected), `names ${expected}; got:\n${problems}`);
    }
    assert.equal((await ctx.repos.jobs.list({ limit: 10 })).length, 0, 'no job was created');

    const empty = await client.post('/api/jobs', { ...JOB_INPUT, requirements: [] });
    assert.equal(empty.status, 400);

    const tooMany = await client.post('/api/jobs', {
      ...JOB_INPUT,
      requirements: Array.from({ length: 26 }, (_, i) => ({ label: `r${i}`, criterion: 'c', kind: 'nice_to_have', weight: 1 })),
    });
    assert.equal(tooMany.status, 400);

    const notAnObject = await client.post('/api/jobs', 'a string');
    assert.equal(notAnObject.status, 400);
  });
});

// --- add a CV ----------------------------------------------------------------

test('a pasted CV is stored and redacted and opens a pending evaluation without calling a model', async () => {
  await withApi(async (client, ctx, provider) => {
    const job = await createJobViaApi(client);
    const added = await addCandidate(client, job.id, 'cv-001');

    assert.equal(added.status, 201);
    assert.equal(added.body.status, 'pending');
    assert.ok(added.body.redactedCount >= 5, `protected attributes were masked (${added.body.redactedCount})`);
    assert.equal(provider.started, 0, 'adding a CV never reaches a model');

    const evaluation = await ctx.repos.evaluations.getById(added.body.evaluationId);
    assert.ok(evaluation);
    const resume = await ctx.repos.resumes.getById(evaluation.resumeId);
    assert.ok(resume);
    for (const value of SENSITIVE_VALUES) {
      assert.ok(!resume.redactedText.includes(value), `the redacted copy still holds "${value}"`);
    }

    const events = await ctx.repos.audit.listForCorrelation(added.body.evaluationId);
    assert.equal(events.find((e) => e.eventType === 'evaluation_opened')?.actor, 'human');
    assert.ok(events.find((e) => e.eventType === 'evaluation_opened')?.actorId);
  });
});

test('adding a CV is refused when the body is wrong, the job is unknown, or the paste is too long', async () => {
  await withApi(async (client, ctx) => {
    const job = await createJobViaApi(client);

    const bad = await client.post<{ error: { details: { problems: string[] } } }>(`/api/jobs/${job.id}/candidates`, {
      reference: '../etc/passwd',
      text: '   ',
    });
    assert.equal(bad.status, 400);
    const problems = bad.body.error.details.problems.join('\n');
    assert.ok(problems.includes('"reference"'));
    assert.ok(problems.includes('"text"'));

    const tooLong = await client.post(`/api/jobs/${job.id}/candidates`, { reference: 'long-1', text: 'x'.repeat(200_001) });
    assert.equal(tooLong.status, 400);

    const missingJob = await client.post('/api/jobs/no-such-job/candidates', { reference: 'a', text: 'b' });
    assert.equal(missingJob.status, 404);

    assert.equal(await ctx.repos.evaluations.count(), 0, 'nothing was opened by any refused request');
  });
});

test('the same CV twice is refused, and a changed CV opens a new evaluation that replaces the old one', async () => {
  await withApi(async (client, ctx) => {
    const job = await createJobViaApi(client);
    const first = await addCandidate(client, job.id, 'cv-dup');
    assert.equal(first.status, 201);

    const again = await addCandidate(client, job.id, 'cv-dup');
    assert.equal(again.status, 409);
    assert.equal(await ctx.repos.evaluations.count(), 1);

    const changed = await addCandidate(client, job.id, 'cv-dup', `${RESUME_TEXT}\nAlso: wrote the team's on-call runbook.`);
    assert.equal(changed.status, 201);
    assert.notEqual(changed.body.evaluationId, first.body.evaluationId);

    const old = await client.get<StatusBody>(`/api/evaluations/${first.body.evaluationId}/status`);
    assert.equal(old.body.isCurrent, false, 'the first evaluation was superseded');
    assert.equal(old.body.supersededBy, changed.body.evaluationId);
  });
});

// --- run extraction ----------------------------------------------------------

test('running answers 202 at once, the work finishes in the background, and the status flow ends at scored', async () => {
  await withApi(async (client, _ctx, provider) => {
    const job = await createJobViaApi(client);
    const added = await addCandidate(client, job.id, 'cv-run');

    provider.hold();
    const run = await client.post<{ evaluationId: string; status: string }>(`/api/evaluations/${added.body.evaluationId}/run`, {});
    assert.equal(run.status, 202);
    assert.equal(run.body.status, 'pending');

    // The request has already been answered while the model call is still open.
    await waitFor(() => provider.started === 1);
    const midway = await client.get<StatusBody>(`/api/evaluations/${added.body.evaluationId}/status`);
    assert.equal(midway.body.status, 'pending', 'still running');
    assert.equal(midway.body.failureReason, null);

    // Asking again while it runs is the same 202 and does not start a second call.
    const again = await client.post(`/api/evaluations/${added.body.evaluationId}/run`, {});
    assert.equal(again.status, 202);

    provider.release();
    const done = await waitForStatus(client, added.body.evaluationId, 'scored');
    assert.equal(done.isCurrent, true);
    assert.equal(provider.started, 1, 'one model call in total');

    const detail = await client.get<{ status: string; scoreBasisPoints: number; failureReason: string | null; requirements: Array<{ evidence: unknown[] }> }>(
      `/api/evaluations/${added.body.evaluationId}`,
    );
    assert.equal(detail.body.status, 'scored');
    assert.equal(detail.body.failureReason, null);
    assert.ok(detail.body.scoreBasisPoints > 0);
    assert.ok(detail.body.requirements.some((r) => r.evidence.length > 0), 'verified evidence is attached');

    const ranking = await client.get<{ entries: Array<{ reference: string }> }>(`/api/jobs/${job.id}/ranking`);
    assert.ok(ranking.body.entries.some((entry) => entry.reference === 'cv-run'));

    // A finished assessment cannot be started again.
    const late = await client.post(`/api/evaluations/${added.body.evaluationId}/run`, {});
    assert.equal(late.status, 409);
  });
});

test('running an unknown or replaced evaluation is refused', async () => {
  await withApi(async (client) => {
    const job = await createJobViaApi(client);
    const first = await addCandidate(client, job.id, 'cv-old');
    await addCandidate(client, job.id, 'cv-old', `${RESUME_TEXT}\nPlus a changed line.`);

    assert.equal((await client.post('/api/evaluations/nope/run', {})).status, 404);
    assert.equal((await client.post(`/api/evaluations/${first.body.evaluationId}/run`, {})).status, 409);
    assert.equal((await client.get('/api/evaluations/nope/status')).status, 404);
  });
});

// --- failure and re-run ------------------------------------------------------

test('a provider outage fails the evaluation with a record, and a re-run supersedes it and succeeds', async () => {
  await withApi(async (client, ctx, provider) => {
    const job = await createJobViaApi(client);
    const added = await addCandidate(client, job.id, 'cv-outage');

    provider.failing = true;
    assert.equal((await client.post(`/api/evaluations/${added.body.evaluationId}/run`, {})).status, 202);
    const failed = await waitForStatus(client, added.body.evaluationId, 'failed');
    assert.ok(failed.failureReason && failed.failureReason.length > 10, 'a message for a person');
    assert.ok(!failed.failureReason.includes('simulated outage'), 'the provider error text stays out of the response');

    const detail = await client.get<{ failureReason: string; status: string }>(`/api/evaluations/${added.body.evaluationId}`);
    assert.equal(detail.body.status, 'failed');
    assert.equal(detail.body.failureReason, failed.failureReason);

    // Re-run with the service back.
    provider.failing = false;
    const rerun = await client.post<{ evaluationId: string; previousEvaluationId: string; status: string }>(
      `/api/evaluations/${added.body.evaluationId}/rerun`,
      {},
    );
    assert.equal(rerun.status, 202);
    assert.equal(rerun.body.previousEvaluationId, added.body.evaluationId);
    assert.notEqual(rerun.body.evaluationId, added.body.evaluationId);

    const second = await waitForStatus(client, rerun.body.evaluationId, 'scored');
    assert.equal(second.isCurrent, true);

    // The failed attempt is kept, unchanged, and no longer current.
    const old = await client.get<StatusBody>(`/api/evaluations/${added.body.evaluationId}/status`);
    assert.equal(old.body.status, 'failed');
    assert.equal(old.body.isCurrent, false);
    assert.equal(old.body.supersededBy, rerun.body.evaluationId);

    // Audited on both, naming the operator.
    const onNew = (await ctx.repos.audit.listForCorrelation(rerun.body.evaluationId)).find((e) => e.eventType === 'evaluation_rerun');
    assert.ok(onNew);
    assert.equal(onNew.actor, 'human');
    assert.ok(onNew.actorId);
    assert.equal(onNew.payload.previousEvaluationId, added.body.evaluationId);
    const onOld = (await ctx.repos.audit.listForCorrelation(added.body.evaluationId)).map((e) => e.eventType);
    assert.ok(onOld.includes('extraction_unavailable'), 'the failure itself is on record');
    assert.ok(onOld.includes('evaluation_superseded_by_rerun'));

    // One person, one current evaluation.
    const ranking = await client.get<{ entries: Array<{ reference: string }> }>(`/api/jobs/${job.id}/ranking`);
    assert.equal(ranking.body.entries.filter((entry) => entry.reference === 'cv-outage').length, 1);
  });
});

test('only a failed (or abandoned) assessment can be re-run', async () => {
  await withApi(async (client, _ctx, provider) => {
    const job = await createJobViaApi(client);

    // Scored.
    const done = await addCandidate(client, job.id, 'cv-done');
    await client.post(`/api/evaluations/${done.body.evaluationId}/run`, {});
    await waitForStatus(client, done.body.evaluationId, 'scored');
    assert.equal((await client.post(`/api/evaluations/${done.body.evaluationId}/rerun`, {})).status, 409);

    // Still running.
    const busy = await addCandidate(client, job.id, 'cv-busy');
    provider.hold();
    await client.post(`/api/evaluations/${busy.body.evaluationId}/run`, {});
    await waitFor(() => provider.started === 2);
    const refused = await client.post<{ error: { message: string } }>(`/api/evaluations/${busy.body.evaluationId}/rerun`, {});
    assert.equal(refused.status, 409);
    assert.match(refused.body.error.message, /still running/);
    provider.release();
    await waitForStatus(client, busy.body.evaluationId, 'scored');

    // Unknown.
    assert.equal((await client.post('/api/evaluations/nope/rerun', {})).status, 404);

    // Already replaced.
    provider.failing = true;
    const flaky = await addCandidate(client, job.id, 'cv-flaky');
    await client.post(`/api/evaluations/${flaky.body.evaluationId}/run`, {});
    await waitForStatus(client, flaky.body.evaluationId, 'failed');
    provider.failing = false;
    assert.equal((await client.post(`/api/evaluations/${flaky.body.evaluationId}/rerun`, {})).status, 202);
    assert.equal((await client.post(`/api/evaluations/${flaky.body.evaluationId}/rerun`, {})).status, 409);
  });
});

test('a pending evaluation that nothing is running (left by a restart) can be re-run', async () => {
  await withApi(async (client) => {
    const job = await createJobViaApi(client);
    const orphan = await addCandidate(client, job.id, 'cv-orphan'); // opened, never started

    const rerun = await client.post<{ evaluationId: string }>(`/api/evaluations/${orphan.body.evaluationId}/rerun`, {});
    assert.equal(rerun.status, 202);
    await waitForStatus(client, rerun.body.evaluationId, 'scored');
  });
});

test('a cut-off answer shows its own message, keeps its usage, and a re-run recovers', async () => {
  await withApi(async (client, ctx, provider) => {
    const job = await createJobViaApi(client);
    const added = await addCandidate(client, job.id, 'cv-cut');

    provider.failWith = new LlmFailure('scripted', 'truncated', 'internal text', {
      model: 'served-model',
      latencyMs: 900,
      usage: { inputTokens: 1000, outputTokens: 4096 },
      raw: { findings: [{ quote: 'Desi' }] },
    });
    await client.post(`/api/evaluations/${added.body.evaluationId}/run`, {});
    const failed = await waitForStatus(client, added.body.evaluationId, 'failed');
    assert.equal(failed.failureReason, FAILURE_WORDING.truncated.message);

    const detail = await client.get<{
      failureReason: string;
      modelFoundNothing: boolean;
      extraction: { result: string; outputTokens: number; model: string; rawOutput?: unknown };
    }>(`/api/evaluations/${added.body.evaluationId}`);
    assert.equal(detail.body.extraction.result, 'truncated');
    assert.equal(detail.body.extraction.outputTokens, 4096);
    assert.equal(detail.body.extraction.model, 'served-model');
    assert.equal(detail.body.modelFoundNothing, false, 'a cut-off answer is not "found nothing"');
    assert.ok(!('rawOutput' in detail.body.extraction), 'the raw answer is never sent to the browser');
    assert.ok(!JSON.stringify(detail.body).includes('Desi'), 'nor any part of it');
    assert.equal((await ctx.repos.evaluationRecords.getForEvaluation(added.body.evaluationId))?.rawOutput, '{"findings":[{"quote":"Desi"}]}');

    provider.failWith = null;
    const rerun = await client.post<{ evaluationId: string }>(`/api/evaluations/${added.body.evaluationId}/rerun`, {});
    await waitForStatus(client, rerun.body.evaluationId, 'scored');
  });
});

test('when the model finds nothing the evaluation is scored with every requirement unclear, and flagged', async () => {
  await withApi(async (client, _ctx, provider) => {
    const job = await createJobViaApi(client);
    const added = await addCandidate(client, job.id, 'cv-empty');
    provider.inner.register('extract_evidence', { findings: [] });

    await client.post(`/api/evaluations/${added.body.evaluationId}/run`, {});
    await waitForStatus(client, added.body.evaluationId, 'scored');

    const detail = await client.get<{
      modelFoundNothing: boolean;
      scoreBasisPoints: number;
      extraction: { result: string; findingsReturned: number };
      requirements: Array<{ verdict: string; evidence: unknown[] }>;
    }>(`/api/evaluations/${added.body.evaluationId}`);
    assert.equal(detail.body.modelFoundNothing, true);
    assert.equal(detail.body.extraction.findingsReturned, 0);
    assert.deepEqual([...new Set(detail.body.requirements.map((r) => r.verdict))], ['unclear']);
    assert.ok(detail.body.requirements.every((r) => r.evidence.length === 0));
    assert.equal(detail.body.scoreBasisPoints, 0);

    const trail = await client.get<{ events: Array<{ eventType: string }> }>(`/api/evaluations/${added.body.evaluationId}/audit`);
    assert.ok(trail.body.events.some((event) => event.eventType === 'extraction_empty'));
  });
});

test('started from configuration alone, the mock provider assesses a CV, in the mode MATCH_MODE names', async () => {
  const outcome: Record<string, { verdicts: string[]; mode: unknown }> = {};

  for (const mode of ['strict', 'folded']) {
    await withApi(
      async (client, ctx) => {
        const job = await createJobViaApi(client);
        const added = await addCandidate(client, job.id, `cv-${mode}`, `${RESUME_TEXT}
Running PostgreSQL at scale for the payments team.`);
        assert.equal((await client.post(`/api/evaluations/${added.body.evaluationId}/run`, {})).status, 202);
        await waitForStatus(client, added.body.evaluationId, 'scored');

        const detail = await client.get<{ requirements: Array<{ label: string; verdict: string }> }>(`/api/evaluations/${added.body.evaluationId}`);
        const events = await ctx.repos.audit.listForCorrelation(added.body.evaluationId);
        outcome[mode] = {
          verdicts: detail.body.requirements.map((requirement) => requirement.verdict),
          mode: events.find((event) => event.eventType === 'requirements_matched')?.payload.matchMode,
        };
      },
      { env: { MATCH_MODE: mode }, defaultProvider: true },
    );
  }

  assert.equal(outcome.strict?.mode, 'strict');
  assert.equal(outcome.folded?.mode, 'folded');
  // The job asks for someone who has "run PostgreSQL at scale"; the CV says "Running PostgreSQL ...".
  assert.equal(outcome.strict?.verdicts[1], 'partial');
  assert.equal(outcome.folded?.verdicts[1], 'met');
});

// --- wiring ------------------------------------------------------------------

test('the app is built with the injected provider, and the server source no longer discards it', async () => {
  await withApi(async (client, _ctx, provider) => {
    const job = await createJobViaApi(client);
    const added = await addCandidate(client, job.id, 'cv-wired');
    await client.post(`/api/evaluations/${added.body.evaluationId}/run`, {});
    await waitForStatus(client, added.body.evaluationId, 'scored');
    assert.equal(provider.started, 1, 'the injected provider is the one that was called');
    assert.equal(provider.inner.calls.length, 1);
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.resolve(here, '../src/app.ts'), 'utf8');
  assert.ok(!/void\s+llm/.test(source), 'app.ts must not discard the provider');
});

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for a condition.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
