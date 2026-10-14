import { randomUUID, createHash } from 'node:crypto';

// Identity generation (the portability rules).
//
// IDs are generated in application code, never by the database. Two
// consequences, both load-bearing:
//
//   1. No `gen_random_uuid()`, so no pgcrypto extension, so the same DDL runs
//      on Postgres and SQLite unchanged.
//   2. An id exists *before* the row does. That is what lets a multi-step operation build
//      a multi-action plan in memory — where action 3 references the company
//      action 1 will create — and then write the whole thing in one
//      transaction. If ids came back from INSERTs, the plan would have to be
//      applied step-by-step and atomicity would be gone.

export type IdGenerator = () => string;

export const newId: IdGenerator = () => randomUUID();

/**
 * A deterministic id generator for tests and evaluations.
 *
 * Same prefix and same call order produce the same ids, every run — which is
 * what makes a failing test reproducible and an evaluation comparable between
 * runs.
 *
 * IT MUST PRODUCE VALID UUIDs, AND THAT WAS LEARNED THE HARD WAY.
 *
 * It used to return `prefix-1`, `prefix-2`, on the reasoning that a readable id
 * makes a failure easier to read. That worked only because SQLite maps the
 * schema's `UUID` columns to `TEXT` and accepts any string. PostgreSQL enforces
 * the type, so the first insert against a real server failed with
 * `invalid input syntax for type uuid` — and every test and all six evaluations
 * were therefore incapable of running against the database this project is
 * actually designed to deploy on.
 *
 * Deriving from `deterministicId` keeps the determinism, keeps the prefix
 * meaningful (a given prefix always yields the same sequence), and produces ids
 * both drivers accept. The readability that was lost was worth less than the
 * ability to test against Postgres at all.
 */
export function createSequentialIds(prefix = 'id'): IdGenerator {
  let n = 0;
  return () => deterministicId(`${prefix}-${++n}`);
}

/**
 * A stable UUID derived from a name — same name in, same id out, forever.
 *
 * The seed data uses this so that the demo can be reset to *exactly* the same
 * state, ids included, while the seed file itself stays readable: it
 * references `company:harborview-digital` rather than a hex string nobody can
 * check. Deriving the id also means the fixture file cannot contain a typo'd
 * UUID that points at nothing.
 *
 * Shaped as a v5-style UUID (version nibble 5, RFC-4122 variant) because it is
 * exactly that: a name-based, deterministic id — as opposed to `newId()`, which
 * is random and used for everything the system creates at runtime.
 */
export function deterministicId(name: string): string {
  const hex = createHash('sha256').update(`explainable-ats:${name}`).digest('hex');
  const version = `5${hex.slice(13, 16)}`;
  const variantNibble = ((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  const variant = `${variantNibble}${hex.slice(17, 20)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;
}
