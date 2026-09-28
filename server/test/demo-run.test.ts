import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { hashPassword } from '../src/lib/password.ts';
import { rateLimit, RATE_LIMITS, classify } from '../src/http/rateLimit.ts';
import { createJob } from '../src/agent/ingest.ts';
import { DEMO_JOB, DEMO_CANDIDATES } from '../src/demo/dataset.ts';
import { isDemoScenarioId, runDemoScenario, DEMO_SCENARIO_IDS } from '../src/demo/runScenario.ts';
import { createTestContext } from './helpers.ts';
import type { Repositories } from '../src/db/repositories/index.ts';

// The public demo-run endpoint: `POST /api/demo/scenarios/:scenario/run`.
//
// WHAT THIS FILE IS DEFENDING
//
// This is the one write route in the whole API an anonymous stranger can
// reach. Every test below is written the way an attacker would read them: not
// "does the happy path work?" but "what is the complete set of things a caller
// can make this route do, and is any of it something other than 'run one of
// exactly five fixed scenarios against the fixed demo job'?"

const PASSWORD = 'demo-run-test-operator-password';

type Server = { url: string; repos: Repositories; stop(): Promise<void> };

/** Seeds only the demo job — never the candidates — matching a fresh, real
 *  deployment that has run `npm run seed:demo` but has not yet had any
 *  candidate assessed through the live endpoint. */
async function seedDemoJobOnly(repos: Repositories): Promise<void> {
  await createJob({ repos }, DEMO_JOB);
}

async function serve(
  options: { seedJob?: boolean; overrides?: Partial<AppConfig>; rateLimiter?: ReturnType<typeof rateLimit> } = {},
): Promise<Server> {
  const ctx = await createTestContext({ idPrefix: 'demo-run' });
  if (options.seedJob ?? true) await seedDemoJobOnly(ctx.repos);

  const config: AppConfig = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    cookieSecure: false,
    demoPublicReadonly: true,
    ...options.overrides,
  };

  const app = createApp({
    db: ctx.db,
    config,
    logger: createMemoryLogger().logger,
    ...(options.rateLimiter ? { rateLimiter: options.rateLimiter } : {}),
  });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    repos: ctx.repos,
    stop: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ctx.close();
    },
  };
}

function run(base: string, scenario: string, init?: RequestInit): Promise<Response> {
  return fetch(`${base}/api/demo/scenarios/${scenario}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

// --- the registry itself -----------------------------------------------------

test('the scenario registry matches the dataset exactly, in both directions', () => {
  assert.deepEqual([...DEMO_SCENARIO_IDS].sort(), DEMO_CANDIDATES.map((c) => c.reference).sort());
});

test('isDemoScenarioId accepts only the five fixed ids', () => {
  for (const id of DEMO_SCENARIO_IDS) assert.equal(isDemoScenarioId(id), true);
  for (const bogus of ['demo-000', 'demo-006', '', 'DEMO-001', ' demo-001', 'demo-001 ', 42, null, undefined, {}]) {
    assert.equal(isDemoScenarioId(bogus), false, `${JSON.stringify(bogus)} was accepted`);
  }
});

// --- 1/2/3/4: a valid scenario runs the real pipeline, deterministically -----

test('a valid scenario executes and returns a real, scored evaluation id', async () => {
  const server = await serve();
  try {
    const response = await run(server.url, 'demo-001');
    assert.equal(response.status, 201);
    const body = (await response.json()) as { evaluationId: string };
    assert.equal(typeof body.evaluationId, 'string');
    assert.ok(body.evaluationId.length > 0);

    // The evaluation is real: fetched back through the ordinary read API (the
    // public-demo read window is open in this test, matching a real
    // deployment that offers both features together).
    const detail = await (await fetch(`${server.url}/api/evaluations/${body.evaluationId}`)).json();
    assert.equal(detail.status, 'scored');
    assert.equal(typeof detail.scoreBasisPoints, 'number');
    assert.equal(detail.job.title, DEMO_JOB.title);
  } finally {
    await server.stop();
  }
});

test('the real pipeline was exercised, not faked: verified evidence backs the requirements', async () => {
  const server = await serve();
  try {
    const response = await run(server.url, 'demo-001');
    const { evaluationId } = (await response.json()) as { evaluationId: string };
    const detail = await (await fetch(`${server.url}/api/evaluations/${evaluationId}`)).json();

    // demo-001 (Rowan Ashfield) is documented in dataset.ts as meeting every
    // requirement with a quoted line each — so every requirement must carry
    // at least one piece of evidence, not zero.
    for (const requirement of detail.requirements) {
      assert.ok(requirement.evidence.length > 0, `${requirement.label} had no evidence`);
    }
    assert.equal(detail.evidenceRejectedCount, 0);
  } finally {
    await server.stop();
  }
});

test('the same scenario produces byte-identical scores across two fresh runs', async () => {
  const a = await serve();
  const b = await serve();
  try {
    const evalA = (await (await run(a.url, 'demo-003')).json()) as { evaluationId: string };
    const evalB = (await (await run(b.url, 'demo-003')).json()) as { evaluationId: string };

    const detailA = await (await fetch(`${a.url}/api/evaluations/${evalA.evaluationId}`)).json();
    const detailB = await (await fetch(`${b.url}/api/evaluations/${evalB.evaluationId}`)).json();

    assert.equal(detailA.scoreBasisPoints, detailB.scoreBasisPoints);
    assert.deepEqual(
      detailA.requirements.map((r: { verdict: string }) => r.verdict),
      detailB.requirements.map((r: { verdict: string }) => r.verdict),
    );
  } finally {
    await a.stop();
    await b.stop();
  }
});

test('a "queued" scenario opens an evaluation and leaves it unscored, exactly like the seeder', async () => {
  const server = await serve();
  try {
    const response = await run(server.url, 'demo-005');
    assert.equal(response.status, 201);
    const { evaluationId } = (await response.json()) as { evaluationId: string };

    const detail = await (await fetch(`${server.url}/api/evaluations/${evaluationId}`)).json();
    assert.equal(detail.status, 'pending');
    assert.equal(detail.scoreBasisPoints, null);
  } finally {
    await server.stop();
  }
});

// --- 5: unknown scenarios are rejected before the pipeline runs -------------

test('an unknown scenario is rejected and touches nothing', async () => {
  const server = await serve();
  try {
    for (const bogus of ['demo-000', 'demo-999', 'not-a-scenario', '../demo-001', 'demo-001x']) {
      const response = await run(server.url, encodeURIComponent(bogus));
      assert.equal(response.status, 404, `${bogus} was not rejected`);
      const body = (await response.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'NOT_FOUND');
    }

    assert.equal(await server.repos.candidates.count(), 0, 'an unknown scenario created a candidate');
    assert.equal(await server.repos.evaluations.count(), 0, 'an unknown scenario created an evaluation');
  } finally {
    await server.stop();
  }
});

// --- 6/7: no arbitrary id or data can be injected, via path or body ---------

test('a request body is refused outright, even one that tries to supply ids', async () => {
  const server = await serve();
  try {
    const response = await run(server.url, 'demo-001', {
      body: JSON.stringify({ candidateId: 'not-a-real-id', jobId: 'not-a-real-id', resumeText: 'hello' }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'VALIDATION_ERROR');

    // Nothing was created despite the attempted payload.
    assert.equal(await server.repos.candidates.count(), 0);
    assert.equal(await server.repos.evaluations.count(), 0);
  } finally {
    await server.stop();
  }
});

test('an empty body is accepted, since the endpoint reads nothing from it either way', async () => {
  const server = await serve();
  try {
    const response = await run(server.url, 'demo-001', { body: JSON.stringify({}) });
    assert.equal(response.status, 201);
  } finally {
    await server.stop();
  }
});

test('provider selection cannot be requested by the caller', async () => {
  const server = await serve();
  try {
    const response = await run(server.url, 'demo-001', { body: JSON.stringify({ provider: 'anthropic' }) });
    // Refused as an unexpected body, same as any other payload — there is no
    // code path anywhere that reads a `provider` field from this request.
    assert.equal(response.status, 400);
  } finally {
    await server.stop();
  }
});

// --- 8: demo isolation — only the demo namespace is ever touched -----------

test('a demo run creates only demo-namespaced data, and never touches an existing non-demo job or candidate', async () => {
  const server = await serve();
  try {
    // A real, non-demo job and candidate, seeded independently of anything
    // this endpoint knows about.
    const { job: realJob } = await createJob(
      { repos: server.repos },
      { title: 'A Real Role', seniority: 'mid', requirements: [{ label: 'X', criterion: 'Has X', kind: 'must_have', weight: 1 }] },
    );
    const realCandidate = await server.repos.candidates.create({ reference: 'real-applicant-1', source: 'upload' });

    await run(server.url, 'demo-001');

    const candidates = await server.repos.candidates.list({ limit: 50 });
    const demoCandidates = candidates.filter((c) => c.reference.startsWith('demo-'));
    assert.equal(demoCandidates.length, 1);
    assert.equal(demoCandidates[0]?.source, 'demo');

    // The real candidate and job are exactly as they were.
    assert.equal(await server.repos.evaluations.getCurrent(realJob.id, realCandidate.id), null);
    const stillReal = await server.repos.candidates.getById(realCandidate.id);
    assert.equal(stillReal?.reference, 'real-applicant-1');

    const jobs = await server.repos.jobs.list({ limit: 50 });
    assert.equal(jobs.filter((j) => j.title === DEMO_JOB.title).length, 1, 'the demo job was duplicated or altered');
  } finally {
    await server.stop();
  }
});

test('the demo job is resolved read-only: it is never created by the endpoint', async () => {
  // No job seeded at all.
  const server = await serve({ seedJob: false });
  try {
    const response = await run(server.url, 'demo-001');
    assert.equal(response.status, 409);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'INVALID_STATE');

    assert.equal(await server.repos.jobs.count(), 0, 'a missing demo job was silently created');
    assert.equal(await server.repos.candidates.count(), 0);
  } finally {
    await server.stop();
  }
});

// --- 9: no session, no cookie, no CSRF token is ever issued -----------------

test('a demo run creates no session and issues no cookie', async () => {
  const server = await serve();
  try {
    const response = await run(server.url, 'demo-001');
    assert.equal(response.headers.getSetCookie().length, 0, 'a demo run issued a cookie');

    const session = (await (await fetch(`${server.url}/api/auth/session`)).json()) as {
      authenticated: boolean;
      operator: string | null;
      csrfToken: string | null;
    };
    assert.equal(session.authenticated, false);
    assert.equal(session.operator, null);
    assert.equal(session.csrfToken, null);
  } finally {
    await server.stop();
  }
});

// --- 10: rate limiting is specific to this endpoint -------------------------

test('classify() puts the demo-run path in its own class, distinct from mutation', () => {
  assert.equal(classify('POST', '/demo/scenarios/demo-001/run'), 'demoRun');
  assert.equal(classify('POST', '/demo/scenarios/demo-001/run'), classify('POST', '/demo/scenarios/demo-005/run'));
  assert.notEqual(classify('POST', '/demo/scenarios/demo-001/run'), classify('POST', '/evaluations/e1/decision'));
  assert.equal(classify('GET', '/demo/scenarios/demo-001/run'), null, 'a GET on this path must never be classed');
});

test('the dedicated demo-run budget is real and separate from the mutation budget', async () => {
  const tinyLimiter = rateLimit({
    limits: {
      ...RATE_LIMITS,
      demoRun: { limit: 2, windowMs: 60_000 },
    },
  });
  const server = await serve({ rateLimiter: tinyLimiter });
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      // Each call names a different scenario so a 201 (not a pipeline error)
      // is what a within-budget call looks like.
      statuses.push((await run(server.url, DEMO_SCENARIO_IDS[i % DEMO_SCENARIO_IDS.length] as string)).status);
    }

    assert.deepEqual(statuses.slice(0, 2), [201, 201], 'a call inside the budget was refused');
    assert.equal(statuses[2], 429, 'the budget was not enforced');
    assert.equal(statuses[3], 429);

    const refused = await run(server.url, 'demo-001');
    assert.ok(refused.headers.get('retry-after'), 'a 429 carried no Retry-After');
  } finally {
    await server.stop();
  }
});

// --- 11: repeated execution supersedes rather than overwrites ---------------

test('running the same scenario twice creates a new evaluation and supersedes the previous one', async () => {
  const server = await serve();
  try {
    const first = (await (await run(server.url, 'demo-002')).json()) as { evaluationId: string };
    const second = (await (await run(server.url, 'demo-002')).json()) as { evaluationId: string };

    assert.notEqual(first.evaluationId, second.evaluationId);

    const firstRow = await server.repos.evaluations.getById(first.evaluationId);
    const secondRow = await server.repos.evaluations.getById(second.evaluationId);
    assert.equal(firstRow?.supersededBy, second.evaluationId);
    assert.equal(secondRow?.supersededBy, null);

    // The old evaluation's own history is intact and independently readable —
    // nothing was deleted or overwritten.
    const oldDetail = await (await fetch(`${server.url}/api/evaluations/${first.evaluationId}`)).json();
    assert.equal(oldDetail.isCurrent, false);
    assert.equal(oldDetail.status, 'scored');

    // Only one candidate exists — re-running did not create a second person.
    const demoCandidates = (await server.repos.candidates.list({ limit: 50 })).filter((c) =>
      c.reference.startsWith('demo-'),
    );
    assert.equal(demoCandidates.length, 1);
  } finally {
    await server.stop();
  }
});

// --- concurrency: two simultaneous runs of the same scenario ----------------

test('two concurrent runs of the same scenario do not crash and do not duplicate the candidate', async () => {
  const server = await serve();
  try {
    const [a, b] = await Promise.all([run(server.url, 'demo-004'), run(server.url, 'demo-004')]);

    // Both requests must resolve to a real outcome — no 500, no hang.
    assert.ok([200, 201].includes(a.status), `first concurrent call returned ${a.status}`);
    assert.ok([200, 201].includes(b.status), `second concurrent call returned ${b.status}`);

    const demoCandidates = (await server.repos.candidates.list({ limit: 50 })).filter((c) =>
      c.reference.startsWith('demo-'),
    );
    assert.equal(demoCandidates.length, 1, 'a concurrent run duplicated the candidate');

    const jobs = await server.repos.jobs.list({ limit: 50 });
    assert.equal(jobs.filter((j) => j.title === DEMO_JOB.title).length, 1, 'a concurrent run duplicated the job');

    // Documenting the known supersession race (see runScenario.ts and the
    // Option B inspection) rather than asserting a specific winner: exactly
    // one of the two evaluations ends up current, and that is all that is
    // guaranteed by the existing evaluations.create() semantics, which this
    // milestone does not change.
    const bodyA = (await a.json()) as { evaluationId: string };
    const bodyB = (await b.json()) as { evaluationId: string };
    const rowA = await server.repos.evaluations.getById(bodyA.evaluationId);
    const rowB = await server.repos.evaluations.getById(bodyB.evaluationId);
    const currentCount = [rowA, rowB].filter((row) => row?.supersededBy === null).length;
    assert.equal(currentCount, 1, 'concurrent runs left zero or two evaluations current');
  } finally {
    await server.stop();
  }
});

// --- 12: existing read-only public demo behaviour is untouched --------------

test('the existing public read-only demo routes still work exactly as before', async () => {
  const server = await serve();
  try {
    const response = await fetch(`${server.url}/api/jobs`);
    assert.equal(response.status, 200);

    const write = await fetch(`${server.url}/api/evaluations/nope/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'shortlist', reason: 'trying it on' }),
    });
    assert.equal(write.status, 401, 'the read-only demo window started allowing writes');
  } finally {
    await server.stop();
  }
});

test('the read-only demo window shut still refuses reads exactly as before, unaffected by the new route', async () => {
  const server = await serve({ overrides: { demoPublicReadonly: false } });
  try {
    const response = await fetch(`${server.url}/api/jobs`);
    assert.equal(response.status, 401);
  } finally {
    await server.stop();
  }
});

// --- 13: the existing recruiter-decision auth boundary is unchanged --------

test('the recruiter decision route still requires a real session, demo route or not', async () => {
  const server = await serve();
  try {
    await run(server.url, 'demo-001');

    const response = await fetch(`${server.url}/api/evaluations/anything/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'shortlist', reason: 'no session was ever presented' }),
    });
    assert.equal(response.status, 401);
  } finally {
    await server.stop();
  }
});

// --- 14: errors use the existing safe envelope ------------------------------

test('every error from this endpoint uses the existing safe envelope and leaks nothing internal', async () => {
  const server = await serve({ seedJob: false });
  try {
    const missingJob = await run(server.url, 'demo-001');
    const missingJobBody = (await missingJob.json()) as { error: { code: string; message: string } };
    assert.equal(missingJobBody.error.code, 'INVALID_STATE');
    assert.doesNotMatch(missingJobBody.error.message, /seed:demo|npm run|sqlite|postgres/i);

    await seedDemoJobOnly(server.repos);
    const unknownScenario = await run(server.url, 'demo-999');
    const unknownScenarioBody = (await unknownScenario.json()) as { error: { code: string } };
    assert.equal(unknownScenarioBody.error.code, 'NOT_FOUND');

    const badBody = await run(server.url, 'demo-001', { body: JSON.stringify({ x: 1 }) });
    const badBodyText = await badBody.text();
    assert.doesNotMatch(badBodyText, /at Object|at async|node_modules|\.ts:\d+/, 'a stack trace leaked');
  } finally {
    await server.stop();
  }
});

// --- runDemoScenario as a unit, independent of HTTP -------------------------

test('runDemoScenario is directly callable and independently produces the same isolation guarantees', async () => {
  const ctx = await createTestContext({ idPrefix: 'unit' });
  try {
    await seedDemoJobOnly(ctx.repos);
    const evaluation = await runDemoScenario({ repos: ctx.repos }, 'demo-001');
    assert.equal(evaluation.status, 'scored');

    const candidate = await ctx.repos.candidates.getById(evaluation.candidateId);
    assert.equal(candidate?.reference, 'demo-001');
    assert.equal(candidate?.source, 'demo');
  } finally {
    await ctx.close();
  }
});
