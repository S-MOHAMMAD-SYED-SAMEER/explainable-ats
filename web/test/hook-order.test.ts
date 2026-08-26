import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Hook order — on day one, deliberately.
//
// Project 2 shipped a screen that had never once rendered successfully in a
// browser. A `useState` sat below an early return, so the first render
// registered five hooks and the second registered six: React error #310,
// uncaught, no error boundary, blank white page. It survived 800 passing tests
// because nothing in a `node:test` suite renders a component — NFR-9 rules out
// jsdom, Playwright and Cypress, and that is not going to change here.
//
// So the guard is a source scan. It cannot prove a component renders; it can
// prove the one structural mistake that blanks the app is absent, which is the
// difference between finding this in CI and finding it in front of a client.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

type Finding = { component: string; returnLine: number; hookLine: number };

/**
 * Finds a hook called after an early return.
 *
 * Deliberately callable on a string as well as a file, so the negative controls
 * below can prove it fires. The first version of this scan in Project 2
 * reported a clean result against code that was already broken, because its
 * pattern required `useState(` to be adjacent — and `useState<string | null>(`
 * is not. A scan that cannot fail is worse than no scan.
 */
export function hooksAfterEarlyReturn(source: string): Finding[] {
  const HOOK =
    /\buse(?:State|Effect|Callback|Memo|Ref|Reducer|Context|Transition|DeferredValue|Id|SyncExternalStore)\s*(?:<[^>]*>)?\s*\(/;
  const EARLY_RETURN = /^ {2}(?:if \(.*\)\s*)?return\b|^ {4}return\b/;
  const COMPONENT = /^export function ([A-Z][A-Za-z0-9]*)/;

  const found: Finding[] = [];
  let component: string | null = null;
  let returnLine = 0;

  source.split('\n').forEach((line, index) => {
    const declaration = COMPONENT.exec(line);
    if (declaration) {
      component = declaration[1] ?? null;
      returnLine = 0;
      return;
    }
    if (component === null) return;

    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    if (returnLine === 0 && EARLY_RETURN.test(line) && !line.trimEnd().endsWith('return (')) {
      returnLine = index + 1;
      return;
    }
    if (returnLine !== 0 && HOOK.test(line)) {
      found.push({ component, returnLine, hookLine: index + 1 });
      returnLine = 0;
    }
  });

  return found;
}

function componentFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx')) found.push(full);
    }
  };
  walk(SRC);
  return found;
}

test('NEGATIVE CONTROL — the scan catches the exact shape that shipped in Project 2', () => {
  const broken = [
    'export function Broken({ id }: { id: string }): ReactNode {',
    "  const [state, setState] = useState<LoadState>({ status: 'loading' });",
    '  useEffect(() => { void load(); }, [load]);',
    "  if (state.status === 'loading') return <p>Loading…</p>;",
    // Below the return. Five hooks on the first render, six on the second.
    '  const [refusal, setRefusal] = useState<string | null>(null);',
    '  return <div>{refusal}</div>;',
    '}',
  ].join('\n');

  const findings = hooksAfterEarlyReturn(broken);
  assert.equal(findings.length, 1, 'the scan missed a hook placed after an early return');
  assert.equal(findings[0]?.component, 'Broken');
  assert.equal(findings[0]?.returnLine, 4);
  assert.equal(findings[0]?.hookLine, 5);
});

test('NEGATIVE CONTROL — the same component is accepted once corrected', () => {
  // Without this, the scan could be flagging everything and still "pass".
  const fixed = [
    'export function Fixed({ id }: { id: string }): ReactNode {',
    "  const [state, setState] = useState<LoadState>({ status: 'loading' });",
    '  const [refusal, setRefusal] = useState<string | null>(null);',
    '  useEffect(() => { void load(); }, [load]);',
    "  if (state.status === 'loading') return <p>Loading…</p>;",
    '  return <div>{refusal}</div>;',
    '}',
  ].join('\n');

  assert.deepEqual(hooksAfterEarlyReturn(fixed), []);
});

test('no component calls a hook after an early return', () => {
  const offenders: string[] = [];
  for (const file of componentFiles()) {
    for (const finding of hooksAfterEarlyReturn(fs.readFileSync(file, 'utf8'))) {
      offenders.push(
        `${path.relative(SRC, file).replace(/\\/g, '/')} — ${finding.component}() returns at line ` +
          `${finding.returnLine} then calls a hook at line ${finding.hookLine}`,
      );
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `React error #310 waiting to happen — a hook count that changes between renders:\n${offenders.join('\n')}`,
  );
});

test('the scan actually reads the components it claims to', () => {
  // A scan that walked an empty directory would satisfy the assertion above.
  const files = componentFiles().map((f) => path.relative(SRC, f).replace(/\\/g, '/'));
  assert.ok(files.length >= 3, `the scan found only ${files.length} components`);
  for (const required of [
    'App.tsx',
    'screens/Overview.tsx',
    'components/AppShell.tsx',
    // The recruiter workflow (P3-F). Named explicitly so a renamed or deleted
    // screen drops out of the assertion rather than out of the scan.
    'screens/Jobs.tsx',
    'screens/JobDetail.tsx',
    'screens/CandidateDetail.tsx',
  ]) {
    assert.ok(files.includes(required), `the scan missed ${required}`);
  }
});

// ==================================================== what reaches a browser

test('no secret-shaped string is committed in the client', () => {
  // The browser holds no key and no token: every provider call happens on the
  // server. If this ever fails, something has gone wrong upstream of the client.
  const sources = componentFiles()
    .concat(
      fs
        .readdirSync(path.join(SRC, 'api'))
        .map((name) => path.join(SRC, 'api', name)),
    )
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');

  assert.ok(!/sk-ant-[A-Za-z0-9]{6,}/.test(sources), 'an API key is present in client source');
  assert.ok(!/postgres(?:ql)?:\/\/[^\s"']*:[^\s"']*@/.test(sources), 'a connection string is present in client source');
});

test('the client addresses the API relatively', () => {
  // A baked-in host is the most common way a working local build becomes a
  // broken deploy — and this project is single-origin, so a host is never right.
  const client = fs.readFileSync(path.join(SRC, 'api', 'client.ts'), 'utf8');

  assert.match(client, /['"`]\/api['"`]/, 'the client no longer uses a relative base URL');
  assert.ok(
    !/https?:\/\/[a-zA-Z0-9.:-]+\/api/.test(client),
    'an absolute API host is hardcoded in the client',
  );
});
