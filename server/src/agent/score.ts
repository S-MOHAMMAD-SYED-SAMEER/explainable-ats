import { decideMatch, type EvidenceLike, type MatchDecision } from './matchRules.ts';
import { BASIS_POINTS_MAX, VERDICT_BASIS_POINTS, type JobRequirement } from '../domain/ats.ts';

// SCORING — integer arithmetic a recruiter can redo on paper.
//
// The score is a weighted average of what each requirement earned:
//
//     score = floor( Σ (weight_i × verdictBasisPoints_i) / Σ weight_i )
//
// Every term is an integer and the division happens exactly once, at the end.
// There is no floating point anywhere in this file, which is why the same
// evidence gives the same number on every machine, forever.
//
// CONTRIBUTIONS ADD UP TO THE SCORE, EXACTLY
//
// Each requirement's stored contribution is its share of that final number, so
// an explanation screen can list them and have the column total equal the
// headline figure. Naive flooring would lose a basis point here and there and
// the column would come up short — a small error that destroys trust in the
// whole page, because the one thing a reader checks is whether it adds up. The
// remainder is therefore handed out by largest-remainder apportionment, in a
// fixed order, so the distribution is deterministic too.
//
// THE MUST-HAVE GATE IS NOT APPLIED HERE
//
// A missed must-have does not reduce the number. It is counted instead, and the
// counts are stored on the evaluation, because capping the score would break
// the identity above: the contributions would no longer sum to the total and
// the arithmetic would stop being checkable. Deciding what a missed must-have
// means for a candidate's standing is a ranking question, and ranking is
// computed on read from these stored counts.

export type ScoredRequirement = {
  requirement: JobRequirement;
  decision: MatchDecision;
  /** The weight as it was at scoring time, kept so old explanations still add up. */
  weightApplied: number;
  /** This requirement's share of the final score, in basis points. */
  contributionBasisPoints: number;
};

export type ScoreBreakdown = {
  scoreBasisPoints: number;
  mustHavesMet: number;
  mustHavesTotal: number;
  /** Must-haves the resume said nothing about. Not the same as failing them. */
  mustHavesUnclear: number;
  totalWeight: number;
  rows: ScoredRequirement[];
};

/**
 * Scores one evaluation from its verified evidence.
 *
 * Pure: no database, no clock, no model. Given the same requirements and the
 * same evidence it returns the same breakdown, which is what makes a score
 * from six weeks ago reproducible today.
 */
export function scoreEvaluation(
  requirements: readonly JobRequirement[],
  evidence: readonly EvidenceLike[],
): ScoreBreakdown {
  if (requirements.length === 0) {
    // Zero out of zero renders as a rejection, and a candidate must never be
    // rejected by an empty job spec.
    throw new Error('An evaluation needs at least one requirement to score against.');
  }

  const totalWeight = requirements.reduce((sum, requirement) => sum + requirement.weight, 0);
  if (totalWeight <= 0) {
    throw new Error('Requirement weights must be positive, so their total cannot be zero.');
  }

  const decisions = requirements.map((requirement) => ({
    requirement,
    decision: decideMatch(requirement, evidence),
  }));

  // The exact weighted numerator, before the single division.
  const numerator = decisions.reduce(
    (sum, { requirement, decision }) => sum + requirement.weight * VERDICT_BASIS_POINTS[decision.verdict],
    0,
  );
  const scoreBasisPoints = Math.floor(numerator / totalWeight);

  // Largest-remainder apportionment, so the parts sum to the whole.
  const parts = decisions.map(({ requirement, decision }, index) => {
    const earned = requirement.weight * VERDICT_BASIS_POINTS[decision.verdict];
    return {
      index,
      base: Math.floor(earned / totalWeight),
      remainder: earned % totalWeight,
    };
  });

  const allocated = parts.reduce((sum, part) => sum + part.base, 0);
  let deficit = scoreBasisPoints - allocated;

  // Ties are broken by the requirement's own order, never by sort stability.
  const byRemainder = [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const extra = new Set<number>();
  for (const part of byRemainder) {
    if (deficit <= 0) break;
    extra.add(part.index);
    deficit -= 1;
  }

  const rows: ScoredRequirement[] = decisions.map(({ requirement, decision }, index) => ({
    requirement,
    decision,
    weightApplied: requirement.weight,
    contributionBasisPoints: (parts[index] as { base: number }).base + (extra.has(index) ? 1 : 0),
  }));

  const mustHaves = decisions.filter(({ requirement }) => requirement.kind === 'must_have');

  return {
    scoreBasisPoints,
    mustHavesMet: mustHaves.filter(({ decision }) => decision.verdict === 'met').length,
    mustHavesTotal: mustHaves.length,
    mustHavesUnclear: mustHaves.filter(({ decision }) => decision.verdict === 'unclear').length,
    totalWeight,
    rows,
  };
}

/**
 * The score as a percentage string, for display only.
 *
 * Never stored and never fed back into arithmetic — basis points are the
 * value, and this is a rendering of it.
 */
export function formatScore(basisPoints: number): string {
  const clamped = Math.max(0, Math.min(BASIS_POINTS_MAX, basisPoints));
  return `${Math.round(clamped / 100)}%`;
}
