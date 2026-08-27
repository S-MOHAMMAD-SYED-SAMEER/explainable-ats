import { createDatabase } from '../src/db/index.ts';
import { createRepositories } from '../src/db/repositories/index.ts';
import { config } from '../src/config/env.ts';
import { clearDemoData, containsOnlyDemoData, isEmpty, seedDemoData } from '../src/demo/seed.ts';
import { DEMO_CANDIDATES, DEMO_JOB } from '../src/demo/dataset.ts';

// Loads the demo dataset into a database.
//
//   npm run seed:demo             seed, refusing if anything is already there
//   npm run seed:demo -- --reset  remove the demo dataset first, then seed
//
// THE GUARDS ARE THE INTERESTING PART
//
// This writes to whatever database the environment points at, and the
// environment is the one thing a script cannot verify the intent of. So it
// refuses rather than guesses:
//
//   * it will not touch PostgreSQL without --allow-remote, because the local
//     default is SQLite and a hosted URL in the environment is the difference
//     between seeding a laptop and seeding whatever is deployed;
//   * it will not seed over data that is already there;
//   * --reset will not run against a database holding anything it did not
//     create, checked by candidate reference rather than by hoping;
//   * it prints what it is about to do, and to which database, before writing.
//
// Nothing here can delete a non-demo row. `clearDemoData` deletes by the
// `demo-` reference prefix and by the demo job title, so the worst it can do to
// a database full of real applicants is nothing at all.

const args = new Set(process.argv.slice(2));
const reset = args.has('--reset');
const allowRemote = args.has('--allow-remote');

function refuse(message: string, remedy?: string): never {
  console.error(`\n[seed:demo] REFUSED — ${message}`);
  if (remedy) console.error(`[seed:demo] ${remedy}`);
  process.exit(1);
}

/** Never the URL itself: it carries a password. */
function describeTarget(): string {
  return config.dbDriver === 'postgres' ? 'a PostgreSQL server (from DATABASE_URL)' : config.sqlitePath;
}

async function main(): Promise<void> {
  console.log('[seed:demo] target:  ' + describeTarget());
  console.log('[seed:demo] driver:  ' + config.dbDriver);
  console.log('[seed:demo] dataset: ' + `"${DEMO_JOB.title}", ${DEMO_CANDIDATES.length} candidates`);

  if (config.dbDriver === 'postgres' && !allowRemote) {
    refuse(
      'the target is PostgreSQL, and this seeder defaults to local SQLite only.',
      'If you genuinely mean to seed a hosted database, re-run with --allow-remote.',
    );
  }

  const db = await createDatabase(config);
  const repos = createRepositories(db);

  try {
    const empty = await isEmpty(repos);
    const demoOnly = await containsOnlyDemoData(repos);

    if (!empty && !reset) {
      refuse(
        'this database already contains data.',
        'Re-run with --reset to replace the demo dataset, or point SQLITE_PATH somewhere else.',
      );
    }

    if (reset && !demoOnly) {
      refuse(
        'this database contains records that are not part of the demo dataset.',
        'Refusing to reset. Nothing has been changed.',
      );
    }

    if (reset && !empty) {
      const removed = await clearDemoData({ repos });
      console.log(`[seed:demo] removed ${removed.candidates} demo candidate(s) and ${removed.jobs} demo job(s).`);
    }

    const result = await seedDemoData({ repos });

    console.log(`\n[seed:demo] seeded "${result.jobTitle}" with ${result.requirementCount} requirements.`);
    for (const candidate of result.candidates) {
      const spec = DEMO_CANDIDATES.find((entry) => entry.reference === candidate.reference);
      const state = spec?.assess === 'queued' ? 'queued, not assessed' : (spec?.expected.tier ?? 'assessed');
      console.log(
        `[seed:demo]   ${candidate.reference}  ${candidate.displayName.padEnd(16)} ` +
          `${String(state).padEnd(22)} ${candidate.redactedCount} personal detail(s) masked`,
      );
    }
    console.log('\n[seed:demo] done. Start the server and open the Roles screen.');
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error('[seed:demo] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
