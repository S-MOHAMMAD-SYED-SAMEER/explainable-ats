import { criterionTerms, containsTerm, decideMatch, wordsOf, type EvidenceLike, type MatchDecision, type MatchMode } from './matchRules.ts';
import { disagreementOf, lowerOf, SUPPORT_RANK, type Disagreement } from './verdictMode.ts';
import { BASIS_POINTS_MAX, VERDICT_BASIS_POINTS, type ConfidenceLevel, type JobRequirement, type MatchVerdict } from '../domain/ats.ts';
import type { ScoreBreakdown, ScoredRequirement } from './score.ts';

// THE CODE'S RULES FOR A MODEL'S VERDICT (`model_checked` mode). Pure: no database, no clock, no model.
//
// A model's verdict is a PROPOSAL. Three things happen to it, in order, and none of them can raise it:
//
//   1. ENFORCEMENT. A verdict needs evidence that was found in the CV.
//        met or partial   needs at least one VERIFIED passage (word for word in the real CV, 15 characters or more),
//                         otherwise it is lowered to `unclear`.
//        not_met          needs either a verified passage (an explicit negative, "I have not ...") or a CV that is
//                         silent about the requirement (none of its words appear), otherwise `unclear`: a model that says
//                         the CV falls short while quoting nothing, about a CV that does mention the subject, has not
//                         shown what it is relying on.
//        unclear          always stands.
//        no answer        for a requirement the model did not answer is `unclear`.
//   2. THE SECOND OPINION. The deterministic matcher gives its own verdict from the SAME verified passages. One step apart
//      is shown to the recruiter. Two steps or more (see `verdictMode.ts`) routes the candidate to a person.
//   3. THE SCORED VERDICT. The enforced verdict, with ONE exception: when the model's verdict is higher than the matcher's by
//      two steps or more AND not one word of the requirement appears in any passage the model relied on (the matcher found
//      NOTHING in them), the matcher's verdict is scored instead, until a person decides. A passage that shares no word with the
//      requirement cannot raise a score: that is what stops a model that was fooled into crediting an attacker's line.
//      Every other disagreement, however large, is shown and routed to a person but does not change the number: the matcher
//      counts words, so on a passage that really is about the subject it is wrong far more often than it is right (measured:
//      about 35 to 40% agreement with the labels even when every passage is perfect), and letting it overrule the model
//      would put the ceiling back where it was.
//
// So the score is always at most what the enforced verdicts give, and the enforced verdicts are never above the model's.

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

/** Whether the CV never mentions the requirement: none of its words (folded, so "services" is "service") appear as whole words. */
export function cvIsSilent(requirement: Pick<JobRequirement, 'label' | 'criterion'>, contentText: string): boolean {
  const terms = criterionTerms(requirement);
  // A requirement made only of common words gives nothing to be silent about; claiming silence would be a guess.
  if (terms.length === 0) return false;
  const words = wordsOf(contentText, 'folded');
  return terms.every((term) => !containsTerm(words, term, 'folded'));
}

export function enforceVerdicts(input: {
  requirements: readonly Pick<JobRequirement, 'id' | 'label' | 'criterion'>[];
  answers: ReadonlyMap<string, ModelAnswer>;
  /** The passages that survived verification, by requirement. */
  verifiedPassages: ReadonlyMap<string, readonly string[]>;
  contentText: string;
}): EnforcedVerdict[] {
  return input.requirements.map((requirement) => {
    const answer = input.answers.get(requirement.id);
    const passages = input.verifiedPassages.get(requirement.id)?.length ?? 0;

    if (!answer) {
      return { requirementId: requirement.id, modelVerdict: null, modelReason: null, enforcedVerdict: 'unclear', downgrade: 'no_answer', verifiedPassages: passages };
    }

    let enforced: MatchVerdict = answer.verdict;
    let downgrade: EnforcedVerdict['downgrade'] = null;

    if ((answer.verdict === 'met' || answer.verdict === 'partial') && passages === 0) {
      enforced = 'unclear';
      downgrade = 'no_verified_passage';
    } else if (answer.verdict === 'not_met' && passages === 0 && !cvIsSilent(requirement, input.contentText)) {
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
  /** The verdict the score uses: the enforced one, or the matcher's lower verdict when the model credited passages that share no word with the requirement. */
  scoredVerdict: MatchVerdict;
  /** True when the scored verdict was lowered below the enforced one because the passages share no word with the requirement. */
  capped: boolean;
};

/**
 * Compares each enforced verdict with the matcher's verdict on the same verified passages.
 *
 * `evidence` is the verified evidence only: the matcher re-checks `verified` itself, as it always does.
 */
export function reconcileWithMatcher(
  requirements: readonly Pick<JobRequirement, 'id' | 'label' | 'criterion'>[],
  enforced: readonly EnforcedVerdict[],
  evidence: readonly EvidenceLike[],
  matchMode: MatchMode,
): Reconciled[] {
  const byRequirement = new Map(enforced.map((entry) => [entry.requirementId, entry]));
  return requirements.map((requirement) => {
    const mine = byRequirement.get(requirement.id) as EnforcedVerdict;
    const matcher = decideMatch(requirement, evidence, matchMode);
    const disagreement = disagreementOf(mine.enforcedVerdict, matcher.verdict);
    // Capped only when the model is HIGHER by two steps or more and the passages share no word with the requirement.
    const unrelated = matcher.matchedTerms.length === 0;
    const higher = SUPPORT_RANK[mine.enforcedVerdict] > SUPPORT_RANK[matcher.verdict];
    const scoredVerdict = disagreement === 'two_plus' && higher && unrelated ? lowerOf(mine.enforcedVerdict, matcher.verdict) : mine.enforcedVerdict;
    return { ...mine, matcher, disagreement, scoredVerdict, capped: scoredVerdict !== mine.enforcedVerdict };
  });
}

/** How much the evidence backs the scored verdict: agreement with a passage behind it is high, a one-step gap medium, the rest low. */
export function confidenceOf(entry: Reconciled): ConfidenceLevel {
  if (entry.disagreement === 'two_plus') return 'low';
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
