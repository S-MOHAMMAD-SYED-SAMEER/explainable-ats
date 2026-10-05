import { createHash, randomBytes } from 'node:crypto';
import { createSqliteDatabase } from '../db/sqlite.ts';
import { runMigrations } from '../db/migrate.ts';
import { createRepositories, type Repositories } from '../db/repositories/index.ts';
import { createFixedClock, systemClock, type Clock } from '../lib/clock.ts';
import { createSequentialIds } from '../lib/ids.ts';
import { DEMO_JOB } from './dataset.ts';
import { seedDemoData } from './seed.ts';
import { isDemoScenarioId, type DemoScenarioId } from './scenarios.ts';
import type { Database } from '../db/types.ts';
import type { Logger } from '../lib/logger.ts';

// Visitor-scoped demo sessions.
//
// WHY EACH VISITOR GETS A DATABASE OF THEIR OWN
//
// A visitor can act on the demo — decide on a candidate, say — and their action
// must not be visible to the next stranger. A shared copy would be exactly right
// for something nobody can change and exactly wrong for anything a visitor can,
// so every visitor gets a private one. This file is that mechanism and nothing
// else. It exists only in demo mode (`config/mode.ts`): the real application never
// builds a session store.
//
// WHAT A SESSION IS
//
// A private in-memory SQLite database holding the fixed synthetic dataset,
// produced by the same `seedDemoData` the canonical seeder runs: ingest, redact,
// extract, verify, match, score — the real pipeline, with the deterministic
// stand-in for the model and no provider, no key and no network. A fixed clock
// and sequential ids make every session start byte-identical to every other.
//
// THE TOKEN
//
// 32 random bytes, base64url. It names a session and carries nothing: no
// identity, no timestamp, no scenario, nothing to decode or forge a meaning
// into. Guessing one is a 2^256 problem, and a modified one is simply a
// different, unknown string. The map is keyed by the token's SHA-256, so
// nothing that can read the map (a heap dump, a debugger, a stray log of it)
// can read a usable token out of it.
//
// BOUNDED, BECAUSE ANYONE CAN CREATE ONE
//
//   * A session expires after `ttlMs` without use; use slides the window.
//   * At most `maxSessions` exist. At the limit the least recently used one is
//     evicted — the alternative, refusing, would let a flood lock real visitors
//     out, where eviction only ever costs the visitor nobody has touched.
//   * Creation is rate-limited by the HTTP layer (`demoSession` class).
//
// MEMORY-ONLY BY DESIGN
//
// Nothing here touches the canonical database. This module is not given its
// repositories, so there is no path from a session to a recruiter's records: not
// by id, not by mistake. A restart discards every session, and a visitor whose
// session has gone is simply sent back to start another.

/** Where a session's clock starts while the dataset is built. Fixed, so every session starts identical. */
export const SANDBOX_CLOCK_START = '2026-01-01T00:00:00.000Z';

export const DEFAULT_DEMO_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_MAX_DEMO_SESSIONS = 100;

/** 32 bytes as unpadded base64url is exactly 43 characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type VisitorSandbox = {
  /** This visitor's private repositories. Never the canonical ones. */
  repos: Repositories;
  jobId: string;
  jobTitle: string;
  /** When the session lapses if it is not used again, ISO-8601. */
  expiresAt: string;
  /** The evaluation the fixed scenario produced in THIS session. */
  evaluationFor(scenario: DemoScenarioId): string;
};

export type DemoSessionStore = {
  /** Builds a fresh session. The token is returned once and never again. */
  create(): Promise<{ token: string; sandbox: VisitorSandbox }>;
  /** The live session this token names, or null. Never throws on a bad token. */
  resolve(token: unknown): VisitorSandbox | null;
  /** Replaces this one session's state with a fresh copy. Null if there is none. */
  reset(token: unknown): Promise<VisitorSandbox | null>;
  /** Discards this one session. True if it existed. */
  end(token: unknown): Promise<boolean>;
  readonly size: number;
  close(): Promise<void>;
};

export type DemoSessionStoreOptions = {
  migrationsDir: string;
  logger?: Logger;
  /** Injectable so a test can move time. Governs expiry only, never the data. */
  clock?: Clock;
  ttlMs?: number;
  maxSessions?: number;
};

type Built = {
  db: Database;
  repos: Repositories;
  jobId: string;
  jobTitle: string;
  evaluations: ReadonlyMap<string, string>;
};

type Entry = {
  built: Built;
  lastUsedMs: number;
};

/** Whether a value could be a session token at all. Says nothing about whether one exists. */
export function isWellFormedDemoToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

function keyOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createDemoSessionStore(options: DemoSessionStoreOptions): DemoSessionStore {
  const { migrationsDir, logger } = options;
  const clock = options.clock ?? systemClock;
  const ttlMs = options.ttlMs ?? DEFAULT_DEMO_SESSION_TTL_MS;
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_DEMO_SESSIONS;

  const sessions = new Map<string, Entry>();

  const nowMs = (): number => Date.parse(clock.nowIso());

  async function build(): Promise<Built> {
    const db = createSqliteDatabase(':memory:');
    try {
      await runMigrations(db, migrationsDir, { now: () => SANDBOX_CLOCK_START });

      // Two clocks behind one. The dataset is stamped by the fixed clock, so every
      // session starts byte-identical; once it is built the clock goes live, so
      // what a visitor does afterwards — a decision and its audit event — carries
      // the time it actually happened. A decision dated 1 January would read as
      // fake, and it would be wrong in a way a visitor could see.
      const seedClock = createFixedClock(SANDBOX_CLOCK_START, 1000);
      let seeding = true;
      const repos = createRepositories(db, {
        clock: { nowIso: () => (seeding ? seedClock.nowIso() : clock.nowIso()) },
        newId: createSequentialIds('demo-visitor'),
      });

      // The canonical seeder, pointed at a private database. Nothing about the
      // dataset or the pipeline is restated here.
      const seeded = await seedDemoData({ repos });
      seeding = false;

      const evaluations = new Map<string, string>();
      for (const candidate of seeded.candidates) {
        if (candidate.evaluationId !== null) evaluations.set(candidate.reference, candidate.evaluationId);
      }

      return { db, repos, jobId: seeded.jobId, jobTitle: DEMO_JOB.title, evaluations };
    } catch (err) {
      await db.close();
      throw err;
    }
  }

  function view(entry: Entry): VisitorSandbox {
    const { built } = entry;
    return {
      repos: built.repos,
      jobId: built.jobId,
      jobTitle: built.jobTitle,
      expiresAt: new Date(entry.lastUsedMs + ttlMs).toISOString(),
      evaluationFor(scenario) {
        const id = built.evaluations.get(scenario);
        // Unreachable while the dataset and the scenario list agree — a test
        // asserts they do — and a throw is the right answer if they ever drift.
        if (!id || !isDemoScenarioId(scenario)) {
          throw new Error(`Demo scenario "${scenario}" has no evaluation in this session.`);
        }
        return id;
      },
    };
  }

  async function discard(key: string): Promise<boolean> {
    const entry = sessions.get(key);
    if (!entry) return false;
    sessions.delete(key);
    await entry.built.db.close();
    return true;
  }

  /** Drops what has lapsed, then makes room for one more. */
  async function makeRoom(): Promise<void> {
    const now = nowMs();
    for (const [key, entry] of sessions) {
      if (now - entry.lastUsedMs >= ttlMs) await discard(key);
    }

    while (sessions.size >= maxSessions) {
      let oldest: string | null = null;
      let oldestUsed = Infinity;
      for (const [key, entry] of sessions) {
        if (entry.lastUsedMs < oldestUsed) {
          oldest = key;
          oldestUsed = entry.lastUsedMs;
        }
      }
      if (oldest === null) break;
      await discard(oldest);
    }
  }

  /** Finds a live entry and slides its window. Expired entries are dropped on sight. */
  function lookup(token: unknown): { key: string; entry: Entry } | null {
    if (!isWellFormedDemoToken(token)) return null;

    const key = keyOf(token);
    const entry = sessions.get(key);
    if (!entry) return null;

    const now = nowMs();
    if (now - entry.lastUsedMs >= ttlMs) {
      void discard(key);
      return null;
    }

    entry.lastUsedMs = now;
    return { key, entry };
  }

  return {
    async create() {
      await makeRoom();
      const built = await build();

      const token = randomBytes(32).toString('base64url');
      const entry: Entry = { built, lastUsedMs: nowMs() };
      sessions.set(keyOf(token), entry);

      logger?.debug('Started a demo session', { live: sessions.size });
      return { token, sandbox: view(entry) };
    },

    resolve(token) {
      const found = lookup(token);
      return found ? view(found.entry) : null;
    },

    async reset(token) {
      const found = lookup(token);
      if (!found) return null;

      // Built before anything is replaced, so a failure leaves the visitor's
      // existing session exactly as it was rather than half-torn-down.
      const fresh = await build();
      const previous = found.entry.built;

      found.entry.built = fresh;
      found.entry.lastUsedMs = nowMs();
      await previous.db.close();

      return view(found.entry);
    },

    async end(token) {
      if (!isWellFormedDemoToken(token)) return false;
      return discard(keyOf(token));
    },

    get size() {
      return sessions.size;
    },

    async close() {
      const keys = [...sessions.keys()];
      for (const key of keys) await discard(key);
    },
  };
}
