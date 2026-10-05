import { configSummary, type AppConfig, config as defaultConfig } from '../config/env.ts';
import { capabilitiesOf, type AppMode } from '../config/mode.ts';
import { appliedMigrations } from '../db/migrate.ts';
import type { Database } from '../db/types.ts';

// Health.
//
// A plain function returning `{ status, body }`, so it can be exercised with an
// in-memory database and no HTTP server, no port and no supertest dependency.
//
// What it may report is constrained: whether each dependency is configured,
// never how. No key, no fragment of a key, no connection string, no host name.
//
// IT ALSO SAYS WHICH PRODUCT THIS IS
//
// `mode` is how the front end learns what it is talking to. One build of the
// client is served by both deployments, so the answer cannot be baked into the
// bundle — and it must not be guessed from a request that only one of them
// understands. Health is the one route both modes register, and `mode` is the one
// thing about the deployment it is meant to tell a stranger.

export type HealthDeps = { db?: Database; config?: AppConfig };

export type HealthBody = {
  mode: AppMode;
  status: 'ok' | 'degraded';
  /** `null` in demo mode: there is no canonical database to report on. */
  database: { driver: string; reachable: boolean; migrationsApplied: number } | null;
  adapters: Record<string, string | boolean | number>;
  version: string;
};

// A product version, never a milestone label: this is rendered on an operator
// surface, where "P3-A" would read as a pre-release marker.
const VERSION = '0.1.0';

export async function handleHealth(deps: HealthDeps = {}): Promise<{ status: number; body: HealthBody }> {
  const cfg = deps.config ?? defaultConfig;

  // A demo process has no database to be unreachable. It is healthy when it is
  // answering, and says nothing about a database it does not have.
  if (!capabilitiesOf(cfg.appMode).canonicalDatabase) {
    return {
      status: 200,
      body: { mode: cfg.appMode, status: 'ok', database: null, adapters: configSummary(cfg), version: VERSION },
    };
  }

  let reachable = false;
  let migrationsApplied = 0;

  if (deps.db) {
    try {
      await deps.db.query('SELECT 1 AS ok');
      reachable = true;
      migrationsApplied = (await appliedMigrations(deps.db)).length;
    } catch {
      // Deliberately swallowed. Health reports that the database is
      // unreachable; explaining the driver's error to whoever asked is what
      // the log is for.
      reachable = false;
    }
  }

  return {
    status: 200,
    body: {
      mode: cfg.appMode,
      status: reachable ? 'ok' : 'degraded',
      database: { driver: cfg.dbDriver, reachable, migrationsApplied },
      adapters: configSummary(cfg),
      version: VERSION,
    },
  };
}
