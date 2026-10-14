import type { SqlParam } from '../types.ts';

// Small SQL builders shared by the repositories.
//
// Deliberately not an ORM and deliberately not a query builder: these two
// functions assemble an INSERT and an UPDATE from a column→value map and do
// nothing else. No joins, no conditions, no relations, no lazy loading. Every
// SELECT in this codebase is written out as SQL, because a SELECT is where the
// interesting decisions live (which index, what ordering, what a soft delete
// means) and hiding those behind a builder is how a data layer stops being
// reviewable.
//
// Values are always parameterised. Column names are interpolated — they come
// from this codebase, never from a request — and the identifier guard below
// makes that assumption explicit and enforced rather than assumed.

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(name: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`Unsafe SQL identifier: ${JSON.stringify(name)}`);
  }
  return name;
}

export type ColumnValues = Record<string, SqlParam>;

export function buildInsert(table: string, values: ColumnValues): { sql: string; params: SqlParam[] } {
  assertIdentifier(table);
  const columns = Object.keys(values).map(assertIdentifier);
  if (columns.length === 0) throw new Error(`Refusing to build an INSERT into ${table} with no columns.`);

  const placeholders = columns.map(() => '?').join(', ');
  return {
    sql: `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
    params: columns.map((column) => values[column] as SqlParam),
  };
}

/**
 * Builds an UPDATE ... WHERE id = ?.
 *
 * `undefined` values are dropped so a caller can pass a patch object straight
 * through: leaving a field out means "do not change it", while passing null
 * means "set it to null". Those are genuinely different intentions and the
 * repositories rely on being able to express both.
 */
export function buildUpdate(
  table: string,
  id: string,
  values: Record<string, SqlParam | undefined>,
): { sql: string; params: SqlParam[] } | null {
  assertIdentifier(table);
  const entries = Object.entries(values).filter(([, value]) => value !== undefined) as Array<[string, SqlParam]>;
  if (entries.length === 0) return null;

  const assignments = entries.map(([column]) => `${assertIdentifier(column)} = ?`).join(', ');
  return {
    sql: `UPDATE ${table} SET ${assignments} WHERE id = ?`,
    params: [...entries.map(([, value]) => value), id],
  };
}
