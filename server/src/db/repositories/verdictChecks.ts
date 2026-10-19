import { buildInsert } from './helpers.ts';
import { toText, toTextOrNull } from '../rows.ts';
import { routesToReview, VERDICT_MODES, type VerdictMode } from '../../agent/verdictMode.ts';
import type { MatchVerdict } from '../../domain/ats.ts';
import type { MatchMode } from '../../agent/matchRules.ts';
import type { RepoDeps } from './types.ts';

// The record of what the model said about each requirement and what the code did with it (`verdict_checks`).
// Written by the match stage, read by the evaluation detail and by the ranking (to route to a person a candidate for whom, on a
// must-have, the model's verdict is two or more steps higher than the second opinion's: `routesToReview`).

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
  scoredVerdict: MatchVerdict;
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
    scoredVerdict: toText(row.scored_verdict) as MatchVerdict,
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
        scored_verdict: input.scoredVerdict,
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
     * order: a MUST-HAVE where the model's enforced verdict is two steps or more above the matcher's (`routesToReview`). Other
     * disagreements are recorded and shown but route nobody. ONE query whatever the number of evaluations.
     */
    async routedForEvaluations(evaluationIds: readonly string[]): Promise<Map<string, string[]>> {
      const found = new Map<string, string[]>();
      if (evaluationIds.length === 0) return found;
      const marks = evaluationIds.map(() => '?').join(',');
      const rows = await db.query<{ evaluation_id: string; label: string; kind: string; enforced_verdict: string; matcher_verdict: string | null }>(
        `SELECT vc.evaluation_id AS evaluation_id, jr.label AS label, jr.kind AS kind,
                vc.enforced_verdict AS enforced_verdict, vc.matcher_verdict AS matcher_verdict
           FROM verdict_checks vc JOIN job_requirements jr ON jr.id = vc.requirement_id
          WHERE vc.disagreement = 'two_plus' AND vc.evaluation_id IN (${marks})
          ORDER BY jr.position`,
        [...evaluationIds],
      );
      for (const row of rows) {
        const matcher = toTextOrNull(row.matcher_verdict) as MatchVerdict | null;
        if (matcher === null || !routesToReview(toText(row.kind) as 'must_have' | 'nice_to_have', toText(row.enforced_verdict) as MatchVerdict, matcher)) continue;
        const id = toText(row.evaluation_id);
        found.set(id, [...(found.get(id) ?? []), toText(row.label)]);
      }
      return found;
    },
  };
}
