import { config, configProblems } from '../src/config/env.ts';
import { createDatabase } from '../src/db/index.ts';
import { runMigrations, appliedMigrations } from '../src/db/migrate.ts';

// `npm run migrate`

async function main(): Promise<void> {
  for (const problem of configProblems) console.warn(`[config] ${problem}`);

  const db = await createDatabase(config);
  try {
    console.log(`[migrate] driver: ${db.driver}`);
    const report = await runMigrations(db, config.migrationsDir);
    for (const name of report.applied) console.log(`[migrate] applied ${name}`);
    const applied = await appliedMigrations(db);
    console.log(`[migrate] schema is at ${applied.length} migration(s).`);
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('[migrate] failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
