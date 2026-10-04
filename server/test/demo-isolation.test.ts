import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { hashPassword } from '../src/lib/password.ts';
import { rateLimit, RATE_LIMITS } from '../src/http/rateLimit.ts';
import { CSRF_HEADER } from '../src/auth/csrf.ts';
import { CSRF_COOKIE } from '../src/auth/cookies.ts';
import { rankJob } from '../src/agent/rank.ts';
import { seedDemoData } from '../src/demo/seed.ts';
import { DEMO_CANDIDATES } from '../src/demo/dataset.ts';
import { DEMO_SCENARIO_IDS } from '../src/demo/runScenario.ts';
import { createTestContext, type TestContext } from './helpers.ts';

// Public demo isolation.
//
// The demo-run endpoint is anonymous. The property under test here is the one
// that makes that acceptable: NOTHING an anonymous caller does through it can
// change what the operator sees or has decided. Before the sandbox, a public
// run opened a fresh canonical evaluation, which superseded the current one —
// and a recruiter's decision went with it, off the ranking and no longer
// decidable. These tests would have failed against that design; they are the
// regression guard that it stays gone.
//
// Everything runs over real HTTP against a canonical database seeded with the
// real demo dataset, which is what a deployed instance holds.

const PASSWORD = 'demo-isolation-operator-password';

type EvaluationBody = {
  evaluationId: string;
  status: string;
  tier: string;
  isCurrent: boolean;
  scoreBasisPoints: number | null;
  job: { id: string; title: string };
  decision: { outcome: string; reason: string; decidedBy: string } | null;
  requirements: Array<{
    label: string;
    verdict: string | null;
    contributionBasisPoints: number | null;
    evidence: Array<{ quote: string }>;
  }>;
};

type RankingBody = { entries: Array<{ reference: string; evaluationId: string | null; tier: string }> };
type ErrorBody = { error: { code: string } };

type Harness = {
  base: string;
  ctx: TestContext;
  jobId: string;
  /** Canonical evaluation id by demo reference, as seeded. */
  canonical: Map<string, string>;
  /** Anonymous, exactly as a visitor's browser would call it. */
  publicRun(scenario: string): Promise<Response>;
  anonymousGet(path: string): Promise<Response>;
  anonymousPost(path: string, body: unknown): Promise<Response>;
  /** A signed-in session. `csrf: false` leaves the header off. */
  signedIn: {
    get<T>(path: string): Promise<{ status: number; body: T }>;
    post<T>(path: string, body: unknown, options?: { csrf?: boolean }): Promise<{ status: number; body: T }>;
  };
};

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function withHarness(
  fn: (harness: Harness) => Promise<void>,
  overrides: Partial<AppConfig> = {},
): Promise<void> {
  const ctx = await createTestContext({ idPrefix: 'isolation' });
  const seeded = await seedDemoData({ repos: ctx.repos });

  const config: AppConfig = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    cookieSecure: false,
    demoPublicReadonly: true,
    ...overrides,
  };

  // A generous demo-run budget: these tests are about what runs DO, and the
  // budget itself is covered in demo-run.test.ts.
  const rateLimiter = rateLimit({ limits: { ...RATE_LIMITS, demoRun: { limit: 10_000, windowMs: 60_000 } } });
  const app = createApp({ db: ctx.db, config, logger: createMemoryLogger().logger, rateLimiter });
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
  const cookies = login.headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0] ?? '')
    .join('; ');
  const csrf = new RegExp(`${CSRF_COOKIE}=([^;]+)`).exec(cookies)?.[1] ?? '';
  assert.notEqual(csrf, '', 'precondition: a CSRF token was issued');

  const canonical = new Map(seeded.candidates.map((c) => [c.reference, c.evaluationId ?? '']));

  const harness: Harness = {
    base,
    ctx,
    jobId: seeded.jobId,
    canonical,
    publicRun: (scenario) =>
      fetch(`${base}/api/demo/scenarios/${scenario}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({}),
      }),
    anonymousGet: (path) => fetch(`${base}${path}`),
    anonymousPost: (path, body) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify(body),
      }),
    signedIn: {
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
            origin: base,
            ...(options.csrf === false ? {} : { [CSRF_HEADER]: csrf }),
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as never };
      },
    },
  };

  try {
    await fn(harness);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.close();
  }
}

const TABLES = [
  'jobs',
  'job_requirements',
  'candidates',
  'resumes',
  'sensitive_findings',
  'evaluations',
  'evidence',
  'requirement_matches',
  'recruiter_decisions',
  'audit_events',
] as const;

/** Row counts for every domain table of the canonical database. */
async function rowCounts(ctx: TestContext): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = await ctx.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    counts[table] = Number(rows[0]?.n ?? 0);
  }
  return counts;
}

/** The current/superseded state of every canonical evaluation. */
async function evaluationState(ctx: TestContext): Promise<unknown[]> {
  return ctx.db.query(
    'SELECT id, superseded_by, status, score_basis_points, must_haves_met FROM evaluations ORDER BY id',
  );
}

const DECISION_REASON = 'Strong evidence for both essential requirements.';

// --- 1: a public run cannot supersede canonical state -----------------------

test('public demo runs do not supersede or alter any canonical evaluation', async () => {
  await withHarness(async (h) => {
    const before = await evaluationState(h.ctx);
    const rankingBefore = await rankJob({ repos: h.ctx.repos }, h.jobId);
    assert.ok(before.length >= DEMO_SCENARIO_IDS.length, 'precondition: the canonical database is seeded');

    for (let round = 0; round < 3; round++) {
      for (const scenario of DEMO_SCENARIO_IDS) {
        assert.equal((await h.publicRun(scenario)).status, 201, `${scenario} did not run`);
      }
    }

    assert.deepEqual(await evaluationState(h.ctx), before, 'a public run changed a canonical evaluation');
    const unsuperseded = await h.ctx.db.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM evaluations WHERE superseded_by IS NOT NULL',
    );
    assert.equal(Number(unsuperseded[0]?.n), 0, 'a public run superseded a canonical evaluation');

    // The ranking a recruiter reads is identical, entry for entry.
    assert.deepEqual(await rankJob({ repos: h.ctx.repos }, h.jobId), rankingBefore);
  });
});

// --- 2: a recruiter decision survives a public run --------------------------

test('a recruiter decision stays on its evaluation, and stays current, after public runs', async () => {
  await withHarness(async (h) => {
    const evaluationId = h.canonical.get('demo-001') as string;

    const decided = await h.signedIn.post<{ decision: { outcome: string } }>(
      `/api/evaluations/${evaluationId}/decision`,
      { outcome: 'shortlist', reason: DECISION_REASON },
    );
    assert.equal(decided.status, 201, 'precondition: the recruiter could record a decision');

    // An anonymous visitor now runs the very same candidate, repeatedly.
    for (let i = 0; i < 3; i++) assert.equal((await h.publicRun('demo-001')).status, 201);

    const after = await h.signedIn.get<EvaluationBody>(`/api/evaluations/${evaluationId}`);
    assert.equal(after.status, 200);
    assert.equal(after.body.isCurrent, true, 'the decided evaluation was superseded');
    assert.equal(after.body.decision?.outcome, 'shortlist');
    assert.equal(after.body.decision?.reason, DECISION_REASON);
    assert.ok(after.body.decision && after.body.decision.decidedBy.length > 0, 'the decision lost its author');

    // And the ranking still points at that evaluation, not at a newer one.
    const ranking = await h.signedIn.get<RankingBody>(`/api/jobs/${h.jobId}/ranking`);
    const entry = ranking.body.entries.find((item) => item.reference === 'demo-001');
    assert.equal(entry?.evaluationId, evaluationId, 'the ranking moved off the decided evaluation');

    const decisions = await h.ctx.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM recruiter_decisions');
    assert.equal(Number(decisions[0]?.n), 1);
  });
});

test('a candidate can still be decided on after a public run of that candidate', async () => {
  await withHarness(async (h) => {
    // The reverse order: the visitor runs first. The recruiter must still be
    // able to decide on the canonical evaluation, which a supersession would
    // have refused with 409 ("replaced by a newer one").
    assert.equal((await h.publicRun('demo-002')).status, 201);
    const evaluationId = h.canonical.get('demo-002') as string;

    const decided = await h.signedIn.post(`/api/evaluations/${evaluationId}/decision`, {
      outcome: 'hold',
      reason: 'Waiting on a second interviewer before choosing.',
    });
    assert.equal(decided.status, 201);
  });
});

// --- 3: no unbounded persistent growth --------------------------------------

test('public demo runs add no persistent rows, however many are made', async () => {
  await withHarness(async (h) => {
    const before = await rowCounts(h.ctx);

    for (let round = 0; round < 25; round++) {
      for (const scenario of DEMO_SCENARIO_IDS) {
        assert.equal((await h.publicRun(scenario)).status, 201);
      }
    }

    assert.deepEqual(await rowCounts(h.ctx), before, 'the public endpoint wrote to the canonical database');
  });
});

// --- 4: the real mutation is still protected --------------------------------

test('the decision route still needs a session AND a CSRF token, before and after public runs', async () => {
  await withHarness(async (h) => {
    const evaluationId = h.canonical.get('demo-001') as string;
    const path = `/api/evaluations/${evaluationId}/decision`;
    const body = { outcome: 'reject', reason: 'This should never be recorded.' };

    const check = async (label: string) => {
      const anonymous = await h.anonymousPost(path, body);
      assert.equal(anonymous.status, 401, `${label}: an anonymous decision was not refused`);

      const noCsrf = await h.signedIn.post<ErrorBody>(path, body, { csrf: false });
      assert.equal(noCsrf.status, 403, `${label}: a decision without a CSRF token was not refused`);
      assert.equal(noCsrf.body.error.code, 'FORBIDDEN');
    };

    await check('before');
    for (const scenario of DEMO_SCENARIO_IDS) await h.publicRun(scenario);
    await check('after');

    const decisions = await h.ctx.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM recruiter_decisions');
    assert.equal(Number(decisions[0]?.n), 0, 'a refused decision was recorded anyway');
  });
});

test('a sandboxed evaluation cannot be decided on, even by a signed-in operator with a CSRF token', async () => {
  await withHarness(async (h) => {
    const run = await readJson<{ evaluationId: string }>(await h.publicRun('demo-001'));
    assert.ok(![...h.canonical.values()].includes(run.evaluationId), 'a sandbox id collided with a canonical one');

    const attempt = await h.signedIn.post<ErrorBody>(`/api/evaluations/${run.evaluationId}/decision`, {
      outcome: 'shortlist',
      reason: 'Attempting to decide on a demo run.',
    });
    assert.equal(attempt.status, 404);
    assert.equal(attempt.body.error.code, 'NOT_FOUND');

    const decisions = await h.ctx.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM recruiter_decisions');
    assert.equal(Number(decisions[0]?.n), 0);
  });
});

test('the public run exposes no write surface beyond its own route', async () => {
  await withHarness(async (h) => {
    const run = await readJson<{ evaluationId: string }>(await h.publicRun('demo-001'));

    // Other writes an anonymous caller might try against a sandbox id.
    for (const path of [
      `/api/evaluations/${run.evaluationId}/decision`,
      `/api/evaluations/${run.evaluationId}`,
      `/api/evaluations/${run.evaluationId}/audit`,
    ]) {
      const response = await h.anonymousPost(path, { outcome: 'shortlist', reason: 'anonymous attempt to write' });
      assert.equal(response.status, 401, `${path} accepted an anonymous POST`);
    }
  });
});

test('sandbox results add nothing to the anonymous read surface when the demo window is shut', async () => {
  await withHarness(
    async (h) => {
      // The run itself is a public route and is unaffected by the read window...
      const response = await h.publicRun('demo-001');
      assert.equal(response.status, 201);
      const run = await readJson<{ evaluationId: string }>(response);

      // ...but its result is only as readable as any other evaluation.
      assert.equal((await h.anonymousGet(`/api/evaluations/${run.evaluationId}`)).status, 401);
      assert.equal((await h.anonymousGet(`/api/evaluations/${run.evaluationId}/audit`)).status, 401);

      // A signed-in operator can read it, like any evaluation.
      assert.equal((await h.signedIn.get(`/api/evaluations/${run.evaluationId}`)).status, 200);
    },
    { demoPublicReadonly: false },
  );
});

// --- 5: matching, scoring and ranking are unchanged -------------------------

test('a public run reaches exactly the verdicts, scores and quotes the canonical pipeline did', async () => {
  await withHarness(async (h) => {
    for (const candidate of DEMO_CANDIDATES) {
      if (candidate.assess !== 'scored') continue;

      const run = await readJson<{ evaluationId: string }>(await h.publicRun(candidate.reference));
      const publicRead = await h.signedIn.get<EvaluationBody>(`/api/evaluations/${run.evaluationId}`);
      const canonicalRead = await h.signedIn.get<EvaluationBody>(
        `/api/evaluations/${h.canonical.get(candidate.reference)}`,
      );

      const where = candidate.displayName;
      assert.equal(publicRead.body.status, 'scored', `${where}: status`);
      assert.equal(publicRead.body.scoreBasisPoints, candidate.expected.scoreBasisPoints, `${where}: score`);
      assert.equal(publicRead.body.scoreBasisPoints, canonicalRead.body.scoreBasisPoints, `${where}: vs canonical`);
      assert.equal(publicRead.body.tier, canonicalRead.body.tier, `${where}: tier`);
      assert.deepEqual(
        publicRead.body.requirements.map((r) => r.verdict),
        candidate.expected.verdicts,
        `${where}: verdicts`,
      );
      assert.deepEqual(
        publicRead.body.requirements.map((r) => [r.verdict, r.contributionBasisPoints, r.evidence.map((e) => e.quote)]),
        canonicalRead.body.requirements.map((r) => [r.verdict, r.contributionBasisPoints, r.evidence.map((e) => e.quote)]),
        `${where}: per-requirement outcome`,
      );
    }
  });
});

test('a sandboxed evaluation links back to the canonical role and carries its full audit trail', async () => {
  await withHarness(async (h) => {
    const run = await readJson<{ evaluationId: string }>(await h.publicRun('demo-003'));

    const detail = await readJson<EvaluationBody>(await h.anonymousGet(`/api/evaluations/${run.evaluationId}`));
    assert.equal(detail.job.id, h.jobId, 'the back-link would land on a job the canonical database does not have');
    assert.equal((await h.anonymousGet(`/api/jobs/${detail.job.id}`)).status, 200);

    const audit = await readJson<{ events: Array<{ stage: string; eventType: string }> }>(
      await h.anonymousGet(`/api/evaluations/${run.evaluationId}/audit`),
    );
    const types = audit.events.map((event) => event.eventType);
    for (const expected of ['resume_ingested', 'sensitive_attributes_masked', 'evidence_verified', 'score_computed']) {
      assert.ok(types.includes(expected), `the sandbox audit trail is missing "${expected}"`);
    }
  });
});

test('canonical ranking is the dataset\'s own, untouched by any public run', async () => {
  await withHarness(async (h) => {
    for (const scenario of DEMO_SCENARIO_IDS) await h.publicRun(scenario);

    const ranking = await h.signedIn.get<RankingBody>(`/api/jobs/${h.jobId}/ranking`);
    for (const candidate of DEMO_CANDIDATES) {
      const entry = ranking.body.entries.find((item) => item.reference === candidate.reference);
      assert.ok(entry, `${candidate.displayName} is missing from the ranking`);
      assert.equal(entry.tier, candidate.expected.tier, `${candidate.displayName}: tier`);
      assert.equal(entry.evaluationId, h.canonical.get(candidate.reference), `${candidate.displayName}: evaluation`);
    }
  });
});
