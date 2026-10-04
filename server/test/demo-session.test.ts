import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rateLimit, RATE_LIMITS, classify } from '../src/http/rateLimit.ts';
import { CSRF_HEADER } from '../src/auth/csrf.ts';
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/auth/cookies.ts';
import { PUBLIC_DEMO_READS, isPublicDemoRead } from '../src/auth/middleware.ts';
import { DEMO_CANDIDATES, DEMO_JOB, demoPersonalDetails } from '../src/demo/dataset.ts';
import { DEMO_SCENARIO_IDS } from '../src/demo/runScenario.ts';
import {
  createDemoSessionStore,
  isWellFormedDemoToken,
} from '../src/demo/sessions.ts';
import { DEMO_SESSION_COOKIE } from '../src/routes/demoSession.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import { MIGRATIONS_DIR } from './helpers.ts';

// The visitor-scoped public demo (Phase 3C.1).
//
// WHAT THIS FILE IS DEFENDING
//
// A visitor can enter the demo with no sign-in, no key and no recruiter
// identity, and gets a private copy of the fixed synthetic dataset that nobody
// else can see or change. Every test is written the way someone attacking that
// would read it: not "does a session start?" but "is there ANY way through this
// surface to a recruiter's record, to another visitor's, or to a credential?"
//
// Everything runs over real HTTP against a canonical database that holds the
// real seeded dataset AND a recruiter's decision — what a deployed instance
// holds, and the state the surface must leave exactly as it found it.

import {
  FIXTURE_NAME,
  PASSWORD,
  SECRET_API_KEY,
  canonicalSnapshot,
  flip,
  rankingOf,
  tokenFrom,
  withHarness,
  type EvaluationBody,
  type Reply,
} from './demoHarness.ts';

// ============================================================ 1. direct entry

test('a visitor enters the demo directly: no sign-in, no key, no operator password, no demo window', async () => {
  // Nothing is configured that a public deployment might lack: the read window
  // is shut, and no operator password hash exists at all.
  await withHarness(
    async (h) => {
      const { reply } = await h.start();
      assert.equal(reply.status, 201);
      assert.equal(reply.body.active, true);
      assert.equal(reply.body.jobTitle, DEMO_JOB.title);
      assert.equal(typeof reply.body.jobId, 'string');
      assert.equal(typeof reply.body.expiresAt, 'string');
    },
    { overrides: { demoPublicReadonly: false, operatorPasswordHash: null, anthropicApiKey: null } },
  );
});

test('the demo cookie is HttpOnly and SameSite=Strict, and carries no operator or CSRF cookie', async () => {
  await withHarness(async (h) => {
    const { reply } = await h.start();
    const demo = reply.cookies.find((c) => c.startsWith(`${DEMO_SESSION_COOKIE}=`)) ?? '';

    assert.match(demo, /HttpOnly/i);
    assert.match(demo, /SameSite=Strict/i);
    assert.match(demo, /Path=\//);
    assert.doesNotMatch(demo, /Secure/i, 'this harness runs with cookieSecure=false');

    assert.equal(reply.cookies.length, 1, 'only the demo cookie was set');
    assert.ok(!reply.cookies.some((c) => c.startsWith(`${SESSION_COOKIE}=`) || c.startsWith(`${CSRF_COOKIE}=`)));
  });
});

test('the demo cookie is Secure whenever the deployment is configured for it', async () => {
  await withHarness(
    async (h) => {
      const { reply } = await h.start();
      assert.match(reply.cookies.find((c) => c.startsWith(`${DEMO_SESSION_COOKIE}=`)) ?? '', /Secure/i);
    },
    { overrides: { cookieSecure: true } },
  );
});

test('the token is opaque: well-formed, never in a response body, and nothing to decode', async () => {
  await withHarness(async (h) => {
    const { token, reply } = await h.start();
    assert.ok(isWellFormedDemoToken(token));
    assert.equal(token.length, 43);
    assert.ok(!JSON.stringify(reply.body).includes(token), 'the token was echoed in a body');

    // Two sessions never share a token, and neither resembles the other.
    const second = await h.start();
    assert.notEqual(second.token, token);

    // Nothing about the dataset, the job or time is derivable from it.
    for (const fragment of [DEMO_JOB.title, 'demo', 'session', String(new Date().getFullYear())]) {
      assert.ok(!token.toLowerCase().includes(fragment.toLowerCase().replace(/\s/g, '')), `token contains "${fragment}"`);
    }
  });
});

// ===================================================== 2/3. session + dataset

test('a session holds the fixed synthetic dataset, ranked exactly as the dataset says', async () => {
  await withHarness(async (h) => {
    const { token, reply } = await h.start();
    const jobId = reply.body.jobId as string;

    const jobs = await h.call<{ jobs: Array<{ id: string; title: string; candidateCount: number }> }>(
      'GET', '/api/demo/session/jobs', { token });
    assert.equal(jobs.status, 200);
    assert.equal(jobs.body.jobs.length, 1, 'a session holds exactly the one demo job');
    assert.equal(jobs.body.jobs[0]?.title, DEMO_JOB.title);
    assert.equal(jobs.body.jobs[0]?.candidateCount, DEMO_CANDIDATES.length);

    const ranking = await rankingOf(h, token, jobId);
    assert.deepEqual(
      ranking.entries.map((e) => e.reference),
      ['demo-001', 'demo-002', 'demo-004', 'demo-003', 'demo-005'],
      'qualified, then needs review, then gated, then unranked',
    );
    for (const entry of ranking.entries) {
      const spec = DEMO_CANDIDATES.find((c) => c.reference === entry.reference);
      assert.equal(entry.tier, spec?.expected.tier, `${entry.reference} tier`);
      assert.equal(entry.scoreBasisPoints, spec?.expected.scoreBasisPoints, `${entry.reference} score`);
    }

    // Only synthetic people are in it — not the canonical fixture candidate.
    assert.ok(!JSON.stringify(ranking).includes(FIXTURE_NAME));
    assert.ok(!JSON.stringify(jobs.body).includes('real-0001'));
  });
});

test('every candidate in a session has the verdicts the dataset declares, backed by verified quotes', async () => {
  await withHarness(async (h) => {
    const { token, reply } = await h.start();
    const ranking = await rankingOf(h, token, reply.body.jobId as string);

    for (const entry of ranking.entries) {
      const spec = DEMO_CANDIDATES.find((c) => c.reference === entry.reference);
      assert.ok(entry.evaluationId);
      const detail = await h.call<EvaluationBody>('GET', `/api/demo/session/evaluations/${entry.evaluationId}`, { token });
      assert.equal(detail.status, 200);
      assert.deepEqual(
        detail.body.requirements.map((r) => r.verdict).filter((v) => v !== null),
        spec?.expected.verdicts,
        `${entry.reference} verdicts`,
      );
      assert.equal(detail.body.decision, null, 'a fresh session holds no decision');
    }
  });
});

test('two sessions begin byte-identical, and match the canonical seed in every judgement', async () => {
  await withHarness(async (h) => {
    const a = await h.start();
    const b = await h.start();

    const rankingA = await rankingOf(h, a.token, a.reply.body.jobId as string);
    const rankingB = await rankingOf(h, b.token, b.reply.body.jobId as string);
    assert.deepEqual(rankingA, rankingB, 'two fresh sessions differ');

    // The same judgements as the canonical pipeline run: scores, verdicts and quotes.
    const op = await h.operator();
    for (const entry of rankingA.entries) {
      const canonicalId = h.canonicalEvaluations.get(entry.reference);
      const mine = await h.call<EvaluationBody>('GET', `/api/demo/session/evaluations/${entry.evaluationId}`, { token: a.token });
      const theirs = await fetch(`${h.base}/api/evaluations/${canonicalId}`, { headers: { cookie: op.cookie } });
      const canonicalBody = (await theirs.json()) as EvaluationBody;

      assert.equal(mine.body.scoreBasisPoints, canonicalBody.scoreBasisPoints, `${entry.reference} score`);
      assert.equal(mine.body.tier, canonicalBody.tier);
      assert.deepEqual(
        mine.body.requirements.map((r) => [r.label, r.verdict, r.evidence.map((e) => e.quote)]),
        canonicalBody.requirements.map((r) => [r.label, r.verdict, r.evidence.map((e) => e.quote)]),
        `${entry.reference} verdicts and quotes`,
      );
    }
  });
});

test('the dataset the sessions run on is unchanged: one job, five candidates, the declared outcomes', () => {
  assert.equal(DEMO_JOB.title, 'Senior Backend Engineer');
  assert.deepEqual(
    DEMO_JOB.requirements.map((r) => [r.label, r.kind, r.weight]),
    [['Node.js', 'must_have', 3], ['PostgreSQL', 'must_have', 2], ['Mentoring', 'nice_to_have', 2]],
  );
  assert.deepEqual(
    DEMO_CANDIDATES.map((c) => [c.reference, c.displayName, c.expected.tier, c.expected.scoreBasisPoints]),
    [
      ['demo-001', 'Rowan Ashfield', 'qualified', 10_000],
      ['demo-002', 'Devi Narayanan', 'qualified', 7_142],
      ['demo-003', 'Marcus Oyelaran', 'gated', 7_142],
      ['demo-004', 'Ines Fabre', 'needs_review', 5_714],
      ['demo-005', 'Toby Kestrel', 'not_evaluated', null],
    ],
  );
});

test('a session is built without any network call, key or model provider', async () => {
  // Any outbound call from building or reading a session would have to go
  // through fetch (the Anthropic SDK does). Make that impossible, then build.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error('a demo session attempted a network call');
  }) as typeof fetch;
  const store = createDemoSessionStore({ migrationsDir: MIGRATIONS_DIR });
  try {
    const { token, sandbox } = await store.create();
    assert.ok(isWellFormedDemoToken(token));
    assert.equal(sandbox.jobTitle, DEMO_JOB.title);
    assert.ok(store.resolve(token));
  } finally {
    globalThis.fetch = realFetch;
    await store.close();
  }
});

test('the session modules import no provider, no config and no environment', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ['../src/demo/sessions.ts', '../src/handlers/demoSession.ts', '../src/routes/demoSession.ts']) {
    const source = fs.readFileSync(path.join(here, rel), 'utf8').replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(source, /adapters\/llm|@anthropic-ai|anthropicApiKey|ANTHROPIC|process\.env|createLlmProvider/, `${rel} reaches for a provider or key`);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${rel} makes a network call`);
  }
});

// ============================================== 3. persistence across reload

test('a reload resumes the same session: status, repeat start and reads all agree', async () => {
  await withHarness(async (h) => {
    const { token, reply } = await h.start();

    const status = await h.call('GET', '/api/demo/session', { token });
    assert.equal(status.status, 200);
    // `expiresAt` slides with use, so it is the one field that may differ.
    assert.deepEqual({ ...status.body, expiresAt: null }, { ...reply.body, expiresAt: null }, 'the status is the session that was started');

    // Starting again with the cookie resumes rather than replaces, and sets no new cookie.
    const again = await h.call('POST', '/api/demo/session', { token });
    assert.equal(again.status, 200);
    assert.equal(again.body.jobId, reply.body.jobId);
    assert.equal(again.cookies.length, 0, 'a resume must not rotate the cookie');
    assert.equal(h.store.size, 1, 'a resume must not build a second session');
  });
});

test('with no cookie there is no session, and that is an answer, not an error', async () => {
  await withHarness(async (h) => {
    const status = await h.call('GET', '/api/demo/session');
    assert.equal(status.status, 200);
    assert.deepEqual(status.body, { active: false });
    assert.equal(status.cookies.length, 0);
  });
});

test('every response from the session surface is uncacheable and varies by cookie', async () => {
  await withHarness(async (h) => {
    const { token } = await h.start();
    for (const reply of [
      await h.call('GET', '/api/demo/session', { token }),
      await h.call('GET', '/api/demo/session/jobs', { token }),
      await h.call('GET', '/api/demo/session/jobs', {}),
    ]) {
      assert.equal(reply.headers.get('cache-control'), 'no-store');
      assert.match(reply.headers.get('vary') ?? '', /cookie/i);
    }
  });
});

// ============================================================ 4. visitor isolation

test('visitor A\'s state is invisible to visitor B, and B\'s to A', async () => {
  const store = createDemoSessionStore({ migrationsDir: MIGRATIONS_DIR });
  await withHarness(
    async (h) => {
      const a = await h.start();
      const b = await h.start();
      const rankingA = await rankingOf(h, a.token, a.reply.body.jobId as string);
      const targetId = rankingA.entries[0]?.evaluationId as string;

      // Give A state that B does not have. (There is no decision route for
      // visitors yet; the store hands out each visitor's private repositories,
      // which is the same database a future route would write to.)
      const sandboxA = h.store.resolve(a.token);
      assert.ok(sandboxA);
      await sandboxA.repos.decisions.record({
        evaluationId: targetId,
        outcome: 'hold',
        reason: 'Visitor A decided this in their own copy.',
        decidedBy: 'demo-visitor',
      });

      const seenByA = await h.call<EvaluationBody>('GET', `/api/demo/session/evaluations/${targetId}`, { token: a.token });
      const seenByB = await h.call<EvaluationBody>('GET', `/api/demo/session/evaluations/${targetId}`, { token: b.token });
      assert.equal(seenByA.body.decision?.outcome, 'hold', 'A sees A\'s own state');
      assert.equal(seenByB.body.decision, null, 'B saw A\'s state');

      // The reverse, so the isolation is not one-directional.
      const sandboxB = h.store.resolve(b.token);
      assert.ok(sandboxB);
      assert.notEqual(sandboxA.repos, sandboxB.repos, 'two visitors share one set of repositories');
      await sandboxB.repos.decisions.record({
        evaluationId: targetId,
        outcome: 'reject',
        reason: 'Visitor B decided this in their own copy.',
        decidedBy: 'demo-visitor',
      });
      const aAfter = await h.call<EvaluationBody>('GET', `/api/demo/session/evaluations/${targetId}`, { token: a.token });
      assert.equal(aAfter.body.decision?.outcome, 'hold', 'B\'s state leaked into A');
    },
    { store },
  );
});

test('a guessed, modified or foreign token reaches nothing', async () => {
  await withHarness(async (h) => {
    const a = await h.start();
    const b = await h.start();
    const ranking = await rankingOf(h, a.token, a.reply.body.jobId as string);
    const evaluationId = ranking.entries[0]?.evaluationId as string;

    const candidates: Array<[string, string]> = [
      ['A\'s token with one character changed', flip(a.token)],
      ['a well-formed random token', 'A'.repeat(43)],
      ['a token that is a prefix of a real one', a.token.slice(0, 42)],
      ['a token that extends a real one', `${a.token}A`],
      ['a real token with its case altered', a.token.toLowerCase() === a.token ? a.token.toUpperCase() : a.token.toLowerCase()],
    ];

    for (const [label, token] of candidates) {
      assert.notEqual(token, a.token);
      assert.notEqual(token, b.token);
      for (const p of [
        '/api/demo/session/jobs',
        `/api/demo/session/jobs/${a.reply.body.jobId}`,
        `/api/demo/session/jobs/${a.reply.body.jobId}/ranking`,
        `/api/demo/session/evaluations/${evaluationId}`,
        `/api/demo/session/evaluations/${evaluationId}/audit`,
      ]) {
        const reply = await h.call('GET', p, { token });
        assert.equal(reply.status, 401, `${label} read ${p}`);
        assert.ok(!JSON.stringify(reply.body).includes('Senior Backend Engineer'), `${label} leaked the job`);
      }
      assert.equal((await h.call('POST', '/api/demo/session/reset', { token })).status, 401, `${label} reset`);
      assert.equal((await h.call('POST', '/api/demo/session/scenarios/demo-001/run', { token })).status, 401, `${label} run`);
    }

    assert.ok(h.store.resolve(a.token), 'A\'s session survived every forged attempt');
    assert.ok(h.store.resolve(b.token), 'B\'s session survived every forged attempt');
  });
});

test('a token in the URL, a header or the body is ignored: only the cookie names a session', async () => {
  await withHarness(async (h) => {
    const { token } = await h.start();

    for (const attempt of [
      fetch(`${h.base}/api/demo/session/jobs?token=${token}`),
      fetch(`${h.base}/api/demo/session/jobs?${DEMO_SESSION_COOKIE}=${token}`),
      fetch(`${h.base}/api/demo/session/jobs`, { headers: { 'x-demo-session': token, authorization: `Bearer ${token}` } }),
    ]) {
      assert.equal((await attempt).status, 401);
    }
  });
});

// ============================================================ 5. invalid sessions

test('malformed demo cookies fail safely: a clean 401 or an inactive status, never a 500', async () => {
  await withHarness(async (h) => {
    const malformed = [
      '',
      ' ',
      'x',
      '%',
      '%E0%A4%A',
      '../../etc/passwd',
      "' OR '1'='1",
      '<script>alert(1)</script>',
      'A'.repeat(42),
      'A'.repeat(44),
      'A'.repeat(10_000),
      `${'A'.repeat(42)}=`,
      `${'A'.repeat(42)}!`,
      'null',
      'undefined',
      '[object Object]',
    ];

    for (const value of malformed) {
      const rawCookie = `${DEMO_SESSION_COOKIE}=${value}`;

      const read = await h.call('GET', '/api/demo/session/jobs', { rawCookie });
      assert.equal(read.status, 401, `read with ${JSON.stringify(value.slice(0, 20))}`);

      const status = await h.call('GET', '/api/demo/session', { rawCookie });
      assert.equal(status.status, 200);
      assert.deepEqual(status.body, { active: false });

      assert.equal((await h.call('POST', '/api/demo/session/reset', { rawCookie })).status, 401);
      assert.equal((await h.call('POST', '/api/demo/session/scenarios/demo-001/run', { rawCookie })).status, 401);

      // The refusal says nothing about why — and never repeats what was sent.
      assert.ok(!JSON.stringify(read.body).includes(value.slice(0, 30)) || value.length < 3);
      assert.equal((read.body as { error: { code: string } }).error.code, 'UNAUTHORIZED');
    }
    assert.equal(h.store.size, 0, 'no malformed request created a session');
  });
});

test('a cookie that names nothing is cleared, so the browser stops sending it', async () => {
  await withHarness(async (h) => {
    const stale = await h.call('GET', '/api/demo/session', { token: 'A'.repeat(43) });
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.body, { active: false });
    const cleared = stale.cookies.find((c) => c.startsWith(`${DEMO_SESSION_COOKIE}=`)) ?? '';
    assert.match(cleared, /Max-Age=0/);
  });
});

test('starting with a malformed or stale cookie simply starts a new session', async () => {
  await withHarness(async (h) => {
    const reply = await h.call('POST', '/api/demo/session', { rawCookie: `${DEMO_SESSION_COOKIE}=garbage` });
    assert.equal(reply.status, 201);
    assert.ok(tokenFrom(reply.cookies));
    assert.equal(h.store.size, 1);
  });
});

test('duplicate demo cookies cannot smuggle a second identity past the first', async () => {
  await withHarness(async (h) => {
    const a = await h.start();
    const rawCookie = `${DEMO_SESSION_COOKIE}=${'B'.repeat(43)}; ${DEMO_SESSION_COOKIE}=${a.token}`;
    const reply = await h.call('GET', '/api/demo/session/jobs', { rawCookie });
    // The first cookie wins, as it does for the operator session — and it is unknown.
    assert.equal(reply.status, 401);
  });
});

test('an expired session fails exactly like an unknown one', async () => {
  let nowMs = Date.parse('2026-06-01T00:00:00.000Z');
  const store = createDemoSessionStore({
    migrationsDir: MIGRATIONS_DIR,
    clock: { nowIso: () => new Date(nowMs).toISOString() },
    ttlMs: 60_000,
  });
  await withHarness(
    async (h) => {
      const { token } = await h.start();
      assert.equal((await h.call('GET', '/api/demo/session/jobs', { token })).status, 200);

      nowMs += 61_000;
      const expired = await h.call('GET', '/api/demo/session/jobs', { token });
      const unknown = await h.call('GET', '/api/demo/session/jobs', { token: flip(token) });
      assert.equal(expired.status, 401);
      assert.deepEqual(expired.body, unknown.body, 'expired and unknown are distinguishable');
      assert.equal(store.size, 0, 'the expired session was released');
    },
    { store },
  );
});

// ================================================================ 6. reset

test('reset restores this visitor\'s session to the fixed dataset and changes nobody else\'s', async () => {
  await withHarness(async (h) => {
    const a = await h.start();
    const b = await h.start();
    const jobId = a.reply.body.jobId as string;
    const ranking = await rankingOf(h, a.token, jobId);
    const targetId = ranking.entries[0]?.evaluationId as string;

    for (const who of [a, b]) {
      const sandbox = h.store.resolve(who.token);
      assert.ok(sandbox);
      await sandbox.repos.decisions.record({
        evaluationId: targetId,
        outcome: 'shortlist',
        reason: 'State that reset must discard — for A only.',
        decidedBy: 'demo-visitor',
      });
    }
    const dirty = await h.call<EvaluationBody>('GET', `/api/demo/session/evaluations/${targetId}`, { token: a.token });
    assert.ok(dirty.body.decision, 'precondition: A\'s session holds state');

    const reset = await h.call('POST', '/api/demo/session/reset', { token: a.token });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.active, true);
    assert.equal(reset.cookies.length, 0, 'reset keeps the same session; it does not rotate the cookie');

    const aAfter = await h.call<EvaluationBody>('GET', `/api/demo/session/evaluations/${targetId}`, { token: a.token });
    assert.equal(aAfter.status, 200);
    assert.equal(aAfter.body.decision, null, 'A\'s state survived the reset');

    const bAfter = await h.call<EvaluationBody>('GET', `/api/demo/session/evaluations/${targetId}`, { token: b.token });
    assert.equal(bAfter.body.decision?.outcome, 'shortlist', 'A\'s reset reached B\'s session');

    // Back to the fixed dataset, byte for byte.
    assert.deepEqual(await rankingOf(h, a.token, reset.body.jobId as string), ranking);
  });
});

test('reset is repeatable, needs a session, takes no body and names no target', async () => {
  await withHarness(async (h) => {
    assert.equal((await h.call('POST', '/api/demo/session/reset')).status, 401, 'reset without a session');

    const { token } = await h.start();
    for (let i = 0; i < 3; i++) assert.equal((await h.call('POST', '/api/demo/session/reset', { token })).status, 200);
    assert.equal(h.store.size, 1, 'reset must not stack sessions');

    // A body — including one that tries to name another visitor — is refused outright.
    const b = await h.start();
    const pointed = await h.call('POST', '/api/demo/session/reset', { token, body: { token: b.token, session: b.token } });
    assert.equal(pointed.status, 400);
    assert.ok(h.store.resolve(b.token));
  });
});

test('ending a session discards it, is repeatable, and touches no other session', async () => {
  await withHarness(async (h) => {
    const a = await h.start();
    const b = await h.start();

    const ended = await h.call('DELETE', '/api/demo/session', { token: a.token });
    assert.equal(ended.status, 200);
    assert.match(ended.cookies.find((c) => c.startsWith(`${DEMO_SESSION_COOKIE}=`)) ?? '', /Max-Age=0/);

    assert.equal((await h.call('GET', '/api/demo/session/jobs', { token: a.token })).status, 401);
    assert.equal((await h.call('GET', '/api/demo/session/jobs', { token: b.token })).status, 200, 'B was ended with A');

    assert.equal((await h.call('DELETE', '/api/demo/session', { token: a.token })).status, 200, 'ending twice must be safe');
    assert.equal((await h.call('DELETE', '/api/demo/session')).status, 200, 'ending with no session must be safe');
  });
});

// ======================================================= the scenario run route

test('running a scenario in a session resolves to that visitor\'s own evaluation, repeatably', async () => {
  await withHarness(async (h) => {
    const { token, reply } = await h.start();
    const ranking = await rankingOf(h, token, reply.body.jobId as string);

    for (const scenario of DEMO_SCENARIO_IDS) {
      const expected = ranking.entries.find((e) => e.reference === scenario)?.evaluationId;
      for (let i = 0; i < 2; i++) {
        const run = await h.call<{ evaluationId: string }>('POST', `/api/demo/session/scenarios/${scenario}/run`, { token });
        assert.equal(run.status, 200);
        assert.equal(run.body.evaluationId, expected, `${scenario} resolved to another evaluation`);
      }
    }
    assert.equal(h.store.size, 1, 'running scenarios must not build further sessions');
  });
});

test('the session run route refuses a body and any scenario outside the five', async () => {
  await withHarness(async (h) => {
    const { token } = await h.start();

    const withBody = await h.call('POST', '/api/demo/session/scenarios/demo-001/run', {
      token,
      body: { candidateId: 'x', jobId: 'y', resume: 'z', provider: 'anthropic' },
    });
    assert.equal(withBody.status, 400);

    for (const bogus of ['demo-000', 'demo-006', 'DEMO-001', '..%2F', 'x']) {
      assert.equal((await h.call('POST', `/api/demo/session/scenarios/${bogus}/run`, { token })).status, 404, bogus);
    }
  });
});

// ================================================== 7. canonical data protection

test('nothing a visitor can do through the session surface changes one canonical row', async () => {
  await withHarness(async (h) => {
    const before = await canonicalSnapshot(h.ctx);

    const a = await h.start();
    const b = await h.start();
    for (const scenario of DEMO_SCENARIO_IDS) {
      await h.call('POST', `/api/demo/session/scenarios/${scenario}/run`, { token: a.token });
      await h.call('POST', `/api/demo/scenarios/${scenario}/run`);
    }
    await h.call('POST', '/api/demo/session/reset', { token: a.token });
    await h.call('POST', '/api/demo/session/reset', { token: a.token });
    await h.call('GET', '/api/demo/session/jobs', { token: a.token });
    await h.call('DELETE', '/api/demo/session', { token: b.token });
    // And the forged and malformed attempts.
    await h.call('POST', '/api/demo/session/reset', { token: flip(a.token) });
    await h.call('POST', '/api/demo/session', { rawCookie: `${DEMO_SESSION_COOKIE}=garbage` });

    assert.equal(await canonicalSnapshot(h.ctx), before, 'a canonical row changed');
  });
});

test('a session identifier cannot resolve a canonical evaluation or job, and a canonical one cannot resolve a session\'s', async () => {
  await withHarness(async (h) => {
    const { token, reply } = await h.start();
    const sessionJobId = reply.body.jobId as string;
    const ranking = await rankingOf(h, token, sessionJobId);
    const sessionEvaluationId = ranking.entries[0]?.evaluationId as string;

    // Canonical ids, asked of the session surface: not found.
    const canonicalEvaluationId = h.canonicalEvaluations.get('demo-001') as string;
    for (const p of [
      `/api/demo/session/evaluations/${canonicalEvaluationId}`,
      `/api/demo/session/evaluations/${canonicalEvaluationId}/audit`,
      `/api/demo/session/jobs/${h.canonicalJobId}`,
      `/api/demo/session/jobs/${h.canonicalJobId}/ranking`,
    ]) {
      assert.equal((await h.call('GET', p, { token })).status, 404, p);
    }

    // The ids the two worlds use are different — a visitor's is never a canonical row.
    assert.notEqual(sessionEvaluationId, canonicalEvaluationId);
    assert.deepEqual(
      await h.ctx.db.query('SELECT id FROM evaluations WHERE id = ?', [sessionEvaluationId]),
      [],
      'a session evaluation id exists in the canonical database',
    );
    assert.deepEqual(await h.ctx.db.query('SELECT id FROM jobs WHERE id = ?', [sessionJobId]), []);

    // And the reverse: the canonical surface does not know a session's ids, even
    // with the demo window open and a demo cookie presented.
    const op = await h.operator();
    const canonicalRead = await fetch(`${h.base}/api/evaluations/${sessionEvaluationId}`, {
      headers: { cookie: `${op.cookie}; ${DEMO_SESSION_COOKIE}=${token}` },
    });
    assert.equal(canonicalRead.status, 404);
  }, { overrides: { demoPublicReadonly: true } });
});

test('the canonical read surface serves canonical data to a visitor with a demo cookie, never the session\'s', async () => {
  await withHarness(
    async (h) => {
      const { token } = await h.start();
      const jobs = await h.call<{ jobs: Array<{ id: string }> }>('GET', '/api/jobs', { token });
      assert.equal(jobs.status, 200);
      assert.deepEqual(jobs.body.jobs.map((j) => j.id), [h.canonicalJobId], 'the cookie changed what the canonical route serves');
    },
    { overrides: { demoPublicReadonly: true } },
  );
});

// ================================== recruiter decision route stays protected

test('a demo session cannot be used to call the recruiter decision route', async () => {
  await withHarness(async (h) => {
    const { token, reply } = await h.start();
    const ranking = await rankingOf(h, token, reply.body.jobId as string);
    const sessionEvaluationId = ranking.entries[0]?.evaluationId as string;
    const canonicalId = h.canonicalEvaluations.get('demo-002') as string;
    const before = await canonicalSnapshot(h.ctx);
    const payload = { outcome: 'reject', reason: 'An anonymous visitor must not be able to record this.' };

    const attempts: Array<[string, Reply]> = [
      ['demo cookie, canonical id', await h.call('POST', `/api/evaluations/${canonicalId}/decision`, { token, body: payload })],
      ['demo cookie, session id', await h.call('POST', `/api/evaluations/${sessionEvaluationId}/decision`, { token, body: payload })],
      ['no cookie at all', await h.call('POST', `/api/evaluations/${canonicalId}/decision`, { body: payload })],
      // The demo token presented as an operator session, with and without a CSRF header.
      ['demo token as operator cookie', await h.call('POST', `/api/evaluations/${canonicalId}/decision`, { rawCookie: `${SESSION_COOKIE}=${token}`, body: payload })],
      ['demo token as operator cookie + csrf cookie', await h.call('POST', `/api/evaluations/${canonicalId}/decision`, { rawCookie: `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=${token}`, body: payload })],
    ];
    for (const [label, result] of attempts) {
      assert.equal(result.status, 401, `${label} was not refused`);
    }

    // The same, with the CSRF header forged to match.
    const forged = await fetch(`${h.base}/api/evaluations/${canonicalId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${token}`, [CSRF_HEADER]: token },
      body: JSON.stringify(payload),
    });
    assert.equal(forged.status, 401);

    // The demo has its own decision route (demo-decision.test.ts). Nothing else under
    // the demo namespace is one: a look-alike path is not served, and falls to the gate.
    assert.equal((await h.call('POST', `/api/demo/evaluations/${sessionEvaluationId}/decision`, { token, body: payload })).status, 401);

    assert.equal(await canonicalSnapshot(h.ctx), before, 'a decision row appeared');
  });
});

test('the recruiter flow is unchanged: sign-in works, and the decision route still needs a session AND a CSRF token', async () => {
  await withHarness(async (h) => {
    const { token } = await h.start();
    const op = await h.operator();
    const target = h.canonicalEvaluations.get('demo-002') as string;
    const body = JSON.stringify({ outcome: 'hold', reason: 'Needs a second look from the team.' });
    const headers = { 'content-type': 'application/json', cookie: `${op.cookie}; ${DEMO_SESSION_COOKIE}=${token}` };

    // Signed in, but no CSRF header: refused, demo cookie or not.
    const noCsrf = await fetch(`${h.base}/api/evaluations/${target}/decision`, { method: 'POST', headers, body });
    assert.equal(noCsrf.status, 403);

    // With it, the operator records a decision on the canonical record — the
    // demo cookie in the jar changes nothing about who may do that.
    const ok = await fetch(`${h.base}/api/evaluations/${target}/decision`, {
      method: 'POST',
      headers: { ...headers, [CSRF_HEADER]: op.csrf },
      body,
    });
    assert.equal(ok.status, 201);

    // That decision is canonical only: the visitor's session does not hold it.
    const sandbox = h.store.resolve(token);
    assert.ok(sandbox);
    assert.equal((await sandbox.repos.decisions.getForEvaluation(target)) ?? null, null);
  });
});

// ============================================== no credential or real data out

test('no response from the session surface carries a key, a credential, a protected detail or a real record', async () => {
  await withHarness(async (h) => {
    const { token, reply } = await h.start();
    const jobId = reply.body.jobId as string;
    const ranking = await rankingOf(h, token, jobId);
    const forbidden = [
      SECRET_API_KEY,
      PASSWORD,
      'scrypt$',
      'OPERATOR_PASSWORD_HASH',
      'ANTHROPIC',
      FIXTURE_NAME,
      'real-0001',
      ...demoPersonalDetails(),
    ];

    const replies: Reply[] = [
      reply,
      await h.call('GET', '/api/demo/session', { token }),
      await h.call('GET', '/api/demo/session/jobs', { token }),
      await h.call('GET', `/api/demo/session/jobs/${jobId}`, { token }),
      await h.call('GET', `/api/demo/session/jobs/${jobId}/ranking`, { token }),
      await h.call('POST', '/api/demo/session/reset', { token }),
      await h.call('GET', '/api/demo/session/jobs', {}),
      await h.call('POST', '/api/demo/session/reset', {}),
    ];
    for (const entry of ranking.entries) {
      replies.push(await h.call('GET', `/api/demo/session/evaluations/${entry.evaluationId}`, { token }));
      replies.push(await h.call('GET', `/api/demo/session/evaluations/${entry.evaluationId}/audit`, { token }));
      replies.push(await h.call('POST', `/api/demo/session/scenarios/${entry.reference}/run`, { token }));
    }

    for (const r of replies) {
      const text = JSON.stringify(r.body) + JSON.stringify([...r.headers.entries()].filter(([k]) => k !== 'set-cookie'));
      for (const needle of forbidden) {
        assert.ok(!text.includes(needle), `a response contained ${JSON.stringify(needle.slice(0, 24))}`);
      }
      assert.ok(!text.includes(token), 'a response echoed the session token');
    }
  });
});

test('a visitor\'s session never contains the canonical database\'s extra records', async () => {
  await withHarness(async (h) => {
    const { token } = await h.start();
    const sandbox = h.store.resolve(token);
    assert.ok(sandbox);

    const candidates = await sandbox.repos.candidates.list({ limit: 500 });
    assert.deepEqual(
      candidates.map((c) => c.reference).sort(),
      DEMO_CANDIDATES.map((c) => c.reference).sort(),
    );
    assert.equal(await sandbox.repos.jobs.count(), 1);
  });
});

// ======================================================== 8. the public allow-list

test('the existing public GET allow-list is exactly what it was', () => {
  assert.deepEqual(
    PUBLIC_DEMO_READS.map((r) => r.source),
    [
      String.raw`^\/jobs$`,
      String.raw`^\/jobs\/[^/]+$`,
      String.raw`^\/jobs\/[^/]+\/ranking$`,
      String.raw`^\/evaluations\/[^/]+$`,
      String.raw`^\/evaluations\/[^/]+\/audit$`,
    ],
  );

  // The session surface is not on it, under any method — it is served by its
  // own router, ahead of the gate, and never needed to be.
  for (const p of ['/demo/session', '/demo/session/jobs', '/demo/session/jobs/x/ranking', '/demo/session/evaluations/x', '/demo/session/reset']) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      assert.equal(isPublicDemoRead(method, p), false, `${method} ${p} joined the allow-list`);
    }
  }
});

test('with the demo window shut, canonical reads are still refused — a demo session does not open them', async () => {
  await withHarness(async (h) => {
    const { token } = await h.start();
    for (const p of ['/api/jobs', `/api/jobs/${h.canonicalJobId}`, `/api/jobs/${h.canonicalJobId}/ranking`, `/api/evaluations/${h.canonicalEvaluations.get('demo-001')}`]) {
      assert.equal((await h.call('GET', p, { token })).status, 401, p);
    }
  });
});

test('routes under the session prefix that do not exist fall through to the gate, not to a handler', async () => {
  await withHarness(async (h) => {
    const { token } = await h.start();
    for (const [method, p] of [
      ['GET', '/api/demo/session/users'],
      ['POST', '/api/demo/session/jobs'],
      ['PUT', '/api/demo/session'],
      ['GET', '/api/demo/session/evaluations/x/decision'],
      ['POST', '/api/demo/session/anything'],
    ] as const) {
      const reply = await h.call(method, p, { token });
      assert.ok([401, 404, 405].includes(reply.status), `${method} ${p} answered ${reply.status}`);
      assert.notEqual(reply.status, 200);
    }
  });
});

// =============================================================== 6. rate limiting

test('the session surface has its own rate-limit classes, and reads stay unlimited', () => {
  assert.equal(classify('POST', '/demo/session'), 'demoSession');
  assert.equal(classify('POST', '/demo/session/reset'), 'demoSession');
  assert.equal(classify('DELETE', '/demo/session'), 'demoSession');
  assert.equal(classify('POST', '/demo/session/scenarios/demo-001/run'), 'demoRun');
  assert.equal(classify('POST', '/demo/scenarios/demo-001/run'), 'demoRun', 'the shared sandbox\'s class is unchanged');

  assert.equal(classify('GET', '/demo/session'), null);
  assert.equal(classify('GET', '/demo/session/jobs'), null);
  assert.equal(classify('GET', '/demo/session/evaluations/x'), null);
  assert.notEqual(classify('POST', '/demo/session'), classify('POST', '/evaluations/e1/decision'));
  assert.ok(RATE_LIMITS.demoSession.limit <= 10, 'starting a session must stay a conservative budget');
});

test('starting sessions is rate-limited, and the refusal carries Retry-After', async () => {
  const tiny = rateLimit({ limits: { ...RATE_LIMITS, demoSession: { limit: 2, windowMs: 60_000 } } });
  await withHarness(
    async (h) => {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await h.call('POST', '/api/demo/session')).status);
      assert.deepEqual(statuses, [201, 201, 429, 429]);
      assert.equal(h.store.size, 2, 'a refused request must not have built a session');

      const refused = await h.call('POST', '/api/demo/session');
      assert.ok(refused.headers.get('retry-after'));

      // Resetting and ending share the budget; reading does not.
      assert.equal((await h.call('POST', '/api/demo/session/reset')).status, 429);
      assert.equal((await h.call('GET', '/api/demo/session')).status, 200);
    },
    { rateLimiter: tiny },
  );
});

test('scenario runs in a session are rate-limited as demo runs, apart from session starts', async () => {
  const tiny = rateLimit({
    limits: { ...RATE_LIMITS, demoSession: { limit: 100, windowMs: 60_000 }, demoRun: { limit: 2, windowMs: 60_000 } },
  });
  await withHarness(
    async (h) => {
      const { token } = await h.start();
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) statuses.push((await h.call('POST', '/api/demo/session/scenarios/demo-001/run', { token })).status);
      assert.deepEqual(statuses, [200, 200, 429, 429]);
      assert.equal((await h.call('POST', '/api/demo/session', { token })).status, 200, 'starts have their own budget');
    },
    { rateLimiter: tiny },
  );
});

// ================================================================ the store itself

test('a session lapses only after it goes unused, and use slides the window', async () => {
  let nowMs = Date.parse('2026-06-01T00:00:00.000Z');
  const store = createDemoSessionStore({
    migrationsDir: MIGRATIONS_DIR,
    clock: { nowIso: () => new Date(nowMs).toISOString() },
    ttlMs: 60_000,
  });
  try {
    const { token } = await store.create();

    nowMs += 50_000;
    assert.ok(store.resolve(token), 'still live before the window closes');
    nowMs += 50_000; // 100s since creation, but only 50s since last use
    assert.ok(store.resolve(token), 'use must slide the window');
    nowMs += 60_000;
    assert.equal(store.resolve(token), null, 'lapsed after a full idle window');
    assert.equal(store.size, 0);
  } finally {
    await store.close();
  }
});

test('at capacity the least recently used session is evicted, never a recently used one', async () => {
  let nowMs = Date.parse('2026-06-01T00:00:00.000Z');
  const store = createDemoSessionStore({
    migrationsDir: MIGRATIONS_DIR,
    clock: { nowIso: () => new Date(nowMs).toISOString() },
    maxSessions: 2,
  });
  try {
    const first = await store.create();
    nowMs += 1000;
    const second = await store.create();
    nowMs += 1000;
    store.resolve(first.token); // first is now the more recently used
    nowMs += 1000;
    const third = await store.create();

    assert.equal(store.size, 2, 'the capacity was exceeded');
    assert.ok(store.resolve(first.token), 'a recently used session was evicted');
    assert.equal(store.resolve(second.token), null, 'the least recently used session survived');
    assert.ok(store.resolve(third.token));
  } finally {
    await store.close();
  }
});

test('isWellFormedDemoToken accepts only 43 base64url characters', () => {
  assert.equal(isWellFormedDemoToken('A'.repeat(43)), true);
  assert.equal(isWellFormedDemoToken('a-_9'.repeat(10) + 'abc'), true);
  for (const bad of ['', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}+`, `${'A'.repeat(42)}=`, null, undefined, 43, {}, ['A'.repeat(43)]]) {
    assert.equal(isWellFormedDemoToken(bad), false, `${JSON.stringify(bad)} was accepted`);
  }
});

test('resetting an unknown or malformed token does nothing and builds nothing', async () => {
  const store = createDemoSessionStore({ migrationsDir: MIGRATIONS_DIR });
  try {
    for (const bad of [null, undefined, '', 'x', 'A'.repeat(43), 42, {}]) {
      assert.equal(await store.reset(bad), null);
      assert.equal(await store.end(bad), false);
    }
    assert.equal(store.size, 0);
  } finally {
    await store.close();
  }
});

test('the fixed clock the sessions use never reaches expiry', async () => {
  // Session data is stamped by a fixed clock; expiry runs on the store's own.
  // If the two were the same clock, a session would never expire — or always.
  const store = createDemoSessionStore({ migrationsDir: MIGRATIONS_DIR, clock: createFixedClock('2030-01-01T00:00:00.000Z', 0) });
  try {
    const { token, sandbox } = await store.create();
    assert.equal(sandbox.expiresAt.slice(0, 4), '2030', 'expiry follows the store clock');
    const evaluation = await sandbox.repos.evaluations.getById(sandbox.evaluationFor('demo-001'));
    assert.equal(evaluation?.createdAt.slice(0, 4), '2026', 'data timestamps follow the sandbox clock');
    assert.ok(store.resolve(token));
  } finally {
    await store.close();
  }
});
