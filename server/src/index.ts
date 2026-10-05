import { config, configProblems } from './config/env.ts';
import { capabilitiesOf } from './config/mode.ts';
import { createDatabase } from './db/index.ts';
import { appliedMigrations } from './db/migrate.ts';
import { createApp } from './app.ts';
import { createLogger } from './lib/logger.ts';
import type { Database } from './db/types.ts';

// Server bootstrap.

const log = createLogger('server', { level: config.logLevel });

async function main(): Promise<void> {
  // Configuration problems are operator-facing and are printed here, at
  // startup, naming the exact variable. Nothing in an HTTP response repeats
  // this detail: the person running the server needs to know which variable is
  // wrong; a stranger sending a request does not need to know what this system
  // is built from.
  for (const problem of configProblems) log.warn(problem);

  // Only the real application opens a database. A demo process has none to open:
  // its visitors each get a private in-memory one, built on demand.
  let db: Database | undefined;
  let migrationsApplied = 0;
  if (capabilitiesOf(config.appMode).canonicalDatabase) {
    db = await createDatabase(config);

    const applied = await appliedMigrations(db);
    migrationsApplied = applied.length;
    if (applied.length === 0) {
      log.warn('No migrations have been applied. Run `npm run migrate` before using the API.');
    }
  }

  const app = createApp({ ...(db ? { db } : {}), logger: createLogger('http', { level: config.logLevel }) });

  const server = app.listen(config.port, () => {
    log.info(`Listening on port ${config.port}`, {
      mode: config.appMode,
      ...(db ? { database: db.driver, migrationsApplied } : {}),
      llmProvider: config.llmProvider,
    });
  });

  const shutdown = (signal: string): void => {
    log.info(`Received ${signal}, shutting down.`);
    server.close(() => {
      void (db ? db.close() : Promise.resolve()).finally(() => process.exit(0));
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log.error('Failed to start', { internal: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
