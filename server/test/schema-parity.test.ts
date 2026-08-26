import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS_DIR } from './helpers.ts';
import {
  AUDIT_ACTORS,
  AUDIT_OUTCOMES,
  AUDIT_STAGES,
  CANDIDATE_SOURCES,
  CONFIDENCE_LEVELS,
  DECISION_OUTCOMES,
  EVALUATION_STATUSES,
  JOB_STATUSES,
  MATCH_VERDICTS,
  REQUIREMENT_KINDS,
  SENIORITIES,
  SENSITIVE_CATEGORIES,
  VERDICT_BASIS_POINTS,
  BASIS_POINTS_MAX,
} from '../src/domain/ats.ts';

// Schema parity.
//
// Every closed set in the domain is mirrored by a CHECK constraint in the
// schema. Either can be edited without the other, and the failure that produces
// is the worst kind: a value the code can construct and the database rejects,
// surfacing on whichever input first happens to use it. So both are read here
// and compared.
//
// The comparison is against the migration TEXT rather than a live database,
// because that is the artefact both drivers are built from — and because a
// constraint that never made it into the file would otherwise pass by being
// absent from both sides.

const schema = fs.readFileSync(path.join(MIGRATIONS_DIR, '002_domain.sql'), 'utf8');

/**
 * The schema with its comments removed.
 *
 * Needed because the comments explain the rules — the note about never using a
 * float contains the word "float", and "double-count" contains "double". A scan
 * that reads them finds the prose rather than the columns.
 */
const sql = schema.replace(/^\s*--.*$/gm, '').replace(/\s*--.*$/gm, '');

/** The body of the CHECK constraint on one column, or '' if there is none. */
function checkFor(column: string): string {
  const pattern = new RegExp(`${column}\\s+[A-Z]+[^,]*?CHECK\\s*\\(([^)]*\\([^)]*\\)[^)]*|[^)]*)\\)`, 's');
  return pattern.exec(schema)?.[1] ?? '';
}

function assertEnumMirrored(column: string, values: readonly string[]): void {
  const body = checkFor(column);
  assert.ok(body.length > 0, `no CHECK constraint found for "${column}" — the guard below would be vacuous`);

  for (const value of values) {
    assert.ok(body.includes(`'${value}'`), `the schema rejects "${value}", which the domain can produce for ${column}`);
  }

  // And the other direction: a value in the schema the domain does not know is
  // a value nothing can read back safely.
  const inSchema = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  for (const value of inSchema) {
    assert.ok(values.includes(value as string), `the schema allows "${value}" for ${column}, which the domain does not`);
  }
}

test('every domain enum matches its CHECK constraint', () => {
  assertEnumMirrored('seniority', SENIORITIES);
  assertEnumMirrored('status', JOB_STATUSES);
  assertEnumMirrored('kind', REQUIREMENT_KINDS);
  assertEnumMirrored('source', CANDIDATE_SOURCES);
  assertEnumMirrored('category', SENSITIVE_CATEGORIES);
  assertEnumMirrored('verdict', MATCH_VERDICTS);
  assertEnumMirrored('confidence', CONFIDENCE_LEVELS);
  assertEnumMirrored('outcome', DECISION_OUTCOMES);
  assertEnumMirrored('actor', AUDIT_ACTORS);
  assertEnumMirrored('stage', AUDIT_STAGES);
});

test('NEGATIVE CONTROL — the parity check detects a divergence', () => {
  // Everything above passes when the two sides agree, which is also what a
  // broken comparison looks like. This proves the assertion actually fires.
  const body = checkFor('verdict');
  assert.ok(body.length > 0);
  assert.ok(!body.includes("'invented_verdict'"), 'the fixture value must not really be in the schema');

  assert.throws(() => {
    assertEnumMirrored('verdict', [...MATCH_VERDICTS, 'invented_verdict']);
  }, /the schema rejects "invented_verdict"/);
});

test('the two enums the parity helper cannot see are checked directly', () => {
  // `status` appears on both `jobs` and `evaluations`, and the helper finds the
  // first. Checking the second explicitly rather than pretending one assertion
  // covered both.
  // `jobs.status` carries a DEFAULT between the type and the CHECK, so the
  // pattern has to allow anything in between or it silently finds only one.
  const evaluationStatus = /status\s+TEXT NOT NULL[^,]*?CHECK \(status IN \(([^)]*)\)\)/g;
  const bodies = [...schema.matchAll(evaluationStatus)].map((m) => m[1] ?? '');
  assert.ok(bodies.length >= 2, `expected two status constraints, found ${bodies.length}`);

  const combined = bodies.join(' ');
  for (const value of EVALUATION_STATUSES) {
    assert.ok(combined.includes(`'${value}'`), `no CHECK accepts evaluation status "${value}"`);
  }
  for (const value of AUDIT_OUTCOMES) {
    assert.ok(schema.includes(`'${value}'`), `no CHECK accepts audit outcome "${value}"`);
  }
});

// ================================================= structural guarantees

test('all ten domain tables exist, and no eleventh appeared', () => {
  const tables = [...schema.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...tables].sort(),
    [
      'audit_events',
      'candidates',
      'evaluations',
      'evidence',
      'job_requirements',
      'jobs',
      'recruiter_decisions',
      'requirement_matches',
      'resumes',
      'sensitive_findings',
    ],
    'the domain gained or lost a table',
  );
});

test('there is no ranking table', () => {
  // Deliberate. A ranking is a pure function of the current evaluations;
  // storing it would create a second source of truth able to disagree with the
  // first the moment one evaluation is superseded.
  assert.ok(!/CREATE TABLE ranking/i.test(schema), 'a ranking table was added — it must stay derived');
});

test('the quarantine cannot store the value it quarantines', () => {
  // The point of `sensitive_findings` is that a protected attribute was
  // detected and excluded. A column holding the value would undo that.
  const table = /CREATE TABLE sensitive_findings \(([\s\S]*?)\n\);/.exec(schema)?.[1] ?? '';
  assert.ok(table.length > 0, 'the sensitive_findings table was not found');

  assert.ok(/char_start/.test(table) && /char_end/.test(table), 'the finding does not record where it was');
  for (const forbidden of ['value', 'content', 'text', 'quote', 'detail']) {
    assert.ok(
      !new RegExp(`\\b${forbidden}\\s+TEXT`, 'i').test(table),
      `sensitive_findings has a "${forbidden}" column — it must record the category and location, never the value`,
    );
  }
});

test('scores are integers, never floats or NUMERIC', () => {
  // A float makes the same inputs produce different last digits on different
  // machines, and `pg` returns NUMERIC as a string, so a weight arriving as "3"
  // would concatenate rather than add.
  assert.match(schema, /score_basis_points\s+INTEGER/, 'the score column is not an integer');
  assert.match(schema, /contribution_basis_points\s+INTEGER/, 'the contribution column is not an integer');
  // Word-bounded, and against the comment-free SQL: this is a check about
  // column types, not about the prose that explains them.
  assert.ok(
    !/\b(NUMERIC|REAL|FLOAT|DOUBLE PRECISION)\b/i.test(sql),
    'a floating-point or NUMERIC column reached the schema',
  );
});

test('the arithmetic contract is bounded and consistent', () => {
  assert.equal(BASIS_POINTS_MAX, 10_000);
  assert.equal(VERDICT_BASIS_POINTS.met, BASIS_POINTS_MAX);
  assert.equal(VERDICT_BASIS_POINTS.not_met, 0);
  // `unclear` earns nothing but is NOT the same fact as `not_met`, which is why
  // it is a separate verdict rather than a synonym.
  assert.equal(VERDICT_BASIS_POINTS.unclear, 0);
  assert.notEqual(MATCH_VERDICTS.indexOf('unclear'), MATCH_VERDICTS.indexOf('not_met'));

  for (const verdict of MATCH_VERDICTS) {
    const points = VERDICT_BASIS_POINTS[verdict];
    assert.ok(Number.isInteger(points), `${verdict} is worth a non-integer`);
    assert.ok(points >= 0 && points <= BASIS_POINTS_MAX, `${verdict} is out of range`);
  }

  // And the schema agrees about the bound.
  assert.match(schema, /score_basis_points BETWEEN 0 AND 10000/);
});

test('the constraints that stop double counting are present', () => {
  assert.match(schema, /UNIQUE \(evaluation_id, requirement_id\)/, 'a requirement could be judged twice');
  assert.match(schema, /UNIQUE \(correlation_id, sequence\)/, 'an audit sequence could be duplicated');
  assert.match(schema, /UNIQUE \(job_id, label\)/, 'a requirement label could be duplicated within a job');
  assert.match(schema, /UNIQUE \(candidate_id, content_hash\)/, 'the same resume could be stored twice');
  assert.match(schema, /evaluation_id\s+UUID NOT NULL UNIQUE/, 'an evaluation could carry two decisions');
});

test('a weight cannot be zero and a span cannot be empty', () => {
  assert.match(schema, /weight\s+INTEGER NOT NULL CHECK \(weight > 0\)/);
  const emptySpanGuards = [...schema.matchAll(/CHECK \(char_end > char_start\)/g)];
  assert.ok(emptySpanGuards.length >= 2, 'a table with offsets does not guard against an empty span');
});
