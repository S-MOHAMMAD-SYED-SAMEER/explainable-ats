import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROUTE, ROUTES, parseRoute, routeToHash } from '../src/router.ts';
import {
  demoSessionFromResponse,
  demoSessionInUse,
  isDemoSessionPath,
  resolveApiPath,
} from '../src/demo/session.ts';
import { api, setApiScope, setDemoSessionLostHandler, setUnauthorizedHandler } from '../src/api/client.ts';

// The public demo's entry and session (Phase 3C.1), from the browser's side.
//
// NFR-9 rules out jsdom and Playwright, so nothing here renders a component. What
// can be proved without a browser is what matters most here: the pure functions
// that decide where a call goes and whether the demo is "on", the real client
// against a stubbed `fetch`, and — by source scan — that the demo files cannot
// have grown a second way to hold a session, a credential or a sign-in.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
/** Strips comments, so a scan matches code rather than the note explaining it. */
const code = (source: string): string => source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const DEMO_FILES = ['demo/session.ts', 'demo/useDemoSession.ts', 'screens/DemoEntry.tsx'];

// ============================================================ the entry route

test('#/demo is a real route, and an unrecognised hash still falls back to the work', () => {
  assert.ok((ROUTES as readonly string[]).includes('demo'));
  assert.deepEqual(parseRoute('#/demo'), { name: 'demo', id: null });
  assert.equal(routeToHash({ name: 'demo', id: null }), '#/demo');
  assert.deepEqual(parseRoute(routeToHash({ name: 'demo', id: null })), { name: 'demo', id: null });

  assert.deepEqual(parseRoute('#/nonsense'), DEFAULT_ROUTE);
  assert.equal(DEFAULT_ROUTE.name, 'jobs', 'the default must stay the recruiter\'s work');
});

test('the demo entry sits above the sign-in gate, which is still there and still guards the dashboard', () => {
  const app = code(read('App.tsx'));

  const entry = app.indexOf('<DemoEntry');
  const login = app.indexOf('<Login');
  assert.ok(entry !== -1 && login !== -1, 'App renders both the demo entry and the sign-in screen');
  assert.ok(entry < login, 'a visitor who asked for the demo would meet the password box first');

  // The gate itself is untouched in kind: anonymous, not browsing, and not in a demo session.
  assert.match(app, /session\.state\.status === 'anonymous' && !browsingDemo && !inDemoSession/);
  assert.match(app, /demoSessionInUse\(/);
});

test('the demo is never modelled as, or derived into, a signed-in state', () => {
  for (const rel of [...DEMO_FILES, 'App.tsx']) {
    const source = code(read(rel));
    assert.doesNotMatch(source, /status:\s*'authenticated'/, `${rel} constructs an authenticated state`);
    assert.doesNotMatch(source, /sessionFromResponse|isAuthenticated\(/, `${rel} reaches into the sign-in state`);
  }

  // The operator name shown in the shell is withheld while the demo is on.
  assert.match(code(read('App.tsx')), /authenticated' && !inDemoSession \? session\.state\.operator : null/);
});

test('the demo files never sign in, sign out, decide, or read the operator\'s session', () => {
  for (const rel of ['demo/useDemoSession.ts', 'screens/DemoEntry.tsx']) {
    const source = code(read(rel));
    for (const forbidden of ['api.login', 'api.logout', 'api.decide', 'api.session(']) {
      assert.ok(!source.includes(forbidden), `${rel} calls ${forbidden}`);
    }
  }
});

test('the sign-in screen is unchanged in kind and links to the demo through the router', () => {
  const login = code(read('screens/Login.tsx'));
  assert.equal(login.split('api.login(').length - 1, 1, 'exactly one sign-in call');
  assert.ok(login.includes('await api.login(password)'));
  assert.ok(login.includes('onClick={onBrowseDemo}'), 'the read-only demo button is still there');
  assert.match(login, /routeToHash\(\{ name: 'demo', id: null \}\)/, 'the demo link must be built with the router');
});

test('the entry screen never starts a session by itself: only a visitor\'s click does, and a failure is retried the same way', () => {
  const source = code(read('screens/DemoEntry.tsx'));
  // No effect of any kind: nothing can run on arrival, so nothing can loop.
  assert.doesNotMatch(source, /useEffect|useLayoutEffect|setTimeout|setInterval/);
  // Every call to start is inside a click handler.
  assert.equal(source.split('start()').length - 1, 1, 'start() is called from more than one place');
  assert.match(source, /const session = await start\(\);/);
  assert.equal(source.split('onClick={() => void begin()}').length - 1, 2, 'both Start buttons must go through begin()');
  // The failure state is the same button, relabelled by the pure view.
  assert.match(source, /view\.primary/);
});

// ====================================================== no browser-side session

test('the browser holds no demo token: no storage, no cookie access, no URL parameter', () => {
  for (const rel of DEMO_FILES) {
    const source = code(read(rel));
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/, `${rel} persists something in the browser`);
    assert.doesNotMatch(source, /document\.cookie/, `${rel} reads cookies`);
    assert.doesNotMatch(source, /location\.(search|href)|URLSearchParams/, `${rel} puts something in the URL`);
  }
  // The cookie is HttpOnly: nothing in the client may so much as name it.
  const all = fs
    .readdirSync(SRC, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(all, /ats_demo/, 'the client names the demo cookie');
});

test('the session survives a reload because the server is asked at startup, not because the browser remembers', () => {
  const hook = code(read('demo/useDemoSession.ts'));
  assert.match(hook, /api\s*\.demoSession\(\)/, 'startup does not ask the server');
  assert.match(hook, /\}, \[\]\);/, 'the startup check is not a run-once effect');
  assert.match(hook, /useState<DemoState>\(\{ status: 'checking' \}\)/, 'the app must not draw anything before the server has answered');
});

// ================================================================ pure functions

test('demoSessionFromResponse is strict and total: anything but a whole, active answer means no session', () => {
  const valid = { active: true, jobId: 'job-1', jobTitle: 'Senior Backend Engineer', expiresAt: '2026-06-01T00:00:00.000Z' };
  assert.deepEqual(demoSessionFromResponse(valid), {
    active: true,
    session: { jobId: 'job-1', jobTitle: 'Senior Backend Engineer', expiresAt: '2026-06-01T00:00:00.000Z' },
  });
  assert.deepEqual(demoSessionFromResponse({ active: false }), { active: false });

  for (const bad of [
    null, undefined, '', 'active', 42, [], {},
    { active: 'true', jobId: 'j', jobTitle: 't', expiresAt: 'x' },
    { active: 1, jobId: 'j', jobTitle: 't', expiresAt: 'x' },
    { active: true },
    { active: true, jobId: '', jobTitle: 't', expiresAt: 'x' },
    { active: true, jobId: 5, jobTitle: 't', expiresAt: 'x' },
    { active: true, jobId: 'j', jobTitle: null, expiresAt: 'x' },
    { active: true, jobId: 'j', jobTitle: 't' },
  ]) {
    assert.deepEqual(demoSessionFromResponse(bad), { active: false }, JSON.stringify(bad));
  }

  // Whatever else a response carries is dropped, not passed along.
  const extra = demoSessionFromResponse({ ...valid, token: 'secret', operator: 'someone' });
  assert.ok(extra.active);
  assert.deepEqual(Object.keys(extra.active ? extra.session : {}).sort(), ['expiresAt', 'jobId', 'jobTitle']);
});

test('a reload keeps an anonymous visitor in the demo, and an operator\'s dashboard stays theirs', () => {
  // [live demo session, signed in, chose the demo this page load] -> demo drawn?
  const table: Array<[boolean, boolean, boolean, boolean, string]> = [
    [true, false, false, true, 'anonymous visitor, straight after a reload'],
    [true, false, true, true, 'anonymous visitor who just entered'],
    [false, false, false, false, 'no session'],
    [false, false, true, false, 'a session that ended'],
    [true, true, false, false, 'operator with a stale demo cookie: their dashboard, not the sandbox'],
    [true, true, true, true, 'operator who chose the demo this visit'],
    [false, true, true, false, 'operator whose demo session ended'],
  ];
  for (const [sessionActive, authenticated, entered, expected, label] of table) {
    assert.equal(demoSessionInUse({ sessionActive, authenticated, entered }), expected, label);
  }
});

test('resolveApiPath sends the dashboard\'s reads and the scenario run to the sandbox, and nothing else', () => {
  // Recruiter scope is the identity.
  for (const p of ['/jobs', '/jobs/j1', '/jobs/j1/ranking', '/evaluations/e1', '/evaluations/e1/audit', '/evaluations/e1/decision', '/demo/scenarios/demo-001/run', '/health', '/auth/session']) {
    assert.equal(resolveApiPath(p, 'recruiter'), p);
  }

  const mapped: Array<[string, string]> = [
    ['/jobs', '/demo/session/jobs'],
    ['/jobs/j1', '/demo/session/jobs/j1'],
    ['/jobs/j1/ranking', '/demo/session/jobs/j1/ranking'],
    ['/evaluations/e1', '/demo/session/evaluations/e1'],
    ['/evaluations/e1/audit', '/demo/session/evaluations/e1/audit'],
    ['/demo/scenarios/demo-003/run', '/demo/session/scenarios/demo-003/run'],
  ];
  for (const [from, to] of mapped) assert.equal(resolveApiPath(from, 'demo'), to);

  // Left exactly alone: authentication, health, and the session's own lifecycle.
  for (const p of ['/health', '/auth/login', '/auth/logout', '/auth/session', '/demo/session', '/demo/session/reset', '/unknown', '/jobsx', '/evaluationsx']) {
    assert.equal(resolveApiPath(p, 'demo'), p, `${p} was redirected`);
  }

  // The decision path is redirected like any evaluation path — to a route that
  // does not exist — and so can never be a call to the canonical decision route.
  const decision = resolveApiPath('/evaluations/e1/decision', 'demo');
  assert.equal(decision, '/demo/session/evaluations/e1/decision');
  assert.notEqual(decision, '/evaluations/e1/decision');
});

test('isDemoSessionPath recognises exactly the demo session\'s own paths', () => {
  for (const p of ['/demo/session', '/demo/session/jobs', '/demo/session/reset']) assert.equal(isDemoSessionPath(p), true, p);
  for (const p of ['/demo/scenarios/demo-001/run', '/demo/sessions', '/demo', '/jobs', '/auth/session', '']) {
    assert.equal(isDemoSessionPath(p), false, p);
  }
});

// =========================================== the real client, against a stub

type Call = { url: string; method: string; body: unknown; credentials: unknown; headers: Record<string, string> };

/** Runs `fn` with `fetch` stubbed, and returns every call it made. */
async function withFetch(
  respond: (call: Call) => { status: number; body: unknown },
  fn: () => Promise<void>,
): Promise<Call[]> {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ?? null,
      credentials: init?.credentials,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    const { status, body } = respond(call);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = real;
    setApiScope('recruiter');
    setUnauthorizedHandler(null);
    setDemoSessionLostHandler(null);
  }
  return calls;
}

const ok = () => ({ status: 200, body: {} });

test('in the demo scope the same api calls read the visitor\'s sandbox; in the recruiter scope they do not', async () => {
  const demoCalls = await withFetch(ok, async () => {
    setApiScope('demo');
    await api.jobs();
    await api.job('j1');
    await api.ranking('j1');
    await api.evaluation('e1');
    await api.evaluationAudit('e1');
    await api.runDemoScenario('demo-002');
  });
  assert.deepEqual(
    demoCalls.map((c) => c.url),
    [
      '/api/demo/session/jobs',
      '/api/demo/session/jobs/j1',
      '/api/demo/session/jobs/j1/ranking',
      '/api/demo/session/evaluations/e1',
      '/api/demo/session/evaluations/e1/audit',
      '/api/demo/session/scenarios/demo-002/run',
    ],
  );

  const recruiterCalls = await withFetch(ok, async () => {
    setApiScope('recruiter');
    await api.jobs();
    await api.evaluation('e1');
    await api.runDemoScenario('demo-002');
  });
  assert.deepEqual(recruiterCalls.map((c) => c.url), ['/api/jobs', '/api/evaluations/e1', '/api/demo/scenarios/demo-002/run']);
});

test('the session lifecycle calls go where they say, in either scope, carrying no token and no body', async () => {
  for (const scope of ['recruiter', 'demo'] as const) {
    const calls = await withFetch(ok, async () => {
      setApiScope(scope);
      await api.demoSession();
      await api.startDemoSession();
      await api.resetDemoSession();
      await api.endDemoSession();
    });

    assert.deepEqual(
      calls.map((c) => `${c.method} ${c.url}`),
      ['GET /api/demo/session', 'POST /api/demo/session', 'POST /api/demo/session/reset', 'DELETE /api/demo/session'],
      scope,
    );
    for (const call of calls) {
      assert.ok(call.body === null || call.body === '{}', `${call.method} ${call.url} sent data`);
      assert.equal(call.credentials, 'same-origin');
      assert.deepEqual(Object.keys(call.headers).map((k) => k.toLowerCase()).sort(), ['content-type'], 'unexpected headers');
    }
  }
});

test('a demo-scope decision attempt never reaches the canonical decision route', async () => {
  const calls = await withFetch(() => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'x' } } }), async () => {
    setApiScope('demo');
    await assert.rejects(() => api.decide('e1', 'reject', 'A reason that is long enough.'));
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, '/api/demo/session/evaluations/e1/decision');
  assert.notEqual(calls[0]?.url, '/api/evaluations/e1/decision');
});

test('a 401 from the visitor\'s sandbox reports a lost demo session, not a sign-out', async () => {
  let signedOut = 0;
  let lost = 0;
  await withFetch(() => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'There is no active demo session.' } } }), async () => {
    setUnauthorizedHandler(() => void signedOut++);
    setDemoSessionLostHandler(() => void lost++);
    setApiScope('demo');
    await assert.rejects(() => api.jobs());
    await assert.rejects(() => api.evaluation('e1'));
  });
  assert.equal(lost, 2);
  assert.equal(signedOut, 0, 'a visitor losing a demo was reported as an operator signing out');
});

test('a 401 from the canonical API still reports a sign-out, and never a lost demo', async () => {
  let signedOut = 0;
  let lost = 0;
  await withFetch(() => ({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } } }), async () => {
    setUnauthorizedHandler(() => void signedOut++);
    setDemoSessionLostHandler(() => void lost++);
    setApiScope('recruiter');
    await assert.rejects(() => api.jobs());
    await assert.rejects(() => api.evaluation('e1'));
  });
  assert.equal(signedOut, 2);
  assert.equal(lost, 0);
});

test('the client sends no credential of its own in either scope', async () => {
  for (const scope of ['recruiter', 'demo'] as const) {
    const calls = await withFetch(ok, async () => {
      setApiScope(scope);
      await api.jobs();
      await api.startDemoSession();
    });
    for (const call of calls) {
      const names = Object.keys(call.headers).map((k) => k.toLowerCase());
      assert.ok(!names.includes('authorization') && !names.includes('x-demo-session') && !names.includes('cookie'), `${scope}: ${names}`);
    }
  }
});
