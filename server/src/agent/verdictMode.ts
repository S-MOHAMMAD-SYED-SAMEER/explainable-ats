import type { MatchVerdict } from '../domain/ats.ts';

// WHO DECIDES A VERDICT: the setting, and how far apart two verdicts are.
//
//   model_checked   The model proposes a verdict for each requirement and the passages it relies on. The code
//                   enforces the rules (see `verdictEnforcement.ts`), and the deterministic matcher computes its
//                   own verdict from the same verified passages as a SECOND OPINION. The default.
//   matcher         The old behaviour, kept for comparison: the model only quotes, and the matcher alone judges.
//
// The reason `model_checked` exists is a measurement: with the deterministic matcher, verdict agreement with the
// labels was about 35 to 40% even when every passage was perfect, so the ceiling was the matcher, not the model.
// A matcher that counts words cannot read "ran the Postgres fleet" as "run PostgreSQL". The matcher stays, but as a
// check on the model rather than as the judge.

export const VERDICT_MODES = ['model_checked', 'matcher'] as const;
export type VerdictMode = (typeof VERDICT_MODES)[number];
export const DEFAULT_VERDICT_MODE: VerdictMode = 'model_checked';

// HOW FAR APART TWO VERDICTS ARE
//
// A scale of how much the CV demonstrates, highest first:
//
//     met 3   partial 2   unclear 1   not_met 0
//
// `unclear` (the CV is silent) sits above `not_met` (the CV speaks to it and falls short): saying nothing is not a
// finding against anyone. Two verdicts differing by ONE step (met and partial, partial and unclear, unclear and
// not_met) are shown to the recruiter and nothing else happens. Two or more steps (met and unclear, met and not_met,
// partial and not_met) route the candidate to a person: the model and the check cannot both be right about the same
// passages, and a person looks.
//
// Why partial and not_met count as two steps: a model fooled into calling an irrelevant passage `partial`, against a
// matcher that finds none of the requirement's words in it, would otherwise be credited half the requirement.
//
// WHAT HAPPENS ON A DISAGREEMENT. Every difference is shown on the candidate page. A candidate is ROUTED to a person only by
// `routesToReview` below: a MUST-HAVE requirement on which the model is two steps or more HIGHER than the matcher. A model that is
// lower than the matcher can only have lowered a score, so it is shown and not routed; and a nice-to-have cannot send anyone to a
// person. The score changes only in one case, set out in `verdictEnforcement.ts`: the model credited passages that share no word
// with the requirement, which cannot be evidence for it.

export const SUPPORT_RANK: Readonly<Record<MatchVerdict, number>> = Object.freeze({ met: 3, partial: 2, unclear: 1, not_met: 0 });

/** Two steps or more is a disagreement that can be acted on. */
export const ROUTING_STEPS = 2;

export type Disagreement = 'none' | 'one_step' | 'two_plus';

export function verdictSteps(a: MatchVerdict, b: MatchVerdict): number {
  return Math.abs(SUPPORT_RANK[a] - SUPPORT_RANK[b]);
}

export function disagreementOf(a: MatchVerdict, b: MatchVerdict): Disagreement {
  const steps = verdictSteps(a, b);
  return steps === 0 ? 'none' : steps >= ROUTING_STEPS ? 'two_plus' : 'one_step';
}

/**
 * Whether a requirement sends its candidate to a person: it is a must-have, and the model's (enforced) verdict is `ROUTING_STEPS` or
 * more steps HIGHER than the matcher's. A matcher that is higher than the model, or any gap on a nice-to-have, is shown and not routed.
 */
export function routesToReview(kind: 'must_have' | 'nice_to_have', enforced: MatchVerdict, matcher: MatchVerdict): boolean {
  return kind === 'must_have' && SUPPORT_RANK[enforced] - SUPPORT_RANK[matcher] >= ROUTING_STEPS;
}

/** The verdict that demonstrates less. A tie returns the first. */
export function lowerOf(a: MatchVerdict, b: MatchVerdict): MatchVerdict {
  return SUPPORT_RANK[b] < SUPPORT_RANK[a] ? b : a;
}
