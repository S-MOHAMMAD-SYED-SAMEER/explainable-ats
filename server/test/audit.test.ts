import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestContext, rejects } from './helpers.ts';
import { deterministicId } from '../src/lib/ids.ts';

// The audit log.
//
// This is the record that has to still be true in six months, when somebody
// asks why a candidate was rejected. Two properties matter, and both are tested
// here rather than asserted in a comment: it cannot be rewritten, and it cannot
// quietly lose or duplicate an entry.

const CORRELATION = deterministicId('audit-correlation');

// ======================================================= append-only, by shape

test('the audit repository exposes no way to change or remove an event', () => {
  // Enforced by ABSENCE. Not "there is a method you should not call" — there is
  // none, so no caller can be written that rewrites history, and adding one
  // later is a visible change to this file rather than a line in a handler.
  const source = fs.readFileSync(
    new URL('../src/db/repositories/audit.ts', import.meta.url),
    'utf8',
  );

  for (const forbidden of [/\bUPDATE\s+audit_events/i, /\bDELETE\s+FROM\s+audit_events/i]) {
    assert.ok(!forbidden.test(source), `the audit repository contains ${forbidden}`);
  }

  // And no method named for mutation, whatever SQL it might contain.
  for (const method of ['update', 'delete', 'remove', 'edit', 'amend', 'clear', 'purge']) {
    assert.ok(
      !new RegExp(`async ${method}\\s*\\(`, 'i').test(source),
      `the audit repository has a "${method}" method`,
    );
  }
});

test('NEGATIVE CONTROL — that scan would catch a mutation if one were added', () => {
  // The test above passes when the file is clean, which is also what a broken
  // pattern looks like. This proves the patterns fire.
  const tampered = `
    async update(id: string) {
      await db.execute('UPDATE audit_events SET summary = ? WHERE id = ?', ['rewritten', id]);
    }
  `;
  assert.ok(/\bUPDATE\s+audit_events/i.test(tampered), 'the SQL pattern would not catch a rewrite');
  assert.ok(/async update\s*\(/i.test(tampered), 'the method pattern would not catch a mutator');
});

// ========================================================== sequence integrity

test('events are numbered from one, in the order they were appended', async () => {
  const { repos, close } = await createTestContext();

  for (const summary of ['job created', 'resume ingested', 'evidence extracted']) {
    await repos.audit.append({
      correlationId: CORRELATION,
      stage: 'system',
      eventType: 'test_event',
      actor: 'system',
      outcome: 'ok',
      summary,
    });
  }

  const events = await repos.audit.listForCorrelation(CORRELATION);
  assert.deepEqual(events.map((e) => e.sequence), [1, 2, 3], 'the sequence is not dense and ascending');
  assert.deepEqual(
    events.map((e) => e.summary),
    ['job created', 'resume ingested', 'evidence extracted'],
    'the trail is not in the order it happened',
  );

  await close();
});

test('two correlations number independently', async () => {
  // A trail is one story. Sharing a counter across stories would make every
  // sequence meaningless the moment two ran at once.
  const { repos, close } = await createTestContext();
  const other = deterministicId('audit-other');

  await repos.audit.append({
    correlationId: CORRELATION,
    stage: 'system',
    eventType: 'a',
    actor: 'system',
    outcome: 'ok',
    summary: 'first story',
  });
  const second = await repos.audit.append({
    correlationId: other,
    stage: 'system',
    eventType: 'b',
    actor: 'system',
    outcome: 'ok',
    summary: 'second story',
  });

  assert.equal(second.sequence, 1, 'a second correlation continued the first one\'s numbering');
  await close();
});

test('a duplicate sequence is refused by the database, not merely avoided', async () => {
  // The repository allocates the sequence inside a transaction, so this should
  // never fire in normal use. It is asserted anyway: the constraint is the
  // backstop, and a trail with two events claiming to be third looks complete
  // and is not.
  const { repos, db, close } = await createTestContext();

  const first = await repos.audit.append({
    correlationId: CORRELATION,
    stage: 'system',
    eventType: 'a',
    actor: 'system',
    outcome: 'ok',
    summary: 'first',
  });
  assert.equal(first.sequence, 1, 'PRECONDITION: the first event must be sequence 1');

  const err = await rejects(() =>
    db.execute(
      `INSERT INTO audit_events (id, correlation_id, sequence, stage, event_type, actor, outcome, summary, payload, created_at)
       VALUES (?, ?, ?, 'system', 'a', 'system', 'ok', 'forged', '{}', ?)`,
      [deterministicId('forged'), CORRELATION, 1, '2026-06-01T00:00:00.000Z'],
    ),
  );
  assert.match(err.message, /unique|constraint/i, 'a duplicate sequence was accepted');

  await close();
});

test('a sequence of zero is refused', async () => {
  const { db, close } = await createTestContext();
  const err = await rejects(() =>
    db.execute(
      `INSERT INTO audit_events (id, correlation_id, sequence, stage, event_type, actor, outcome, summary, payload, created_at)
       VALUES (?, ?, 0, 'system', 'a', 'system', 'ok', 'zero', '{}', ?)`,
      [deterministicId('zero'), CORRELATION, '2026-06-01T00:00:00.000Z'],
    ),
  );
  assert.match(err.message, /constraint|check/i);
  await close();
});

// ================================================================ the payload

test('a payload survives the round trip with its types intact', async () => {
  // The payload is a JSON column, and this is where Project 2's driver
  // divergence surfaced: a boolean or a number that came back as something
  // else. Asserted by type, not merely by value.
  const { repos, close } = await createTestContext();

  const appended = await repos.audit.append({
    correlationId: CORRELATION,
    stage: 'score',
    eventType: 'score_computed',
    actor: 'system',
    outcome: 'ok',
    summary: 'Scored against 3 requirements.',
    payload: {
      scoreBasisPoints: 8_333,
      mustHavesMet: 2,
      allMustHavesMet: true,
      unclearCount: 0,
      verdicts: ['met', 'met', 'partial'],
      note: null,
    },
  });

  const stored = await repos.audit.getById(appended.id);
  assert.ok(stored);
  assert.equal(typeof stored.payload.scoreBasisPoints, 'number', 'a number came back as something else');
  assert.equal(stored.payload.scoreBasisPoints, 8_333);
  assert.equal(typeof stored.payload.allMustHavesMet, 'boolean', 'a boolean came back as something else');
  assert.equal(stored.payload.allMustHavesMet, true);
  assert.equal(stored.payload.unclearCount, 0, 'a zero was lost');
  assert.deepEqual(stored.payload.verdicts, ['met', 'met', 'partial']);
  assert.equal(stored.payload.note, null);

  await close();
});

test('an event with no payload reads as an empty object, never undefined', async () => {
  const { repos, close } = await createTestContext();
  const appended = await repos.audit.append({
    correlationId: CORRELATION,
    stage: 'system',
    eventType: 'no_payload',
    actor: 'system',
    outcome: 'ok',
    summary: 'Nothing to record.',
  });

  const stored = await repos.audit.getById(appended.id);
  assert.deepEqual(stored?.payload, {}, 'a missing payload did not default to an empty object');
  await close();
});

// =============================================================== retrieval

test('the trail for one entity can be read back', async () => {
  const { repos, close } = await createTestContext();
  const evaluationId = deterministicId('evaluation-1');

  await repos.audit.append({
    correlationId: CORRELATION,
    stage: 'extract',
    eventType: 'evidence_recorded',
    actor: 'ai',
    actorId: 'mock',
    outcome: 'ok',
    summary: 'Found three quotes.',
    entityType: 'evaluation',
    entityId: evaluationId,
  });
  await repos.audit.append({
    correlationId: CORRELATION,
    stage: 'verify',
    eventType: 'evidence_rejected',
    actor: 'system',
    outcome: 'blocked',
    summary: 'A quote was not found in the resume and was discarded.',
    entityType: 'evaluation',
    entityId: evaluationId,
  });

  const trail = await repos.audit.listForEntity('evaluation', evaluationId);
  assert.equal(trail.length, 2);
  assert.equal(trail[0]?.actor, 'ai');
  assert.equal(trail[1]?.outcome, 'blocked', 'a rejected fabrication was not recorded as blocked');

  await close();
});

test('the log can be filtered by who acted', async () => {
  // "What did the AI do, and what did a person do" is the question a recruiter
  // asks of a trail, so it has to be answerable without reading all of it.
  const { repos, close } = await createTestContext();

  for (const actor of ['system', 'ai', 'human'] as const) {
    await repos.audit.append({
      correlationId: CORRELATION,
      stage: 'system',
      eventType: 'test',
      actor,
      outcome: 'ok',
      summary: `by ${actor}`,
    });
  }

  const byHuman = await repos.audit.list({ actor: 'human' });
  assert.equal(byHuman.length, 1);
  assert.equal(byHuman[0]?.actor, 'human');
  assert.equal((await repos.audit.list()).length, 3, 'the unfiltered list is not returning everything');

  await close();
});

// ============================================================ the migration

test('the append-only intent is stated in the schema, not only in code', () => {
  const migration = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../migrations/002_domain.sql'),
    'utf8',
  );

  assert.match(migration, /UNIQUE \(correlation_id, sequence\)/);
  assert.match(migration, /append-only/i, 'the schema does not say the log is append-only');
});
