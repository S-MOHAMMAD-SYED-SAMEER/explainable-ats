import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_MODES, isAppMode, modeFromHealth, MODE_UNKNOWN_MESSAGE } from '../src/mode.ts';
import { DEFAULT_ROUTE, DEMO_DEFAULT_ROUTE, DEMO_ROUTES, RECRUITER_ROUTES, parseRoute } from '../src/router.ts';
import { resolveApiPath } from '../src/demo/session.ts';
import { openingTags, stripComments } from './jsxScan.ts';

// Deployment mode (Phase 3C.8), from the browser's side.
//
// ONE BUNDLE, TWO DEPLOYMENTS. The real application and the portfolio demo serve
// the same built client, so which one a page is talking to is not something the
// bundle can know: it asks `GET /api/health`, and draws the matching half. These
// tests pin the three things that make that safe — the answer is read strictly
// and never guessed, each half draws only its own screens, and nothing of the
// retired read-only demo is left to be reached.
//
// NFR-9 rules out rendering components, so what is checked is pure functions and
// source — the same convention as the rest of this folder.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
const code = (rel: string): string => stripComments(read(rel));

function sourceFiles(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// ===================================================== reading the mode, strictly

test('the two modes are exactly the server\'s two', () => {
  assert.deepEqual([...APP_MODES], ['app', 'demo']);
  assert.equal(isAppMode('app'), true);
  assert.equal(isAppMode('demo'), true);
  for (const other of ['', 'APP', 'Demo', ' demo', 'demo ', 'production', 'both', null, undefined, 1, {}, ['demo']]) {
    assert.equal(isAppMode(other), false, JSON.stringify(other));
  }

  // And they are the ones the server reports, read from its own source.
  const server = fs.readFileSync(path.resolve(HERE, '../../server/src/config/mode.ts'), 'utf8');
  const declared = /APP_MODES = \[([^\]]*)\] as const/.exec(server)?.[1] ?? '';
  assert.deepEqual([...declared.matchAll(/'([a-z]+)'/g)].map((m) => m[1]), [...APP_MODES], 'the client and the server disagree about the modes');
});

test('the mode is read from the health answer, and from nowhere else', () => {
  const base = { status: 'ok', database: null, adapters: {}, version: '0.1.0' };
  assert.equal(modeFromHealth({ ...base, mode: 'app' }), 'app');
  assert.equal(modeFromHealth({ ...base, mode: 'demo' }), 'demo');
});

test('an answer with no mode, an unknown one or a malformed one names no mode — it is never defaulted', () => {
  const unknown: unknown[] = [
    null, undefined, '', 'demo', 'app', 42, true, [], ['demo'],
    {},
    { status: 'ok' },
    { mode: null },
    { mode: '' },
    { mode: 'Demo' },
    { mode: ' demo' },
    { mode: 'DEMO' },
    { mode: 'production' },
    { mode: ['demo'] },
    { mode: { name: 'demo' } },
    { mode: 1 },
    // An old server, from before there was a mode, answers like this — the page must not assume.
    { status: 'ok', database: { driver: 'sqlite', reachable: true, migrationsApplied: 2 }, adapters: { llmProvider: 'mock' }, version: '0.1.0' },
  ];
  for (const body of unknown) assert.equal(modeFromHealth(body), null, JSON.stringify(body));
});

test('when the mode cannot be learned the page says so and offers a retry, and draws neither product', () => {
  const app = code('App.tsx');

  // Both outcomes that are not "ready" end in a message — not in a sign-in, not in the demo.
  assert.match(app, /mode\.state\.status === 'loading'/);
  assert.match(app, /mode\.state\.status === 'error'/);
  assert.match(app, /onClick=\{mode\.retry\}/);
  assert.match(app, /\{mode\.state\.message\}/);
  assert.match(app, /return mode\.state\.mode === 'demo' \? <DemoApp \/> : <RecruiterApp \/>;/);
  assert.ok(MODE_UNKNOWN_MESSAGE.length > 20 && !/sign in|demo/i.test(MODE_UNKNOWN_MESSAGE));

  // The two products are drawn in exactly one place each, and only from a ready answer.
  const returns = [...app.matchAll(/return[\s\S]*?;\n/g)].map((m) => m[0]);
  assert.equal(returns.filter((r) => r.includes('<DemoApp')).length, 1);
  assert.equal(returns.filter((r) => r.includes('<RecruiterApp')).length, 1);
  assert.doesNotMatch(app, /<Login|<DemoEntry|<AppShell/, 'App draws a product\'s screen itself');
});

test('the hook asks the server, once, and keeps nothing: no storage, no URL, no build-time flag', () => {
  const hook = code('useMode.ts');
  assert.match(hook, /api\s*\.health\(\)/);
  assert.match(hook, /modeFromHealth\(body\)/);
  assert.doesNotMatch(hook, /localStorage|sessionStorage|indexedDB|document\.cookie|location\./);

  // A build-time flag would be right for one deployment and wrong for the other.
  for (const file of sourceFiles()) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    assert.doesNotMatch(text, /import\.meta\.env|process\.env|\bVITE_[A-Z_]+/, `${path.relative(SRC, file)} reads a build-time setting`);
  }
  const vite = fs.readFileSync(path.resolve(HERE, '../vite.config.ts'), 'utf8');
  assert.doesNotMatch(vite, /define\s*:|APP_MODE|VITE_/, 'the build bakes the mode in');
});

test('health is reached the same way in both scopes, so the question can be asked before the answer is known', () => {
  for (const scope of ['recruiter', 'demo'] as const) assert.equal(resolveApiPath('/health', scope), '/health');
  assert.match(code('api/client.ts'), /health: \(\): Promise<Health> => request<Health>\('\/health'\)/);
  assert.match(code('api/types.ts'), /mode: 'app' \| 'demo';/);
});

// ============================================================== each half is its own

test('the recruiter application is the sign-in gate and the recruiter\'s screens, and nothing of the demo', () => {
  const app = code('RecruiterApp.tsx');

  assert.ok(app.includes('<Login'));
  assert.ok(app.includes('<Overview />') && app.includes('<Jobs />') && app.includes('<JobDetail') && app.includes('<CandidateDetail'));
  assert.match(app, /setApiScope\('recruiter'\)/);
  assert.match(app, /useRoute\(RECRUITER_ROUTES, DEFAULT_ROUTE\)/);
  assert.doesNotMatch(app, /[Dd]emo/, 'the application mentions the demo');
});

test('the demo is the project explanation, then the dashboard in the visitor\'s own session, and nothing of sign-in', () => {
  const app = code('DemoApp.tsx');

  assert.ok(app.includes('<DemoEntry'));
  assert.ok(app.includes('<Jobs />') && app.includes('<JobDetail') && app.includes('<CandidateDetail'));
  assert.ok(!app.includes('<Overview'), 'the Status screen is drawn in the demo');
  assert.match(app, /setApiScope\('demo'\)/);
  assert.match(app, /useRoute\(DEMO_ROUTES, DEMO_DEFAULT_ROUTE\)/);
  assert.doesNotMatch(app, /Login|useSession\b|operator|password|api\.login|api\.logout/i, 'the demo draws or handles a sign-in');
  // Leaving goes back to page one.
  assert.match(app, /navigate\(DEMO_DEFAULT_ROUTE\)/);
});

test('application mode shows sign-in and no demo link anywhere a stranger can see', () => {
  for (const rel of ['screens/Login.tsx', 'RecruiterApp.tsx', 'screens/Jobs.tsx', 'screens/JobDetail.tsx', 'screens/Overview.tsx']) {
    const source = code(rel);
    // No link to the demo's route, in any form.
    assert.doesNotMatch(source, /name:\s*'demo'/, `${rel} links to the demo route`);
    assert.deepEqual(openingTags(source, 'a').filter((tag) => /demo/i.test(tag)), [], `${rel} has a demo link`);
  }
  // And the only link to the demo route in the whole client is the demo's own.
  const linking = sourceFiles().filter((file) => /name:\s*'demo'/.test(stripComments(fs.readFileSync(file, 'utf8'))));
  assert.deepEqual(
    linking.map((f) => path.relative(SRC, f).replace(/\\/g, '/')).sort(),
    ['router.ts'].sort(),
    'something other than the router names the demo route',
  );
});

test('demo mode has no Status screen and no navigation: Page 1, then the dashboard, and Exit returns to Page 1', () => {
  assert.deepEqual([...DEMO_ROUTES], ['demo', 'jobs', 'candidates']);
  assert.ok(!(DEMO_ROUTES as readonly string[]).includes('overview'));
  assert.deepEqual(DEMO_DEFAULT_ROUTE, { name: 'demo', id: null });
  assert.deepEqual(parseRoute('#/overview', { allowed: DEMO_ROUTES, fallback: DEMO_DEFAULT_ROUTE }), DEMO_DEFAULT_ROUTE);

  const shell = code('components/AppShell.tsx');
  // The navigation is drawn for the application only.
  assert.match(shell, /\{demoSession \? null : \(\s*<nav aria-label="Sections"/);
  assert.doesNotMatch(shell, /Read-only demo|onExitDemo/);
  // The header controls differ by which group of props arrived — there is no third combination.
  assert.match(shell, /\{demoSession \? \(\s*<>/);
  assert.match(shell, /Sign out/);
  assert.doesNotMatch(shell, /Sign in\b/);

  assert.deepEqual([...RECRUITER_ROUTES], ['overview', 'jobs', 'candidates']);
  assert.deepEqual(parseRoute('#/demo', { allowed: RECRUITER_ROUTES, fallback: DEFAULT_ROUTE }), DEFAULT_ROUTE);
});

// ============================================================ the retired read-only demo

test('nothing of the retired read-only demo is left in the client', () => {
  const retired = [
    /DemoRunner/,
    /runDemoScenario/,
    /browsingDemo|setBrowsingDemo|onBrowseDemo|onExitDemo/,
    /demoAvailable/,
    /demoSessionInUse/,
    /DEMO_PUBLIC_READONLY|PUBLIC_DEMO_READS/,
    /Read-only demo|read-only demo|read-only window/,
    /Browse the read-only demo/,
    /\/demo\/scenarios\//,
  ];
  for (const file of sourceFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of retired) assert.doesNotMatch(text, pattern, `${path.relative(SRC, file)} still has ${pattern}`);
  }
  assert.equal(fs.existsSync(path.join(SRC, 'components/DemoRunner.tsx')), false);
  assert.equal(fs.existsSync(path.join(HERE, 'demo-runner.test.ts')), false);
});

test('the session-based interactive demo is still all there', () => {
  // The pieces a visitor uses, by name: session lifecycle, ranking, evidence, pipeline, timeline, decision.
  for (const [rel, needle] of [
    ['api/client.ts', 'startDemoSession'],
    ['api/client.ts', 'resetDemoSession'],
    ['api/client.ts', 'endDemoSession'],
    ['api/client.ts', 'evaluationResume'],
    ['demo/useDemoSession.ts', 'useDemoSession'],
    ['screens/DemoEntry.tsx', 'DemoEntry'],
    ['screens/CandidateDetail.tsx', 'DemoPipelineSection'],
    ['screens/CandidateDetail.tsx', 'DemoResumeSection'],
    ['screens/CandidateDetail.tsx', 'DemoTimelineSection'],
    ['screens/CandidateDetail.tsx', 'demoDecidable'],
    ['components/DemoOverview.tsx', 'DemoOverview'],
    ['components/DemoGuide.tsx', 'DemoGuide'],
  ] as const) {
    assert.ok(read(rel).includes(needle), `${rel} lost ${needle}`);
  }
});

// ======================================================== the portfolio is left alone

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
