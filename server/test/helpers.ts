import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase } from '../src/db/index.ts';
import { runMigrations, readMigrations } from '../src/db/migrate.ts';
import { createRepositories, type Repositories } from '../src/db/repositories/index.ts';
import { createFixedClock } from '../src/lib/clock.ts';
import { createSequentialIds } from '../src/lib/ids.ts';
import type { Database } from '../src/db/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');
export const MIGRATION_COUNT = readMigrations(MIGRATIONS_DIR).length;

export type TestContext = {
  db: Database;
  repos: Repositories;
  close: () => Promise<void>;
};

/**
 * A migrated, private, in-memory database.
 *
 * The clock and the id generator are fixed so a test can assert an exact value
 * without freezing the process. Note the consequence, because Project 2 lost an
 * hour to it: handlers that default to `systemClock` will see a date months
 * away from the repositories' date, so a test that cares about expiry has to
 * pass this same clock in rather than let the two drift apart.
 */
export async function createTestContext(options: { idPrefix?: string } = {}): Promise<TestContext> {
  const db = createTestDatabase();
  await runMigrations(db, MIGRATIONS_DIR, { now: () => '2026-01-01T00:00:00.000Z' });

  const repos = createRepositories(db, {
    clock: createFixedClock('2026-06-01T00:00:00.000Z', 1000),
    newId: createSequentialIds(options.idPrefix ?? 'test'),
  });

  return { db, repos, close: () => db.close() };
}

/** The clock `createTestContext` pins the repositories to. */
export const TEST_CLOCK_ISO = '2026-06-01T00:00:00.000Z';

/** Asserts a promise rejects, and returns the error for further assertions. */
export async function rejects(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (err) {
    return err as Error;
  }
  throw new Error('Expected the call to reject, and it resolved.');
}
