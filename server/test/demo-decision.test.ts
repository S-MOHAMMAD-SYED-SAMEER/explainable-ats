import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rateLimit, RATE_LIMITS, classify } from '../src/http/rateLimit.ts';
import { CSRF_HEADER } from '../src/auth/csrf.ts';
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/auth/cookies.ts';
import { DEMO_CANDIDATES } from '../src/demo/dataset.ts';
import { DEMO_SESSION_COOKIE } from '../src/routes/demoSession.ts';
import { DEMO_ACTOR } from '../src/handlers/demoSession.ts';
import { DECISION_OUTCOMES } from '../src/domain/ats.ts';
import {
  PASSWORD,
  SECRET_API_KEY,
  canonicalSnapshot,
  flip,
  rankingOf,
  withHarness,
  type EvaluationBody,
  type Harness,
  type Json,
  type RankingBody,
  type Reply,
} from './demoHarness.ts';

// A public visitor's decision on a demo candidate (Phase 3C.2).
//
// WHAT THIS FILE IS DEFENDING
//
// A visitor can make a recruiter-style decision, and that decision exists in
// their private sandbox and nowhere else: not in another visitor's, not in the
// canonical database, not reachable through the recruiter's decision route, and
// not creatable with anything but the demo cookie. The recruiter route is
// asserted unchanged alongside, because the way to break this feature is to make
// the two routes share a credential, an id space or a code path that decides who
// may write.
//
// Everything runs over real HTTP against a canonical database holding the real
// seeded dataset and a recruiter's own decision.

const REASON = 'Synthetic demo reason: strong evidence for both essentials.';
const PAYLOAD = { outcome: 'shortlist', reason: REASON };

type DecisionBody = {
  decision: { outcome: string; reason: string; decidedBy: string; decidedAt: string };
  evaluation: EvaluationBody;
};
type AuditBody = {
  events: Array<{ eventType: string; actor: string; actorId: string | null; summary: string; payload: Json; createdAt: string }>;
};
type ErrorBody = { error: { code: string; message: string; details?: { problems?: string[] } } };

type Visitor = { token: string; jobId: string };

async function visitor(h: Harness): Promise<Visitor> {
  const { token, reply } = await h.start();
  return { token, jobId: reply.body.jobId as string };
}

/** The evaluation id for a demo candidate. Ids are the same in every session; where they resolve is not. */
async function evaluationOf(h: Harness, v: Visitor, reference: string): Promise<string> {
  const ranking = await rankingOf(h, v.token, v.jobId);
  const id = ranking.entries.find((e) => e.reference === reference)?.evaluationId;
  assert.ok(id, `${reference} has no evaluation`);
  return id;
}

const decide = (h: Harness, evaluationId: string, options: { token?: string | null; rawCookie?: string; body?: unknown }) =>
  h.call<DecisionBody & ErrorBody>('POST', `/api/demo/session/evaluations/${evaluationId}/decision`, {
    ...options,
    body: 'body' in options ? options.body : PAYLOAD,
  });

const detail = (h: Harness, v: Visitor, evaluationId: string) =>
  h.call<EvaluationBody>('GET', `/api/demo/session/evaluations/${evaluationId}`, { token: v.token });

const audit = (h: Harness, v: Visitor, evaluationId: string) =>
  h.call<AuditBody>('GET', `/api/demo/session/evaluations/${evaluationId}/audit`, { token: v.token });

/** Everything a visitor can read about one candidate, as one comparable string. */
async function whatTheyCanSee(h: Harness, v: Visitor, evaluationId: string): Promise<string> {
  return JSON.stringify([
    (await detail(h, v, evaluationId)).body,
    (await audit(h, v, evaluationId)).body,
    await rankingOf(h, v.token, v.jobId),
  ]);
}

// =========================================================== 1. a visitor decides

test('visitor A decides on A\'s candidate, and the response is safe and structured', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');

    const reply = await decide(h, rowan, { token: a.token });
    assert.equal(reply.status, 201);

    // A fixed demo actor — and nothing in the decision that is an internal id.
    assert.deepEqual(Object.keys(reply.body.decision).sort(), ['decidedAt', 'decidedBy', 'outcome', 'reason']);
    assert.equal(reply.body.decision.outcome, 'shortlist');
    assert.equal(reply.body.decision.reason, REASON);
    assert.equal(reply.body.decision.decidedBy, DEMO_ACTOR);
    assert.equal(DEMO_ACTOR, 'demo-visitor');

    // The same state the server now holds, as the screen will render it.
    assert.deepEqual(reply.body.evaluation.decision, reply.body.decision);

    const seen = await detail(h, a, rowan);
    assert.deepEqual(seen.body.decision, reply.body.decision, 'A cannot see their own decision');
  });
});

test('every supported outcome can be recorded, and no other', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const references = ['demo-001', 'demo-002', 'demo-003'];
    assert.equal(DECISION_OUTCOMES.length, references.length, 'precondition: one candidate per outcome');

    for (const [index, outcome] of DECISION_OUTCOMES.entries()) {
      const id = await evaluationOf(h, a, references[index] as string);
      const reply = await decide(h, id, { token: a.token, body: { outcome, reason: REASON } });
      assert.equal(reply.status, 201, outcome);
      assert.equal(reply.body.decision.outcome, outcome);
    }
  });
});

test('a decision changes nothing about the score, the verdicts or the ranking', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const before = await rankingOf(h, a.token, a.jobId);
    const rowan = await evaluationOf(h, a, 'demo-001');
    const detailBefore = (await detail(h, a, rowan)).body;

    assert.equal((await decide(h, rowan, { token: a.token, body: { outcome: 'reject', reason: REASON } })).status, 201);

    assert.deepEqual(await rankingOf(h, a.token, a.jobId), before, 'a decision moved the ranking');
    const detailAfter = (await detail(h, a, rowan)).body;
    assert.deepEqual({ ...detailAfter, decision: null }, { ...detailBefore, decision: null });
  });
});

test('the decision persists within the session: reading again, any number of times, returns it', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');
    const recorded = await decide(h, rowan, { token: a.token });

    for (let i = 0; i < 3; i++) {
      assert.deepEqual((await detail(h, a, rowan)).body.decision, recorded.body.decision);
      // Resuming the session — what a reload does — finds the same state.
      assert.equal((await h.call('POST', '/api/demo/session', { token: a.token })).status, 200);
    }
  });
});

// ============================================================== 2. isolation

test('visitor B cannot decide on A\'s evaluation: B\'s own cookie writes B\'s sandbox, a forged one nothing', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const b = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');
    assert.equal(await evaluationOf(h, b, 'demo-001'), rowan, 'precondition: the two sessions use the same ids');

    assert.equal((await decide(h, rowan, { token: a.token })).status, 201);
    const aSees = await whatTheyCanSee(h, a, rowan);

    // B names A's evaluation id. With B's cookie that is B's own record...
    const asB = await decide(h, rowan, { token: b.token, body: { outcome: 'reject', reason: 'B deciding in B\'s own copy.' } });
    assert.equal(asB.status, 201);
    assert.equal(asB.body.decision.outcome, 'reject');
    // ...and A's is exactly what it was.
    assert.equal(await whatTheyCanSee(h, a, rowan), aSees, 'B\'s decision reached A\'s sandbox');

    // With A's cookie guessed or altered, B reaches nothing at all.
    const c = await visitor(h);
    for (const token of [flip(a.token), flip(b.token), 'A'.repeat(43)]) {
      assert.equal((await decide(h, await evaluationOf(h, c, 'demo-002'), { token })).status, 401);
    }
    assert.equal(await whatTheyCanSee(h, a, rowan), aSees);
  });
});

test('visitor B\'s evaluation stays undecided until B decides', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const b = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');

    await decide(h, rowan, { token: a.token });
    assert.equal((await detail(h, b, rowan)).body.decision, null, 'B saw A\'s decision');
    assert.equal((await detail(h, a, rowan)).body.decision?.reason, REASON);

    const bReason = 'Synthetic reason written by visitor B only.';
    await decide(h, rowan, { token: b.token, body: { outcome: 'hold', reason: bReason } });
    assert.equal((await detail(h, b, rowan)).body.decision?.reason, bReason);
    assert.equal((await detail(h, a, rowan)).body.decision?.reason, REASON, 'B\'s decision replaced A\'s');
    assert.equal((await detail(h, a, rowan)).body.decision?.outcome, 'shortlist');
  });
});

test('another visitor\'s sandbox is byte-for-byte unchanged by a decision', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const b = await visitor(h);
    const references = DEMO_CANDIDATES.filter((c) => c.assess === 'scored').map((c) => c.reference);
    const ids = await Promise.all(references.map((r) => evaluationOf(h, b, r)));

    const before = await Promise.all(ids.map((id) => whatTheyCanSee(h, b, id)));
    for (const id of ids) assert.equal((await decide(h, id, { token: a.token })).status, 201);
    const after = await Promise.all(ids.map((id) => whatTheyCanSee(h, b, id)));

    assert.deepEqual(after, before, 'a decision by A changed what B can see');
  });
});

// ====================================================== 4/5. the two id spaces

test('a canonical evaluation id cannot be decided through the demo route', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const before = await canonicalSnapshot(h.ctx);

    for (const reference of ['demo-001', 'demo-002', 'demo-003', 'demo-004']) {
      const canonicalId = h.canonicalEvaluations.get(reference) as string;
      const reply = await decide(h, canonicalId, { token: a.token });
      assert.equal(reply.status, 404, `canonical ${reference} was reachable through the demo route`);
      assert.equal(reply.body.error.code, 'NOT_FOUND');
    }

    assert.equal(await canonicalSnapshot(h.ctx), before);
    // And nothing was written to A's sandbox either: the id simply is not there.
    const sandbox = h.store.resolve(a.token);
    assert.ok(sandbox);
    for (const id of h.canonicalEvaluations.values()) assert.equal(await sandbox.repos.decisions.getForEvaluation(id), null);
  });
});

test('a demo evaluation id cannot be decided through the canonical recruiter route', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const demoId = await evaluationOf(h, a, 'demo-002');
    const op = await h.operator();
    const canonicalBefore = await canonicalSnapshot(h.ctx);
    const aBefore = await whatTheyCanSee(h, a, demoId);

    // On the demo the recruiter route does not exist at all.
    const onDemo = await h.call('POST', `/api/evaluations/${demoId}/decision`, { token: a.token, body: PAYLOAD });
    assert.equal(onDemo.status, 404);

    // On the real application, anonymously, with the demo cookie: refused outright.
    const anonymous = await h.callApp('POST', `/api/evaluations/${demoId}/decision`, { token: a.token, body: PAYLOAD });
    assert.equal(anonymous.status, 401);

    // Even a fully authenticated operator with a valid CSRF token cannot: the id is
    // not a canonical evaluation, so there is nothing for the recruiter route to find.
    const asOperator = await fetch(`${h.appBase}/api/evaluations/${demoId}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${op.cookie}; ${DEMO_SESSION_COOKIE}=${a.token}`, [CSRF_HEADER]: op.csrf },
      body: JSON.stringify(PAYLOAD),
    });
    assert.equal(asOperator.status, 404);

    assert.equal(await canonicalSnapshot(h.ctx), canonicalBefore);
    assert.equal(await whatTheyCanSee(h, a, demoId), aBefore, 'the canonical route reached the demo sandbox');
  });
});

// ================================================= 6/7. the cookie is the only credential

test('with no demo cookie, a decision is refused — and nothing else stands in for the cookie', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');
    const url = `${h.base}/api/demo/session/evaluations/${rowan}/decision`;
    const json = { 'content-type': 'application/json' };
    const body = JSON.stringify(PAYLOAD);

    assert.equal((await decide(h, rowan, {})).status, 401, 'no cookie');

    const attempts: Array<[string, Promise<Response>]> = [
      ['token in the query string', fetch(`${url}?token=${a.token}&${DEMO_SESSION_COOKIE}=${a.token}`, { method: 'POST', headers: json, body })],
      ['token in a custom header', fetch(url, { method: 'POST', headers: { ...json, 'x-demo-session': a.token }, body })],
      ['token as a bearer credential', fetch(url, { method: 'POST', headers: { ...json, authorization: `Bearer ${a.token}` }, body })],
      ['token in the body', fetch(url, { method: 'POST', headers: json, body: JSON.stringify({ ...PAYLOAD, token: a.token, session: a.token, [DEMO_SESSION_COOKIE]: a.token }) })],
    ];
    for (const [label, attempt] of attempts) assert.equal((await attempt).status, 401, label);

    assert.equal((await detail(h, a, rowan)).body.decision, null, 'a refused request recorded a decision');
  });
});

test('a forged, altered or malformed demo cookie is refused with the same 401', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');
    const refusals: Reply<ErrorBody>[] = [];

    for (const token of [flip(a.token), a.token.slice(0, 42), `${a.token}A`, 'A'.repeat(43), 'garbage', '%', '../x', 'A'.repeat(5000)]) {
      const reply = await decide(h, rowan, { rawCookie: `${DEMO_SESSION_COOKIE}=${token}` });
      assert.equal(reply.status, 401, JSON.stringify(token.slice(0, 20)));
      refusals.push(reply as Reply<ErrorBody>);
    }
    assert.ok(refusals.every((r) => JSON.stringify(r.body) === JSON.stringify(refusals[0]?.body)), 'refusals differ, which tells a guesser something');
    assert.equal((await detail(h, a, rowan)).body.decision, null);
  });
});

test('the operator\'s session is not a demo identity', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');
    const op = await h.operator();

    // Signed in as the operator, with a valid CSRF token, but no demo cookie.
    const reply = await fetch(`${h.base}/api/demo/session/evaluations/${rowan}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: op.cookie, [CSRF_HEADER]: op.csrf },
      body: JSON.stringify(PAYLOAD),
    });
    assert.equal(reply.status, 401);

    // The operator's session token offered as the demo cookie names nothing.
    const sessionToken = new RegExp(`${SESSION_COOKIE}=([^;]+)`).exec(op.cookie)?.[1] ?? '';
    assert.notEqual(sessionToken, '');
    assert.equal((await decide(h, rowan, { rawCookie: `${DEMO_SESSION_COOKIE}=${sessionToken}` })).status, 401);
    assert.equal((await detail(h, a, rowan)).body.decision, null);
  });
});

// ============================================ 8/9. the recruiter route is unchanged

test('a demo session cannot satisfy recruiter authentication on the recruiter decision route', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const target = h.canonicalEvaluations.get('demo-002') as string;
    const before = await canonicalSnapshot(h.ctx);

    const attempts: Array<[string, Reply]> = [
      ['demo cookie only', await h.callApp('POST', `/api/evaluations/${target}/decision`, { token: a.token, body: PAYLOAD })],
      ['demo token as the operator cookie', await h.callApp('POST', `/api/evaluations/${target}/decision`, { rawCookie: `${SESSION_COOKIE}=${a.token}`, body: PAYLOAD })],
      ['demo token as both operator cookies', await h.callApp('POST', `/api/evaluations/${target}/decision`, { rawCookie: `${SESSION_COOKIE}=${a.token}; ${CSRF_COOKIE}=${a.token}`, body: PAYLOAD })],
    ];
    for (const [label, reply] of attempts) assert.equal(reply.status, 401, label);

    // The demo has no such route to offer, whatever is presented.
    assert.equal((await h.call('POST', `/api/evaluations/${target}/decision`, { token: a.token, body: PAYLOAD })).status, 404);

    const withCsrfHeader = await fetch(`${h.appBase}/api/evaluations/${target}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${SESSION_COOKIE}=${a.token}; ${DEMO_SESSION_COOKIE}=${a.token}`, [CSRF_HEADER]: a.token },
      body: JSON.stringify(PAYLOAD),
    });
    assert.equal(withCsrfHeader.status, 401);

    assert.equal(await canonicalSnapshot(h.ctx), before);
  });
});

test('a demo session cannot satisfy the recruiter\'s CSRF check', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const op = await h.operator();
    const target = h.canonicalEvaluations.get('demo-002') as string;
    const before = await canonicalSnapshot(h.ctx);
    const send = (headers: Record<string, string>) =>
      fetch(`${h.appBase}/api/evaluations/${target}/decision`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ outcome: 'hold', reason: 'Attempt with someone else\'s CSRF token.' }),
      });

    // A real operator session, with the demo token in the CSRF slot, or none.
    assert.equal((await send({ cookie: op.cookie, [CSRF_HEADER]: a.token })).status, 403);
    assert.equal((await send({ cookie: `${op.cookie}; ${DEMO_SESSION_COOKIE}=${a.token}` })).status, 403);

    assert.equal(await canonicalSnapshot(h.ctx), before);

    // The route still works for the operator who does it properly — the demo
    // cookie in the jar changes nothing about who may do that.
    const proper = await send({ cookie: `${op.cookie}; ${DEMO_SESSION_COOKIE}=${a.token}`, [CSRF_HEADER]: op.csrf });
    assert.equal(proper.status, 201);
    assert.equal((await h.store.resolve(a.token)?.repos.decisions.getForEvaluation(target)) ?? null, null, 'the recruiter\'s decision reached a demo sandbox');
  });
});

test('the recruiter route and the demo route share no credential and no actor', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const strip = (rel: string) => fs.readFileSync(path.join(here, rel), 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const recruiter = strip('../src/routes/recruiter.ts');
  const demo = strip('../src/routes/demoSession.ts');
  const demoHandler = strip('../src/handlers/demoSession.ts');

  // The recruiter route is as it was: its identity comes from the session.
  assert.match(recruiter, /'\/evaluations\/:evaluationId\/decision'/);
  assert.match(recruiter, /operatorOf\(req\)/);
  assert.doesNotMatch(recruiter, /demo-visitor|DEMO_ACTOR|ats_demo|demoSession/);

  // The demo route never asks who the operator is, and never reads a session.
  for (const [name, source] of [['route', demo], ['handler', demoHandler]] as const) {
    assert.doesNotMatch(source, /operatorOf|req\.operator|req\.session|attachSession|requireSession/, `the demo ${name} reaches for the operator`);
  }
  // The actor is a constant, not something read from the request.
  assert.match(demoHandler, /DEMO_ACTOR = 'demo-visitor'/);
  assert.match(demoHandler, /handleDecision\(\{ repos: sandbox\.repos \}, evaluationId, body, DEMO_ACTOR\)/);
});

// ================================================================ 10/11. validation

test('an invalid outcome is a safe validation error and records nothing', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');

    for (const outcome of ['advance', 'SHORTLIST', 'shortlist ', '', ' ', null, 5, true, {}, ['shortlist'], '<script>alert(1)</script>', 'x'.repeat(5000)]) {
      const reply = await decide(h, rowan, { token: a.token, body: { outcome, reason: REASON } });
      assert.equal(reply.status, 400, JSON.stringify(outcome)?.slice(0, 30));
      assert.equal(reply.body.error.code, 'VALIDATION_ERROR');
      const text = JSON.stringify(reply.body);
      assert.ok(!/at .*\.ts|node_modules|stack|sqlite|ENOENT/i.test(text), 'the error leaked an internal detail');
      assert.ok(!text.includes('<script>') && !text.includes('x'.repeat(100)), 'the error echoed the input back');
    }
    assert.equal((await reply(h, a, rowan)).decision, null);

    // A missing body and a non-object body are the same kind of refusal.
    for (const body of [{}, null, 'shortlist', 42, []]) {
      assert.equal((await decide(h, rowan, { token: a.token, body })).status, 400, JSON.stringify(body));
    }
    assert.equal((await reply(h, a, rowan)).decision, null);
  });

  async function reply(h: Harness, v: Visitor, id: string) {
    return (await detail(h, v, id)).body;
  }
});

test('a missing or too-short reason is a safe validation error and records nothing', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');

    const bad: Json[] = [
      { outcome: 'shortlist' },
      { outcome: 'shortlist', reason: '' },
      { outcome: 'shortlist', reason: '          ' },
      { outcome: 'shortlist', reason: 'too short' },
      { outcome: 'shortlist', reason: '   nine chr   '.slice(0, 11) },
      { outcome: 'shortlist', reason: null },
      { outcome: 'shortlist', reason: 12345678901234 },
      { outcome: 'shortlist', reason: ['a reason that is long enough'] },
      { outcome: 'shortlist', reason: 'x'.repeat(2001) },
    ];
    for (const body of bad) {
      const reply = await decide(h, rowan, { token: a.token, body });
      assert.equal(reply.status, 400, JSON.stringify(body).slice(0, 60));
      assert.equal(reply.body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal((await detail(h, a, rowan)).body.decision, null);

    // The same rule the recruiter route applies: ten characters is enough, trimmed.
    const exactly = await decide(h, rowan, { token: a.token, body: { outcome: 'hold', reason: '  1234567890  ' } });
    assert.equal(exactly.status, 201);
    assert.equal(exactly.body.decision.reason, '1234567890');
  });
});

test('the body cannot choose who made the decision or when', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');

    const reply = await decide(h, rowan, {
      token: a.token,
      body: { ...PAYLOAD, decidedBy: 'operator', decidedAt: '1999-01-01T00:00:00.000Z', evaluationId: 'something-else', actor: 'operator' },
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.decision.decidedBy, DEMO_ACTOR);
    assert.notEqual(reply.body.decision.decidedAt.slice(0, 4), '1999');
  });
});

// ============================================================== state rules

test('a candidate can be decided on once; a second attempt says how to start over and changes nothing', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');

    const first = await decide(h, rowan, { token: a.token });
    assert.equal(first.status, 201);

    const second = await decide(h, rowan, { token: a.token, body: { outcome: 'reject', reason: 'A change of mind that must not stick.' } });
    assert.equal(second.status, 409);
    assert.equal(second.body.error.code, 'CONFLICT');
    assert.match(second.body.error.message, /Reset demo/);
    assert.doesNotMatch(second.body.error.message, /re-assess/i, 'the message points at something a visitor cannot do');

    assert.deepEqual((await detail(h, a, rowan)).body.decision, first.body.decision);
  });
});

test('two simultaneous decisions on one candidate record exactly one, and neither is a server error', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');

    const replies = await Promise.all(
      Array.from({ length: 6 }, (_, i) => decide(h, rowan, { token: a.token, body: { outcome: 'hold', reason: `Concurrent synthetic reason number ${i}.` } })),
    );
    const statuses = replies.map((r) => r.status).sort();
    assert.deepEqual(statuses, [201, 409, 409, 409, 409, 409]);
    assert.ok(replies.every((r) => r.status !== 500));

    const sandbox = h.store.resolve(a.token);
    const rows = await sandbox?.repos.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM recruiter_decisions');
    assert.equal(Number(rows?.[0]?.n), 1);
  });
});

test('a candidate whose assessment never ran cannot be decided on', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const toby = await evaluationOf(h, a, 'demo-005');

    const reply = await decide(h, toby, { token: a.token });
    assert.equal(reply.status, 409);
    assert.equal(reply.body.error.code, 'INVALID_STATE');
    assert.equal((await detail(h, a, toby)).body.decision, null);
  });
});

test('an unknown or malformed evaluation id is a clean refusal', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    for (const id of ['nope', '00000000-0000-4000-8000-000000000000', '..%2F..%2Fx', 'x'.repeat(200)]) {
      const reply = await decide(h, id, { token: a.token });
      assert.ok([400, 404].includes(reply.status), `${id.slice(0, 20)} answered ${reply.status}`);
    }
  });
});

// ============================================================= 12. canonical data

test('the canonical database is byte-for-byte unchanged by any demo decision, accepted or refused', async () => {
  await withHarness(async (h) => {
    const before = await canonicalSnapshot(h.ctx);

    const a = await visitor(h);
    const b = await visitor(h);
    for (const who of [a, b]) {
      for (const reference of ['demo-001', 'demo-002', 'demo-003', 'demo-004']) {
        const id = await evaluationOf(h, who, reference);
        await decide(h, id, { token: who.token });
        await decide(h, id, { token: who.token, body: { outcome: 'nope', reason: 'x' } });
        await decide(h, id, { token: who.token });
      }
    }
    await decide(h, h.canonicalEvaluations.get('demo-001') as string, { token: a.token });
    await decide(h, await evaluationOf(h, a, 'demo-001'), { token: flip(a.token) });
    await h.call('POST', '/api/demo/session/reset', { token: a.token });
    await h.call('DELETE', '/api/demo/session', { token: b.token });

    assert.equal(await canonicalSnapshot(h.ctx), before, 'a canonical row changed');
  });
});

// ================================================================ audit, history

test('the decision appears in that session\'s own audit history, and only there', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const b = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');

    const before = (await audit(h, a, rowan)).body.events;
    await decide(h, rowan, { token: a.token });
    const after = (await audit(h, a, rowan)).body.events;

    assert.equal(after.length, before.length + 1);
    const event = after.at(-1);
    assert.ok(event, 'the history has no new event');
    assert.equal(event.eventType, 'decision_recorded');
    assert.equal(event.actor, 'human');
    assert.equal(event.actorId, DEMO_ACTOR);
    assert.match(event.summary, /shortlist/);
    assert.equal(event.payload.reason, REASON);

    // Earlier events are untouched, and the new one sorts after them.
    assert.deepEqual(after.slice(0, -1), before);

    assert.equal((await audit(h, b, rowan)).body.events.some((e) => e.eventType === 'decision_recorded'), false, 'B\'s history shows A\'s decision');
    const canonicalAudit = await h.ctx.db.query<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE actor_id = ?", [DEMO_ACTOR]);
    assert.equal(Number(canonicalAudit[0]?.n), 0, 'a demo actor appears in the canonical audit trail');
  });
});

test('a decision carries the time it was made, while the seeded dataset stays on its fixed clock', async () => {
  await withHarness(async (h) => {
    const startedAt = Date.now();
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');

    const reply = await decide(h, rowan, { token: a.token });
    const decidedAt = Date.parse(reply.body.decision.decidedAt);
    assert.ok(decidedAt >= startedAt - 1000 && decidedAt <= Date.now() + 1000, 'the decision is not stamped with the real time');

    const events = (await audit(h, a, rowan)).body.events;
    assert.equal(events.at(-1)?.eventType, 'decision_recorded', 'the decision does not sort after the pipeline events');
    assert.ok(events.slice(0, -1).every((e) => e.createdAt.startsWith('2026-01-01')), 'the seeded history moved off its fixed clock');
  });
});

// ======================================================= 14/15. reset and end

test('reset removes the visitor\'s decision, restores the original candidate, and touches nobody else', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const b = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');

    const pristine = await whatTheyCanSee(h, a, rowan);
    const bPristine = await whatTheyCanSee(h, b, rowan);
    const canonicalBefore = await canonicalSnapshot(h.ctx);

    await decide(h, rowan, { token: a.token });
    await decide(h, rowan, { token: b.token, body: { outcome: 'reject', reason: 'B\'s own synthetic reason, kept.' } });
    assert.notEqual(await whatTheyCanSee(h, a, rowan), pristine, 'precondition: A holds a decision');
    const bDecided = await whatTheyCanSee(h, b, rowan);

    assert.equal((await h.call('POST', '/api/demo/session/reset', { token: a.token })).status, 200);

    assert.equal((await detail(h, a, rowan)).body.decision, null, 'the decision survived the reset');
    assert.equal(await whatTheyCanSee(h, a, rowan), pristine, 'reset did not restore the original deterministic state');
    assert.equal(await whatTheyCanSee(h, b, rowan), bDecided, 'A\'s reset changed B\'s sandbox');
    assert.equal(await canonicalSnapshot(h.ctx), canonicalBefore);
    assert.notEqual(bDecided, bPristine);

    // And the candidate can be decided on again.
    assert.equal((await decide(h, rowan, { token: a.token, body: { outcome: 'hold', reason: 'A deciding again after a reset.' } })).status, 201);
  });
});

test('ending the session makes the old demo session unusable for decisions and reads', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const b = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');
    await decide(h, rowan, { token: a.token });

    assert.equal((await h.call('DELETE', '/api/demo/session', { token: a.token })).status, 200);

    assert.equal((await decide(h, rowan, { token: a.token, body: { outcome: 'hold', reason: 'After the session ended.' } })).status, 401);
    assert.equal((await h.call('GET', `/api/demo/session/evaluations/${rowan}`, { token: a.token })).status, 401);
    assert.equal((await h.call('GET', `/api/demo/session/evaluations/${rowan}/audit`, { token: a.token })).status, 401);

    // A fresh session starts clean — the old decision is gone with the old session.
    const fresh = await visitor(h);
    assert.equal((await detail(h, fresh, rowan)).body.decision, null);
    assert.equal((await detail(h, b, rowan)).body.decision, null, 'ending A touched B');
  });
});

// ============================================================ rate limiting, leaks

test('demo decisions are rate-limited like any other write', async () => {
  assert.equal(classify('POST', '/demo/session/evaluations/e1/decision'), 'mutation');
  assert.equal(classify('GET', '/demo/session/evaluations/e1'), null);

  const tiny = rateLimit({ limits: { ...RATE_LIMITS, mutation: { limit: 3, windowMs: 60_000 }, demoSession: { limit: 100, windowMs: 60_000 } } });
  await withHarness(
    async (h) => {
      const a = await visitor(h);
      const rowan = await evaluationOf(h, a, 'demo-001');
      const statuses: number[] = [];
      for (let i = 0; i < 5; i++) statuses.push((await decide(h, rowan, { token: a.token, body: { outcome: 'nope', reason: 'x' } })).status);
      assert.deepEqual(statuses, [400, 400, 400, 429, 429]);
      assert.ok((await decide(h, rowan, { token: a.token })).headers.get('retry-after'));
    },
    { rateLimiter: tiny },
  );
});

test('no decision response carries a key, a credential, the token or a real record', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');
    const replies = [
      await decide(h, rowan, { token: a.token }),
      await decide(h, rowan, { token: a.token }),
      await decide(h, rowan, { token: a.token, body: { outcome: 'x' } }),
      await decide(h, rowan, {}),
      await audit(h, a, rowan),
    ];
    for (const r of replies) {
      const text = JSON.stringify(r.body) + JSON.stringify([...r.headers.entries()].filter(([k]) => k !== 'set-cookie'));
      for (const needle of [SECRET_API_KEY, PASSWORD, 'scrypt$', 'ANTHROPIC', a.token, 'real-0001', 'Canonical Recruiter Fixture']) {
        assert.ok(!text.includes(needle), `a response contained ${JSON.stringify(needle.slice(0, 20))}`);
      }
    }
  });
});

test('the real application does not serve the demo decision route, even to a signed-in operator', async () => {
  await withHarness(async (h) => {
    const a = await visitor(h);
    const rowan = await evaluationOf(h, a, 'demo-001');
    const op = await h.operator();

    const asOperator = await fetch(`${h.appBase}/api/demo/session/evaluations/${rowan}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${op.cookie}; ${DEMO_SESSION_COOKIE}=${a.token}`, [CSRF_HEADER]: op.csrf },
      body: JSON.stringify(PAYLOAD),
    });
    assert.equal(asOperator.status, 404);
    assert.equal((await h.callApp('POST', `/api/demo/session/evaluations/${rowan}/decision`, { token: a.token, body: PAYLOAD })).status, 401);
    assert.equal((await detail(h, a, rowan)).body.decision, null, 'a decision reached the demo through the real application');
  });
});

test('no demo decision test relies on a model, a key or the network', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '../src/handlers/demoSession.ts'), 'utf8').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(source, /adapters\/llm|@anthropic-ai|ANTHROPIC|process\.env|\bfetch\s*\(/);
});

// A type-only reference, so the shared harness's `RankingBody` stays used here.
void (null as RankingBody | null);
