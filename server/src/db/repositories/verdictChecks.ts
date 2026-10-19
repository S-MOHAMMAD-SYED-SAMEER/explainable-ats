import { buildInsert } from './helpers.ts';
import { toBool, toText, toTextOrNull } from '../rows.ts';
import { VERDICT_MODES, type VerdictMode } from '../../agent/verdictMode.ts';
import type { MatchVerdict } from '../../domain/ats.ts';
import type { MatchMode } from '../../agent/matchRules.ts';
import type { RepoDeps } from './types.ts';

// The record of what the model said about each requirement and what the code did with it (`verdict_checks`).
// Written by the match stage, read by the evaluation detail and by the ranking (to route to a person a candidate with a credited
// must-have whose quote shares no word with the requirement: `routesToReview`).

export type Disagreement = 'none' | 'one_step' | 'two_plus';
export type DowngradeReason = 'no_verified_passage' | 'no_answer';

export type VerdictCheck = {
  id: string;
  evaluationId: string;
  requirementId: string;
  verdictMode: VerdictMode;
  modelVerdict: MatchVerdict | null;
  modelReason: string | null;
  enforcedVerdict: MatchVerdict;
  downgradeReason: DowngradeReason | null;
  matcherVerdict: MatchVerdict | null;
  matcherMode: MatchMode | null;
  disagreement: Disagreement;
  /** A credited verdict (met or partial) on quotes that share no word with the requirement: flagged for a person, never scored differently. */
  quoteNoOverlap: boolean;
  createdAt: string;
};

export type VerdictCheckInput = Omit<VerdictCheck, 'id' | 'createdAt'>;

function mapCheck(row: Record<string, unknown>): VerdictCheck {
  const mode = toText(row.verdict_mode);
  if (!(VERDICT_MODES as readonly string[]).includes(mode)) throw new Error(`Unknown verdict mode "${mode}" in verdict_checks.`);
  return {
    id: toText(row.id),
    evaluationId: toText(row.evaluation_id),
    requirementId: toText(row.requirement_id),
    verdictMode: mode as VerdictMode,
    modelVerdict: toTextOrNull(row.model_verdict) as MatchVerdict | null,
    modelReason: toTextOrNull(row.model_reason),
    enforcedVerdict: toText(row.enforced_verdict) as MatchVerdict,
    downgradeReason: toTextOrNull(row.downgrade_reason) as DowngradeReason | null,
    matcherVerdict: toTextOrNull(row.matcher_verdict) as MatchVerdict | null,
    matcherMode: toTextOrNull(row.matcher_mode) as MatchMode | null,
    disagreement: toText(row.disagreement) as Disagreement,
    quoteNoOverlap: toBool(row.quote_no_overlap),
    createdAt: toText(row.created_at),
  };
}

export function createVerdictCheckRepository({ db, clock, newId }: RepoDeps) {
  return {
    /** Records one requirement's check. One row per evaluation and requirement: a second write replaces the first. */
    async record(input: VerdictCheckInput): Promise<VerdictCheck> {
      await db.execute('DELETE FROM verdict_checks WHERE evaluation_id = ? AND requirement_id = ?', [input.evaluationId, input.requirementId]);
      const id = newId();
      const { sql, params } = buildInsert('verdict_checks', {
        id,
        evaluation_id: input.evaluationId,
        requirement_id: input.requirementId,
        verdict_mode: input.verdictMode,
        model_verdict: input.modelVerdict,
        model_reason: input.modelReason,
        enforced_verdict: input.enforcedVerdict,
        downgrade_reason: input.downgradeReason,
        matcher_verdict: input.matcherVerdict,
        matcher_mode: input.matcherMode,
        disagreement: input.disagreement,
        // Always the enforced verdict: nothing is lowered automatically (migration 005).
        scored_verdict: input.enforcedVerdict,
        quote_no_overlap: input.quoteNoOverlap,
        created_at: clock.nowIso(),
      });
      await db.execute(sql, params);
      const rows = await db.query('SELECT * FROM verdict_checks WHERE id = ?', [id]);
      return mapCheck(rows[0] as Record<string, unknown>);
    },

    async listForEvaluation(evaluationId: string): Promise<VerdictCheck[]> {
      const rows = await db.query('SELECT * FROM verdict_checks WHERE evaluation_id = ?', [evaluationId]);
      return rows.map((row) => mapCheck(row as Record<string, unknown>));
    },

    /**
     * The evaluations, among those given, that go to a person, and the labels of the requirements that send them there, in job
     * order: a MUST-HAVE whose credited verdict rests on a quote that shares no word with the requirement (`routesToReview`).
     * Other disagreements are recorded and shown but route nobody. ONE query whatever the number of evaluations.
     */
    async routedForEvaluations(evaluationIds: readonly string[]): Promise<Map<string, string[]>> {
      const found = new Map<string, string[]>();
      if (evaluationIds.length === 0) return found;
      const marks = evaluationIds.map(() => '?').join(',');
      const rows = await db.query<{ evaluation_id: string; label: string }>(
        `SELECT vc.evaluation_id AS evaluation_id, jr.label AS label
           FROM verdict_checks vc JOIN job_requirements jr ON jr.id = vc.requirement_id
          WHERE vc.quote_no_overlap = ? AND jr.kind = 'must_have' AND vc.evaluation_id IN (${marks})
          ORDER BY jr.position`,
        [true, ...evaluationIds],
      );
      for (const row of rows) {
        const id = toText(row.evaluation_id);
        found.set(id, [...(found.get(id) ?? []), toText(row.label)]);
      }
      return found;
    },
  };
}
