import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROUTE, DEMO_DEFAULT_ROUTE, DEMO_ROUTES, RECRUITER_ROUTES, ROUTES, parseRoute, routeToHash } from '../src/router.ts';
import { demoSessionFromResponse, isDemoSessionPath, resolveApiPath } from '../src/demo/session.ts';
import { api, setApiScope, setDemoSessionLostHandler, setUnauthorizedHandler } from '../src/api/client.ts';
import { openingTags } from './jsxScan.ts';

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

test('the demo deployment draws the front page and never a sign-in; the application draws the sign-in and never the demo', () => {
  const demo = code(read('DemoApp.tsx'));
  const recruiter = code(read('RecruiterApp.tsx'));

  assert.ok(demo.includes('<DemoEntry') && !demo.includes('<Login'), 'the demo deployment draws a sign-in');
  assert.ok(recruiter.includes('<Login') && !recruiter.includes('<DemoEntry'), 'the application draws the demo\'s front page');

  // Neither half reaches for the other's state.
  assert.doesNotMatch(demo, /useSession\b|\bapi\.session|sessionFromResponse/);
  assert.doesNotMatch(recruiter, /useDemoSession|demoSession|DemoEntry/);
});

test('the demo is never modelled as, or derived into, a signed-in state', () => {
  for (const rel of [...DEMO_FILES, 'DemoApp.tsx', 'RecruiterApp.tsx', 'App.tsx']) {
    const source = code(read(rel));
    assert.doesNotMatch(source, /status:\s*'authenticated'/, `${rel} constructs an authenticated state`);
    assert.doesNotMatch(source, /sessionFromResponse|isAuthenticated\(/, `${rel} reaches into the sign-in state`);
  }

  // The demo deployment has no operator at all: not a name to show, nor one to withhold.
  assert.doesNotMatch(code(read('DemoApp.tsx')), /operator/i);
});

test('the demo files never sign in, sign out, decide, or read the operator\'s session', () => {
  for (const rel of ['demo/useDemoSession.ts', 'screens/DemoEntry.tsx']) {
    const source = code(read(rel));
    for (const forbidden of ['api.login', 'api.logout', 'api.decide', 'api.session(']) {
      assert.ok(!source.includes(forbidden), `${rel} calls ${forbidden}`);
    }
  }
});

test('the sign-in screen is unchanged in kind, and has no link, button or wording for the demo', () => {
  const login = code(read('screens/Login.tsx'));
  assert.equal(login.split('api.login(').length - 1, 1, 'exactly one sign-in call');
  assert.ok(login.includes('await api.login(password)'));

  // Nothing else on it: the password form's own button, and no anchor at all.
  assert.deepEqual(openingTags(login, 'a'), [], 'the sign-in screen links somewhere');
  assert.equal(openingTags(login, 'button').length, 1, 'the only button is the password form\'s submit');
  assert.doesNotMatch(login, /[Dd]emo|routeToHash|onBrowseDemo|browsingDemo|setBrowsingDemo/);
});

test('the entry screen never starts a session by itself: only a visitor\'s click does, and a failure is retried the same way', () => {
  const source = code(read('screens/DemoEntry.tsx'));
  // No effect of any kind: nothing can run on arrival, so nothing can loop.
  assert.doesNotMatch(source, /useEffect|useLayoutEffect|setTimeout|setInterval/);
  // Every call to start is inside a click handler.
  assert.equal(source.split('start()').length - 1, 1, 'start() is called from more than one place');
  assert.match(source, /const session = await start\(\);/);
  assert.equal(source.split('onClick={() => void begin()}').length - 1, 1, 'the one call to action must go through begin()');
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

test('the demo deployment shows the dashboard to a visitor with a live session, and the front page to everyone else', () => {
  const app = code(read('DemoApp.tsx'));

  // Derived from the server's answer and the route — never stored.
  assert.match(app, /const inSession = demoSession\.state\.status === 'active' && route\.name !== 'demo';/);
  assert.match(app, /if \(!inSession\) \{\s*return <DemoEntry demo=\{demoSession\} redirect=\{route\.name === 'demo'\} \/>;/);
  assert.doesNotMatch(app, /useState|localStorage|sessionStorage/, 'the demo app keeps state of its own about the session');
});

test('each deployment has its own routes, and anything else falls back to its own front page', () => {
  // The demo: its front page and the dashboard's two screens. No Status screen.
  assert.deepEqual([...DEMO_ROUTES], ['demo', 'jobs', 'candidates']);
  const demoParse = (hash: string) => parseRoute(hash, { allowed: DEMO_ROUTES, fallback: DEMO_DEFAULT_ROUTE });
  assert.deepEqual(demoParse(''), { name: 'demo', id: null });
  assert.deepEqual(demoParse('#/nonsense'), { name: 'demo', id: null });
  assert.deepEqual(demoParse('#/overview'), { name: 'demo', id: null }, 'the Status screen is a route in the demo');
  assert.deepEqual(demoParse('#/jobs/j1'), { name: 'jobs', id: 'j1' });
  assert.deepEqual(demoParse('#/candidates/e1'), { name: 'candidates', id: 'e1' });
  assert.deepEqual(demoParse('#/demo'), { name: 'demo', id: null });

  // The application: no front page for a demo. `#/demo` is just an unknown hash there.
  const appParse = (hash: string) => parseRoute(hash, { allowed: RECRUITER_ROUTES, fallback: DEFAULT_ROUTE });
  assert.deepEqual([...RECRUITER_ROUTES], ['overview', 'jobs', 'candidates']);
  assert.deepEqual(appParse('#/demo'), DEFAULT_ROUTE, 'the demo\'s front page is a route in the application');
  assert.deepEqual(appParse('#/overview'), { name: 'overview', id: null });
  assert.deepEqual(appParse('#/jobs/j1'), { name: 'jobs', id: 'j1' });

  // No route is in both modes\' private lists.
  assert.ok(!(RECRUITER_ROUTES as readonly string[]).includes('demo'));
  assert.ok(!(DEMO_ROUTES as readonly string[]).includes('overview'));
});

test('resolveApiPath sends the dashboard\'s reads to the sandbox, and nothing else', () => {
  // Recruiter scope is the identity.
  for (const p of ['/jobs', '/jobs/j1', '/jobs/j1/ranking', '/evaluations/e1', '/evaluations/e1/audit', '/evaluations/e1/decision', '/health', '/auth/session']) {
    assert.equal(resolveApiPath(p, 'recruiter'), p);
  }

  const mapped: Array<[string, string]> = [
    ['/jobs', '/demo/session/jobs'],
    ['/jobs/j1', '/demo/session/jobs/j1'],
    ['/jobs/j1/ranking', '/demo/session/jobs/j1/ranking'],
    ['/evaluations/e1', '/demo/session/evaluations/e1'],
    ['/evaluations/e1/audit', '/demo/session/evaluations/e1/audit'],
  ];
  for (const [from, to] of mapped) assert.equal(resolveApiPath(from, 'demo'), to);

  // Left exactly alone: authentication, health, and the session's own lifecycle.
  // (The retired scenario-run path is among them: it is no longer mapped to anything.)
  for (const p of ['/health', '/auth/login', '/auth/logout', '/auth/session', '/demo/session', '/demo/session/reset', '/demo/scenarios/demo-001/run', '/unknown', '/jobsx', '/evaluationsx']) {
    assert.equal(resolveApiPath(p, 'demo'), p, `${p} was redirected`);
  }

  // The decision path is redirected like any evaluation path — to the demo's own
  // decision route — and so can never be a call to the recruiter's decision route.
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
  });
  assert.deepEqual(
    demoCalls.map((c) => c.url),
    [
      '/api/demo/session/jobs',
      '/api/demo/session/jobs/j1',
      '/api/demo/session/jobs/j1/ranking',
      '/api/demo/session/evaluations/e1',
      '/api/demo/session/evaluations/e1/audit',
    ],
  );

  const recruiterCalls = await withFetch(ok, async () => {
    setApiScope('recruiter');
    await api.jobs();
    await api.evaluation('e1');
  });
  assert.deepEqual(recruiterCalls.map((c) => c.url), ['/api/jobs', '/api/evaluations/e1']);

  // The client has no call for a demo run at all any more.
  assert.ok(!('runDemoScenario' in api));
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

test('a demo-scope decision attempt never reaches the recruiter\'s decision route', async () => {
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
