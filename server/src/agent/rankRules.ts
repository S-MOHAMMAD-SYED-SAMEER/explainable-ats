import { formatScore } from './score.ts';
import type { Evaluation, JobRequirement, RequirementMatch } from '../domain/ats.ts';

// RANKING — derived on read, never stored.
//
// A ranking is a pure function of the evaluations that currently exist. Storing
// it would create a second source of truth that drifts the moment one
// evaluation is superseded and the other is not, and the list would then
// disagree with the evaluation it links to. So there is no ranking table, and
// this file writes nothing at all.
//
// THE SCORE IS NOT TOUCHED
//
// The must-have gate changes where a candidate is placed and what they are
// called. It does not change their number. A score that quietly differed from
// the one on the evaluation page would make both pages untrustworthy, and the
// arithmetic behind it is the thing this product sells.
//
// "FAILED" AND "UNRESOLVED" ARE DIFFERENT ANSWERS
//
// A must-have the resume never addressed is not a must-have the candidate
// failed. The first is a gap in the reading and deserves a human look; the
// second is a finding. Collapsing them is how a good candidate is silently
// filtered out, so they are separate tiers with separate wording.

export const RANK_TIERS = ['qualified', 'needs_review', 'gated', 'not_evaluated'] as const;
export type RankTier = (typeof RANK_TIERS)[number];

const TIER_ORDER: Readonly<Record<RankTier, number>> = Object.freeze({
  qualified: 0,
  needs_review: 1,
  gated: 2,
  not_evaluated: 3,
});

export type RankCandidate = {
  id: string;
  reference: string;
  /** Carried for display only. Nothing in the ordering below reads it. */
  displayName: string | null;
};

export type RankInput = {
  candidate: RankCandidate;
  /** The current evaluation, or null when this candidate has none at all. */
  evaluation: Evaluation | null;
  matches: readonly RequirementMatch[];
};

export type RankedCandidate = {
  candidateId: string;
  reference: string;
  displayName: string | null;
  evaluationId: string | null;
  tier: RankTier;
  /** Exactly the number stored on the evaluation. The gate never edits it. */
  scoreBasisPoints: number | null;
  /**
   * The same number, rounded for display.
   *
   * Formatted here rather than in the browser. Rounding is arithmetic, and a
   * score rounded in two places is a score that can differ in two places —
   * which on this product is the difference between a list a recruiter trusts
   * and one they check by hand.
   */
  scorePercent: string | null;
  mustHavesMet: number | null;
  mustHavesTotal: number | null;
  /** Must-haves the evidence spoke to and did not demonstrate. */
  failedMustHaves: string[];
  /** Must-haves the resume said nothing about. Not the same thing. */
  unclearMustHaves: string[];
  /** 1-based display order. Always a total order. */
  position: number;
  /** Competition rank — equal for candidates who genuinely tie. Null when unranked. */
  rank: number | null;
  /** How many others share this rank. */
  tiedWith: number;
  rationale: string;
};

export type Ranking = {
  jobId: string;
  entries: RankedCandidate[];
  rankedCount: number;
  notEvaluatedCount: number;
};

type Classification = {
  tier: RankTier;
  failedMustHaves: string[];
  unclearMustHaves: string[];
};

/**
 * Decides which tier a candidate falls into.
 *
 * The gate itself is read from the stored `mustHavesMet` / `mustHavesTotal`,
 * because those are what the scorer committed to and are the authoritative
 * record. The matches are consulted only to explain WHY the gate did not pass —
 * which is a different question, and one the counts alone cannot answer.
 */
export function classify(
  evaluation: Evaluation | null,
  matches: readonly RequirementMatch[],
  requirements: readonly JobRequirement[],
): Classification {
  if (!evaluation || evaluation.status !== 'scored') {
    return { tier: 'not_evaluated', failedMustHaves: [], unclearMustHaves: [] };
  }

  const mustHaves = requirements.filter((requirement) => requirement.kind === 'must_have');
  const byRequirement = new Map(matches.map((match) => [match.requirementId, match]));

  const failed: string[] = [];
  const unclear: string[] = [];
  for (const requirement of mustHaves) {
    const verdict = byRequirement.get(requirement.id)?.verdict;
    if (verdict === 'met') continue;
    if (verdict === 'unclear' || verdict === undefined) unclear.push(requirement.label);
    else failed.push(requirement.label);
  }

  const total = evaluation.mustHavesTotal ?? 0;
  const met = evaluation.mustHavesMet ?? 0;
  if (met >= total) {
    return { tier: 'qualified', failedMustHaves: [], unclearMustHaves: [] };
  }

  // A found-and-insufficient must-have outranks an unaddressed one: the
  // stronger signal decides the tier, and both lists are still reported.
  return {
    tier: failed.length > 0 ? 'gated' : 'needs_review',
    failedMustHaves: failed,
    unclearMustHaves: unclear,
  };
}

function quoted(labels: readonly string[]): string {
  return labels.map((label) => `"${label}"`).join(', ');
}

function buildRationale(entry: Omit<RankedCandidate, 'rationale'>, total: number): string {
  const place =
    entry.rank === null
      ? 'Not ranked.'
      : entry.tiedWith > 0
        ? `Ranked ${entry.rank} of ${total}, tied with ${entry.tiedWith} other${entry.tiedWith === 1 ? '' : 's'}.`
        : `Ranked ${entry.rank} of ${total}.`;

  switch (entry.tier) {
    case 'qualified':
      return (
        `${place} Meets all ${entry.mustHavesTotal} must-have${entry.mustHavesTotal === 1 ? '' : 's'}, ` +
        `scoring ${formatScore(entry.scoreBasisPoints ?? 0)}.`
      );

    case 'gated':
      return (
        `${place} Scored ${formatScore(entry.scoreBasisPoints ?? 0)} and meets ${entry.mustHavesMet} of ` +
        `${entry.mustHavesTotal} must-haves. The evidence found does not demonstrate ${quoted(entry.failedMustHaves)}. ` +
        'Placed below every candidate who meets all of them, however high that score is — the score itself is unchanged.'
      );

    case 'needs_review':
      return (
        `${place} Scored ${formatScore(entry.scoreBasisPoints ?? 0)} and meets ${entry.mustHavesMet} of ` +
        `${entry.mustHavesTotal} must-haves. The resume said nothing about ${quoted(entry.unclearMustHaves)}, ` +
        'so this is unresolved rather than failed and is worth a human look.'
      );

    case 'not_evaluated':
      return entry.evaluationId === null
        ? `${place} There is no evaluation of this candidate for this job yet.`
        : `${place} The current evaluation of this candidate has not been scored.`;
  }
}

/**
 * Orders candidates and explains every placement.
 *
 * Pure and total: given the same inputs it returns the same list, in the same
 * order, on every machine. The final tie-break is the candidate id, which is
 * arbitrary but stable — and because it IS arbitrary, genuine ties are reported
 * as ties rather than dressed up as one candidate beating another.
 */
export function rankCandidates(
  jobId: string,
  requirements: readonly JobRequirement[],
  inputs: readonly RankInput[],
): Ranking {
  const classified = inputs.map((input) => {
    const { tier, failedMustHaves, unclearMustHaves } = classify(input.evaluation, input.matches, requirements);
    const scored = tier !== 'not_evaluated' ? input.evaluation : null;

    return {
      candidateId: input.candidate.id,
      reference: input.candidate.reference,
      displayName: input.candidate.displayName,
      evaluationId: input.evaluation?.id ?? null,
      tier,
      scoreBasisPoints: scored?.scoreBasisPoints ?? null,
      scorePercent:
        scored?.scoreBasisPoints === undefined || scored?.scoreBasisPoints === null
          ? null
          : formatScore(scored.scoreBasisPoints),
      mustHavesMet: scored?.mustHavesMet ?? null,
      mustHavesTotal: scored?.mustHavesTotal ?? null,
      failedMustHaves,
      unclearMustHaves,
      createdAt: input.evaluation?.createdAt ?? '',
    };
  });

  // Every comparison is a total order over the input, so the result cannot
  // depend on the sort implementation being stable.
  classified.sort(
    (a, b) =>
      TIER_ORDER[a.tier] - TIER_ORDER[b.tier] ||
      (b.scoreBasisPoints ?? -1) - (a.scoreBasisPoints ?? -1) ||
      (b.mustHavesMet ?? -1) - (a.mustHavesMet ?? -1) ||
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0),
  );

  // Competition ranking: candidates who genuinely tie share a rank, and the
  // next rank skips accordingly (1, 2, 2, 4). The unevaluated are not ranked
  // at all — a placeholder rank would read as a judgement nobody made.
  const rankable = classified.filter((entry) => entry.tier !== 'not_evaluated');
  const tieKey = (entry: (typeof classified)[number]) =>
    `${entry.tier}|${entry.scoreBasisPoints}|${entry.mustHavesMet}`;

  const ranks = new Map<string, { rank: number; size: number }>();
  rankable.forEach((entry, index) => {
    const key = tieKey(entry);
    const existing = ranks.get(key);
    if (existing) existing.size += 1;
    else ranks.set(key, { rank: index + 1, size: 1 });
  });

  const entries: RankedCandidate[] = classified.map((entry, index) => {
    const tie = entry.tier === 'not_evaluated' ? null : ranks.get(tieKey(entry));
    const base = {
      candidateId: entry.candidateId,
      reference: entry.reference,
      displayName: entry.displayName,
      evaluationId: entry.evaluationId,
      tier: entry.tier,
      scoreBasisPoints: entry.scoreBasisPoints,
      scorePercent: entry.scorePercent,
      mustHavesMet: entry.mustHavesMet,
      mustHavesTotal: entry.mustHavesTotal,
      failedMustHaves: entry.failedMustHaves,
      unclearMustHaves: entry.unclearMustHaves,
      position: index + 1,
      rank: tie?.rank ?? null,
      tiedWith: tie ? tie.size - 1 : 0,
    };

    return { ...base, rationale: buildRationale(base, rankable.length) };
  });

  return {
    jobId,
    entries,
    rankedCount: rankable.length,
    notEvaluatedCount: classified.length - rankable.length,
  };
}
