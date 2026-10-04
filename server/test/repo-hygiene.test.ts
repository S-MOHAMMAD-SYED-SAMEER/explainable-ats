import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classify, RATE_LIMITS } from '../src/http/rateLimit.ts';
import { CSRF_COOKIE, SESSION_COOKIE } from '../src/auth/cookies.ts';
import { resolvePortfolioFixture } from './portfolioFixture.ts';

// The repository describes itself in three places a reader trusts without
// checking: the README, the CI workflow, and the names in the source. Each of
// them went stale once — a README that said "no public mutation route exists"
// beside a public POST, rate-limit entries for routes that were never here, a
// session cookie named after a different product. These tests do not prove the
// README is complete; they fail when it names something that is not there, or
// when residue from another project comes back.
//
// Test counts are deliberately NOT checked here. They are a number that has to
// be read off a run, and a test that guessed it would be wrong in the way that
// matters most.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel: string): boolean => fs.existsSync(path.join(ROOT, rel));

const README = read('README.md');

function scripts(pkg: 'server' | 'web'): Record<string, string> {
  return (JSON.parse(read(`${pkg}/package.json`)) as { scripts: Record<string, string> }).scripts;
}

/** Every `backticked` span in the README. */
function backticked(markdown: string): string[] {
  return [...markdown.matchAll(/`([^`\n]+)`/g)].map((match) => match[1] as string);
}

// --- README: what it points at exists ----------------------------------------

/** Tokens that name a file in the portfolio repository, or a build output. */
const NOT_IN_THIS_REPO = new Set(['run.ts', 'web/dist']);

const FILE_EXTENSIONS = /\.(ts|tsx|sql|yml|md|json|example)$/;

/** Where a README path may be relative to: the repo, or a directory it abbreviates. */
const BASES = ['', 'server/src', 'server', 'server/test', 'server/migrations', 'web/src', 'web/test', 'web'];

function looksLikeRepoPath(token: string): boolean {
  if (/\s/.test(token)) return false;
  if (token.startsWith('/') || token.startsWith('..') || token.startsWith('@')) return false;
  if (token.includes('://')) return false; // a URL scheme, such as postgres://
  if (/[*{}$<>=]/.test(token)) return false;
  return token.includes('/') || FILE_EXTENSIONS.test(token.split('::')[0] ?? '');
}

test('every file or directory the README names exists', () => {
  const missing: string[] = [];
  let checked = 0;

  for (const token of new Set(backticked(README))) {
    if (!looksLikeRepoPath(token)) continue;
    const target = (token.split('::')[0] ?? '').replace(/\/$/, '');
    if (NOT_IN_THIS_REPO.has(target)) continue;

    checked += 1;
    if (!BASES.some((base) => exists(path.posix.join(base, target)))) missing.push(token);
  }

  assert.ok(checked > 40, `only ${checked} paths were checked — the scan has stopped finding the README's paths`);
  assert.deepEqual(missing, [], 'the README names files that do not exist');
});

test('every npm command the README tells you to run is a real script', () => {
  const server = scripts('server');
  const web = scripts('web');
  const names = new Set<string>();

  for (const match of README.matchAll(/npm run (?:-s )?([\w:-]+)/g)) names.add(match[1] as string);
  assert.ok(names.size >= 6, 'the scan stopped finding the README\'s npm commands');

  for (const name of names) {
    assert.ok(name in server || name in web, `the README runs "npm run ${name}", which is in neither package.json`);
  }
  // The bare forms.
  assert.ok('test' in server && 'test' in web, 'the README says `npm test` for both packages');
});

// --- README: it does not say what used to be true -----------------------------

test('the README does not repeat claims that were once true or never were', () => {
  const stale: Array<[RegExp, string]> = [
    [/node_modules[^\n]{0,60}(not|aren't) installed/i, 'says dependencies are not installed'],
    [/not been executed in the current environment/i, 'says the commands were never run'],
    [/no public mutation route exists/i, 'denies the one anonymous POST'],
    [/no live HTTP endpoint (that )?accepts/i, 'denies the demo-run endpoint'],
    [/\b14 TypeScript errors\b/i, 'quotes the old typecheck failure count'],
    [/\b(389|346|337) tests\b/i, 'quotes an old test count'],
    [/No Docker, Compose, or CI/i, 'denies the CI workflow'],
    [/reachability has not been verified/i, 'makes an obsolete deployment-reachability claim'],
    [/pinned to `?claude-sonnet-5`? by default/i, 'implies the Anthropic provider works'],
    [/read-only exploration experience/i, 'calls the demo purely read-only'],
  ];

  for (const [pattern, why] of stale) {
    assert.equal(pattern.test(README), false, `the README ${why}`);
  }
});

test('the README names no machine-specific path', () => {
  assert.equal(/(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(README), false, 'contains a drive-letter path');
  assert.equal(/\/(Users|home)\/\w+/.test(README), false, 'contains a home-directory path');
});

test('the README states the things that are true now', () => {
  const required: Array<[RegExp, string]> = [
    [/POST \/api\/demo\/scenarios\/:scenario\/run/, 'the demo-run endpoint'],
    [/isolated[^.]*in-memory[^.]*sandbox/i, 'that it runs in an isolated in-memory sandbox'],
    [/does not write to the canonical database/i, 'that it does not touch canonical state'],
    [/ephemeral/i, 'that sandbox results are ephemeral'],
    [/anthropic[^\n]*not implemented|not implemented[^\n]*anthropic/i, 'that the Anthropic provider is not implemented'],
    [/@anthropic-ai\/sdk[\s\S]{0,120}not imported|not imported[\s\S]{0,120}@anthropic-ai\/sdk/i, 'that the SDK is unused'],
    [/deterministic mock/i, 'that extraction is a deterministic mock'],
    [/no PDF or DOCX parsing/i, 'that there is no PDF/DOCX parsing'],
    [/PORTFOLIO_DEMO_DIR/, 'the parity override'],
    [/\.github\/workflows\/ci\.yml/, 'the CI workflow'],
  ];

  for (const [pattern, what] of required) {
    assert.ok(pattern.test(README), `the README does not state ${what}`);
  }
});

// --- README: the claims that can be checked against the code ------------------

test('the README\'s claims about the code match the code', () => {
  // The demo-run route it documents is the route that exists.
  assert.match(read('server/src/routes/demo.ts'), /'\/demo\/scenarios\/:scenario\/run'/);

  // "The SDK is not imported anywhere" — and it is not.
  const importers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && read(rel).includes('@anthropic-ai/sdk')) importers.push(rel);
    }
  };
  walk('server/src');
  walk('server/scripts');
  walk('web/src');
  assert.deepEqual(importers, [], 'the README says the Anthropic SDK is unused, but something references it');

  // The cookie names and the demo-run budget it quotes.
  assert.ok(README.includes(`\`${SESSION_COOKIE}\``) && README.includes(`\`${CSRF_COOKIE}\``));
  assert.ok(new RegExp(`${RATE_LIMITS.demoRun.limit} per minute`).test(README), 'the README quotes a different demo-run budget');
});

test('the parity lookup order the README documents is the lookup order in the code', () => {
  const { tried } = resolvePortfolioFixture({ repoRoot: ROOT, env: {}, exists: () => false });
  assert.equal(tried.length, 2);

  for (const dir of tried) {
    const relative = path.relative(ROOT, dir).split(path.sep).join('/');
    assert.ok(README.includes(relative), `the README does not document the lookup location ${relative}`);
  }
});

// --- CI: valid in shape, and it runs real commands -----------------------------

const CI_PATH = '.github/workflows/ci.yml';

type CiStep = { run?: string; uses?: string };
type CiJob = { workingDirectory: string; steps: CiStep[]; nodeVersion: string | null; cachePaths: string[] };

/**
 * A reader for exactly the subset of YAML this workflow uses.
 *
 * There is no YAML parser in the dependency tree and one is not worth adding for
 * a single file, so this understands `jobs:` > `<name>:` > `defaults.run.working-directory`
 * and a flat list of steps. If the workflow is restructured beyond that, this
 * reader finds nothing and the assertions below fail loudly rather than pass.
 */
function parseCi(source: string): Map<string, CiJob> {
  const jobs = new Map<string, CiJob>();
  let inJobs = false;
  let current: CiJob | null = null;

  for (const line of source.split(/\r?\n/)) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;

    const job = /^ {2}([\w-]+):\s*$/.exec(line);
    if (job) {
      current = { workingDirectory: '.', steps: [], nodeVersion: null, cachePaths: [] };
      jobs.set(job[1] as string, current);
      continue;
    }
    if (!current) continue;

    const dir = /^\s+working-directory:\s*(\S+)/.exec(line);
    if (dir) current.workingDirectory = dir[1] as string;
    const run = /^\s+- run:\s*(.+?)\s*$/.exec(line);
    if (run) current.steps.push({ run: run[1] as string });
    const uses = /^\s+- uses:\s*(\S+)/.exec(line);
    if (uses) current.steps.push({ uses: uses[1] as string });
    const node = /^\s+node-version:\s*"?(\d+)/.exec(line);
    if (node) current.nodeVersion = node[1] as string;
    const cache = /^\s+cache-dependency-path:\s*(\S+)/.exec(line);
    if (cache) current.cachePaths.push(cache[1] as string);
  }
  return jobs;
}

test('the CI workflow exists, is well-formed, and needs no secrets', () => {
  assert.ok(exists(CI_PATH), 'there is no CI workflow');
  const source = read(CI_PATH);

  assert.equal(/\t/.test(source), false, 'YAML does not allow tab indentation');
  assert.ok(/^name:\s*\S/m.test(source), 'the workflow has no name');
  assert.ok(/^on:\s*$/m.test(source), 'the workflow has no triggers');
  assert.ok(/^jobs:\s*$/m.test(source), 'the workflow has no jobs');
  assert.ok(/^permissions:\s*\n\s+contents:\s*read\s*$/m.test(source), 'the workflow should grant read-only contents access');
  assert.equal(/secrets\./.test(source), false, 'CI should not need a secret');
});

test('the CI workflow runs every check, from the right directory, using real scripts', () => {
  const jobs = parseCi(read(CI_PATH));
  assert.deepEqual([...jobs.keys()].sort(), ['server', 'web'], 'expected exactly a server job and a web job');

  const expected: Record<string, string[]> = {
    server: ['test', 'typecheck', 'lint'],
    web: ['test', 'typecheck', 'lint', 'build'],
  };

  for (const [name, job] of jobs) {
    assert.equal(job.workingDirectory, name, `${name}: runs from the wrong directory`);
    const pkg = name as 'server' | 'web';
    const available = scripts(pkg);

    const runs = job.steps.flatMap((step) => (step.run ? [step.run] : []));
    assert.ok(runs.includes('npm ci'), `${name}: installs with something other than npm ci`);
    assert.ok(exists(`${pkg}/package-lock.json`), `${name}: npm ci needs a lockfile`);

    const invoked = new Set<string>();
    for (const command of runs) {
      if (command === 'npm ci') continue;
      const script = command === 'npm test' ? 'test' : /^npm run ([\w:-]+)$/.exec(command)?.[1];
      assert.ok(script, `${name}: "${command}" is not an npm script invocation`);
      assert.ok(script in available, `${name}: "${command}" is not a script in ${pkg}/package.json`);
      invoked.add(script);
    }
    assert.deepEqual([...invoked].sort(), [...(expected[name] as string[])].sort(), `${name}: runs the wrong set of checks`);

    for (const cachePath of job.cachePaths) assert.ok(exists(cachePath), `${name}: cache path ${cachePath} does not exist`);
  }
});

test('the CI workflow uses only first-party actions and a Node version the server supports', () => {
  const jobs = parseCi(read(CI_PATH));
  const engines = (JSON.parse(read('server/package.json')) as { engines: { node: string } }).engines.node;
  const required = Number(/(\d+)/.exec(engines)?.[1]);
  assert.ok(required >= 24, 'precondition: the server requires a recent Node');

  for (const [name, job] of jobs) {
    for (const step of job.steps) {
      if (step.uses) assert.ok(/^actions\/(checkout|setup-node)@v\d+$/.test(step.uses), `${name}: ${step.uses} is not a first-party action`);
    }
    assert.ok(job.nodeVersion, `${name}: no node-version set`);
    assert.ok(Number(job.nodeVersion) >= required, `${name}: Node ${job.nodeVersion} is older than the ${engines} the server requires`);
  }
});

// --- source: no residue from another project -----------------------------------

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.(ts|tsx|css|html)$/.test(entry.name) ? [rel] : [];
  });
}

test('no source file names another project\'s cookies, routes or documents', () => {
  const residue: Array<[RegExp, string]> = [
    [/inbox_(session|csrf)/, 'an inbox cookie name'],
    [/\/emails\b/, 'an /emails route'],
    [/CLAUDE\.md/, 'a CLAUDE.md that is not in this repository'],
    [/acmecommerce/i, 'another project\'s example domain'],
  ];

  const files = [...sourceFiles('server/src'), ...sourceFiles('server/scripts'), ...sourceFiles('web/src'), 'server/.env.example'];
  assert.ok(files.length > 60, 'the scan found suspiciously few files');

  for (const file of files) {
    const source = read(file);
    for (const [pattern, what] of residue) {
      assert.equal(pattern.test(source), false, `${file} contains ${what}`);
    }
  }
});

test('the rate limiter has no class or path for routes that do not exist', () => {
  assert.deepEqual(Object.keys(RATE_LIMITS).sort(), ['demoRun', 'login', 'mutation']);
  // A path nothing serves is an ordinary mutation, with no special treatment.
  assert.equal(classify('POST', '/emails/decide'), 'mutation');
  assert.equal(classify('POST', '/emails/abc/understand'), 'mutation');
});
