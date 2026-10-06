import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PORTFOLIO_2D_FIXTURE_ENV,
  PORTFOLIO_FIXTURE_ENV,
  resolvePortfolio2dFixture,
  resolvePortfolioFixture,
  skipReason,
} from './portfolioFixture.ts';

// How the parity suite finds the portfolio's demo runner.
//
// The parity tests skip when the runner is absent, and "absent" has to mean
// absent — not "was looked for in the wrong place". The first version of that
// lookup hard-coded a layout this workspace does not have, so the suite skipped
// silently on exactly the machine that could have run it. These tests pin the
// lookup down with an injected `exists`, so they need no sibling checkout.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** A repository root that does not depend on the machine running the test. */
const ROOT = path.resolve('/workspace', 'explainable-ats');
const SIBLING = path.resolve(ROOT, '..', 'sameer-3d-portfolio', 'src', 'demo', 'p3');
const SIBLING_2D = path.resolve(ROOT, '..', 'portfolio', 'src', 'demo', 'p3');
const LEGACY = path.resolve(ROOT, '..', '..', 'sameer-3d-portfolio', 'sameer-3d-portfolio', 'src', 'demo', 'p3');

const present = (...dirs: string[]) => {
  const files = new Set(dirs.map((dir) => path.join(dir, 'run.ts')));
  return (file: string) => files.has(file);
};

test('the standalone layout is found when the portfolio sits beside this repository', () => {
  const lookup = resolvePortfolioFixture({ repoRoot: ROOT, env: {}, exists: present(SIBLING) });
  assert.equal(lookup.dir, SIBLING);
  assert.equal(lookup.runner, path.join(SIBLING, 'run.ts'));
  assert.equal(lookup.explicitButMissing, false);

  // The 2D portfolio's runner is looked for beside this repository too, and its
  // absence is "not found", not a misconfiguration.
  const lookup2d = resolvePortfolio2dFixture({ repoRoot: ROOT, env: {}, exists: present(SIBLING_2D) });
  assert.equal(lookup2d.dir, SIBLING_2D);
  assert.equal(lookup2d.runner, path.join(SIBLING_2D, 'run.ts'));
  const absent = resolvePortfolio2dFixture({ repoRoot: ROOT, env: {}, exists: present() });
  assert.equal(absent.dir, null);
  assert.equal(absent.explicitButMissing, false);
  assert.deepEqual(absent.tried, [SIBLING_2D]);
});

test('the layout from the monorepo days is still found', () => {
  const lookup = resolvePortfolioFixture({ repoRoot: ROOT, env: {}, exists: present(LEGACY) });
  assert.equal(lookup.dir, LEGACY);
});

test('the standalone layout wins when both exist', () => {
  const lookup = resolvePortfolioFixture({ repoRoot: ROOT, env: {}, exists: present(SIBLING, LEGACY) });
  assert.equal(lookup.dir, SIBLING);
});

test('an explicit directory overrides the defaults', () => {
  const elsewhere = path.resolve('/somewhere', 'else', 'p3');
  const lookup = resolvePortfolioFixture({
    repoRoot: ROOT,
    env: { [PORTFOLIO_FIXTURE_ENV]: elsewhere },
    exists: present(elsewhere, SIBLING),
  });
  assert.equal(lookup.dir, elsewhere);

  // The 2D runner has its own override, and a wrong one is not silently replaced.
  const wrong = path.resolve('/nowhere', 'p3');
  const lookup2d = resolvePortfolio2dFixture({
    repoRoot: ROOT,
    env: { [PORTFOLIO_2D_FIXTURE_ENV]: wrong },
    exists: present(SIBLING_2D),
  });
  assert.equal(lookup2d.dir, null);
  assert.equal(lookup2d.explicitButMissing, true);
});

test('a relative override is resolved against the repository root', () => {
  const expected = path.resolve(ROOT, '..', 'portfolio-copy', 'p3');
  const lookup = resolvePortfolioFixture({
    repoRoot: ROOT,
    env: { [PORTFOLIO_FIXTURE_ENV]: '../portfolio-copy/p3' },
    exists: present(expected),
  });
  assert.equal(lookup.dir, expected);
});

test('an explicit directory that holds no runner is a misconfiguration, never a silent fallback', () => {
  const missing = path.resolve('/nowhere', 'p3');
  const lookup = resolvePortfolioFixture({
    repoRoot: ROOT,
    env: { [PORTFOLIO_FIXTURE_ENV]: missing },
    // The default location HAS a runner. It must still not be used.
    exists: present(SIBLING),
  });
  assert.equal(lookup.dir, null);
  assert.equal(lookup.explicitButMissing, true);
  assert.deepEqual(lookup.tried, [missing]);
});

test('with nothing present, the lookup reports every place it looked, and is not an error', () => {
  const lookup = resolvePortfolioFixture({ repoRoot: ROOT, env: {}, exists: () => false });
  assert.equal(lookup.dir, null);
  assert.equal(lookup.runner, null);
  assert.equal(lookup.explicitButMissing, false);
  assert.deepEqual(lookup.tried, [SIBLING, LEGACY]);

  const reason = skipReason(lookup);
  assert.ok(reason.includes(SIBLING) && reason.includes(LEGACY), 'the skip message named neither location');
  assert.ok(reason.includes(PORTFOLIO_FIXTURE_ENV), 'the skip message did not name the override');
});

test('a blank override is ignored rather than treated as a path', () => {
  const lookup = resolvePortfolioFixture({
    repoRoot: ROOT,
    env: { [PORTFOLIO_FIXTURE_ENV]: '   ' },
    exists: present(SIBLING),
  });
  assert.equal(lookup.dir, SIBLING);
});

test('every default candidate is derived from the repository root', () => {
  const lookup = resolvePortfolioFixture({ repoRoot: REPO_ROOT, env: {}, exists: () => false });
  assert.deepEqual(lookup.tried, [
    path.resolve(REPO_ROOT, '..', 'sameer-3d-portfolio', 'src', 'demo', 'p3'),
    path.resolve(REPO_ROOT, '..', '..', 'sameer-3d-portfolio', 'sameer-3d-portfolio', 'src', 'demo', 'p3'),
  ]);
  assert.ok(lookup.tried.every((dir) => path.isAbsolute(dir)));
});
