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
import { isDemoScenarioId, DEMO_SCENARIO_IDS } from '../src/demo/runScenario.ts';
import { createDemoSandbox } from '../src/demo/sandbox.ts';
import { createTestContext, MIGRATIONS_DIR } from './helpers.ts';
import type { Repositories } from '../src/db/repositories/index.ts';

// The public demo-run endpoint: `POST /api/demo/scenarios/:scenario/run`.
//
// WHAT THIS FILE IS DEFENDING
//
// This is the one POST in the whole API an anonymous stranger can reach. Every
// test below is written the way an attacker would read them: not "does the
// happy path work?" but "what is the complete set of things a caller can make
// this route do, and is any of it something other than 'run one of exactly
// five fixed scenarios in an isolated sandbox'?"
//
// The route writes nothing to the canonical database: the scenario runs in an
// in-memory sandbox (src/demo/sandbox.ts). The isolation guarantees themselves
// — a recruiter's evaluation and decision cannot be displaced by a public run —
// are asserted in demo-isolation.test.ts.

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

/** The parts of an evaluation response these tests read. */
type EvaluationBody = {
  status: string;
  scoreBasisPoints: number | null;
  isCurrent: boolean;
  evidenceRejectedCount: number;
  job: { id: string; title: string };
  requirements: Array<{ label: string; verdict: string | null; evidence: unknown[] }>;
};

/** `Response.json()` is `unknown` under strict typing; say what is expected. */
async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function readEvaluation(base: string, evaluationId: string): Promise<EvaluationBody> {
  return readJson<EvaluationBody>(await fetch(`${base}/api/evaluations/${evaluationId}`));
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
    const detail = await readEvaluation(server.url, body.evaluationId);
    assert.equal(detail.status, 'scored');
    assert.equal(typeof detail.scoreBasisPoints, 'number');
    assert.equal(detail.job.title, DEMO_JOB.title);

    // And the canonical database was never written: the run lives in the sandbox.
    assert.equal(await server.repos.evaluations.count(), 0);
    assert.equal(await server.repos.candidates.count(), 0);
  } finally {
    await server.stop();
  }
});

test('the real pipeline was exercised, not faked: verified evidence backs the requirements', async () => {
  const server = await serve();
  try {
    const response = await run(server.url, 'demo-001');
    const { evaluationId } = (await response.json()) as { evaluationId: string };
    const detail = await readEvaluation(server.url, evaluationId);

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
    const evalA = await readJson<{ evaluationId: string }>(await run(a.url, 'demo-003'));
    const evalB = await readJson<{ evaluationId: string }>(await run(b.url, 'demo-003'));

    // Not just the same scores: the same ids, because the sandbox derives them
    // from the scenario name rather than from a random source.
    assert.equal(evalA.evaluationId, evalB.evaluationId);

    const detailA = await readEvaluation(a.url, evalA.evaluationId);
    const detailB = await readEvaluation(b.url, evalB.evaluationId);

    assert.equal(detailA.scoreBasisPoints, detailB.scoreBasisPoints);
    assert.deepEqual(
      detailA.requirements.map((r) => r.verdict),
      detailB.requirements.map((r) => r.verdict),
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

    const detail = await readEvaluation(server.url, evaluationId);
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

test('a demo run writes nothing to the canonical database and never touches an existing job or candidate', async () => {
  const server = await serve();
  try {
    // A real, non-demo job and candidate, seeded independently of anything
    // this endpoint knows about.
    const { job: realJob } = await createJob(
      { repos: server.repos },
      { title: 'A Real Role', seniority: 'mid', requirements: [{ label: 'X', criterion: 'Has X', kind: 'must_have', weight: 1 }] },
    );
    const realCandidate = await server.repos.candidates.create({ reference: 'real-applicant-1', source: 'upload' });

    const auditBefore = await server.repos.audit.count();
    const response = await run(server.url, 'demo-001');
    assert.equal(response.status, 201);

    // Canonical state: exactly the candidate seeded above — no demo candidate,
    // no evaluation, no audit event.
    const candidates = await server.repos.candidates.list({ limit: 50 });
    assert.deepEqual(candidates.map((c) => c.reference), ['real-applicant-1']);
    assert.equal(await server.repos.evaluations.count(), 0);
    assert.equal(await server.repos.audit.count(), auditBefore);

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

// --- 11: repeated execution is idempotent, and supersedes nothing -----------

test('running the same scenario twice returns the same sandboxed evaluation and stacks nothing', async () => {
  const server = await serve();
  try {
    const first = await readJson<{ evaluationId: string }>(await run(server.url, 'demo-002'));
    const second = await readJson<{ evaluationId: string }>(await run(server.url, 'demo-002'));

    assert.equal(first.evaluationId, second.evaluationId);

    // The evaluation is current, scored and readable — and absent from the
    // canonical database, where a repeat run would once have superseded it.
    const detail = await readEvaluation(server.url, first.evaluationId);
    assert.equal(detail.isCurrent, true);
    assert.equal(detail.status, 'scored');
    assert.equal(await server.repos.evaluations.getById(first.evaluationId), null);
    assert.equal(await server.repos.candidates.count(), 0);
  } finally {
    await server.stop();
  }
});

// --- concurrency: two simultaneous runs of the same scenario ----------------

test('two concurrent runs of the same scenario resolve to one sandboxed evaluation', async () => {
  const server = await serve();
  try {
    const [a, b] = await Promise.all([run(server.url, 'demo-004'), run(server.url, 'demo-004')]);

    // Both requests must resolve to a real outcome — no 500, no hang.
    assert.equal(a.status, 201, `first concurrent call returned ${a.status}`);
    assert.equal(b.status, 201, `second concurrent call returned ${b.status}`);

    const bodyA = await readJson<{ evaluationId: string }>(a);
    const bodyB = await readJson<{ evaluationId: string }>(b);
    assert.equal(bodyA.evaluationId, bodyB.evaluationId, 'concurrent runs built two different sandboxes');

    // Nothing canonical was created by either.
    assert.equal(await server.repos.candidates.count(), 0);
    assert.equal(await server.repos.evaluations.count(), 0);
    const jobs = await server.repos.jobs.list({ limit: 50 });
    assert.equal(jobs.filter((j) => j.title === DEMO_JOB.title).length, 1, 'a concurrent run duplicated the job');
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

// --- the sandbox as a unit, independent of HTTP -----------------------------

test('the sandbox runs a scenario in isolation and is bounded by the scenario count', async () => {
  const sandbox = createDemoSandbox({ migrationsDir: MIGRATIONS_DIR });
  try {
    assert.equal(sandbox.size, 0);

    const entry = await sandbox.run('demo-001', 'canonical-job-id');
    const evaluation = await entry.repos.evaluations.getById(entry.evaluationId);
    assert.equal(evaluation?.status, 'scored');

    const candidate = evaluation ? await entry.repos.candidates.getById(evaluation.candidateId) : null;
    assert.equal(candidate?.reference, 'demo-001');
    assert.equal(candidate?.source, 'demo');

    // Repeats return the same entry; only new scenarios add to the size.
    assert.equal(await sandbox.run('demo-001', 'canonical-job-id'), entry);
    assert.equal(sandbox.size, 1);
    for (const scenario of DEMO_SCENARIO_IDS) await sandbox.run(scenario, 'canonical-job-id');
    assert.equal(sandbox.size, DEMO_SCENARIO_IDS.length);
    for (let i = 0; i < 20; i++) await sandbox.run('demo-003', 'canonical-job-id');
    assert.equal(sandbox.size, DEMO_SCENARIO_IDS.length, 'repeat runs grew the sandbox');

    assert.equal(sandbox.find(entry.evaluationId), entry);
    assert.equal(sandbox.find('not-a-sandbox-id'), null);
  } finally {
    await sandbox.close();
  }
});
