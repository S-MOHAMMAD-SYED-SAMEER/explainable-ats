import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogLevel } from '../lib/logger.ts';
import { APP_MODES, DEFAULT_APP_MODE, isAppMode, type AppMode } from './mode.ts';

export { APP_MODES, type AppMode };

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
//
// THE EXCEPTION IS THE DEPLOYMENT MODE. Every other setting has a safe fallback;
// `APP_MODE` does not. A typo that quietly fell back to "app" would start the
// real application where the demo was meant, and a demo started with a database
// URL, a password hash or an API key is a demo that can reach what it must not.
// Those are refused outright, naming every offending VARIABLE and never a value,
// so a misconfigured deploy fails at boot, where it is seen.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');

try {
  process.loadEnvFile(path.join(SERVER_ROOT, '.env'));
} catch {
  // No .env is the normal case for tests and a fresh clone.
}

/**
 * A configuration the process refuses to run with.
 *
 * Carries the names of the variables at fault and nothing else: the message goes
 * to an operator's terminal and a deploy log, and a value — a connection string,
 * a hash, a key — must never be in either.
 */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = [...problems];
  }
}

export const LLM_PROVIDERS = ['mock', 'anthropic'] as const;

/** Anthropic request limits. Both are bounded: nothing here may wait forever. */
export const ANTHROPIC_DEFAULT_TIMEOUT_MS = 60_000;
export const ANTHROPIC_MAX_TIMEOUT_MS = 300_000;
export const ANTHROPIC_DEFAULT_MAX_RETRIES = 2;
export const ANTHROPIC_MAX_RETRIES = 5;
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

/** Like `readInt`, but a value above `ceiling` is reported and clamped to it. */
function readBoundedInt(
  key: string,
  fallback: number,
  ceiling: number,
  allowZero: boolean,
  problems: string[],
): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    problems.push(
      `${key} must be ${allowZero ? 'a non-negative' : 'a positive'} integer; received "${raw}". Using ${fallback}.`,
    );
    return fallback;
  }
  if (parsed > ceiling) {
    problems.push(`${key} is ${parsed}, above the maximum of ${ceiling}. Using ${ceiling}.`);
    return ceiling;
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

/** Reads `APP_MODE`. Unset means the real application; anything unrecognised is refused. */
function readAppMode(): AppMode {
  const raw = process.env.APP_MODE;
  if (raw === undefined || raw.trim() === '') return DEFAULT_APP_MODE;

  const mode = raw.trim().toLowerCase();
  if (!isAppMode(mode)) {
    // The variable and the allowed values — never the value it had.
    throw new ConfigError([`APP_MODE must be one of: ${APP_MODES.join(', ')}.`]);
  }
  return mode;
}

/**
 * Everything demo mode refuses to start with, by variable name.
 *
 * A demo is a process with no credentials and no persistent state. If one of
 * these is present the deploy is wrong — usually the demo service cloned from the
 * real service's settings — and the safe response is to stop, not to ignore the
 * variable and run on. Each check is on the variable being SET, so nothing here
 * ever puts a secret's value in a message.
 */
function forbiddenInDemo(): string[] {
  const present = (key: string): boolean => (process.env[key] ?? '').trim() !== '';
  const refusals: string[] = [];

  if (present('DATABASE_URL')) refusals.push('DATABASE_URL must not be set in demo mode: the demo has no canonical database.');
  if (present('OPERATOR_PASSWORD_HASH')) {
    refusals.push('OPERATOR_PASSWORD_HASH must not be set in demo mode: the demo has no sign-in.');
  }
  if (present('ANTHROPIC_API_KEY')) refusals.push('ANTHROPIC_API_KEY must not be set in demo mode: the demo calls no model.');

  const provider = (process.env.LLM_PROVIDER ?? '').trim().toLowerCase();
  if (provider !== '' && provider !== 'mock') {
    refusals.push('LLM_PROVIDER must be "mock" (or unset) in demo mode: the demo uses the deterministic provider only.');
  }

  const sqlitePath = (process.env.SQLITE_PATH ?? '').trim();
  if (sqlitePath !== '' && sqlitePath !== ':memory:') {
    refusals.push('SQLITE_PATH must be unset (or ":memory:") in demo mode: the demo keeps no persistent database.');
  }

  return refusals;
}

export type AppConfig = {
  /** Which product this process is. See `config/mode.ts`. */
  appMode: AppMode;
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
  /** Per-request timeout for the Anthropic provider, in milliseconds. */
  anthropicTimeoutMs: number;
  /** Retries after the first attempt, for transient failures only. */
  anthropicMaxRetries: number;
  operatorPasswordHash: string | null;
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
    const appMode = readAppMode();
    const isDemo = appMode === 'demo';

    // In demo mode these are not merely unused, they are forbidden.
    if (isDemo) {
      const refusals = forbiddenInDemo();
      if (refusals.length > 0) throw new ConfigError(refusals);
    }

    const databaseUrl = isDemo ? null : readString('DATABASE_URL', '') || null;
    const dbDriver: DbDriverName = databaseUrl === null ? 'sqlite' : 'postgres';

    const llmProvider: LlmProviderName = isDemo ? 'mock' : readEnum('LLM_PROVIDER', LLM_PROVIDERS, 'mock', problems);
    const anthropicApiKey = isDemo ? null : readString('ANTHROPIC_API_KEY', '') || null;
    if (llmProvider === 'anthropic' && anthropicApiKey === null) {
      problems.push('LLM_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is not set.');
    }

    // Sign-in is the only credential this system has. The demo has none and does
    // not warn about it: nobody is meant to sign in to it.
    const operatorPasswordHash = isDemo ? null : readString('OPERATOR_PASSWORD_HASH', '').trim() || null;
    if (!isDemo) {
      if (operatorPasswordHash === null) {
        problems.push('OPERATOR_PASSWORD_HASH is not set, so nobody can sign in. Generate one with `npm run hash-password`.');
      } else if (!operatorPasswordHash.startsWith('scrypt$')) {
        problems.push('OPERATOR_PASSWORD_HASH is not a scrypt hash produced by `npm run hash-password`.');
      }
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
        appMode,
        port: readInt('PORT', 3200, problems),
        databaseUrl,
        dbDriver,
        // The demo has no canonical database. Its only SQLite is the per-visitor,
        // in-memory one the session store builds for itself.
        sqlitePath: isDemo ? ':memory:' : readString('SQLITE_PATH', path.join(SERVER_ROOT, 'data', 'explainable-ats.sqlite')),
        migrationsDir: readString('MIGRATIONS_DIR', path.join(SERVER_ROOT, 'migrations')),
        demoDataDir: readString('DEMO_DATA_DIR', path.join(SERVER_ROOT, 'data', 'demo')),
        webDistDir: readString('WEB_DIST_DIR', path.join(SERVER_ROOT, '..', 'web', 'dist')),
        llmProvider,
        anthropicApiKey,
        // Sonnet 5 is the intended tier for resume ranking, and is not a default
        // to drift from: API spend is real money, so the tier is stated here and
        // changed deliberately or not at all. The Anthropic provider passes this
        // string through verbatim and never names a model of its own.
        anthropicModel: readString('ANTHROPIC_MODEL', 'claude-sonnet-5'),
        anthropicTimeoutMs: readBoundedInt(
          'ANTHROPIC_TIMEOUT_MS',
          ANTHROPIC_DEFAULT_TIMEOUT_MS,
          ANTHROPIC_MAX_TIMEOUT_MS,
          false,
          problems,
        ),
        anthropicMaxRetries: readBoundedInt(
          'ANTHROPIC_MAX_RETRIES',
          ANTHROPIC_DEFAULT_MAX_RETRIES,
          ANTHROPIC_MAX_RETRIES,
          true,
          problems,
        ),
        operatorPasswordHash,
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
    // The demo has no canonical database; its visitors' in-memory ones are not
    // something health is about.
    database: cfg.appMode === 'demo' ? 'none' : cfg.dbDriver,
    authConfigured: cfg.operatorPasswordHash !== null,
    cookieSecure: cfg.cookieSecure,
    /** How many origins are allowed — never which. */
    corsAllowedOrigins: cfg.corsAllowedOrigins.length,
  };
}

/**
 * Loads the process's configuration, or stops it with a clear message.
 *
 * A refused configuration ends the process here, at import, rather than
 * surfacing as a stack trace from wherever the first caller happened to be.
 */
function loadOrExit(): ConfigResult {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n[config] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

const loaded = loadOrExit();
export const config: AppConfig = loaded.config;
export const configProblems: readonly string[] = loaded.problems;
