import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig, configSummary, type AppConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { hashPassword } from '../src/lib/password.ts';
import { isPublicDemoRead, PUBLIC_DEMO_READS } from '../src/auth/middleware.ts';
import { createTestContext } from './helpers.ts';

// The public read-only demo window.
//
// WHAT THIS FEATURE IS, STATED PRECISELY
//
// Two of the three deployed projects can be looked at without an account. This
// server was the odd one out: a prospective client met an operator password and
// stopped there. The window opened here is the same one Project 2 already
// ships — an allow-list of GET routes over the invented dataset, granting NO
// session.
//
// WHAT IT IS NOT
//
// It is not a second credential. There is no demo password, no demo account and
// no demo token, so there is nothing to leak, guess, copy out of the bundle, or
// escalate. The tests below exist to keep it that way: several of them would
// fail if somebody later "improved" this into a login.

const PASSWORD = 'p3a-operator-password-2026';

/** Config override that opens the window. */
const OPEN: Partial<AppConfig> = { demoPublicReadonly: true };

async function withServer(
  fn: (base: string) => Promise<void>,
  overrides: Partial<AppConfig> = {},
): Promise<void> {
  const ctx = await createTestContext();
  const config: AppConfig = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    // This harness speaks HTTP; Secure is asserted on headers elsewhere.
    cookieSecure: false,
    ...overrides,
  };

  const app = createApp({ db: ctx.db, config, logger: createMemoryLogger().logger });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.close();
  }
}

// ================================================ the window is shut by default

test('the demo window is closed unless the environment opens it by name', () => {
  assert.equal(loadConfig({}).config.demoPublicReadonly, false);
  assert.equal(loadConfig({ DEMO_PUBLIC_READONLY: 'true' }).config.demoPublicReadonly, true);
});

test('with the window shut, every read is refused exactly as before', async () => {
  await withServer(async (base) => {
    for (const path of ['/api/jobs', '/api/evaluations/abc', '/api/evaluations/abc/audit']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 401, `${path} was reachable with the window shut`);
    }
  });
});

// ==================================================== demo access does work

test('with the window open, an allow-listed read is served anonymously', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/jobs`);
    assert.equal(response.status, 200, 'the public read was refused');
  }, OPEN);
});

test('an anonymous read passes the gate rather than being answered by it', async () => {
  await withServer(async (base) => {
    // These ids do not exist, so 404 is the correct answer. What matters is
    // that the router answers and not the gate: a 401 would mean the request
    // never reached the router at all.
    const paths = [
      '/api/jobs/nope',
      '/api/jobs/nope/ranking',
      '/api/evaluations/nope',
      '/api/evaluations/nope/audit',
    ];
    for (const path of paths) {
      const response = await fetch(`${base}${path}`);
      assert.notEqual(response.status, 401, `${path} was blocked by the gate`);
    }
  }, OPEN);
});

// ============================================== demo access cannot escalate

test('the one write route stays shut to anonymous callers', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/evaluations/nope/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'shortlist', reason: 'trying it on' }),
    });
    assert.equal(response.status, 401, 'an anonymous caller reached the decision route');
  }, OPEN);
});

test('an anonymous read is granted no session, no cookie and no CSRF token', async () => {
  await withServer(async (base) => {
    const read = await fetch(`${base}/api/jobs`);
    assert.equal(read.status, 200);
    assert.equal(read.headers.getSetCookie().length, 0, 'a public read issued a cookie');

    const session = await fetch(`${base}/api/auth/session`);
    const body = (await session.json()) as Record<string, unknown>;
    assert.equal(body.authenticated, false);
    assert.equal(body.operator, null);
    // The CSRF token is what a write needs. Handing one to an anonymous caller
    // would be the first half of an escalation.
    assert.equal(body.csrfToken, null, 'a CSRF token was handed to an anonymous caller');
    assert.equal(body.demoAvailable, true);
  }, OPEN);
});

test('the allow-list is literal: an unlisted path is still refused', async () => {
  await withServer(async (base) => {
    const paths = [
      '/api/anything',
      '/api/jobs/a/b/c',
      '/api/evaluations',
      '/api/evaluations/a/decision',
    ];
    for (const path of paths) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 401, `${path} slipped through the allow-list`);
    }
  }, OPEN);
});

// Written out rather than derived from `PUBLIC_DEMO_READS.source`. Deriving
// them means the test reuses whatever the implementation says, so a pattern
// that silently stopped matching would still "pass"; and the first attempt at
// deriving them stripped the `^` out of `[^/]` while stripping the anchor,
// which is exactly the kind of quiet wrongness this file exists to catch.
const PUBLIC_SAMPLES = [
  '/jobs',
  '/jobs/job-1',
  '/jobs/job-1/ranking',
  '/evaluations/eval-1',
  '/evaluations/eval-1/audit',
] as const;

test('every allow-listed path is public under GET and under no other method', () => {
  assert.equal(
    PUBLIC_SAMPLES.length,
    PUBLIC_DEMO_READS.length,
    'a pattern was added or removed without updating the samples',
  );

  for (const sample of PUBLIC_SAMPLES) {
    assert.equal(isPublicDemoRead('GET', sample), true, `${sample} should be a public read`);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
      assert.equal(isPublicDemoRead(method, sample), false, `${method} ${sample} must not be public`);
    }
  }
});

test('the decision route matches no pattern, under any method', () => {
  for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(isPublicDemoRead(method, '/evaluations/abc/decision'), false);
  }
});

// ================================ demo access cannot expose the credential

test('no public response carries the operator credential', async () => {
  await withServer(async (base) => {
    const bodies = [
      await (await fetch(`${base}/api/health`)).text(),
      await (await fetch(`${base}/api/auth/session`)).text(),
      await (await fetch(`${base}/api/jobs`)).text(),
    ].join('\n');

    assert.ok(!bodies.includes(PASSWORD), 'the operator password appeared in a public response');
    assert.ok(!bodies.includes('scrypt$'), 'a password hash appeared in a public response');
    assert.ok(
      !bodies.toLowerCase().includes('operatorpasswordhash'),
      'the credential field name was exposed',
    );
  }, OPEN);
});

test('the config summary reports whether the window is open, never the credential', async () => {
  const config: AppConfig = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    demoPublicReadonly: true,
  };

  const summary = JSON.stringify(configSummary(config));
  assert.equal(configSummary(config).demoPublicReadonly, true);
  assert.equal(configSummary(config).authConfigured, true);
  assert.ok(!summary.includes('scrypt$'), 'the hash reached the summary');
  assert.ok(!summary.includes(PASSWORD), 'the password reached the summary');
});

// ============================================== operator login still works

test('the operator can still sign in, window open or shut', async () => {
  for (const overrides of [{}, OPEN]) {
    await withServer(async (base) => {
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(login.status, 200, 'the operator was refused');

      const cookies = login.headers.getSetCookie();
      assert.ok(cookies.length > 0, 'signing in issued no cookie');

      const session = await fetch(`${base}/api/auth/session`, {
        headers: { cookie: cookies.map((c) => c.split(';')[0]).join('; ') },
      });
      const body = (await session.json()) as Record<string, unknown>;
      assert.equal(body.authenticated, true);
      assert.equal(body.operator, 'operator');
      assert.ok(
        typeof body.csrfToken === 'string' && body.csrfToken.length > 0,
        'a signed-in operator got no CSRF token',
      );
    }, overrides);
  }
});

test('a wrong password is still refused while the window is open', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'not-the-password' }),
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.getSetCookie().length, 0);
  }, OPEN);
});
