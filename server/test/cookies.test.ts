import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { hashPassword } from '../src/lib/password.ts';
import { CSRF_COOKIE, SESSION_COOKIE, readCookie } from '../src/auth/cookies.ts';
import { CSRF_HEADER } from '../src/auth/csrf.ts';
import { createTestContext } from './helpers.ts';

// The session and CSRF cookies, by name.
//
// They were `inbox_session` and `inbox_csrf`, copied from the project this
// server's auth was taken from. They are `ats_session` and `ats_csrf` now. The
// rename is only safe if the session and CSRF behaviour did not change with it,
// which is what these pin down — over real HTTP, because the one thing that can
// go wrong in a rename is the name a browser actually sends back.

const PASSWORD = 'cookie-names-operator-password';

type Harness = { base: string; signIn(): Promise<Response> };

async function withServer(fn: (h: Harness) => Promise<void>): Promise<void> {
  const ctx = await createTestContext({ idPrefix: 'cookies' });
  const config: AppConfig = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    cookieSecure: false,
    demoPublicReadonly: false,
  };
  const app = createApp({ db: ctx.db, config, logger: createMemoryLogger().logger });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  try {
    await fn({
      base,
      signIn: () =>
        fetch(`${base}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: base },
          body: JSON.stringify({ password: PASSWORD }),
        }),
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await ctx.close();
  }
}

/** The value of one cookie out of a response's Set-Cookie headers. */
function setCookieValue(response: Response, name: string): string | null {
  for (const header of response.headers.getSetCookie()) {
    const value = readCookie(header.split(';')[0], name);
    if (value) return value;
  }
  return null;
}

test('the cookies are named for this application, and are the only ones issued', async () => {
  assert.equal(SESSION_COOKIE, 'ats_session');
  assert.equal(CSRF_COOKIE, 'ats_csrf');

  await withServer(async ({ signIn }) => {
    const response = await signIn();
    assert.equal(response.status, 200);

    const names = response.headers.getSetCookie().map((header) => (header.split('=')[0] ?? '').trim());
    assert.deepEqual(names.sort(), ['ats_csrf', 'ats_session']);
  });
});

test('the cookie attributes did not change with the rename', async () => {
  await withServer(async ({ signIn }) => {
    const headers = (await signIn()).headers.getSetCookie();
    const session = headers.find((header) => header.startsWith('ats_session=')) ?? '';
    const csrf = headers.find((header) => header.startsWith('ats_csrf=')) ?? '';

    assert.match(session, /; HttpOnly/, 'the session cookie must stay HttpOnly');
    assert.match(session, /; SameSite=Strict/);
    assert.match(csrf, /; SameSite=Strict/);
    assert.doesNotMatch(csrf, /HttpOnly/, 'the CSRF cookie must stay readable so the front end can echo it');
  });
});

test('a session presented under the new name is accepted', async () => {
  await withServer(async ({ base, signIn }) => {
    const login = await signIn();
    const token = setCookieValue(login, SESSION_COOKIE);
    const csrf = setCookieValue(login, CSRF_COOKIE);
    assert.ok(token && csrf, 'precondition: sign-in issued both cookies');

    const session = await fetch(`${base}/api/auth/session`, {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    });
    const body = (await session.json()) as { authenticated: boolean; csrfToken: string | null };
    assert.equal(body.authenticated, true);
    assert.equal(body.csrfToken, csrf);

    // And the gate opens for it.
    const jobs = await fetch(`${base}/api/jobs`, {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    });
    assert.equal(jobs.status, 200);
  });
});

test('the same session under the old inbox name is not a session', async () => {
  await withServer(async ({ base, signIn }) => {
    const token = setCookieValue(await signIn(), SESSION_COOKIE);
    assert.ok(token, 'precondition: sign-in issued a session');

    // A valid token, wrong cookie name: it must not authenticate, so nothing
    // still reads the old name by accident.
    const session = await fetch(`${base}/api/auth/session`, {
      headers: { cookie: `inbox_session=${encodeURIComponent(token)}` },
    });
    assert.equal(((await session.json()) as { authenticated: boolean }).authenticated, false);

    const jobs = await fetch(`${base}/api/jobs`, { headers: { cookie: `inbox_session=${encodeURIComponent(token)}` } });
    assert.equal(jobs.status, 401);
  });
});

test('CSRF still comes from the session, under the new cookie, via the header', async () => {
  await withServer(async ({ base, signIn }) => {
    const login = await signIn();
    const token = setCookieValue(login, SESSION_COOKIE) ?? '';
    const csrf = setCookieValue(login, CSRF_COOKIE) ?? '';
    const cookie = `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`;
    const post = (headers: Record<string, string>) =>
      fetch(`${base}/api/auth/logout`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json', origin: base, ...headers },
        body: '{}',
      });

    // The cookie alone is not enough — it has to be echoed in the header — and
    // an old-style cookie name carries no weight either.
    assert.equal((await post({})).status, 403);
    assert.equal((await post({ [CSRF_HEADER]: 'not-the-token' })).status, 403);
    assert.equal((await post({ [CSRF_HEADER]: csrf })).status, 200);
  });
});

test('signing out expires the new cookies and does not mention the old ones', async () => {
  await withServer(async ({ base, signIn }) => {
    const login = await signIn();
    const token = setCookieValue(login, SESSION_COOKIE) ?? '';
    const csrf = setCookieValue(login, CSRF_COOKIE) ?? '';

    const logout = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${CSRF_COOKIE}=${encodeURIComponent(csrf)}`,
        'content-type': 'application/json',
        origin: base,
        [CSRF_HEADER]: csrf,
      },
      body: '{}',
    });
    assert.equal(logout.status, 200);

    const cleared = logout.headers.getSetCookie();
    assert.deepEqual(
      cleared.map((header) => (header.split('=')[0] ?? '').trim()).sort(),
      ['ats_csrf', 'ats_session'],
    );
    for (const header of cleared) assert.match(header, /Max-Age=0/, `${header} was not expired`);

    // The session is gone server-side, not merely forgotten by the browser.
    const after = await fetch(`${base}/api/jobs`, {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    });
    assert.equal(after.status, 401);
  });
});
