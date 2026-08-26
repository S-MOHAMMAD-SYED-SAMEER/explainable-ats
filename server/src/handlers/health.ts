import { configSummary, type AppConfig, config as defaultConfig } from '../config/env.ts';
import { appliedMigrations } from '../db/migrate.ts';
import type { Database } from '../db/types.ts';

// Health.
//
// A plain function returning `{ status, body }`, so it can be exercised with an
// in-memory database and no HTTP server, no port and no supertest dependency.
//
// What it may report is constrained: whether each dependency is configured,
// never how. No key, no fragment of a key, no connection string, no host name.

export type HealthDeps = { db?: Database; config?: AppConfig };

export type HealthBody = {
  status: 'ok' | 'degraded';
  database: { driver: string; reachable: boolean; migrationsApplied: number };
  adapters: Record<string, string | boolean | number>;
  version: string;
};

export async function handleHealth(deps: HealthDeps = {}): Promise<{ status: number; body: HealthBody }> {
  const cfg = deps.config ?? defaultConfig;

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
      status: reachable ? 'ok' : 'degraded',
      database: { driver: cfg.dbDriver, reachable, migrationsApplied },
      adapters: configSummary(cfg),
      // A product version, never a milestone label: this is rendered on an
      // operator surface, where "P3-A" would read as a pre-release marker.
      version: '0.1.0',
    },
  };
}
