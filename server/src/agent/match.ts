import { scoreEvaluation, type ScoreBreakdown } from './score.ts';
import { AppError } from '../lib/errors.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { Logger } from '../lib/logger.ts';
import type { Evaluation } from '../domain/ats.ts';

// The stage that turns verified evidence into a number.
//
// No model is called here and none can be: this file imports a provider
// nowhere. That is the architectural claim of the whole product, made
// structural rather than promised — the model cites, deterministic code judges.
//
// WHAT IT READS IS THE POINT
//
// `listVerifiedForEvaluation`, never `listForEvaluation`. Rejected evidence is
// deliberately kept in the table so a fabrication stays visible in the audit
// view, and the single most damaging bug this codebase could contain would be
// scoring it. The rules re-check `verified` themselves as a second lock, and a
// test asserts both.

export type MatchDeps = {
  repos: Repositories;
  logger?: Logger;
};

export type MatchOutcome = {
  evaluation: Evaluation;
  breakdown: ScoreBreakdown;
  /** Unverified rows that were present and ignored. Reported, never counted. */
  evidenceIgnored: number;
};

/**
 * Matches every requirement and records the score.
 *
 * Requires `extracted`: a score can only follow evidence. Scoring an evaluation
 * that never extracted anything would produce a number with nothing behind it,
 * which is the one thing this system must not be able to do.
 */
export async function matchAndScore(deps: MatchDeps, evaluationId: string): Promise<MatchOutcome> {
  const { repos, logger } = deps;

  const evaluation = await repos.evaluations.getById(evaluationId);
  if (!evaluation) throw new AppError('NOT_FOUND', 'That evaluation does not exist.');

  if (evaluation.status !== 'extracted') {
    throw new AppError(
      'INVALID_STATE',
      evaluation.status === 'scored'
        ? 'This evaluation has already been scored. Re-running means opening a new one.'
        : `An evaluation must be extracted before it can be scored; this one is ${evaluation.status}.`,
    );
  }

  // A superseded evaluation is history. Scoring it would put a fresh number on
  // a record that has already been replaced, and a list showing both would have
  // two current-looking answers for one candidate.
  if (evaluation.supersededBy) {
    throw new AppError('INVALID_STATE', 'This evaluation has been superseded by a newer one.');
  }

  const requirements = await repos.requirements.listForJob(evaluation.jobId);
  if (requirements.length === 0) {
    throw new AppError('INVALID_STATE', 'This job has no requirements, so there is nothing to score against.');
  }

  const verified = await repos.evidence.listVerifiedForEvaluation(evaluation.id);
  const all = await repos.evidence.listForEvaluation(evaluation.id);
  const evidenceIgnored = all.length - verified.length;

  const breakdown = scoreEvaluation(requirements, verified);

  // Matches and the score land together. A score without the matches behind it
  // is an unexplainable number, and an explanation without its score is a page
  // that cannot be reconciled with the list it was opened from.
  const updated = await repos.transaction(async (tx) => {
    for (const row of breakdown.rows) {
      await tx.matches.record({
        evaluationId: evaluation.id,
        requirementId: row.requirement.id,
        verdict: row.decision.verdict,
        confidence: row.decision.confidence,
        weightApplied: row.weightApplied,
        contributionBasisPoints: row.contributionBasisPoints,
        rationale: row.decision.rationale,
      });
    }

    return tx.evaluations.recordScore(evaluation.id, {
      scoreBasisPoints: breakdown.scoreBasisPoints,
      mustHavesMet: breakdown.mustHavesMet,
      mustHavesTotal: breakdown.mustHavesTotal,
    });
  });

  if (!updated) throw new AppError('INVALID_STATE', 'This evaluation moved on while it was being scored.');

  if (evidenceIgnored > 0) {
    await repos.audit.append({
      correlationId: evaluation.id,
      stage: 'match',
      eventType: 'unverified_evidence_ignored',
      actor: 'system',
      outcome: 'blocked',
      summary:
        `${evidenceIgnored} quoted passage(s) were never found in the resume and took no part in this score. ` +
        'Only evidence checked against the document is counted.',
      payload: { ignored: evidenceIgnored, counted: verified.length },
      entityType: 'evaluation',
      entityId: evaluation.id,
    });
  }

  await repos.audit.append({
    correlationId: evaluation.id,
    stage: 'match',
    eventType: 'requirements_matched',
    actor: 'system',
    outcome: 'ok',
    summary: `Judged ${breakdown.rows.length} requirement(s) against ${verified.length} verified passage(s).`,
    payload: {
      verdicts: breakdown.rows.map((row) => ({
        requirementId: row.requirement.id,
        label: row.requirement.label,
        verdict: row.decision.verdict,
        confidence: row.decision.confidence,
      })),
      evidenceCounted: verified.length,
    },
    entityType: 'evaluation',
    entityId: evaluation.id,
  });

  // The event that makes the number checkable: every input to the arithmetic
  // is in the payload, so the score can be recomputed from the trail alone.
  await repos.audit.append({
    correlationId: evaluation.id,
    stage: 'score',
    eventType: 'score_computed',
    actor: 'system',
    outcome: 'ok',
    summary:
      `Scored ${breakdown.scoreBasisPoints} of 10000, meeting ${breakdown.mustHavesMet} of ` +
      `${breakdown.mustHavesTotal} must-have(s).`,
    payload: {
      scoreBasisPoints: breakdown.scoreBasisPoints,
      totalWeight: breakdown.totalWeight,
      mustHavesMet: breakdown.mustHavesMet,
      mustHavesTotal: breakdown.mustHavesTotal,
      mustHavesUnclear: breakdown.mustHavesUnclear,
      contributions: breakdown.rows.map((row) => ({
        requirementId: row.requirement.id,
        weightApplied: row.weightApplied,
        verdict: row.decision.verdict,
        contributionBasisPoints: row.contributionBasisPoints,
      })),
    },
    entityType: 'evaluation',
    entityId: evaluation.id,
  });

  logger?.info('Evaluation scored', {
    evaluationId,
    scoreBasisPoints: breakdown.scoreBasisPoints,
    mustHavesMet: breakdown.mustHavesMet,
    mustHavesTotal: breakdown.mustHavesTotal,
  });

  return { evaluation: updated, breakdown, evidenceIgnored };
}
