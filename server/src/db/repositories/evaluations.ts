import { buildInsert } from './helpers.ts';
import { toText, toTextOrNull, toNumber, toNumberOrNull, toBool } from '../rows.ts';
import { NotFoundError } from '../../lib/errors.ts';
import type { RepoDeps } from './types.ts';
import type {
  ConfidenceLevel,
  DecisionOutcome,
  Evaluation,
  EvaluationStatus,
  Evidence,
  MatchVerdict,
  RecruiterDecision,
  RequirementMatch,
} from '../../domain/ats.ts';

// Evaluations, the evidence behind them, the verdicts derived from that
// evidence, and the human decision at the end.
//
// THERE IS NO RANKING TABLE, AND THAT IS THE POINT
//
// A ranking is a pure function of the evaluations that exist. Storing it would
// create a second source of truth that drifts the moment one evaluation is
// superseded and the other is not. P3-E computes it on read.

function mapEvaluation(row: Record<string, unknown>): Evaluation {
  return {
    id: toText(row.id),
    jobId: toText(row.job_id),
    candidateId: toText(row.candidate_id),
    resumeId: toText(row.resume_id),
    status: toText(row.status) as EvaluationStatus,
    model: toTextOrNull(row.model),
    promptVersion: toTextOrNull(row.prompt_version),
    latencyMs: toNumberOrNull(row.latency_ms),
    scoreBasisPoints: toNumberOrNull(row.score_basis_points),
    mustHavesMet: toNumberOrNull(row.must_haves_met),
    mustHavesTotal: toNumberOrNull(row.must_haves_total),
    failureReason: toTextOrNull(row.failure_reason),
    supersededBy: toTextOrNull(row.superseded_by),
    createdAt: toText(row.created_at),
  };
}

function mapEvidence(row: Record<string, unknown>): Evidence {
  return {
    id: toText(row.id),
    evaluationId: toText(row.evaluation_id),
    resumeId: toText(row.resume_id),
    requirementId: toTextOrNull(row.requirement_id),
    quote: toText(row.quote),
    charStart: toNumber(row.char_start),
    charEnd: toNumber(row.char_end),
    verified: toBool(row.verified),
    createdAt: toText(row.created_at),
  };
}

function mapMatch(row: Record<string, unknown>): RequirementMatch {
  return {
    id: toText(row.id),
    evaluationId: toText(row.evaluation_id),
    requirementId: toText(row.requirement_id),
    verdict: toText(row.verdict) as MatchVerdict,
    confidence: toText(row.confidence) as ConfidenceLevel,
    weightApplied: toNumber(row.weight_applied),
    contributionBasisPoints: toNumber(row.contribution_basis_points),
    rationale: toText(row.rationale),
    createdAt: toText(row.created_at),
  };
}

function mapDecision(row: Record<string, unknown>): RecruiterDecision {
  return {
    id: toText(row.id),
    evaluationId: toText(row.evaluation_id),
    outcome: toText(row.outcome) as DecisionOutcome,
    reason: toText(row.reason),
    decidedBy: toText(row.decided_by),
    decidedAt: toText(row.decided_at),
  };
}

export function createEvaluationRepository({ db, clock, newId }: RepoDeps) {
  return {
    /**
     * Opens an evaluation, superseding any earlier one for the same pair.
     *
     * Re-running never overwrites. The previous evaluation keeps its evidence,
     * its verdicts and its score exactly as they were — that history is what
     * makes a decision from last month explainable, and the reason `superseded`
     * exists rather than an UPDATE.
     */
    async create(input: { jobId: string; candidateId: string; resumeId: string }): Promise<Evaluation> {
      const id = newId();

      await db.transaction(async (tx) => {
        const { sql, params } = buildInsert('evaluations', {
          id,
          job_id: input.jobId,
          candidate_id: input.candidateId,
          resume_id: input.resumeId,
          status: 'pending',
          model: null,
          prompt_version: null,
          latency_ms: null,
          score_basis_points: null,
          must_haves_met: null,
          must_haves_total: null,
          failure_reason: null,
          superseded_by: null,
          created_at: clock.nowIso(),
        });
        await tx.execute(sql, params);

        // Same transaction as the insert, so a current evaluation and the one
        // it replaces can never both look current.
        await tx.execute(
          `UPDATE evaluations SET superseded_by = ?
            WHERE job_id = ? AND candidate_id = ? AND id != ? AND superseded_by IS NULL`,
          [id, input.jobId, input.candidateId, id],
        );
      });

      const created = await this.getById(id);
      if (!created) throw new NotFoundError('Evaluation');
      return created;
    },

    async getById(id: string): Promise<Evaluation | null> {
      const rows = await db.query('SELECT * FROM evaluations WHERE id = ?', [id]);
      return rows[0] ? mapEvaluation(rows[0] as Record<string, unknown>) : null;
    },

    /** The evaluation that counts for this pair — never a superseded one. */
    async getCurrent(jobId: string, candidateId: string): Promise<Evaluation | null> {
      const rows = await db.query(
        `SELECT * FROM evaluations
          WHERE job_id = ? AND candidate_id = ? AND superseded_by IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [jobId, candidateId],
      );
      return rows[0] ? mapEvaluation(rows[0] as Record<string, unknown>) : null;
    },

    /** Every current evaluation for a job — what P3-E ranks. One query. */
    async listCurrentForJob(jobId: string): Promise<Evaluation[]> {
      const rows = await db.query(
        'SELECT * FROM evaluations WHERE job_id = ? AND superseded_by IS NULL ORDER BY created_at DESC',
        [jobId],
      );
      return rows.map((row) => mapEvaluation(row as Record<string, unknown>));
    },

    /**
     * How many candidates each job currently has, in one query.
     *
     * A jobs list that counted per job would be N+1 before it had ten rows on
     * it, and a list screen is the first thing anyone opens.
     */
    async countCurrentByJob(jobIds: readonly string[]): Promise<Map<string, number>> {
      const counts = new Map<string, number>();
      if (jobIds.length === 0) return counts;

      const rows = await db.query<{ job_id: string; n: number }>(
        `SELECT job_id, COUNT(*) AS n FROM evaluations
          WHERE superseded_by IS NULL AND job_id IN (${jobIds.map(() => '?').join(', ')})
          GROUP BY job_id`,
        [...jobIds],
      );
      for (const row of rows) counts.set(toText(row.job_id), toNumber(row.n));
      return counts;
    },

    /** Every evaluation ever made for a pair, newest first. The history. */
    async listHistory(jobId: string, candidateId: string): Promise<Evaluation[]> {
      const rows = await db.query(
        'SELECT * FROM evaluations WHERE job_id = ? AND candidate_id = ? ORDER BY created_at DESC',
        [jobId, candidateId],
      );
      return rows.map((row) => mapEvaluation(row as Record<string, unknown>));
    },

    async recordExtraction(
      id: string,
      input: { model: string; promptVersion: string; latencyMs: number },
    ): Promise<Evaluation | null> {
      const result = await db.execute(
        `UPDATE evaluations SET status = 'extracted', model = ?, prompt_version = ?, latency_ms = ?
          WHERE id = ? AND status = 'pending'`,
        [input.model, input.promptVersion, input.latencyMs, id],
      );
      if (result.rowCount === 0) return null;
      return this.getById(id);
    },

    /**
     * Records the score the deterministic scorer computed.
     *
     * Guarded on `status = 'extracted'`: a score can only follow evidence.
     * Scoring an evaluation that never extracted anything would produce a
     * number with nothing behind it, which is the one thing this system must
     * not be able to do.
     */
    async recordScore(
      id: string,
      input: { scoreBasisPoints: number; mustHavesMet: number; mustHavesTotal: number },
    ): Promise<Evaluation | null> {
      const result = await db.execute(
        `UPDATE evaluations SET status = 'scored', score_basis_points = ?, must_haves_met = ?, must_haves_total = ?
          WHERE id = ? AND status = 'extracted'`,
        [input.scoreBasisPoints, input.mustHavesMet, input.mustHavesTotal, id],
      );
      if (result.rowCount === 0) return null;
      return this.getById(id);
    },

    async recordFailure(id: string, reason: string): Promise<Evaluation | null> {
      const result = await db.execute(
        `UPDATE evaluations SET status = 'failed', failure_reason = ? WHERE id = ? AND status != 'scored'`,
        [reason, id],
      );
      if (result.rowCount === 0) return null;
      return this.getById(id);
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM evaluations');
      return toNumber(rows[0]?.n ?? 0);
    },
  };
}

export function createEvidenceRepository({ db, clock, newId }: RepoDeps) {
  return {
    /**
     * Records a quote the model produced.
     *
     * `verified` defaults to false and is set only by P3-C, once the quote has
     * been found verbatim at those offsets in the resume. Unverified evidence
     * is stored rather than discarded so a fabrication is visible in the audit
     * trail — but nothing downstream may score or display it.
     */
    async record(input: {
      evaluationId: string;
      resumeId: string;
      requirementId?: string | null;
      quote: string;
      charStart: number;
      charEnd: number;
      verified?: boolean;
    }): Promise<Evidence> {
      const id = newId();
      const { sql, params } = buildInsert('evidence', {
        id,
        evaluation_id: input.evaluationId,
        resume_id: input.resumeId,
        requirement_id: input.requirementId ?? null,
        quote: input.quote,
        char_start: input.charStart,
        char_end: input.charEnd,
        verified: input.verified ?? false,
        created_at: clock.nowIso(),
      });
      await db.execute(sql, params);

      const rows = await db.query('SELECT * FROM evidence WHERE id = ?', [id]);
      return mapEvidence(rows[0] as Record<string, unknown>);
    },

    async markVerified(id: string, verified: boolean): Promise<Evidence | null> {
      const result = await db.execute('UPDATE evidence SET verified = ? WHERE id = ?', [verified, id]);
      if (result.rowCount === 0) return null;
      const rows = await db.query('SELECT * FROM evidence WHERE id = ?', [id]);
      return rows[0] ? mapEvidence(rows[0] as Record<string, unknown>) : null;
    },

    /** Everything recorded, verified or not — for the audit view. */
    async listForEvaluation(evaluationId: string): Promise<Evidence[]> {
      const rows = await db.query(
        'SELECT * FROM evidence WHERE evaluation_id = ? ORDER BY char_start',
        [evaluationId],
      );
      return rows.map((row) => mapEvidence(row as Record<string, unknown>));
    },

    /** Only what may be shown or scored. The default for anything user-facing. */
    async listVerifiedForEvaluation(evaluationId: string): Promise<Evidence[]> {
      const rows = await db.query(
        'SELECT * FROM evidence WHERE evaluation_id = ? AND verified = ? ORDER BY char_start',
        [evaluationId, true],
      );
      return rows.map((row) => mapEvidence(row as Record<string, unknown>));
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM evidence');
      return toNumber(rows[0]?.n ?? 0);
    },
  };
}

export function createRequirementMatchRepository({ db, clock, newId }: RepoDeps) {
  return {
    async record(input: {
      evaluationId: string;
      requirementId: string;
      verdict: MatchVerdict;
      confidence: ConfidenceLevel;
      weightApplied: number;
      contributionBasisPoints: number;
      rationale: string;
    }): Promise<RequirementMatch> {
      const id = newId();
      const { sql, params } = buildInsert('requirement_matches', {
        id,
        evaluation_id: input.evaluationId,
        requirement_id: input.requirementId,
        verdict: input.verdict,
        confidence: input.confidence,
        weight_applied: input.weightApplied,
        contribution_basis_points: input.contributionBasisPoints,
        rationale: input.rationale,
        created_at: clock.nowIso(),
      });
      await db.execute(sql, params);

      const rows = await db.query('SELECT * FROM requirement_matches WHERE id = ?', [id]);
      return mapMatch(rows[0] as Record<string, unknown>);
    },

    async listForEvaluation(evaluationId: string): Promise<RequirementMatch[]> {
      const rows = await db.query(
        'SELECT * FROM requirement_matches WHERE evaluation_id = ? ORDER BY created_at',
        [evaluationId],
      );
      return rows.map((row) => mapMatch(row as Record<string, unknown>));
    },

    /** For many evaluations at once, so ranking a job is not N+1. */
    async listForEvaluations(evaluationIds: readonly string[]): Promise<Map<string, RequirementMatch[]>> {
      const byEvaluation = new Map<string, RequirementMatch[]>();
      if (evaluationIds.length === 0) return byEvaluation;

      const rows = await db.query(
        `SELECT * FROM requirement_matches
          WHERE evaluation_id IN (${evaluationIds.map(() => '?').join(', ')})
          ORDER BY created_at`,
        [...evaluationIds],
      );
      for (const row of rows) {
        const match = mapMatch(row as Record<string, unknown>);
        const list = byEvaluation.get(match.evaluationId) ?? [];
        list.push(match);
        byEvaluation.set(match.evaluationId, list);
      }
      return byEvaluation;
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM requirement_matches');
      return toNumber(rows[0]?.n ?? 0);
    },
  };
}

export function createRecruiterDecisionRepository({ db, clock, newId }: RepoDeps) {
  return {
    async record(input: {
      evaluationId: string;
      outcome: DecisionOutcome;
      reason: string;
      decidedBy: string;
    }): Promise<RecruiterDecision> {
      const id = newId();
      const { sql, params } = buildInsert('recruiter_decisions', {
        id,
        evaluation_id: input.evaluationId,
        outcome: input.outcome,
        reason: input.reason,
        decided_by: input.decidedBy,
        decided_at: clock.nowIso(),
      });
      await db.execute(sql, params);

      const rows = await db.query('SELECT * FROM recruiter_decisions WHERE id = ?', [id]);
      return mapDecision(rows[0] as Record<string, unknown>);
    },

    async getForEvaluation(evaluationId: string): Promise<RecruiterDecision | null> {
      const rows = await db.query('SELECT * FROM recruiter_decisions WHERE evaluation_id = ?', [evaluationId]);
      return rows[0] ? mapDecision(rows[0] as Record<string, unknown>) : null;
    },

    async count(): Promise<number> {
      const rows = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM recruiter_decisions');
      return toNumber(rows[0]?.n ?? 0);
    },
  };
}

export { mapEvaluation, mapEvidence, mapMatch, mapDecision };
