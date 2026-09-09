import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionFromResponse, isAuthenticated } from '../src/auth/session.ts';

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

// ============================================ demoAvailable is not authentication

test('an anonymous answer stays anonymous whether or not the demo is offered', () => {
  for (const demoAvailable of [true, false]) {
    const state = sessionFromResponse({
      authenticated: false,
      operator: null,
      expiresAt: null,
      csrfToken: null,
      demoAvailable,
    });

    assert.equal(state.status, 'anonymous');
    assert.equal(isAuthenticated(state), false, 'an anonymous answer produced an authenticated state');
    assert.equal(state.status === 'anonymous' && state.demoAvailable, demoAvailable);
  }
});

test('demoAvailable alone can never produce an authenticated state', () => {
  // Every shape a confused or hostile server could send where the only truthy
  // signal is the demo flag. None may sign anybody in.
  const bodies: unknown[] = [
    { demoAvailable: true },
    { authenticated: false, demoAvailable: true, operator: 'operator' },
    { authenticated: 'true', demoAvailable: true, operator: 'operator' },
    { authenticated: 1, demoAvailable: true, operator: 'operator' },
    { authenticated: true, demoAvailable: true, operator: '' },
    { authenticated: true, demoAvailable: true, operator: null },
  ];

  for (const body of bodies) {
    assert.equal(isAuthenticated(sessionFromResponse(body)), false, JSON.stringify(body));
  }
});

test('a malformed answer offers no demo and no session', () => {
  for (const body of [null, undefined, 'nope', 42, [], {}]) {
    const state = sessionFromResponse(body);
    assert.equal(state.status, 'anonymous');
    assert.equal(state.status === 'anonymous' && state.demoAvailable, false, JSON.stringify(body));
  }
});

test('the flag must be exactly true, not merely truthy', () => {
  for (const value of ['true', 1, {}, [], 'yes']) {
    const state = sessionFromResponse({ authenticated: false, operator: null, demoAvailable: value });
    assert.equal(state.status === 'anonymous' && state.demoAvailable, false, JSON.stringify(value));
  }
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

test('the demo entry point sends no credentials of its own', () => {
  const login = fs.readFileSync(path.join(SRC, 'screens/Login.tsx'), 'utf8');

  // The demo button hands the app a local view preference and nothing else. If
  // it ever starts calling the login endpoint it has become a sign-in, and a
  // sign-in needs a credential — which is the thing this design exists to
  // avoid having at all.
  assert.ok(
    login.includes('onClick={onBrowseDemo}'),
    'the demo button no longer calls onBrowseDemo directly',
  );

  // Exactly one call, and it is the one the password form makes.
  const calls = login.split('api.login(').length - 1;
  assert.equal(calls, 1, `expected a single api.login call, found ${calls}`);
  assert.ok(login.includes('await api.login(password)'), 'the sign-in path changed shape');
});
