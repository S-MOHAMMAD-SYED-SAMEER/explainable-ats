import { createSqliteDatabase } from '../db/sqlite.ts';
import { runMigrations } from '../db/migrate.ts';
import { createRepositories, type Repositories } from '../db/repositories/index.ts';
import { createJob } from '../agent/ingest.ts';
import { createFixedClock } from '../lib/clock.ts';
import { createSequentialIds } from '../lib/ids.ts';
import { DEMO_JOB } from './dataset.ts';
import { executeDemoScenario, type DemoScenarioId } from './runScenario.ts';
import type { Database } from '../db/types.ts';
import type { Logger } from '../lib/logger.ts';

// The public demo's sandbox.
//
// WHY THIS EXISTS
//
// The demo-run endpoint is reachable by anyone, with no session. It used to run
// the real pipeline against the CANONICAL database, and `openEvaluation`
// supersedes whatever evaluation was current for that candidate — so an
// anonymous visitor could push a recruiter's assessed candidate, and the
// decision recorded against it, out of the ranking. A public, repeatable action
// must not be able to move the operator's state, so it no longer touches it.
//
// WHAT IT DOES INSTEAD
//
// Each scenario runs through the same functions the seeder uses — ingest,
// redact, extract, verify, match, score — but into a private in-memory SQLite
// database that nothing else can see: same migrations, same fixed demo job. The
// canonical database is never written, whichever driver it uses.
//
// BOUNDED, AND DETERMINISTIC
//
//   * One sandbox per scenario, built on first use and kept for the life of the
//     process. There are five scenarios, so there are at most five evaluations
//     and their audit trails, however many requests arrive. A repeat run returns
//     the same evaluation instead of stacking a new one.
//   * The clock is fixed and ids are derived from the scenario name, so a
//     scenario produces byte-identical results, ids and timestamps included, in
//     every process on every machine. Re-running it could not give a different
//     answer, so there is nothing to be gained by redoing the work.
//
// WHAT A SANDBOX RESULT CANNOT DO
//
// Its id lives only in this map. The decision route resolves ids against the
// canonical database, so a sandbox id there is simply "not found": nothing in
// the sandbox can be decided on, ranked, or superseded by anyone.
//
// It is memory-only by design: after a restart the ids stop resolving until a
// scenario is run again.

/** Where the sandbox clock starts. Fixed, so results never depend on the wall clock. */
export const SANDBOX_CLOCK_START = '2026-01-01T00:00:00.000Z';

export type SandboxEntry = {
  scenario: DemoScenarioId;
  evaluationId: string;
  repos: Repositories;
  /**
   * The canonical demo job's id, as of the latest run.
   *
   * The sandbox has a job of its own, with a different id. Responses served
   * from it name this one instead, so the "back to the role" link lands on the
   * real, canonical ranking rather than on a job the canonical database has
   * never heard of.
   */
  canonicalJobId: string;
};

export type DemoSandbox = {
  /** Runs the scenario in isolation, or returns the run that already exists. */
  run(scenario: DemoScenarioId, canonicalJobId: string): Promise<SandboxEntry>;
  /** The sandbox holding this evaluation, or null if it is not a sandbox id. */
  find(evaluationId: string): SandboxEntry | null;
  /** How many sandboxed evaluations exist. Never more than the scenario count. */
  readonly size: number;
  close(): Promise<void>;
};

export type DemoSandboxOptions = {
  migrationsDir: string;
  logger?: Logger;
};

export function createDemoSandbox({ migrationsDir, logger }: DemoSandboxOptions): DemoSandbox {
  const building = new Map<DemoScenarioId, Promise<SandboxEntry>>();
  const byEvaluation = new Map<string, SandboxEntry>();
  const databases: Database[] = [];

  async function build(scenario: DemoScenarioId, canonicalJobId: string): Promise<SandboxEntry> {
    const db = createSqliteDatabase(':memory:');
    databases.push(db);

    try {
      await runMigrations(db, migrationsDir, { now: () => SANDBOX_CLOCK_START });

      const repos = createRepositories(db, {
        clock: createFixedClock(SANDBOX_CLOCK_START, 1000),
        newId: createSequentialIds(`demo-sandbox:${scenario}`),
      });

      const { job } = await createJob({ repos, logger }, DEMO_JOB);
      const evaluation = await executeDemoScenario({ repos, logger }, job, scenario);

      const entry: SandboxEntry = { scenario, evaluationId: evaluation.id, repos, canonicalJobId };
      byEvaluation.set(entry.evaluationId, entry);
      return entry;
    } catch (err) {
      databases.splice(databases.indexOf(db), 1);
      await db.close();
      throw err;
    }
  }

  return {
    async run(scenario, canonicalJobId) {
      let pending = building.get(scenario);
      if (!pending) {
        pending = build(scenario, canonicalJobId);
        building.set(scenario, pending);
        // A failed build is not remembered, so the next request can try again.
        pending.catch(() => building.delete(scenario));
      }
      const entry = await pending;
      entry.canonicalJobId = canonicalJobId;
      return entry;
    },

    find(evaluationId) {
      return byEvaluation.get(evaluationId) ?? null;
    },

    get size() {
      return byEvaluation.size;
    },

    async close() {
      building.clear();
      byEvaluation.clear();
      await Promise.all(databases.splice(0).map((db) => db.close()));
    },
  };
}
