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
// WHAT HAPPENS ON A DISAGREEMENT. Every difference is shown on the candidate page. The score changes in one case only, set out in
// `verdictEnforcement.ts`: the model's verdict is two steps or more HIGHER than the matcher's and the passages it quoted share no word
// with the requirement, which cannot be evidence for it. Then the score is LOWERED pending review, and if that requirement is a
// MUST-HAVE the candidate is routed to `needs_review` (`routesToReview` below). Every other disagreement is shown and does neither.

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

/** Whether the score uses a lower verdict than the one the model's verdict became after the code's rules. */
export function scoreLowered(enforced: MatchVerdict, scored: MatchVerdict): boolean {
  return SUPPORT_RANK[scored] < SUPPORT_RANK[enforced];
}

/**
 * Whether a requirement sends its candidate to a person: it is a must-have AND its score was lowered pending review. A disagreement
 * that did not lower the score (a model lower than the matcher, a gap on passages that do share words with the requirement, a
 * nice-to-have) is shown and routes nobody.
 */
export function routesToReview(kind: 'must_have' | 'nice_to_have', enforced: MatchVerdict, scored: MatchVerdict): boolean {
  return kind === 'must_have' && scoreLowered(enforced, scored);
}

/** The verdict that demonstrates less. A tie returns the first. */
export function lowerOf(a: MatchVerdict, b: MatchVerdict): MatchVerdict {
  return SUPPORT_RANK[b] < SUPPORT_RANK[a] ? b : a;
}
