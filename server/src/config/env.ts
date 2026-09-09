import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogLevel } from '../lib/logger.ts';

// Configuration, read once at startup.
//
// Every value has a working default, so the whole thing runs with no .env at
// all: a local SQLite file, the mock model provider, and no keys. The two
// exceptions are deliberate — a database URL turns on PostgreSQL, and an
// operator password hash turns on sign-in. Without the second, nobody can sign
// in and every protected endpoint answers 401, which is the correct posture for
// a machine nobody has configured. There is no built-in default password,
// because that is how demo credentials reach production.
//
// Problems are collected rather than thrown. A single wrong variable should
// produce a startup warning naming it, not a crash that hides the other four.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');

try {
  process.loadEnvFile(path.join(SERVER_ROOT, '.env'));
} catch {
  // No .env is the normal case for tests and a fresh clone.
}

export const LLM_PROVIDERS = ['mock', 'anthropic'] as const;
export type LlmProviderName = (typeof LLM_PROVIDERS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const satisfies readonly LogLevel[];

export const DB_DRIVERS = ['sqlite', 'postgres'] as const;
export type DbDriverName = (typeof DB_DRIVERS)[number];

function readString(key: string, fallback: string): string {
  const raw = process.env[key];
  return raw === undefined || raw.trim() === '' ? fallback : raw.trim();
}

function readBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

function readInt(key: string, fallback: number, problems: string[]): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    problems.push(`${key} must be a positive integer; received "${raw}". Using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

/** Like `readInt`, but zero is legitimate — `TRUST_PROXY` needs it. */
function readNonNegativeInt(key: string, fallback: number, problems: string[]): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    problems.push(`${key} must be a non-negative integer; received "${raw}". Using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

function readEnum<T extends string>(key: string, allowed: readonly T[], fallback: T, problems: string[]): T {
  const raw = readString(key, fallback).toLowerCase();
  if (!(allowed as readonly string[]).includes(raw)) {
    problems.push(`${key} is "${raw}"; expected one of: ${allowed.join(', ')}. Using "${fallback}".`);
    return fallback;
  }
  return raw as T;
}

export type AppConfig = {
  port: number;
  databaseUrl: string | null;
  dbDriver: DbDriverName;
  sqlitePath: string;
  migrationsDir: string;
  demoDataDir: string;
  webDistDir: string;
  llmProvider: LlmProviderName;
  anthropicApiKey: string | null;
  anthropicModel: string;
  operatorPasswordHash: string | null;
  /**
   * Whether anonymous callers may read the allow-listed demo routes.
   *
   * Default false, and false is the safe direction: an environment that
   * forgets to set it behaves exactly as it did before this flag existed —
   * fully gated. Turning it on opens reads over the invented dataset only.
   * It creates no credential and grants no session.
   */
  demoPublicReadonly: boolean;
  sessionTtlHours: number;
  cookieSecure: boolean;
  corsAllowedOrigins: string[];
  /** Reverse proxies in front of this server. 0 means none — see the note below. */
  trustProxy: number;
  logLevel: LogLevel;
};

export type ConfigResult = { config: AppConfig; problems: string[] };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigResult {
  const previous = process.env;
  process.env = env;
  const problems: string[] = [];

  try {
    const databaseUrl = readString('DATABASE_URL', '') || null;
    const dbDriver: DbDriverName = databaseUrl === null ? 'sqlite' : 'postgres';

    const llmProvider = readEnum('LLM_PROVIDER', LLM_PROVIDERS, 'mock', problems);
    const anthropicApiKey = readString('ANTHROPIC_API_KEY', '') || null;
    if (llmProvider === 'anthropic' && anthropicApiKey === null) {
      problems.push('LLM_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is not set.');
    }

    // Sign-in is the only credential this system has.
    const operatorPasswordHash = readString('OPERATOR_PASSWORD_HASH', '').trim() || null;
    if (operatorPasswordHash === null) {
      problems.push('OPERATOR_PASSWORD_HASH is not set, so nobody can sign in. Generate one with `npm run hash-password`.');
    } else if (!operatorPasswordHash.startsWith('scrypt$')) {
      problems.push('OPERATOR_PASSWORD_HASH is not a scrypt hash produced by `npm run hash-password`.');
    }

    const corsAllowedOrigins = readString('CORS_ALLOWED_ORIGINS', '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin !== '');
    if (corsAllowedOrigins.includes('*')) {
      problems.push(
        'CORS_ALLOWED_ORIGINS contains "*", which cannot be combined with credentialed requests. Ignoring it.',
      );
    }

    const cookieSecure = readBool('COOKIE_SECURE', true);
    if (!cookieSecure) {
      problems.push('COOKIE_SECURE is false. Session cookies will be sent over plain HTTP — local development only.');
    }

    return {
      config: {
        port: readInt('PORT', 3200, problems),
        databaseUrl,
        dbDriver,
        sqlitePath: readString('SQLITE_PATH', path.join(SERVER_ROOT, 'data', 'explainable-ats.sqlite')),
        migrationsDir: readString('MIGRATIONS_DIR', path.join(SERVER_ROOT, 'migrations')),
        demoDataDir: readString('DEMO_DATA_DIR', path.join(SERVER_ROOT, 'data', 'demo')),
        webDistDir: readString('WEB_DIST_DIR', path.join(SERVER_ROOT, '..', 'web', 'dist')),
        llmProvider,
        anthropicApiKey,
        // Sonnet 5 for ranking is fixed by CLAUDE.md and is not a default to
        // drift from: API spend is real money, so the tier is stated here and
        // changed deliberately or not at all.
        anthropicModel: readString('ANTHROPIC_MODEL', 'claude-sonnet-5'),
        operatorPasswordHash,
        // Off unless an operator turns it on, by name, in the environment.
        demoPublicReadonly: readBool('DEMO_PUBLIC_READONLY', false),
        sessionTtlHours: readInt('SESSION_TTL_HOURS', 12, problems),
        cookieSecure,
        corsAllowedOrigins: corsAllowedOrigins.filter((origin) => origin !== '*' && /^https?:\/\/[^/]+$/.test(origin)),
        // Zero by default. Trusting a forwarding header nobody is writing lets
        // any client choose its own rate-limit bucket; trusting too few behind a
        // real proxy puts everyone in one bucket. Neither is safe as a guess, so
        // it is configuration set to the real hop count and nothing else.
        trustProxy: readNonNegativeInt('TRUST_PROXY', 0, problems),
        logLevel: readEnum('LOG_LEVEL', LOG_LEVELS, 'info', problems),
      },
      problems,
    };
  } finally {
    process.env = previous;
  }
}

/**
 * What health may report: whether a dependency is configured, never how.
 *
 * No key, no fragment of a key, no connection string and no host name. A health
 * endpoint is usually the least-protected route in a system, which makes it the
 * wrong place to be generous with detail.
 */
export function configSummary(cfg: AppConfig = config): Record<string, string | boolean | number> {
  return {
    llmProvider: cfg.llmProvider,
    llmConfigured: cfg.llmProvider === 'mock' || cfg.anthropicApiKey !== null,
    database: cfg.dbDriver,
    authConfigured: cfg.operatorPasswordHash !== null,
    // Surfaced so an operator can see from outside whether the public demo
    // window is open, without having to read the deployment environment.
    demoPublicReadonly: cfg.demoPublicReadonly,
    cookieSecure: cfg.cookieSecure,
    /** How many origins are allowed — never which. */
    corsAllowedOrigins: cfg.corsAllowedOrigins.length,
  };
}

const loaded = loadConfig();
export const config: AppConfig = loaded.config;
export const configProblems: readonly string[] = loaded.problems;
