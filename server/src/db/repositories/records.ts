import { buildInsert } from './helpers.ts';
import { toText, toTextOrNull, toNumberOrNull } from '../rows.ts';
import type { RepoDeps } from './types.ts';

// The record of each extraction (`evaluation_records`): the model, the cost, the
// time, and the model's answer exactly as it came back. One row per evaluation,
// written for failures as well as successes.
//
// Kept apart from the evaluations repository on purpose: an evaluation is read in
// lists and rankings, and none of those should carry a model's raw answer along.

/** How an extraction ended. `succeeded`, or the kind of failure (see `adapters/llm/failures.ts`). */
export const RECORD_RESULTS = ['succeeded', 'refusal', 'truncated', 'malformed', 'unavailable', 'rejected', 'unexpected'] as const;
export type RecordResult = (typeof RECORD_RESULTS)[number];

export type EvaluationRecord = {
  evaluationId: string;
  result: RecordResult;
  model: string | null;
  maxTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  /** Entries in the model's `findings` array before validation. 0 means it found nothing. */
  findingsReturned: number | null;
  /** The tool input as received, as JSON text. Redacted text only. Null when there was none. */
  rawOutput: string | null;
  createdAt: string;
};

export type RecordInput = {
  evaluationId: string;
  result: RecordResult;
  model?: string | null;
  maxTokens?: number | null;
  usage?: { inputTokens: number; outputTokens: number } | null;
  latencyMs?: number | null;
  findingsReturned?: number | null;
  /** Anything JSON-serialisable: stored as text. */
  raw?: unknown;
};

/**
 * A model's answer is bounded by the output limit, so this is a guard against a bug
 * rather than a working limit. Past it the text is cut and says so; a record that
 * quietly lost its tail would look complete.
 */
export const MAX_RAW_OUTPUT_CHARS = 200_000;
const CUT_MARKER = '\n[cut: the stored copy was longer than the limit]';

function serialise(raw: unknown): string | null {
  if (raw === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(raw) ?? 'null';
  } catch {
    // Something that cannot be serialised is stored as a statement of that fact,
    // never dropped silently and never allowed to fail the write that matters.
    return '"[the output could not be serialised]"';
  }
  return text.length > MAX_RAW_OUTPUT_CHARS ? `${text.slice(0, MAX_RAW_OUTPUT_CHARS)}${CUT_MARKER}` : text;
}

function mapRecord(row: Record<string, unknown>): EvaluationRecord {
  return {
    evaluationId: toText(row.evaluation_id),
    result: toText(row.result) as RecordResult,
    model: toTextOrNull(row.model),
    maxTokens: toNumberOrNull(row.max_tokens),
    inputTokens: toNumberOrNull(row.input_tokens),
    outputTokens: toNumberOrNull(row.output_tokens),
    latencyMs: toNumberOrNull(row.latency_ms),
    findingsReturned: toNumberOrNull(row.findings_returned),
    rawOutput: toTextOrNull(row.raw_output),
    createdAt: toText(row.created_at),
  };
}

export function createEvaluationRecordRepository({ db, clock }: RepoDeps) {
  return {
    /**
     * Records how an evaluation's extraction ended. Replaces an earlier record for the
     * same evaluation rather than failing: an evaluation is extracted once, so a second
     * write can only be a retry of this one.
     */
    async record(input: RecordInput): Promise<EvaluationRecord> {
      await db.execute('DELETE FROM evaluation_records WHERE evaluation_id = ?', [input.evaluationId]);

      const { sql, params } = buildInsert('evaluation_records', {
        evaluation_id: input.evaluationId,
        result: input.result,
        model: input.model ?? null,
        max_tokens: input.maxTokens ?? null,
        input_tokens: input.usage?.inputTokens ?? null,
        output_tokens: input.usage?.outputTokens ?? null,
        latency_ms: input.latencyMs ?? null,
        findings_returned: input.findingsReturned ?? null,
        raw_output: serialise(input.raw),
        created_at: clock.nowIso(),
      });
      await db.execute(sql, params);

      const stored = await this.getForEvaluation(input.evaluationId);
      if (!stored) throw new Error('The extraction record was not found after it was written.');
      return stored;
    },

    async getForEvaluation(evaluationId: string): Promise<EvaluationRecord | null> {
      const rows = await db.query('SELECT * FROM evaluation_records WHERE evaluation_id = ?', [evaluationId]);
      return rows[0] ? mapRecord(rows[0] as Record<string, unknown>) : null;
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM evaluation_records');
      return toNumberOrNull(rows[0]?.n ?? 0) ?? 0;
    },
  };
}
