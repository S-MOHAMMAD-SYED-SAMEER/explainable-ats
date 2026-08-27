import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { hashPassword } from '../src/lib/password.ts';
import { readCookie, SESSION_COOKIE, CSRF_COOKIE } from '../src/auth/cookies.ts';
import { createTestContext, MIGRATION_COUNT } from './helpers.ts';

// HTTP wiring.
//
// The handlers are tested directly elsewhere — that is the point of the
// `{ status, body }` shape. What can only be tested through a real server is
// the wiring: the order of the middleware, which IS the security boundary, and
// the fact that serving the front end from the same origin cannot shadow it.
//
// Node's built-in fetch and an ephemeral port cover it with no HTTP-testing
// dependency (NFR-9).

const PASSWORD = 'p3a-operator-password-2026';

async function withServer(
  fn: (base: string, ctx: { config: AppConfig }) => Promise<void>,
  overrides: Partial<AppConfig> = {},
): Promise<void> {
  const ctx = await createTestContext();
  const config: AppConfig = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    // This harness speaks HTTP; the Secure attribute is asserted on the header
    // rather than exercised over TLS.
    cookieSecure: false,
    ...overrides,
  };

  const app = createApp({ db: ctx.db, config, logger: createMemoryLogger().logger });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;

  try {
    await fn(`http://127.0.0.1:${port}`, { config });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.close();
  }
}

// ================================================================= health

test('health is public and answers JSON', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/health`);
    const body = (await response.json()) as { status: string; database: { migrationsApplied: number } };

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    assert.equal(body.status, 'ok');
    assert.equal(body.database.migrationsApplied, MIGRATION_COUNT);
  });
});

// ============================================================== the gate

test('a protected route is refused without a session', async () => {
  await withServer(async (base) => {
    // Nothing is mounted past the gate yet, so an unknown path proves the same
    // thing: the gate answers before the API's own 404 does. That ordering is
    // deliberate — a stranger learns nothing about which endpoints exist.
    const response = await fetch(`${base}/api/anything`);
    assert.equal(response.status, 401);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
  });
});

test('a wrong password is refused and sets no cookie', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'not-the-password' }),
    });

    assert.equal(response.status, 401);
    assert.equal(response.headers.getSetCookie().length, 0, 'a cookie was issued for a failed sign-in');
  });
});

test('signing in issues cookies with the attributes a browser must enforce', async () => {
  await withServer(
    async (base) => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(response.status, 200);

      const cookies = response.headers.getSetCookie();
      const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '';
      const csrf = cookies.find((c) => c.startsWith(`${CSRF_COOKIE}=`)) ?? '';

      assert.match(session, /HttpOnly/i, 'the session cookie is readable by script');
      assert.match(session, /Secure/i, 'the session cookie is not marked Secure');
      // Strict, not Lax. It is also what makes single-origin serving a
      // requirement rather than a preference: a browser will not send this to a
      // different site at all.
      assert.match(session, /SameSite=Strict/i);

      assert.ok(csrf !== '', 'no CSRF cookie was issued');
      assert.ok(!/HttpOnly/i.test(csrf), 'the CSRF cookie must be readable by the client');
      assert.match(csrf, /SameSite=Strict/i);
    },
    { cookieSecure: true },
  );
});

test('a session opens the gate, and CSRF still guards mutations', async () => {
  await withServer(async (base) => {
    const signIn = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(signIn.status, 200);

    const setCookie = signIn.headers.getSetCookie();
    const token = setCookie.map((c) => readCookie(c.split(';')[0], SESSION_COOKIE)).find(Boolean) ?? '';
    const csrf = setCookie.map((c) => readCookie(c.split(';')[0], CSRF_COOKIE)).find(Boolean) ?? '';
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`;

    // A read is past the gate now: no longer 401, and the API's own 404 answers.
    const authed = await fetch(`${base}/api/anything`, { headers: { cookie } });
    assert.equal(authed.status, 404, 'the gate did not open for a valid session');

    // A mutation WITHOUT the header is refused...
    const noCsrf = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(noCsrf.status, 403, 'a mutation without a CSRF token was accepted');

    // ...and the same mutation WITH it succeeds. Both halves, or the check
    // above could be passing because logout is broken.
    const withCsrf = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf ?? '' },
      body: JSON.stringify({}),
    });
    assert.equal(withCsrf.status, 200);

    // And the session is genuinely gone.
    const afterLogout = await fetch(`${base}/api/anything`, { headers: { cookie } });
    assert.equal(afterLogout.status, 401, 'the session survived logout');
  });
});

test('rate limiting is active on sign-in', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.ok(response.headers.get('x-ratelimit-limit') !== null, 'no rate-limit headers on sign-in');
  });
});

// ================================================= single-origin serving

test('the front end is served from the same origin and cannot shadow the API', async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'p3a-dist-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');

  try {
    await withServer(
      async (base) => {
        const root = await fetch(`${base}/`);
        assert.equal(root.status, 200);
        assert.match(root.headers.get('content-type') ?? '', /text\/html/);
        assert.match(await root.text(), /<div id="root">/);

        // The API still answers JSON, and static serving never reaches it.
        const health = await fetch(`${base}/api/health`);
        assert.match(health.headers.get('content-type') ?? '', /application\/json/);

        // No SPA fallback: the client is a hash router, so the only path a
        // browser requests is `/`. A fallback would turn every genuine 404 into
        // a 200 serving the app.
        const unknown = await fetch(`${base}/jobs`);
        assert.notEqual(unknown.status, 200, 'an unknown path returned the app');
      },
      { webDistDir: dist },
    );
  } finally {
    fs.rmSync(dist, { recursive: true, force: true });
  }
});

test('a missing build leaves the API working', async () => {
  // The normal state in development, where Vite serves the front end.
  await withServer(
    async (base) => {
      assert.equal((await fetch(`${base}/api/health`)).status, 200);
      assert.notEqual((await fetch(`${base}/`)).status, 200);
    },
    { webDistDir: path.join(os.tmpdir(), 'p3a-absent-dist') },
  );
});

// ================================================================ wiring

test('malformed JSON gets a clean envelope, not an HTML stack trace', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });

    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  });
});

// ==================================================== same-origin POSTs
//
// The whole of the rest of this file — and every other suite — speaks to the
// server the way curl does: with no `Origin` header. A browser does not.
//
// Per the Fetch specification a browser omits `Origin` on a same-origin GET but
// attaches one to EVERY request whose method is not GET or HEAD, same-origin
// included. That single header is the difference between the suite passing and
// the application being unusable: with an empty allow-list, every POST the front
// end made — starting with sign-in — was refused 403 by the CORS layer, and no
// test could see it because no test sent the header.
//
// These three tests send it.

test('a same-origin POST carrying an Origin header is allowed', async () => {
  await withServer(async (base) => {
    // Exactly what the browser sends: the origin it is already talking to.
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ password: PASSWORD }),
    });

    assert.equal(response.status, 200, 'the front end cannot sign in to its own API');
    assert.ok(
      response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)),
      'no session cookie was issued',
    );
  });
});

test('a cross-origin POST is still refused, with the allow-list still empty', async () => {
  // The negative control for the test above. Without it, "same-origin POSTs
  // work" would also be satisfied by removing the origin check altogether.
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ password: PASSWORD }),
    });

    assert.equal(response.status, 403);
    const body = (await response.json()) as { error: { code: string; details: { reason: string } } };
    assert.equal(body.error.code, 'FORBIDDEN');
    assert.equal(body.error.details.reason, 'origin_not_allowed');
  });
});

test('a cross-origin POST is refused even when the password is right', async () => {
  // The refusal happens before authentication, which is the point: a write from
  // an origin nobody approved must not execute and then be hidden from the
  // caller. A 401 here would mean the credential had been checked.
  await withServer(async (base) => {
    const wrong = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ password: 'not-the-password' }),
    });
    const right = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ password: PASSWORD }),
    });

    assert.equal(wrong.status, 403);
    assert.equal(right.status, 403, 'a disallowed origin must not reach the password check');
  });
});

test('a same-origin GET carries no Origin, and is unaffected either way', async () => {
  // Documents the asymmetry that hid the fault: GETs were always fine, which is
  // why the app looked healthy right up until someone pressed a button.
  await withServer(async (base) => {
    const withHeader = await fetch(`${base}/api/health`, { headers: { origin: base } });
    const without = await fetch(`${base}/api/health`);

    assert.equal(withHeader.status, 200);
    assert.equal(without.status, 200);
  });
});

test('a same-origin POST on a different port is not the same origin', async () => {
  // The port is part of an origin. Without it, another service on the same host
  // would be treated as our own front end.
  await withServer(async (base) => {
    const url = new URL(base);
    const otherPort = `${url.protocol}//${url.hostname}:${Number(url.port) + 1}`;

    const response = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: otherPort },
      body: JSON.stringify({ password: PASSWORD }),
    });

    assert.equal(response.status, 403);
  });
});

test('an explicitly allowed cross-origin POST works, and is echoed back', async () => {
  // The allow-list still does its job: naming an origin is how a genuine
  // cross-origin client is admitted, and only then is the origin echoed.
  await withServer(
    async (base) => {
      const response = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://partner.example' },
        body: JSON.stringify({ password: PASSWORD }),
      });

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), 'http://partner.example');
      assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
      assert.match(response.headers.get('vary') ?? '', /Origin/i);
    },
    { corsAllowedOrigins: ['http://partner.example'] },
  );
});
