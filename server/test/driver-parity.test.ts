import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTestContext, MIGRATION_COUNT, MIGRATIONS_DIR } from './helpers.ts';
import { runMigrations, readMigrations, checksumOf, appliedMigrations } from '../src/db/migrate.ts';
import { createTestDatabase } from '../src/db/index.ts';
import { toJson, fromJson, toText, toNumber } from '../src/db/rows.ts';
import { convertPlaceholders } from '../src/db/dialect.ts';
import { handleHealth } from '../src/handlers/health.ts';
import { loadConfig } from '../src/config/env.ts';

// Driver parity — on day one, deliberately.
//
// Project 2 ran every test on SQLite and deployed on PostgreSQL. The two
// drivers disagreed about how a JSON column comes back: `node:sqlite` returns
// the text it stored, `pg` returns a parsed value. For objects and arrays that
// difference is invisible, because the row mapper passes those straight
// through — so it stayed hidden until a table stored a JSON *scalar*, and then
// every caller of that table failed in production and only in production.
//
// The lesson is not "test PostgreSQL more". It is that a divergence in how a
// driver RETURNS a value passes a suite that is driver-agnostic in its SQL.
// These tests pin the contract from the SQLite side, which is the side this
// suite can run, and the PostgreSQL driver is configured to honour the same
// contract by returning raw JSON text.

// ============================================================ JSON contract

test('every JSON shape survives the round trip a column takes', () => {
  // Both drivers hand `toJson` text; it parses exactly once. These are the
  // shapes that will hold requirement criteria, evidence spans and audit
  // payloads from P3-B onwards.
  assert.deepEqual(toJson(fromJson({ weight: 3 }), null), { weight: 3 });
  assert.deepEqual(toJson(fromJson([1, 2, 3]), null), [1, 2, 3]);
  assert.deepEqual(toJson(fromJson([]), null), []);
  assert.deepEqual(toJson(fromJson({}), null), {});

  // The scalars. These are the ones that broke Project 2.
  assert.equal(toJson(fromJson(24), null), 24);
  assert.equal(toJson(fromJson(0), null), 0);
  assert.equal(toJson(fromJson(false), null), false);
  assert.equal(toJson(fromJson(true), null), true);
  assert.equal(toJson(fromJson('senior'), null), 'senior');
  assert.equal(toJson(fromJson(''), null), '');
  // A stored JSON `null` reads back as null — it is a value, not an absence.
  // The fallback is for a column that holds nothing at all, asserted below.
  assert.equal(toJson(fromJson(null), 'fallback'), null);
});

test('an absent value falls back instead of throwing', () => {
  assert.deepEqual(toJson(null, { fallback: true }), { fallback: true });
  assert.deepEqual(toJson(undefined, { fallback: true }), { fallback: true });
  assert.deepEqual(toJson('', { fallback: true }), { fallback: true });
});

test('NEGATIVE CONTROL — an already-parsed scalar is exactly what broke before', () => {
  // `toJson` refuses a bare number, and that is correct: the contract is that a
  // JSON column arrives as text. The fix in Project 2 was to make PostgreSQL
  // honour that contract, not to make this helper permissive — a helper that
  // accepted anything would have hidden the divergence instead of surfacing it.
  assert.throws(() => toJson(24 as unknown, null), /Expected a JSON column value, received number/);
  assert.throws(() => toJson(false as unknown, null), /Expected a JSON column value, received boolean/);

  // And the string case, which is why loosening the helper could not have
  // worked: an unwrapped string is indistinguishable from stored JSON text.
  assert.throws(() => toJson('senior', null), SyntaxError);
});

test('the PostgreSQL driver asks pg for raw JSON text', () => {
  // Source-level, because the driver only imports with `pg` present and a
  // connection string. Both registrations must exist: dropping either would
  // resurrect the divergence for that column type.
  const source = fs.readFileSync(new URL('../src/db/postgres.ts', import.meta.url), 'utf8');
  assert.match(source, /setTypeParser\(\s*pg\.types\.builtins\.JSON\s*,/, 'the JSON type parser is not registered');
  assert.match(source, /setTypeParser\(\s*pg\.types\.builtins\.JSONB\s*,/, 'the JSONB type parser is not registered');
});

// ================================================ timestamps and numbers

test('a Date and a text timestamp read the same', () => {
  // `pg` returns TIMESTAMPTZ as a Date; SQLite returns text. Both must reach
  // the domain as one ISO string, or every date comparison depends on the host.
  const iso = '2026-06-01T00:00:00.000Z';
  assert.equal(toText(new Date(iso)), iso);
  assert.equal(toText(iso), iso);
  assert.equal(toText(null), '');
});

test('a numeric column reads as a number from either driver', () => {
  // `pg` can return NUMERIC as a string. A weight that arrives as "3" and is
  // then summed would concatenate instead of adding — and scoring is arithmetic.
  assert.equal(toNumber(3), 3);
  assert.equal(toNumber('3'), 3);
  assert.equal(toNumber(BigInt(3)), 3);
  assert.throws(() => toNumber('not a number'), TypeError);
});

// ============================================================ SQL dialect

test('placeholders are translated for PostgreSQL and left alone for SQLite', () => {
  const sql = 'SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?';
  assert.equal(convertPlaceholders(sql), 'SELECT * FROM sessions WHERE token_hash = $1 AND expires_at > $2');
  // One statement, written once, run on both — which is what makes a single
  // migration file describe two databases.
  assert.ok(!convertPlaceholders(sql).includes('?'));
});

// ============================================================== migrations

test('the foundation migration applies and is recorded', async () => {
  const { db, close } = await createTestContext();
  const applied = await appliedMigrations(db);

  assert.equal(applied.length, MIGRATION_COUNT);
  assert.ok(MIGRATION_COUNT > 0, 'PRECONDITION: there must be a migration to apply');
  assert.equal(applied[0]?.name, '001_foundation.sql');
  await close();
});

test('a migration is immutable once applied', async () => {
  // The checksum is the point of the table. Editing an applied migration means
  // two databases with the same version number and different schemas, which is
  // the kind of drift nobody notices until a deploy.
  const { db, close } = await createTestContext();
  const stored = await appliedMigrations(db);
  const onDisk = readMigrations(MIGRATIONS_DIR);

  let matched = 0;
  for (const file of onDisk) {
    const row = stored.find((r) => r.name === file.name);
    if (row && row.checksum === checksumOf(file.sql)) matched += 1;
  }
  assert.equal(matched, onDisk.length, 'a stored checksum does not match the file on disk');
  await close();
});

test('migrating twice changes nothing', async () => {
  const { db, close } = await createTestContext();
  const report = await runMigrations(db, MIGRATIONS_DIR);

  assert.deepEqual(report.applied, [], 'a second run re-applied a migration');
  assert.equal(report.skipped.length, MIGRATION_COUNT);
  await close();
});

// ================================================== the schema is usable

test('the sessions table round-trips a row', async () => {
  const { repos, close } = await createTestContext();

  const { token, session } = await repos.sessions.create('operator', 12);
  assert.ok(token.length > 0);
  assert.equal(session.operator, 'operator');

  const found = await repos.sessions.findLive(token, '2026-06-01T01:00:00.000Z');
  assert.ok(found, 'a live session was not found by its token');
  assert.equal(found.operator, 'operator');

  // The raw token is never stored — only its hash — so a database leak does not
  // hand over live sessions.
  const rows = await repos.db.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]?.token_hash, token, 'the raw session token was stored');

  await close();
});

test('an expired session is not returned', async () => {
  const { repos, close } = await createTestContext();
  const { token } = await repos.sessions.create('operator', 12);

  // One second past the window.
  const after = await repos.sessions.findLive(token, '2026-06-01T12:00:01.000Z');
  assert.equal(after, null, 'an expired session was returned as live');
  await close();
});

// ============================================================ transactions

test('a failed transaction rolls back every repository it touched', async () => {
  const { repos, db, close } = await createTestContext();
  const MARKER = 'deliberate-rollback';

  let threw: Error | null = null;
  try {
    await repos.transaction(async (tx) => {
      await tx.sessions.create('operator', 12);
      throw new Error(MARKER);
    });
  } catch (err) {
    threw = err as Error;
  }

  // Assert the body ran and failed for the reason given. Without this a
  // TypeError from a mistyped method name would be caught here and read as a
  // successful rollback — a test that never opened a transaction. Project 2
  // shipped exactly that.
  assert.ok(threw, 'the transaction did not throw at all');
  assert.match(threw.message, new RegExp(MARKER), 'it failed for some other reason');

  const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM sessions');
  assert.equal(toNumber(rows[0]?.n), 0, 'a write inside a failed transaction survived');
  await close();
});

// ================================================================= health

test('health reports the configuration of the app it was given', async () => {
  const { db, close } = await createTestContext();
  const { config } = loadConfig({ LLM_PROVIDER: 'mock' });

  const { status, body } = await handleHealth({ db, config });
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.database.reachable, true);
  assert.equal(body.database.migrationsApplied, MIGRATION_COUNT);
  assert.equal(body.adapters.llmProvider, 'mock');

  // The version is a product version, never a milestone label: it is rendered
  // on an operator surface, where "P3-A" would read as a pre-release marker.
  assert.doesNotMatch(body.version, /^P\d/);
  await close();
});

test('health degrades rather than throwing when the database is gone', async () => {
  const { db, close } = await createTestContext();
  await close();

  const { status, body } = await handleHealth({ db });
  // Still 200: the service is up and answering, which is what a liveness probe
  // asks. `degraded` in the body is what a readiness check reads.
  assert.equal(status, 200);
  assert.equal(body.status, 'degraded');
  assert.equal(body.database.reachable, false);
});

test('health never reports a secret', async () => {
  const db = createTestDatabase();
  const { config } = loadConfig({
    ANTHROPIC_API_KEY: 'sk-ant-not-a-real-key',
    DATABASE_URL: 'postgresql://someone:placeholder@db.example.test/appdb',
    OPERATOR_PASSWORD_HASH: 'scrypt$32768$8$1$c2FsdA$aGFzaA',
    LLM_PROVIDER: 'anthropic',
  });

  const { body } = await handleHealth({ db, config });
  const serialised = JSON.stringify(body);

  assert.ok(!serialised.includes('sk-ant'), 'an API key reached the health payload');
  assert.ok(!serialised.includes('placeholder'), 'a connection string reached the health payload');
  assert.ok(!serialised.includes('db.example.test'), 'a host name reached the health payload');
  assert.ok(!serialised.includes('scrypt$'), 'a password hash reached the health payload');

  // It still says whether things are configured — that is the useful half.
  assert.equal(body.adapters.authConfigured, true);
  assert.equal(body.adapters.llmConfigured, true);
  await db.close();
});
