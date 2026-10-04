import pg from 'pg';
import { convertPlaceholders } from './dialect.ts';
import type { Database, QueryResult, SqlParam } from './types.ts';

// PostgreSQL driver (D1) — the hosted path, Neon or otherwise.
//
// STATUS: NOT verified against a live PostgreSQL server for THIS project's
// schema. This driver was inherited from the inbox-crm-agent project, where it
// ran against hosted PostgreSQL; that history does not transfer to a different
// schema. Every test here runs on SQLite, and `test/driver-parity.test.ts` pins
// the contract from the SQLite side only. The suites are driver-agnostic in
// their SQL, but a divergence in how a driver *returns* a value would pass all
// of them — see the JSON note below. Running the suites against a real server
// is still to do.
//
// This module is loaded lazily by `db/index.ts` so that a machine without a
// database URL never imports `pg` at all.

const { Pool } = pg;

// --- JSON columns must look the same from both drivers -----------------------
//
// `node:sqlite` returns a JSON column as the text it stored. `pg` parses JSONB
// and hands back a real JavaScript value. For an object or an array that makes
// no difference — `toJson` passes those through untouched — and this schema's
// only JSON column, `audit_events.payload`, always holds an object.
//
// The divergence bit the inbox-crm-agent project, whose schema also stored JSON
// *scalars* (24, false, "assisted"): through pg those arrive as a number, a
// boolean and an already-unwrapped string, and `toJson` threw or parsed twice,
// on PostgreSQL only, while every test passed on SQLite. This project has no
// such column, but the override stays so both drivers hand `toJson` the same
// thing — text — if one is ever added.
//
// Fixing it here rather than in `toJson` is deliberate: teaching `toJson` to
// accept a number and a boolean would still leave the string case wrong,
// because a JSON string that happens to contain valid JSON (`"123"`) would be
// parsed twice.
//
// Safe because every JSONB read in the codebase goes through `toJson`.
pg.types.setTypeParser(pg.types.builtins.JSON, (value) => value);
pg.types.setTypeParser(pg.types.builtins.JSONB, (value) => value);

function toPgParams(params: readonly SqlParam[]): unknown[] {
  return [...params];
}

export function createPostgresDatabase(connectionString: string): Database {
  const pool = new Pool({
    connectionString,
    // Neon and most hosted Postgres providers terminate plaintext connections.
    // Local development against a plain server keeps working because the flag
    // is only set when the URL does not already say otherwise.
    ...(/\bsslmode=/.test(connectionString) ? {} : { ssl: { rejectUnauthorized: true } }),
    max: 5,
  });

  const wrapClient = (client: pg.PoolClient | pg.Pool, depth: number): Database => ({
    driver: 'postgres',

    async query<Row = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<Row[]> {
      const result = await client.query(convertPlaceholders(sql), toPgParams(params));
      return result.rows as Row[];
    },

    async execute(sql: string, params: readonly SqlParam[] = []): Promise<QueryResult> {
      const result = await client.query(convertPlaceholders(sql), toPgParams(params));
      return { rowCount: result.rowCount ?? 0 };
    },

    async exec(sql: string): Promise<void> {
      await client.query(sql);
    },

    async transaction<T>(fn: (tx: Database) => Promise<T>): Promise<T> {
      // A nested call must run on the *same* client as its parent, or it would
      // be a separate connection outside the parent's transaction — which
      // would quietly break atomicity rather than fail loudly.
      if (depth > 0) {
        const name = `sp_${depth}`;
        await client.query(`SAVEPOINT ${name}`);
        try {
          const result = await fn(wrapClient(client, depth + 1));
          await client.query(`RELEASE SAVEPOINT ${name}`);
          return result;
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          await client.query(`RELEASE SAVEPOINT ${name}`);
          throw err;
        }
      }

      const dedicated = await pool.connect();
      try {
        await dedicated.query('BEGIN');
        const result = await fn(wrapClient(dedicated, 1));
        await dedicated.query('COMMIT');
        return result;
      } catch (err) {
        await dedicated.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        dedicated.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  });

  return wrapClient(pool, 0);
}
