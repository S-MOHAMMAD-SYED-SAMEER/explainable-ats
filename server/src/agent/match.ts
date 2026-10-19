import { scoreEvaluation, type ScoreBreakdown } from './score.ts';
import { DEFAULT_MATCH_MODE, type MatchDecision, type MatchMode } from './matchRules.ts';
import { confidenceOf, reconcileWithMatcher, scoreFromVerdicts, type EnforcedVerdict, type Reconciled } from './verdictEnforcement.ts';
import { DEFAULT_VERDICT_MODE, type VerdictMode } from './verdictMode.ts';
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
  /** How words are compared: `strict` (the default) or `folded`. Recorded in the audit trail. In `model_checked` mode this is the second opinion's mode. */
  matchMode?: MatchMode;
  /**
   * Who decides a verdict: the model, checked by the code and a second opinion (`model_checked`), or the matcher alone (`matcher`).
   * Used only when the evaluation was extracted in `model_checked` mode; an evaluation extracted any other way is scored by the matcher.
   * Recorded in the audit trail.
   */
  verdictMode?: VerdictMode;
};

export type MatchOutcome = {
  evaluation: Evaluation;
  breakdown: ScoreBreakdown;
  /** Unverified rows that were present and ignored. Reported, never counted. */
  evidenceIgnored: number;
  /** The mode that produced the verdicts that were scored. */
  verdictMode: VerdictMode;
  /** True when, on some must-have, the model's verdict was two steps or more above the second opinion's: the candidate is routed to a person. */
  needsReview: boolean;
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
  const matchMode = deps.matchMode ?? DEFAULT_MATCH_MODE;
  const requestedVerdictMode = deps.verdictMode ?? DEFAULT_VERDICT_MODE;

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

  // The verdicts. In `model_checked` mode they are the model's, after the code's rules and the matcher's second opinion; the
  // checks were written when the evaluation was extracted. An evaluation extracted without them (the quotes-only way) is
  // scored by the matcher alone, and the audit trail says which, never the mode that was merely requested.
  const checks = requestedVerdictMode === 'model_checked' ? await repos.verdictChecks.listForEvaluation(evaluation.id) : [];
  const verdictMode: VerdictMode = checks.length > 0 ? 'model_checked' : 'matcher';

  let reconciled: Reconciled[] = [];
  let breakdown: ScoreBreakdown;
  if (verdictMode === 'model_checked') {
    const enforced: EnforcedVerdict[] = requirements.map((requirement) => {
      const check = checks.find((entry) => entry.requirementId === requirement.id);
      return {
        requirementId: requirement.id,
        modelVerdict: check?.modelVerdict ?? null,
        modelReason: check?.modelReason ?? null,
        enforcedVerdict: check?.enforcedVerdict ?? 'unclear',
        downgrade: check?.downgradeReason ?? (check ? null : 'no_answer'),
        verifiedPassages: verified.filter((item) => item.requirementId === requirement.id).length,
      };
    });
    reconciled = reconcileWithMatcher(requirements, enforced, verified, matchMode);
    const decisions: MatchDecision[] = reconciled.map((entry) => ({
      requirementId: entry.requirementId,
      verdict: entry.scoredVerdict,
      confidence: confidenceOf(entry),
      matchedTerms: entry.matcher.matchedTerms,
      missingTerms: entry.matcher.missingTerms,
      evidenceCount: entry.verifiedPassages,
      rationale: modelCheckedRationale(entry, matchMode),
    }));
    breakdown = scoreFromVerdicts(requirements, decisions);
  } else {
    breakdown = scoreEvaluation(requirements, verified, matchMode);
  }
  const needsReview = reconciled.some((entry) => entry.routed);

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

    for (const entry of reconciled) {
      await tx.verdictChecks.record({
        evaluationId: evaluation.id,
        requirementId: entry.requirementId,
        verdictMode: 'model_checked',
        modelVerdict: entry.modelVerdict,
        modelReason: entry.modelReason,
        enforcedVerdict: entry.enforcedVerdict,
        downgradeReason: entry.downgrade,
        matcherVerdict: entry.matcher.verdict,
        matcherMode: matchMode,
        disagreement: entry.disagreement,
        scoredVerdict: entry.scoredVerdict,
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
      matchMode,
      // Present only when the model's verdicts were scored. Its absence means the matcher alone judged (the behaviour the
      // portfolio demo copies are checked against byte for byte), so the matcher path's payload is exactly what it always was.
      ...(verdictMode === 'model_checked'
        ? {
            verdictMode,
            checks: reconciled.map((entry) => ({
              requirementId: entry.requirementId,
              model: entry.modelVerdict,
              enforced: entry.enforcedVerdict,
              matcher: entry.matcher.verdict,
              disagreement: entry.disagreement,
              scored: entry.scoredVerdict,
            })),
          }
        : {}),
    },
    entityType: 'evaluation',
    entityId: evaluation.id,
  });

  if (needsReview) {
    const disagreeing = reconciled.filter((entry) => entry.routed);
    const shownOnly = reconciled.filter((entry) => entry.disagreement === 'two_plus' && !entry.routed).length;
    await repos.audit.append({
      correlationId: evaluation.id,
      stage: 'match',
      eventType: 'verdict_disagreement',
      actor: 'system',
      outcome: 'blocked',
      summary:
        `On ${disagreeing.length} must-have requirement(s) the model's verdict is two steps or more above the second opinion's, ` +
        "so this candidate is routed to a person. Where the passages quoted share no word with the requirement, the score uses the matcher's lower verdict until a person decides.",
      payload: {
        matchMode,
        // Other two-step disagreements (the model lower than the matcher, or a nice-to-have) are recorded in the checks and route nobody.
        shownOnly,
        requirements: disagreeing.map((entry) => ({
          requirementId: entry.requirementId,
          model: entry.modelVerdict,
          enforced: entry.enforcedVerdict,
          matcher: entry.matcher.verdict,
          scored: entry.scoredVerdict,
          capped: entry.capped,
        })),
      },
      entityType: 'evaluation',
      entityId: evaluation.id,
    });
  }

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

  return { evaluation: updated, breakdown, evidenceIgnored, verdictMode, needsReview };
}

/** What a recruiter reads for one requirement in `model_checked` mode: what the model said, what the code did, what the second opinion said. */
function modelCheckedRationale(entry: Reconciled, matchMode: MatchMode): string {
  const model =
    entry.modelVerdict === null
      ? 'The model gave no answer for this requirement.'
      : `Model: ${entry.modelVerdict.replace('_', ' ')}${entry.modelReason ? ` (${entry.modelReason.replace(/[.\s]+$/, '')})` : ''}.`;
  const code =
    entry.downgrade === 'no_verified_passage'
      ? ' The code lowered it to unclear: no passage the model quoted for it was found in the resume.'
      : entry.downgrade === 'no_answer'
        ? ' It reads as unclear.'
        : '';
  const matcher = entry.matcher.verdict.replace('_', ' ');
  const second =
    entry.disagreement === 'none'
      ? ` Second opinion (matcher, ${matchMode}): ${matcher}, which agrees.`
      : entry.disagreement === 'one_step'
        ? ` Second opinion (matcher, ${matchMode}): ${matcher}, one step apart. Shown, not acted on.`
        : ` Second opinion (matcher, ${matchMode}): ${matcher}, two steps or more apart, ` +
          (entry.routed ? 'so a person should look.' : 'shown, not routed: only a must-have where the model is the higher one is sent to a person.') +
          (entry.capped ? ` No word of the requirement appears in the passages quoted, so the matcher's lower verdict (${entry.scoredVerdict.replace('_', ' ')}) is scored until then.` : '');
  return `${model}${code}${second}`;
}
