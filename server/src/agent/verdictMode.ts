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
// WHAT HAPPENS ON A DISAGREEMENT. Every difference is shown on the candidate page, and NONE of them changes the score: the model's
// verified verdict is what is scored. One thing is flagged and acted on by a person, not by the arithmetic: a verdict that credits the
// candidate (met or partial) on quotes that share no word with the requirement ("quote_no_overlap_flagged", `verdictEnforcement.ts`).
// If that requirement is a MUST-HAVE the candidate is routed to `needs_review` (`routesToReview` below).

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
 * Whether a requirement sends its candidate to a person: it is a MUST-HAVE and its credited verdict rests on a quote that shares no
 * word with the requirement. Any other disagreement (a model lower than the matcher, a quote that does share words, a nice-to-have)
 * is shown and routes nobody.
 */
export function routesToReview(kind: 'must_have' | 'nice_to_have', quoteNoOverlap: boolean): boolean {
  return kind === 'must_have' && quoteNoOverlap;
}
