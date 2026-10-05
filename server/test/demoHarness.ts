import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.ts';
import { loadConfig, type AppConfig } from '../src/config/env.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { hashPassword } from '../src/lib/password.ts';
import { rateLimit, RATE_LIMITS } from '../src/http/rateLimit.ts';
import { CSRF_COOKIE } from '../src/auth/cookies.ts';
import { seedDemoData } from '../src/demo/seed.ts';
import { createDemoSessionStore, type DemoSessionStore } from '../src/demo/sessions.ts';
import { DEMO_SESSION_COOKIE } from '../src/routes/demoSession.ts';
import { createTestContext, MIGRATIONS_DIR, type TestContext } from './helpers.ts';

// The harness the visitor-demo tests share: TWO real apps over real HTTP, as two
// real deployments are.
//
//   the demo   (`APP_MODE=demo`) — `h.base`, `h.call`, `h.start`. No canonical
//              database, no operator password, no key: what a deployed demo holds.
//   the app    (`APP_MODE=app`)  — `h.appBase`, `h.callApp`, `h.operator`. A
//              canonical database holding the real seeded dataset AND a
//              recruiter's decision AND a candidate who is not part of the
//              dataset: what a deployed application holds, and the state nothing
//              the demo does may touch.
//
// They are separate processes in production and separate apps here. They share
// nothing but the code, which is the point of the split.

export const PASSWORD = 'demo-session-operator-password';
export const SECRET_API_KEY = 'sk-ant-test-this-must-never-appear-in-any-response';
export const FIXTURE_NAME = 'Canonical Recruiter Fixture';

export type Json = Record<string, unknown>;
export type Reply<T = Json> = { status: number; body: T; headers: Headers; cookies: string[] };

export type RankingBody = {
  jobId: string;
  entries: Array<{
    reference: string;
    displayName: string | null;
    evaluationId: string | null;
    tier: string;
    scoreBasisPoints: number | null;
    position: number;
  }>;
};

export type EvaluationBody = {
  evaluationId: string;
  scoreBasisPoints: number | null;
  tier: string;
  job: { id: string; title: string };
  decision: { outcome: string; reason: string } | null;
  requirements: Array<{ label: string; verdict: string | null; evidence: Array<{ quote: string }> }>;
};

export type Harness = {
  /** The demo deployment. */
  base: string;
  /** The real application's deployment, over the canonical database. */
  appBase: string;
  ctx: TestContext;
  store: DemoSessionStore;
  canonicalJobId: string;
  canonicalEvaluations: Map<string, string>;
  /** Anonymous call to the DEMO, optionally carrying a demo cookie value. */
  call<T = Json>(method: string, path: string, options?: { token?: string | null; rawCookie?: string; body?: unknown }): Promise<Reply<T>>;
  /** The same shape of call, to the REAL APPLICATION. */
  callApp<T = Json>(method: string, path: string, options?: { token?: string | null; rawCookie?: string; body?: unknown }): Promise<Reply<T>>;
  /** Starts a session and returns its token, read from Set-Cookie like a browser would. */
  start(): Promise<{ token: string; reply: Reply }>;
  /** Signs in as the operator, on the real application. */
  operator(): Promise<{ cookie: string; csrf: string }>;
};

export async function withHarness(
  fn: (h: Harness) => Promise<void>,
  options: {
    /** Applied to the DEMO's configuration. */
    overrides?: Partial<AppConfig>;
    /** Applied to the REAL APPLICATION's configuration. */
    appOverrides?: Partial<AppConfig>;
    rateLimiter?: ReturnType<typeof rateLimit>;
    store?: DemoSessionStore;
  } = {},
): Promise<void> {
  const ctx = await createTestContext({ idPrefix: 'demo-session' });
  const seeded = await seedDemoData({ repos: ctx.repos });

  // A canonical record a visitor must never be able to see, change or displace:
  // a recruiter's decision, and a candidate who is not part of the dataset.
  const rowan = seeded.candidates.find((c) => c.reference === 'demo-001');
  await ctx.repos.decisions.record({
    evaluationId: rowan?.evaluationId ?? '',
    outcome: 'shortlist',
    reason: 'Recorded by the recruiter, canonically.',
    decidedBy: 'operator',
  });
  await ctx.repos.candidates.create({ reference: 'real-0001', displayName: FIXTURE_NAME, source: 'manual' });

  const appConfig: AppConfig = {
    ...loadConfig({}).config,
    operatorPasswordHash: await hashPassword(PASSWORD),
    anthropicApiKey: SECRET_API_KEY,
    cookieSecure: false,
    ...options.appOverrides,
  };
  assert.equal(appConfig.appMode, 'app');

  // A real demo configuration: the one the loader builds, which has no password
  // hash, no key and no database URL because it refuses to.
  const config: AppConfig = {
    ...loadConfig({ APP_MODE: 'demo' }).config,
    cookieSecure: false,
    ...options.overrides,
  };

  const store = options.store ?? createDemoSessionStore({ migrationsDir: MIGRATIONS_DIR });
  const rateLimiter =
    options.rateLimiter ??
    rateLimit({ limits: { ...RATE_LIMITS, demoSession: { limit: 10_000, windowMs: 60_000 } } });

  const demoApp = createApp({ config, logger: createMemoryLogger().logger, rateLimiter, demoSessions: store });
  const realApp = createApp({ db: ctx.db, config: appConfig, logger: createMemoryLogger().logger });

  const listen = async (app: ReturnType<typeof createApp>) => {
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  };
  const demo = await listen(demoApp);
  const real = await listen(realApp);
  const base = demo.base;
  const appBase = real.base;

  const callAt =
    (root: string) =>
    async <T = Json>(
      method: string,
      p: string,
      opts: { token?: string | null; rawCookie?: string; body?: unknown } = {},
    ): Promise<Reply<T>> => {
    const headers: Record<string, string> = { 'content-type': 'application/json', origin: root };
    const cookie = opts.rawCookie ?? (opts.token ? `${DEMO_SESSION_COOKIE}=${opts.token}` : undefined);
    if (cookie) headers.cookie = cookie;

    const response = await fetch(`${root}${p}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: JSON.stringify(opts.body ?? {}) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: (text === '' ? {} : JSON.parse(text)) as T,
      headers: response.headers,
      cookies: response.headers.getSetCookie(),
    };
  };
  const call = callAt(base);
  const callApp = callAt(appBase);

  const harness: Harness = {
    base,
    appBase,
    ctx,
    store,
    canonicalJobId: seeded.jobId,
    canonicalEvaluations: new Map(seeded.candidates.map((c) => [c.reference, c.evaluationId ?? ''])),
    call,
    callApp,
    async start() {
      const reply = await call('POST', '/api/demo/session');
      const token = tokenFrom(reply.cookies);
      assert.notEqual(token, null, 'precondition: starting a session issued a demo cookie');
      return { token: token as string, reply };
    },
    async operator() {
      const login = await fetch(`${appBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD }),
      });
      assert.equal(login.status, 200, 'precondition: the operator could sign in');
      const pairs = login.headers.getSetCookie().map((entry) => entry.split(';')[0] ?? '');
      const csrf = new RegExp(`${CSRF_COOKIE}=([^;]+)`).exec(pairs.join('; '))?.[1] ?? '';
      return { cookie: pairs.join('; '), csrf };
    },
  };

  try {
    await fn(harness);
  } finally {
    await new Promise<void>((resolve) => demo.server.close(() => resolve()));
    await new Promise<void>((resolve) => real.server.close(() => resolve()));
    await store.close();
    await ctx.close();
  }
}

/** The demo token out of a response's Set-Cookie headers, as a browser would keep it. */
export function tokenFrom(cookies: readonly string[]): string | null {
  for (const entry of cookies) {
    const match = new RegExp(`^${DEMO_SESSION_COOKIE}=([^;]*)`).exec(entry);
    if (match && match[1]) return decodeURIComponent(match[1]);
  }
  return null;
}

export function flip(token: string): string {
  // A different, still well-formed token: change one character.
  return `${token.slice(0, 20)}${token[20] === 'A' ? 'B' : 'A'}${token.slice(21)}`;
}

export async function rankingOf(h: Harness, token: string, jobId: string): Promise<RankingBody> {
  const reply = await h.call<RankingBody>('GET', `/api/demo/session/jobs/${jobId}/ranking`, { token });
  assert.equal(reply.status, 200);
  return reply.body;
}

export const TABLES = [
  'jobs',
  'job_requirements',
  'candidates',
  'resumes',
  'sensitive_findings',
  'evaluations',
  'evidence',
  'requirement_matches',
  'recruiter_decisions',
  'audit_events',
] as const;

/** Every canonical domain row, in full — not just counts. */
export async function canonicalSnapshot(ctx: TestContext): Promise<string> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) out[table] = await ctx.db.query(`SELECT * FROM ${table} ORDER BY id`);
  return JSON.stringify(out);
}

