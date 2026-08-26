import { buildInsert } from './helpers.ts';
import { toText, toTextOrNull, toNumber, toJson, fromJson } from '../rows.ts';
import type { RepoDeps, ListOptions } from './types.ts';
import type { AuditActor, AuditEvent, AuditOutcome, AuditStage } from '../../domain/ats.ts';

// The audit log.
//
// APPEND-ONLY, AND THAT IS ENFORCED BY ABSENCE
//
// There is no update method here and no delete method. Not "there is one but
// you should not call it" — there is none, so no caller can be written that
// rewrites history, and a future edit that adds one is a visible change to this
// file rather than a line buried in a handler.
//
// The sequence is unique per correlation, so two writers racing produce a
// constraint violation rather than two events silently claiming to be third.
// A gap or a duplicate in a trail is worse than a missing trail: it looks
// complete and is not.

function mapEvent(row: Record<string, unknown>): AuditEvent {
  return {
    id: toText(row.id),
    correlationId: toText(row.correlation_id),
    sequence: toNumber(row.sequence),
    stage: toText(row.stage) as AuditStage,
    eventType: toText(row.event_type),
    actor: toText(row.actor) as AuditActor,
    actorId: toTextOrNull(row.actor_id),
    outcome: toText(row.outcome) as AuditOutcome,
    summary: toText(row.summary),
    payload: toJson<Record<string, unknown>>(row.payload, {}),
    entityType: toTextOrNull(row.entity_type),
    entityId: toTextOrNull(row.entity_id),
    createdAt: toText(row.created_at),
  };
}

export type AppendAuditInput = {
  correlationId: string;
  stage: AuditStage;
  eventType: string;
  actor: AuditActor;
  actorId?: string | null;
  outcome: AuditOutcome;
  summary: string;
  payload?: Record<string, unknown>;
  entityType?: string | null;
  entityId?: string | null;
};

export function createAuditRepository({ db, clock, newId }: RepoDeps) {
  return {
    /**
     * Appends one event.
     *
     * The sequence is allocated inside a transaction, so two concurrent writers
     * on the same correlation cannot both read the same maximum. The unique
     * constraint is the backstop; the transaction is what stops it firing under
     * ordinary load.
     */
    async append(input: AppendAuditInput): Promise<AuditEvent> {
      const id = newId();

      await db.transaction(async (tx) => {
        const rows = await tx.query<{ next: number | null }>(
          'SELECT MAX(sequence) AS next FROM audit_events WHERE correlation_id = ?',
          [input.correlationId],
        );
        const sequence = Number(rows[0]?.next ?? 0) + 1;

        const { sql, params } = buildInsert('audit_events', {
          id,
          correlation_id: input.correlationId,
          sequence,
          stage: input.stage,
          event_type: input.eventType,
          actor: input.actor,
          actor_id: input.actorId ?? null,
          outcome: input.outcome,
          summary: input.summary,
          payload: fromJson(input.payload ?? {}),
          entity_type: input.entityType ?? null,
          entity_id: input.entityId ?? null,
          created_at: clock.nowIso(),
        });
        await tx.execute(sql, params);
      });

      const rows = await db.query('SELECT * FROM audit_events WHERE id = ?', [id]);
      return mapEvent(rows[0] as Record<string, unknown>);
    },

    async getById(id: string): Promise<AuditEvent | null> {
      const rows = await db.query('SELECT * FROM audit_events WHERE id = ?', [id]);
      return rows[0] ? mapEvent(rows[0] as Record<string, unknown>) : null;
    },

    /** One story, in the order it happened. */
    async listForCorrelation(correlationId: string): Promise<AuditEvent[]> {
      const rows = await db.query(
        'SELECT * FROM audit_events WHERE correlation_id = ? ORDER BY sequence',
        [correlationId],
      );
      return rows.map((row) => mapEvent(row as Record<string, unknown>));
    },

    async listForEntity(entityType: string, entityId: string): Promise<AuditEvent[]> {
      const rows = await db.query(
        'SELECT * FROM audit_events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at, sequence',
        [entityType, entityId],
      );
      return rows.map((row) => mapEvent(row as Record<string, unknown>));
    },

    async list(options: ListOptions & { actor?: AuditActor } = {}): Promise<AuditEvent[]> {
      const params: Array<string | number> = [];
      let where = '';
      if (options.actor) {
        where = ' WHERE actor = ?';
        params.push(options.actor);
      }
      const rows = await db.query(
        `SELECT * FROM audit_events${where} ORDER BY created_at DESC, sequence DESC LIMIT ? OFFSET ?`,
        [...params, Math.min(options.limit ?? 100, 500), options.offset ?? 0],
      );
      return rows.map((row) => mapEvent(row as Record<string, unknown>));
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM audit_events');
      return toNumber(rows[0]?.n ?? 0);
    },
  };
}

export { mapEvent };
