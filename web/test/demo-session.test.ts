import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionFromResponse, isAuthenticated, CSRF_COOKIE } from '../src/auth/session.ts';

// The browser's half of the read-only demo.
//
// NFR-9 rules out jsdom and a browser driver, so nothing here renders. What can
// still be proved without one is the part that would actually go wrong: that
// "the demo window is open" can never be mistaken for "this person is signed
// in", and that no credential exists anywhere in this bundle to be mistaken for
// one either.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [full] : [];
  });
}

// ============================================ the sign-in state has no demo in it

test('an anonymous answer is anonymous, and says nothing else', () => {
  const state = sessionFromResponse({ authenticated: false, operator: null, expiresAt: null, csrfToken: null });

  assert.deepEqual(state, { status: 'anonymous' });
  assert.equal(isAuthenticated(state), false, 'an anonymous answer produced an authenticated state');
});

test('a demo flag a stale server might still send can never produce an authenticated state, or any other', () => {
  // Every shape a confused or hostile server could send where the only truthy
  // signal is the retired demo flag. None may sign anybody in, and none changes the state.
  const bodies: unknown[] = [
    { demoAvailable: true },
    { authenticated: false, demoAvailable: true, operator: 'operator' },
    { authenticated: 'true', demoAvailable: true, operator: 'operator' },
    { authenticated: 1, demoAvailable: true, operator: 'operator' },
    { authenticated: true, demoAvailable: true, operator: '' },
    { authenticated: true, demoAvailable: true, operator: null },
  ];

  for (const body of bodies) {
    const state = sessionFromResponse(body);
    assert.equal(isAuthenticated(state), false, JSON.stringify(body));
    assert.deepEqual(state, { status: 'anonymous' }, JSON.stringify(body));
  }
});

test('a malformed answer is anonymous', () => {
  for (const body of [null, undefined, 'nope', 42, [], {}]) {
    assert.deepEqual(sessionFromResponse(body), { status: 'anonymous' }, JSON.stringify(body));
  }
});

test('the session state has three states, and none of them is a demo', () => {
  const source = fs.readFileSync(path.join(SRC, 'auth/session.ts'), 'utf8');
  const type = /export type SessionState =([\s\S]*?);\n/.exec(source)?.[1] ?? '';
  assert.notEqual(type, '', 'precondition: found the type');
  assert.deepEqual([...type.matchAll(/status: '([a-z]+)'/g)].map((m) => m[1]), ['loading', 'anonymous', 'authenticated']);
  assert.doesNotMatch(source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''), /demoAvailable|demo/i);
});

test('a real sign-in still produces an authenticated state', () => {
  const state = sessionFromResponse({
    authenticated: true,
    operator: 'operator',
    expiresAt: '2026-06-01T12:00:00.000Z',
    csrfToken: 'token',
    demoAvailable: true,
  });

  assert.equal(state.status, 'authenticated');
  assert.equal(isAuthenticated(state), true);
  assert.equal(state.status === 'authenticated' && state.operator, 'operator');
});

// ==================================== nothing in the bundle carries a credential

test('no source file contains a password, hash or demo credential', () => {
  const forbidden: readonly [RegExp, string][] = [
    [/scrypt\$/, 'a password hash'],
    [/OPERATOR_PASSWORD_HASH/, 'the credential environment variable'],
    [/demoPassword|DEMO_PASSWORD|demo_password/i, 'a demo password'],
    [/demoToken|DEMO_TOKEN/i, 'a demo token'],
  ];

  for (const file of sourceFiles(SRC)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const [pattern, what] of forbidden) {
      assert.equal(pattern.test(text), false, `${path.relative(SRC, file)} contains ${what}`);
    }
  }
});

test('the sign-in screen sends one credential, and offers no way into the demo', () => {
  // Code only: a comment explaining why the screen has no demo link is not a demo link.
  const login = fs
    .readFileSync(path.join(SRC, 'screens/Login.tsx'), 'utf8')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // The demo is another deployment. If this screen ever links to it, holds a handler
  // for it or calls anything but the one login call, it has become a second way in.
  assert.doesNotMatch(login, /<a\s|href=|routeToHash|onBrowseDemo|[Dd]emo/);

  // Exactly one call, and it is the one the password form makes.
  const calls = login.split('api.login(').length - 1;
  assert.equal(calls, 1, `expected a single api.login call, found ${calls}`);
  assert.ok(login.includes('await api.login(password)'), 'the sign-in path changed shape');
});

// ============================================ the cookie the browser echoes

test('the CSRF cookie the browser reads is the one the server sets', () => {
  // The browser's CSRF_COOKIE is a literal, because it cannot import server
  // code. If the two ever differ, every sign-in succeeds and every decision is
  // then refused with a CSRF failure — which looks like a server bug.
  const serverSource = fs.readFileSync(path.resolve(SRC, '../../server/src/auth/cookies.ts'), 'utf8');
  const serverName = /export const CSRF_COOKIE = '([^']+)'/.exec(serverSource)?.[1];
  assert.ok(serverName, 'could not find CSRF_COOKIE in the server source — this check would be vacuous');
  assert.equal(CSRF_COOKIE, serverName);
});

test('no source file refers to a cookie from another project', () => {
  for (const file of sourceFiles(SRC)) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /inbox_(session|csrf)/, `${file} names an inbox cookie`);
  }
});
