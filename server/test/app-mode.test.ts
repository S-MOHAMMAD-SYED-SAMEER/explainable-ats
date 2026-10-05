import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.ts';
import { ConfigError, configSummary, loadConfig } from '../src/config/env.ts';
import { APP_MODES, DEFAULT_APP_MODE, capabilitiesOf, isAppMode } from '../src/config/mode.ts';
import { handleHealth } from '../src/handlers/health.ts';
import { RATE_LIMITS } from '../src/http/rateLimit.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { hashPassword } from '../src/lib/password.ts';
import { DEMO_SESSION_COOKIE } from '../src/routes/demoSession.ts';
import { CSRF_HEADER } from '../src/auth/csrf.ts';
import { createTestContext } from './helpers.ts';
import { PASSWORD, SECRET_API_KEY, withHarness } from './demoHarness.ts';

// The deployment-mode boundary (Phase 3C.8).
//
// WHAT THIS FILE IS DEFENDING
//
// One codebase is deployed twice, as two products: the real application
// (`APP_MODE=app`) and the portfolio demo (`APP_MODE=demo`). The boundary between
// them has to hold by construction, not by habit — so these tests do not ask "does
// the demo refuse a recruiter request?" but "is there a recruiter route in the
// demo at all?", and the same the other way round. Everything that can be checked
// is checked over real HTTP against an app built exactly as production builds it;
// the boot checks start the real server as a real child process.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SERVER_ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// ============================================================ the mode itself

test('there are exactly two modes, and the real application is the default', () => {
  assert.deepEqual([...APP_MODES], ['app', 'demo']);
  assert.equal(DEFAULT_APP_MODE, 'app');
  assert.equal(loadConfig({}).config.appMode, 'app');
  assert.equal(loadConfig({ APP_MODE: '' }).config.appMode, 'app', 'an empty value is an unset one');
  assert.equal(loadConfig({ APP_MODE: '   ' }).config.appMode, 'app');

  assert.equal(isAppMode('app'), true);
  assert.equal(isAppMode('demo'), true);
  for (const other of ['', 'APP', 'production', 'both', undefined, null, 1, {}]) assert.equal(isAppMode(other), false);
});

test('what each mode may do is stated once, and the two are opposites', () => {
  const app = capabilitiesOf('app');
  const demo = capabilitiesOf('demo');

  assert.deepEqual(app, {
    authentication: true,
    recruiterRoutes: true,
    canonicalDatabase: true,
    demoRoutes: false,
    demoSessionStore: false,
  });
  assert.deepEqual(demo, {
    authentication: false,
    recruiterRoutes: false,
    canonicalDatabase: false,
    demoRoutes: true,
    demoSessionStore: true,
  });

  // Nothing is shared: no capability is on in both modes.
  for (const key of Object.keys(app) as Array<keyof typeof app>) {
    assert.notEqual(app[key], demo[key], `${key} is the same in both modes`);
  }
  assert.ok(Object.isFrozen(app) && Object.isFrozen(demo), 'a capability table that can be edited at runtime is not a boundary');
});

test('APP_MODE is tolerant of case and surrounding space, and nothing else', () => {
  assert.equal(loadConfig({ APP_MODE: 'demo' }).config.appMode, 'demo');
  assert.equal(loadConfig({ APP_MODE: ' DEMO ' }).config.appMode, 'demo');
  assert.equal(loadConfig({ APP_MODE: 'App' }).config.appMode, 'app');
});

test('an invalid APP_MODE is refused outright, never defaulted, and the value is not echoed', () => {
  for (const bad of ['production', 'both', 'demo,app', 'demos', 'live', 'true', '1', 'sk-ant-secret-looking-value']) {
    assert.throws(
      () => loadConfig({ APP_MODE: bad }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError, `${bad} did not throw a ConfigError`);
        assert.match(err.message, /APP_MODE/);
        assert.match(err.message, /app, demo/, 'the message does not say what is allowed');
        assert.ok(!err.message.includes(bad), `the message echoed ${JSON.stringify(bad)}`);
        return true;
      },
    );
  }
});

// ===================================================== demo mode: what is refused

const FORBIDDEN_VALUES = {
  DATABASE_URL: 'postgresql://someone:hunter2-database-secret@db.example.test/appdb',
  OPERATOR_PASSWORD_HASH: 'scrypt$32768$8$1$c2VjcmV0LXNhbHQ$c2VjcmV0LWhhc2gtdmFsdWU',
  ANTHROPIC_API_KEY: 'sk-ant-api03-do-not-print-this-key',
} as const;

test('a clean demo configuration is built with every dependency forced to its safe value', () => {
  const { config, problems } = loadConfig({ APP_MODE: 'demo' });

  assert.equal(config.appMode, 'demo');
  assert.equal(config.databaseUrl, null);
  assert.equal(config.dbDriver, 'sqlite');
  assert.equal(config.sqlitePath, ':memory:', 'the demo must not name a file');
  assert.equal(config.operatorPasswordHash, null);
  assert.equal(config.anthropicApiKey, null);
  assert.equal(config.llmProvider, 'mock');
  assert.deepEqual(problems.filter((p) => /OPERATOR_PASSWORD_HASH|sign in/.test(p)), [], 'the demo warns about a password it must not have');
});

test('demo mode refuses each forbidden setting, by name, and never prints a value', () => {
  for (const [name, value] of Object.entries(FORBIDDEN_VALUES)) {
    assert.throws(
      () => loadConfig({ APP_MODE: 'demo', [name]: value }),
      (err: unknown) => {
        assert.ok(err instanceof ConfigError, `${name} did not stop the demo`);
        assert.match(err.message, new RegExp(name));
        assert.ok(!err.message.includes(value), `the refusal printed the value of ${name}`);
        return true;
      },
    );
  }
});

test('demo mode refuses all of them at once, naming all of them', () => {
  assert.throws(
    () =>
      loadConfig({
        APP_MODE: 'demo',
        ...FORBIDDEN_VALUES,
        LLM_PROVIDER: 'anthropic',
        SQLITE_PATH: '/var/data/explainable-ats.sqlite',
      }),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError);
      for (const name of [...Object.keys(FORBIDDEN_VALUES), 'LLM_PROVIDER', 'SQLITE_PATH']) {
        assert.match(err.message, new RegExp(name), `${name} was not named`);
      }
      for (const value of [...Object.values(FORBIDDEN_VALUES), '/var/data/explainable-ats.sqlite']) {
        assert.ok(!err.message.includes(value), 'a value was printed');
      }
      assert.equal(err.problems.length, 5);
      return true;
    },
  );
});

test('demo mode accepts the harmless spellings of the safe values, and only those', () => {
  for (const env of [{ LLM_PROVIDER: 'mock' }, { LLM_PROVIDER: 'MOCK' }, { SQLITE_PATH: ':memory:' }, { DATABASE_URL: '' }, { DATABASE_URL: '   ' }, { ANTHROPIC_API_KEY: '' }]) {
    assert.doesNotThrow(() => loadConfig({ APP_MODE: 'demo', ...env }), JSON.stringify(env));
  }
  for (const env of [{ LLM_PROVIDER: 'anthropic' }, { LLM_PROVIDER: 'something-else' }, { SQLITE_PATH: 'demo.sqlite' }, { SQLITE_PATH: './:memory:' }]) {
    assert.throws(() => loadConfig({ APP_MODE: 'demo', ...env }), ConfigError, JSON.stringify(env));
  }
});

test('the same variables are still ordinary settings in app mode', () => {
  const { config } = loadConfig({ ...FORBIDDEN_VALUES, LLM_PROVIDER: 'anthropic' });
  assert.equal(config.appMode, 'app');
  assert.equal(config.dbDriver, 'postgres');
  assert.equal(config.llmProvider, 'anthropic');
  assert.notEqual(config.operatorPasswordHash, null);

  // And app mode still collects problems rather than throwing, as before.
  const bare = loadConfig({});
  assert.ok(bare.problems.some((p) => /OPERATOR_PASSWORD_HASH/.test(p)));
});

test('the retired read-only switch is not a setting any more, and setting it changes nothing', () => {
  const on = loadConfig({ DEMO_PUBLIC_READONLY: 'true' }).config;
  const off = loadConfig({}).config;
  assert.deepEqual(on, off);
  assert.ok(!('demoPublicReadonly' in on));
  assert.ok(!('demoPublicReadonly' in configSummary(on)));
});

// ================================================================== health

test('health says which product it is, in both modes', async () => {
  const { db, close } = await createTestContext();
  try {
    const app = await handleHealth({ db, config: loadConfig({}).config });
    assert.equal(app.status, 200);
    assert.equal(app.body.mode, 'app');
    assert.equal(app.body.database?.reachable, true);

    const demo = await handleHealth({ config: loadConfig({ APP_MODE: 'demo' }).config });
    assert.equal(demo.status, 200);
    assert.equal(demo.body.mode, 'demo');
    assert.equal(demo.body.status, 'ok');
    assert.equal(demo.body.database, null, 'the demo has no database to report on');
    assert.equal(demo.body.adapters.llmProvider, 'mock');
    assert.equal(demo.body.adapters.authConfigured, false);
  } finally {
    await close();
  }
});

test('the demo ignores a database it is handed, and reports no database, and no secret', async () => {
  const { db, close } = await createTestContext();
  try {
    const demo = await handleHealth({ db, config: loadConfig({ APP_MODE: 'demo' }).config });
    assert.equal(demo.body.database, null);
    const text = JSON.stringify(demo.body);
    for (const secret of [SECRET_API_KEY, PASSWORD, 'scrypt$', 'sqlite', 'postgres']) {
      assert.ok(!text.toLowerCase().includes(secret.toLowerCase()), `health said ${secret}`);
    }
  } finally {
    await close();
  }
});

// ================================================ an app is one product, wired right

test('a process is one product: the wrong dependencies are refused when the app is built', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const { logger } = createMemoryLogger();
  const app = loadConfig({}).config;
  const demo = loadConfig({ APP_MODE: 'demo' }).config;

  assert.throws(() => createApp({ config: app, logger }), /needs a database/);
  assert.throws(() => createApp({ db: ctx.db, config: demo, logger }), /must not be given a canonical database/);
  assert.throws(
    () => createApp({ db: ctx.db, config: app, logger, demoSessions: { size: 0 } as never }),
    /does not run demo sessions/,
  );
  assert.throws(() => createApp({ config: demo, logger, provider: {} as never }), /does not use a model provider/);

  assert.doesNotThrow(() => createApp({ db: ctx.db, config: app, logger }));
  assert.doesNotThrow(() => createApp({ config: demo, logger }));
});

// ================================================== the route boundary, over HTTP

const OPERATOR_ROUTES = [
  ['GET', '/api/jobs'],
  ['GET', '/api/jobs/job-1'],
  ['GET', '/api/jobs/job-1/ranking'],
  ['GET', '/api/evaluations/evaluation-1'],
  ['GET', '/api/evaluations/evaluation-1/audit'],
  ['POST', '/api/evaluations/evaluation-1/decision'],
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/logout'],
  ['GET', '/api/auth/session'],
] as const;

const DEMO_ROUTES = [
  ['POST', '/api/demo/session'],
  ['GET', '/api/demo/session'],
  ['POST', '/api/demo/session/reset'],
  ['DELETE', '/api/demo/session'],
  ['GET', '/api/demo/session/jobs'],
  ['GET', '/api/demo/session/jobs/job-1'],
  ['GET', '/api/demo/session/jobs/job-1/ranking'],
  ['GET', '/api/demo/session/evaluations/evaluation-1'],
  ['GET', '/api/demo/session/evaluations/evaluation-1/audit'],
  ['GET', '/api/demo/session/evaluations/evaluation-1/resume'],
  ['POST', '/api/demo/session/evaluations/evaluation-1/decision'],
] as const;

test('DEMO MODE: no recruiter or sign-in route exists, whatever is presented with it', async () => {
  await withHarness(async (h) => {
    const { token } = await h.start();
    const op = await h.operator();
    const nonsense = await h.call('GET', '/api/this-route-was-never-written');
    assert.equal(nonsense.status, 404);

    for (const [method, p] of OPERATOR_ROUTES) {
      const attempts = [
        ['anonymous', await h.call(method, p)],
        ['with a demo cookie', await h.call(method, p, { token })],
        // A real operator's session and CSRF token — valid on the OTHER deployment.
        ['with an operator cookie', await h.call(method, p, { rawCookie: op.cookie })],
      ] as const;

      for (const [how, reply] of attempts) {
        assert.equal(reply.status, 404, `${method} ${p} ${how} answered ${reply.status}`);
        assert.deepEqual(reply.body, nonsense.body, `${method} ${p} ${how} answered differently from a path that never existed`);
        assert.deepEqual(reply.cookies, [], `${method} ${p} ${how} set a cookie`);
      }
    }

    // A forged CSRF header on a real operator session changes nothing either.
    const forged = await fetch(`${h.base}/api/evaluations/evaluation-1/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: op.cookie, [CSRF_HEADER]: op.csrf },
      body: JSON.stringify({ outcome: 'shortlist', reason: 'Not a route on the demo at all.' }),
    });
    assert.equal(forged.status, 404);
  });
});

test('DEMO MODE: sign-in cannot be attempted — there is no password to guess and no route to guess it at', async () => {
  await withHarness(async (h) => {
    for (const body of [{ password: 'anything' }, { password: PASSWORD }, {}]) {
      const reply = await h.call('POST', '/api/auth/login', { body });
      assert.equal(reply.status, 404);
      assert.deepEqual(reply.cookies, []);
    }
  });
});

test('DEMO MODE: the routes the demo is for exist, and are reachable with no credential', async () => {
  await withHarness(async (h) => {
    const started = await h.start();
    assert.equal(started.reply.status, 201);
    assert.equal((await h.call('GET', '/api/demo/session', { token: started.token })).body.active, true);
    assert.equal((await h.call('GET', '/api/demo/session/jobs', { token: started.token })).status, 200);

    // Every documented path is a route: none of them is a 404, even for a visitor
    // with no session (which is a 401 or a 200, never "not found").
    for (const [method, p] of DEMO_ROUTES) {
      const reply = await h.call(method, p);
      assert.notEqual(reply.status, 404, `${method} ${p} is not registered in demo mode`);
    }
  });
});

test('DEMO MODE: health is the one shared route, and reports the mode', async () => {
  await withHarness(async (h) => {
    const reply = await h.call<{ mode: string; status: string; database: unknown }>('GET', '/api/health');
    assert.equal(reply.status, 200);
    assert.equal(reply.body.mode, 'demo');
    assert.equal(reply.body.status, 'ok');
    assert.equal(reply.body.database, null);
  });
});

test('APP MODE: no demo route exists — signed in or not — and it answers like a path that never existed', async () => {
  await withHarness(async (h) => {
    const { token } = await h.start();
    const op = await h.operator();

    const strangerNonsense = await h.callApp('GET', '/api/this-route-was-never-written');
    const operatorNonsense = await fetch(`${h.appBase}/api/this-route-was-never-written`, { headers: { cookie: op.cookie } });
    const operatorNonsenseBody = await operatorNonsense.json();
    assert.equal(operatorNonsense.status, 404);

    for (const [method, p] of DEMO_ROUTES) {
      // A stranger is answered exactly as for any other unknown path: by the
      // sign-in gate. Nothing distinguishes a demo path from a made-up one.
      const stranger = await h.callApp(method, p, { token });
      assert.equal(stranger.status, strangerNonsense.status, `${method} ${p} told a stranger something`);
      assert.deepEqual(stranger.body, strangerNonsense.body, `${method} ${p} told a stranger something`);
      assert.deepEqual(stranger.cookies, [], `${method} ${p} set a cookie`);

      // A signed-in operator, with their CSRF token, finds there is no such route.
      const reply = await fetch(`${h.appBase}/api/${p.slice('/api/'.length)}`, {
        method,
        headers: { 'content-type': 'application/json', cookie: `${op.cookie}; ${DEMO_SESSION_COOKIE}=${token}`, [CSRF_HEADER]: op.csrf },
        ...(method === 'GET' ? {} : { body: '{}' }),
      });
      assert.equal(reply.status, 404, `${method} ${p} is a route in app mode`);
      assert.deepEqual(await reply.json(), operatorNonsenseBody, `${method} ${p} answered differently from a path that never existed`);
      assert.deepEqual(reply.headers.getSetCookie(), [], `${method} ${p} set a cookie`);
    }
  });
});

test('APP MODE: starting a demo session is impossible, so no demo cookie is ever issued', async () => {
  await withHarness(async (h) => {
    const op = await h.operator();
    const started = await fetch(`${h.appBase}/api/demo/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: op.cookie, [CSRF_HEADER]: op.csrf },
      body: '{}',
    });
    assert.equal(started.status, 404);
    assert.ok(!started.headers.getSetCookie().some((c) => c.startsWith(`${DEMO_SESSION_COOKIE}=`)));
  });
});

test('APP MODE: the recruiter routes are all behind the gate, and there is no anonymous window', async () => {
  await withHarness(async (h) => {
    for (const [method, p] of OPERATOR_ROUTES) {
      if (p === '/api/auth/login' || p === '/api/auth/session' || p === '/api/auth/logout') continue;
      const reply = await h.callApp(method, p);
      assert.equal(reply.status, 401, `${method} ${p} was served to a stranger`);
    }
    // Sign-in's own routes are reachable, and answer "no" rather than 401.
    const session = await h.callApp<{ authenticated: boolean }>('GET', '/api/auth/session');
    assert.equal(session.status, 200);
    assert.equal(session.body.authenticated, false);
    assert.ok(!('demoAvailable' in session.body), 'the session answer still offers a demo');
  });
});

test('APP MODE: health reports the mode and the canonical database', async () => {
  await withHarness(async (h) => {
    const reply = await h.callApp<{ mode: string; status: string; database: { reachable: boolean } | null }>('GET', '/api/health');
    assert.equal(reply.body.mode, 'app');
    assert.equal(reply.body.status, 'ok');
    assert.equal(reply.body.database?.reachable, true);
  });
});

// ================================================== structure, scanned in the source

test('demo mode is wired only inside the demo branch, and app mode only inside its own', () => {
  const source = read('src/app.ts');
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const code = strip(source);

  const application = /function mountApplication[\s\S]*?\n}\n/.exec(code)?.[0] ?? '';
  const demo = /function mountDemo[\s\S]*?\n}\n/.exec(code)?.[0] ?? '';
  assert.notEqual(application, '', 'precondition: found the application wiring');
  assert.notEqual(demo, '', 'precondition: found the demo wiring');

  // The session store and the demo router exist only in the demo's wiring.
  for (const needle of ['createDemoSessionStore(', 'createDemoSessionRouter(']) {
    assert.equal(code.split(needle).length - 1, 1, `${needle} is called more than once`);
    assert.ok(demo.includes(needle), `${needle} is not in the demo wiring`);
    assert.ok(!application.includes(needle), `${needle} is in the application wiring`);
  }

  // And the other way: sign-in, sessions, CSRF and the recruiter API are the application's alone.
  for (const needle of ['attachSession(', 'requireSession(', 'requireCsrf(', 'createAuthRouter(', 'createRecruiterRouter(', 'createRepositories(', 'createLlmProvider(']) {
    assert.equal(code.split(needle).length - 1, 1, `${needle} is called more than once`);
    assert.ok(application.includes(needle), `${needle} is not in the application wiring`);
    assert.ok(!demo.includes(needle), `${needle} is in the demo wiring`);
  }

  // The demo's router is never handed a repository — a demo process has none.
  assert.doesNotMatch(demo, /repos|\bdb\b/);

  // Both are chosen by the mode's capabilities, not by a string comparison scattered about.
  assert.match(code, /can\.canonicalDatabase && db/);
  assert.match(code, /can\.demoSessionStore/);
});

test('the demo only ever opens in-memory databases, and never reads the canonical configuration', () => {
  const files = ['src/demo/sessions.ts', 'src/demo/seed.ts', 'src/routes/demoSession.ts', 'src/handlers/demoSession.ts'];
  for (const rel of files) {
    const code = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const call of code.matchAll(/createSqliteDatabase\(([^)]*)\)/g)) {
      assert.equal(call[1]?.trim(), "':memory:'", `${rel} opens a database that is not in memory`);
    }
    assert.doesNotMatch(code, /createDatabase\b|databaseUrl|sqlitePath|DATABASE_URL|SQLITE_PATH|process\.env/, `${rel} reaches for persistent storage or the environment`);
  }
});

test('nothing of the retired read-only demo is left in the server', () => {
  const retired = [
    /DEMO_PUBLIC_READONLY/,
    /PUBLIC_DEMO_READS/,
    /demoPublicReadonly/,
    /requireSessionOrPublicRead/,
    /isPublicDemoRead/,
    /handleDemoRun/,
    /findDemoJob/,
    /executeDemoScenario/,
    /createDemoSandbox/,
    /demoAvailable/,
    /demoRun\b/,
    /\/demo\/scenarios\//,
  ];

  const walk = (dir: string): string[] =>
    fs.readdirSync(path.join(SERVER_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = path.posix.join(dir, entry.name);
      return entry.isDirectory() ? walk(rel) : /\.tsx?$/.test(entry.name) ? [rel] : [];
    });
  const files = [...walk('src'), 'scripts/seed-demo.ts', '.env.example'];
  assert.ok(files.length > 40, 'the scan found suspiciously few files');

  for (const rel of files) {
    const text = read(rel);
    for (const pattern of retired) assert.doesNotMatch(text, pattern, `${rel} still mentions ${pattern}`);
  }
  for (const gone of ['src/demo/sandbox.ts', 'src/demo/runScenario.ts', 'src/handlers/demo.ts', 'src/routes/demo.ts']) {
    assert.equal(fs.existsSync(path.join(SERVER_ROOT, gone)), false, `${gone} is back`);
  }
  assert.ok(!('demoRun' in RATE_LIMITS));
});

// ===================================================== the real server, booted

const FREE_KEYS = ['DATABASE_URL', 'OPERATOR_PASSWORD_HASH', 'ANTHROPIC_API_KEY', 'LLM_PROVIDER', 'SQLITE_PATH', 'APP_MODE'];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

type Boot = { code: number | null; stdout: string; stderr: string };

/** Starts the real server entry point and waits for it to stop on its own. */
function bootAndWaitForExit(env: Record<string, string>): Promise<Boot> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.ts'], { cwd: SERVER_ROOT, env: bootEnv(env) });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the server did not stop on its own:\n${stdout}\n${stderr}`));
    }, 20_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** A clean environment: the machine's own settings must not decide what a test boots. */
function bootEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of FREE_KEYS) env[key] = '';
  return { ...env, LOG_LEVEL: 'warn', COOKIE_SECURE: 'false', ...overrides };
}

async function withBootedServer(
  env: Record<string, string>,
  fn: (base: string, output: () => string) => Promise<void>,
): Promise<void> {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/index.ts'], { cwd: SERVER_ROOT, env: bootEnv({ ...env, PORT: String(port) }) });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  const base = `http://127.0.0.1:${port}`;

  try {
    let up = false;
    for (let i = 0; i < 150 && !up; i++) {
      if (child.exitCode !== null) throw new Error(`the server exited with ${child.exitCode}:\n${output}`);
      try {
        up = (await fetch(`${base}/api/health`)).status === 200;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(up, `the server never answered:\n${output}`);
    await fn(base, () => output);
  } finally {
    child.kill();
    await new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', () => resolve())));
  }
}

test('BOOT: an invalid APP_MODE stops the real server with a clear message and a non-zero exit', async () => {
  const boot = await bootAndWaitForExit({ APP_MODE: 'sk-ant-this-looks-like-a-secret' });
  assert.notEqual(boot.code, 0);
  assert.match(boot.stderr, /APP_MODE/);
  assert.ok(!boot.stderr.includes('sk-ant-this-looks-like-a-secret'), 'the invalid value was printed');
  assert.doesNotMatch(boot.stderr, /\bat\s+\S+\s+\(.*\.ts:\d+/, 'a stack trace reached the operator instead of a message');
});

test('BOOT: a demo started with a database, a hash or a key stops, naming them and printing none', async () => {
  const boot = await bootAndWaitForExit({
    APP_MODE: 'demo',
    ...FORBIDDEN_VALUES,
    LLM_PROVIDER: 'anthropic',
  });
  assert.notEqual(boot.code, 0);
  for (const name of [...Object.keys(FORBIDDEN_VALUES), 'LLM_PROVIDER']) assert.match(boot.stderr, new RegExp(name));
  for (const value of Object.values(FORBIDDEN_VALUES)) {
    assert.ok(!boot.stderr.includes(value) && !boot.stdout.includes(value), 'a secret value reached the output');
  }
  assert.ok(!boot.stdout.includes('Listening'), 'it started listening anyway');
});

test('BOOT: the real server in demo mode runs with no database, no credentials and no persistent file', async () => {
  const dataDir = path.join(SERVER_ROOT, 'data');
  const listing = (): string[] => (fs.existsSync(dataDir) ? fs.readdirSync(dataDir).sort() : []);
  const before = listing();

  await withBootedServer({ APP_MODE: 'demo' }, async (base, output) => {
    const health = (await (await fetch(`${base}/api/health`)).json()) as { mode: string; status: string; database: unknown };
    assert.deepEqual([health.mode, health.status, health.database], ['demo', 'ok', null]);

    const started = await fetch(`${base}/api/demo/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(started.status, 201);
    const cookie = (started.headers.getSetCookie()[0] ?? '').split(';')[0] ?? '';
    const jobs = await fetch(`${base}/api/demo/session/jobs`, { headers: { cookie } });
    assert.equal(jobs.status, 200);

    // No sign-in, no recruiter route, no read window — on a real server, not a harness.
    for (const [method, p] of OPERATOR_ROUTES) {
      const reply = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', cookie }, ...(method === 'GET' ? {} : { body: '{}' }) });
      assert.equal(reply.status, 404, `${method} ${p} answered ${reply.status} on a booted demo`);
    }
    assert.doesNotMatch(output(), /migration/i, 'the demo went looking for migrations to apply to a database');
  });

  assert.deepEqual(listing(), before, 'booting the demo created or changed a file under data/');
});

test('BOOT: the real server in app mode serves the recruiter application and no demo', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-app-mode-'));
  await withBootedServer(
    {
      APP_MODE: 'app',
      SQLITE_PATH: path.join(dir, 'app.sqlite'),
      OPERATOR_PASSWORD_HASH: await hashPassword(PASSWORD),
    },
    async (base) => {
      const health = (await (await fetch(`${base}/api/health`)).json()) as { mode: string; adapters: { authConfigured: boolean } };
      assert.equal(health.mode, 'app');
      assert.equal(health.adapters.authConfigured, true);

      assert.equal((await fetch(`${base}/api/jobs`)).status, 401, 'the application served a stranger');
      assert.equal((await fetch(`${base}/api/auth/session`)).status, 200);

      const demo = await fetch(`${base}/api/demo/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(demo.status, 401, 'a demo session could be started on the real application');
      assert.ok(!demo.headers.getSetCookie().some((c) => c.startsWith(`${DEMO_SESSION_COOKIE}=`)));
    },
  );
});
