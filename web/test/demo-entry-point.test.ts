import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES, parseRoute, routeToHash } from '../src/router.ts';
import { openingTags, stripComments } from './jsxScan.ts';

// The ATS's demo entry point: ONE "Read-only demo" entry on the sign-in page,
// and it goes to the public demo at `/#/demo`.
//
// This screen used to carry two entries that led to two different demos — a
// button that drew a read-only dashboard over canonical data, and a link to the
// interactive demo. They are one now. These tests pin that there is a single
// entry, that it is an honest one, that it is a route and not a second
// implementation, and that reaching it needs no authentication.
//
// NFR-9 rules out rendering components, so what is checked is source and pure
// functions — the same convention as the rest of this folder.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel: string): string => stripComments(read(rel));
const flat = (rel: string): string => code(rel).replace(/\s+/g, ' ');

function sourceFiles(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// ============================================== the entry navigates to /#/demo

test('the sign-in page\'s read-only demo entry is a link to /#/demo', () => {
  const login = code('screens/Login.tsx');
  const [anchor] = openingTags(login, 'a');

  assert.ok(anchor, 'the sign-in page has no link');
  assert.match(anchor, /href=\{routeToHash\(\{ name: 'demo', id: null \}\)\}/);
  assert.equal(routeToHash({ name: 'demo', id: null }), '#/demo');

  // And that hash is the demo, not the sign-in page's own route or a fallback.
  assert.deepEqual(parseRoute('#/demo'), { name: 'demo', id: null });
  assert.ok(flat('screens/Login.tsx').includes('Browse the read-only demo'));
  assert.match(flat('screens/Login.tsx'), />\s*Read-only demo\s*<\/p>/, 'the entry is headed "Read-only demo"');
});

test('the entry is always offered: it is not conditional on the server\'s read-only window', () => {
  const login = code('screens/Login.tsx');
  assert.doesNotMatch(login, /demoAvailable/);

  // The card is not wrapped in a condition: nothing between the form's end and the card opens one.
  const between = login.slice(login.indexOf('</form>'), login.indexOf('Read-only demo'));
  assert.doesNotMatch(between, /\?\s*\(|&&\s*\(|\bif\s*\(/, 'the demo entry is behind a condition');

  // The sign-in screen takes one prop: how to report that sign-in succeeded.
  assert.match(login, /export function Login\(\{ onSignedIn \}: \{ onSignedIn\(\): void \}\)/);
});

test('following the entry shows the demo to an anonymous visitor, before the sign-in gate', () => {
  const app = code('App.tsx');

  // The demo branch is above the gate, and is chosen by the route alone.
  assert.ok(app.indexOf("route.name === 'demo'") < app.indexOf('<Login'), 'the demo is not ahead of the sign-in gate');
  assert.match(app, /return <DemoEntry demo=\{demoSession\} redirect=\{route\.name === 'demo'\} \/>;/);
});

// ================================================== the redundant link is gone

test('the redundant "Open the interactive demo" link is gone, everywhere', () => {
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    for (const gone of ['Open the interactive demo', 'Just looking?', 'interactive demo — no sign-in', 'No account?']) {
      assert.ok(!source.includes(gone), `${path.relative(SRC, file)} still says "${gone}"`);
    }
  }
});

test('there is exactly one link to the demo in the whole front end, and it is the sign-in page\'s', () => {
  const linking = sourceFiles().filter((file) => /name: 'demo'/.test(stripComments(fs.readFileSync(file, 'utf8'))) && /href=/.test(stripComments(fs.readFileSync(file, 'utf8'))));
  assert.deepEqual(linking.map((f) => path.relative(SRC, f).replace(/\\/g, '/')), ['screens/Login.tsx']);
});

// ================================================== one route, not two demos

test('there is one demo route: no alias, no second implementation, no remembered "browsing" state', () => {
  assert.equal((ROUTES as readonly string[]).filter((r) => r === 'demo').length, 1);
  for (const alias of ['readonly', 'read-only', 'browse', 'demo-readonly', 'interactive']) {
    assert.ok(!(ROUTES as readonly string[]).includes(alias), `a second route: ${alias}`);
    assert.deepEqual(parseRoute(`#/${alias}`), parseRoute('#/nonsense'), `${alias} is treated as a route`);
  }

  const app = code('App.tsx');
  assert.equal(app.split("route.name === 'demo'").length - 1, 2, 'one branch for the demo, one for its redirect prop');
  assert.doesNotMatch(app, /browsingDemo|setBrowsingDemo|onBrowseDemo|onExitDemo/, 'the old read-only browse path is still wired');

  // Only one component draws the demo's front door.
  assert.equal(sourceFiles().filter((f) => /<DemoEntry\b/.test(fs.readFileSync(f, 'utf8'))).length, 1);
});

// ======================================== sign-in is unchanged, auth not needed

test('sign-in is still available and unchanged, beside the demo entry', () => {
  const text = flat('screens/Login.tsx');
  for (const original of ['Operator password', 'type="password"', "{submitting ? 'Signing in…' : 'Sign in'}", 'That did not match. Check the password and try again.']) {
    assert.ok(text.includes(original), `sign-in lost: ${original}`);
  }
  assert.equal(code('screens/Login.tsx').split('await api.login(password)').length - 1, 1);

  // The gate that shows it is as it was.
  assert.match(code('App.tsx'), /if \(session\.state\.status === 'anonymous' && !inDemoSession\) \{\s*return <Login onSignedIn=\{\(\) => void session\.refresh\(\)\} \/>;/);
});

test('reaching /#/demo needs no recruiter authentication', () => {
  const app = code('App.tsx');

  // The branch that serves the demo's front door never consults the operator's session.
  const branch = /if \(route\.name === 'demo'[^\n]*\{/.exec(app)?.[0] ?? '';
  assert.notEqual(branch, '', 'precondition: found the demo branch');
  assert.doesNotMatch(branch, /session\.state|authenticated|operator|status/);

  // Nothing on the demo path signs in, reads a password or needs an operator.
  for (const rel of ['screens/DemoEntry.tsx', 'demo/useDemoSession.ts']) {
    assert.doesNotMatch(code(rel), /api\.login|api\.logout|api\.session\(|operator|password|csrf/i, `${rel} touches sign-in`);
  }
  // And the route fires with an anonymous, unauthenticated visitor: the only thing the
  // app waits for first is the two "is there a session?" answers, neither of which gates it.
  assert.match(app, /session\.state\.status === 'loading' \|\| demoSession\.state\.status === 'checking'/);
});

// ======================================================== honest wording

test('the entry is described honestly: isolated sample data, private demo actions, nothing reaches recruiter records', () => {
  const text = flat('screens/Login.tsx');
  assert.ok(
    text.includes('Explore the ATS using isolated sample data. Demo actions stay private and never affect recruiter records.'),
    'the entry does not carry the agreed description',
  );

  // It must not say anything a visitor's own private decision would contradict, nor the old, false claim.
  for (const false_claim of [
    /recording a decision needs an operator sign-in/i,
    /nothing you do here can change anything/i,
    /cannot change anything/i,
    /read-only: /i,
    /database is read-only/i,
    /real application/i,
  ]) {
    assert.doesNotMatch(text, false_claim, `the entry makes a claim the demo does not keep: ${false_claim}`);
  }
});

// ======================================================== the portfolio's link

const PORTFOLIO_DATA = path.resolve(HERE, '../../../portfolio/src/data/projects.ts');

// Skipped, like the parity suite, wherever the sibling portfolio checkout is absent (CI).
test(
  'the portfolio\'s Explainable ATS links are exactly what they were — this change does not touch them',
  { skip: fs.existsSync(PORTFOLIO_DATA) ? false : 'the sibling portfolio repository is not checked out here' },
  () => {
    const source = fs.readFileSync(PORTFOLIO_DATA, 'utf8');
    const links =
      /interactiveDemoHref:\s*"([^"]+)",\s*demoHref:\s*"([^"]+)",\s*repoHref:\s*"https:\/\/github\.com\/S-MOHAMMAD-SYED-SAMEER\/explainable-ats"/.exec(source);

    assert.ok(links, 'could not find the Explainable ATS entry in the portfolio data');
    assert.equal(links[1], '/demo-explainable-ats.html', 'the portfolio\'s interactive demo link changed');
    assert.equal(links[2], 'https://explainable-ats.onrender.com', 'the portfolio\'s live-app link changed');
  },
);

test('nothing in this repository refers to the portfolio\'s link text or rewrites it', () => {
  for (const file of sourceFiles()) {
    const source = fs.readFileSync(file, 'utf8');
    assert.ok(!source.includes('demo-explainable-ats'), `${path.relative(SRC, file)} references the portfolio's demo page`);
  }
});
