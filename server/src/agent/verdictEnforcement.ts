import { decideMatch, type EvidenceLike, type MatchDecision, type MatchMode } from './matchRules.ts';
import { disagreementOf, routesToReview, SUPPORT_RANK, type Disagreement } from './verdictMode.ts';
import { BASIS_POINTS_MAX, VERDICT_BASIS_POINTS, type ConfidenceLevel, type JobRequirement, type MatchVerdict } from '../domain/ats.ts';
import type { ScoreBreakdown, ScoredRequirement } from './score.ts';

// THE CODE'S RULES FOR A MODEL'S VERDICT (`model_checked` mode). Pure: no database, no clock, no model.
//
// A model's verdict is a PROPOSAL. Enforcement can only lower it, and then it is scored as it stands:
//
//   1. ENFORCEMENT. A verdict needs evidence that was found in the CV.
//        met or partial   needs at least one VERIFIED passage (word for word in the real CV, 15 characters or more),
//                         otherwise it is lowered to `unclear`.
//        not_met          needs a verified passage (an explicit negative, "I have not ..."), otherwise `unclear`. A CV that
//                         says nothing about a requirement is `unclear`, never `not_met`: silence is not a finding against
//                         anyone (LABELLING_GUIDE.md).
//        unclear          always stands.
//        no answer        for a requirement the model did not answer is `unclear`.
//   2. THE SECOND OPINION. The deterministic matcher gives its own verdict from the SAME verified passages. Every difference is
//      shown to the recruiter.
//   3. THE SCORED VERDICT IS THE ENFORCED VERDICT. Nothing the matcher says changes the score. The matcher counts words, so on a
//      passage that really is about the subject it is wrong far more often than it is right (measured: about 35 to 40% agreement
//      with the labels even when every passage is perfect), and when it was allowed to lower scores it mostly lowered honest
//      paraphrases (the first real run: 6 of 68 verdicts, 5 of them correct).
//   4. ONE FLAG, FOR A PERSON. A verdict that credits the candidate (met or partial) with at least one verified quote behind it, where
//      none of the quotes shares a word with the requirement, is flagged: "Quote shares no words with the requirement; a person
//      should check" (audit event `quote_no_overlap_flagged`). If the requirement is a must-have the candidate is routed to
//      `needs_review` (`routesToReview`, `verdictMode.ts`). The flag is for a person to read. It changes no number.
//
// So the score is exactly what the enforced verdicts give, and the enforced verdicts are never above the model's. What this does NOT
// stop: a model that is fooled into crediting a line that really is in the CV. The line is verified, the verdict is scored, and the
// flag and the routing are what tell a person to look.

export type ModelAnswer = { verdict: MatchVerdict; reason: string };

export type EnforcedVerdict = {
  requirementId: string;
  /** Null when the model gave no answer for this requirement. */
  modelVerdict: MatchVerdict | null;
  modelReason: string | null;
  enforcedVerdict: MatchVerdict;
  downgrade: 'no_verified_passage' | 'no_answer' | null;
  /** How many verified passages stood behind it. */
  verifiedPassages: number;
};

export function enforceVerdicts(input: {
  requirements: readonly Pick<JobRequirement, 'id' | 'label' | 'criterion'>[];
  answers: ReadonlyMap<string, ModelAnswer>;
  /** The passages that survived verification, by requirement. */
  verifiedPassages: ReadonlyMap<string, readonly string[]>;
}): EnforcedVerdict[] {
  return input.requirements.map((requirement) => {
    const answer = input.answers.get(requirement.id);
    const passages = input.verifiedPassages.get(requirement.id)?.length ?? 0;

    if (!answer) {
      return { requirementId: requirement.id, modelVerdict: null, modelReason: null, enforcedVerdict: 'unclear', downgrade: 'no_answer', verifiedPassages: passages };
    }

    let enforced: MatchVerdict = answer.verdict;
    let downgrade: EnforcedVerdict['downgrade'] = null;

    // met, partial and not_met all need a passage that was found in the CV; with none, the verdict reads as unclear.
    if (answer.verdict !== 'unclear' && passages === 0) {
      enforced = 'unclear';
      downgrade = 'no_verified_passage';
    }

    return {
      requirementId: requirement.id,
      modelVerdict: answer.verdict,
      modelReason: answer.reason,
      enforcedVerdict: enforced,
      downgrade,
      verifiedPassages: passages,
    };
  });
}

export type Reconciled = EnforcedVerdict & {
  matcher: MatchDecision;
  disagreement: Disagreement;
  /** A credited verdict (met or partial) on verified quotes none of which shares a word with the requirement. Flagged, never scored differently. */
  quoteNoOverlap: boolean;
  /** True when this requirement sends the candidate to a person: a must-have with `quoteNoOverlap`. */
  routed: boolean;
};

/**
 * Compares each enforced verdict with the matcher's verdict on the same verified passages.
 *
 * `evidence` is the verified evidence only: the matcher re-checks `verified` itself, as it always does.
 */
export function reconcileWithMatcher(
  requirements: readonly Pick<JobRequirement, 'id' | 'label' | 'criterion' | 'kind'>[],
  enforced: readonly EnforcedVerdict[],
  evidence: readonly EvidenceLike[],
  matchMode: MatchMode,
): Reconciled[] {
  const byRequirement = new Map(enforced.map((entry) => [entry.requirementId, entry]));
  return requirements.map((requirement) => {
    const mine = byRequirement.get(requirement.id) as EnforcedVerdict;
    const matcher = decideMatch(requirement, evidence, matchMode);
    const disagreement = disagreementOf(mine.enforcedVerdict, matcher.verdict);
    const credited = mine.enforcedVerdict === 'met' || mine.enforcedVerdict === 'partial';
    const quoteNoOverlap = credited && mine.verifiedPassages > 0 && matcher.matchedTerms.length === 0;
    return { ...mine, matcher, disagreement, quoteNoOverlap, routed: routesToReview(requirement.kind, quoteNoOverlap) };
  });
}

/** How much the evidence backs the scored verdict: agreement with a passage behind it is high, a one-step gap medium, the rest low. */
export function confidenceOf(entry: Reconciled): ConfidenceLevel {
  if (entry.disagreement === 'two_plus' || entry.quoteNoOverlap) return 'low';
  if (entry.disagreement === 'one_step') return 'medium';
  return entry.verifiedPassages > 0 ? 'high' : 'low';
}

// --- scoring from verdicts ------------------------------------------------------------------------------------------
//
// The same integer arithmetic as `scoreEvaluation` in `score.ts` (that file is shared with the portfolio sites and is not
// changed): the weighted sum, one floor division, and the remainder handed out by largest remainder so the contributions add
// up to the score exactly. `verdictScoring.test.ts` runs both over the whole evaluation set and the hostile CVs and requires
// identical results.

export function scoreFromVerdicts(
  requirements: readonly JobRequirement[],
  decisions: readonly MatchDecision[],
): ScoreBreakdown {
  if (requirements.length === 0) throw new Error('An evaluation needs at least one requirement to score against.');
  const totalWeight = requirements.reduce((sum, requirement) => sum + requirement.weight, 0);
  if (totalWeight <= 0) throw new Error('Requirement weights must be positive, so their total cannot be zero.');

  const pairs = requirements.map((requirement, index) => ({ requirement, decision: decisions[index] as MatchDecision }));
  for (const { requirement, decision } of pairs) {
    if (decision.requirementId !== requirement.id) throw new Error('The decisions must be in the same order as the requirements.');
  }

  const numerator = pairs.reduce((sum, { requirement, decision }) => sum + requirement.weight * VERDICT_BASIS_POINTS[decision.verdict], 0);
  const scoreBasisPoints = Math.floor(numerator / totalWeight);

  const parts = pairs.map(({ requirement, decision }, index) => {
    const earned = requirement.weight * VERDICT_BASIS_POINTS[decision.verdict];
    return { index, base: Math.floor(earned / totalWeight), remainder: earned % totalWeight };
  });
  let deficit = scoreBasisPoints - parts.reduce((sum, part) => sum + part.base, 0);
  const byRemainder = [...parts].sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  const extra = new Set<number>();
  for (const part of byRemainder) {
    if (deficit <= 0) break;
    extra.add(part.index);
    deficit -= 1;
  }

  const rows: ScoredRequirement[] = pairs.map(({ requirement, decision }, index) => ({
    requirement,
    decision,
    weightApplied: requirement.weight,
    contributionBasisPoints: (parts[index] as { base: number }).base + (extra.has(index) ? 1 : 0),
  }));
  const mustHaves = pairs.filter(({ requirement }) => requirement.kind === 'must_have');
  return {
    scoreBasisPoints: Math.min(BASIS_POINTS_MAX, scoreBasisPoints),
    mustHavesMet: mustHaves.filter(({ decision }) => decision.verdict === 'met').length,
    mustHavesTotal: mustHaves.length,
    mustHavesUnclear: mustHaves.filter(({ decision }) => decision.verdict === 'unclear').length,
    totalWeight,
    rows,
  };
}

/** The ceiling an enforced verdict list gives, ignoring the second opinion: used to show the cap can only lower a score. */
export function rankSum(verdicts: readonly MatchVerdict[]): number {
  return verdicts.reduce((sum, verdict) => sum + SUPPORT_RANK[verdict], 0);
}
