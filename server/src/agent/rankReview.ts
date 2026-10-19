import { formatScore } from './score.ts';
import type { RankedCandidate, Ranking } from './rankRules.ts';

// A candidate the second opinion disagreed with goes to a person.
//
// In `model_checked` mode the deterministic matcher checks the model's verdicts. When a credited must-have rests on a quote that
// shares no word with the requirement (`routesToReview`, `verdictMode.ts`), the candidate is routed to `needs_review`: the same tier
// the ranking already uses for "worth a human look". Any other disagreement routes nobody. The score is never touched. The ranking itself (`rankRules.ts`, shared with the portfolio sites and not changed) knows nothing of
// this; this module applies it afterwards, to the finished ranking, and renumbers it.
//
// The score is never touched: it is exactly what the evaluation stored. Only the tier, the order that follows from it, the
// positions and the sentence that explains the placement change. Where no candidate is flagged the ranking is returned as it was.

const TIER_ORDER = { qualified: 0, needs_review: 1, gated: 2, not_evaluated: 3 } as const;

function placeOf(entry: Pick<RankedCandidate, 'rank' | 'tiedWith'>, total: number): string {
  return entry.rank === null
    ? 'Not ranked.'
    : entry.tiedWith > 0
      ? `Ranked ${entry.rank} of ${total} assessed candidate${total === 1 ? '' : 's'}, tied with ${entry.tiedWith} other${entry.tiedWith === 1 ? '' : 's'}.`
      : `Ranked ${entry.rank} of ${total} assessed candidate${total === 1 ? '' : 's'}.`;
}

const PLACE_SENTENCE = /^(Not ranked\.|Ranked \d+ of \d+ assessed candidates?(, tied with \d+ others?)?\.)/;

export function routeToReview(ranking: Ranking, routed: ReadonlyMap<string, readonly string[]>): Ranking {
  const flagged = ranking.entries.filter((entry) => entry.evaluationId !== null && entry.tier !== 'not_evaluated' && routed.has(entry.evaluationId));
  if (flagged.length === 0) return ranking;

  const moved = ranking.entries.map((entry) => ({
    entry: flagged.includes(entry) ? { ...entry, tier: 'needs_review' as const } : entry,
    before: entry.position,
  }));
  // Every comparison is a total order over the input: tier, then score, then must-haves met, then the order it already had.
  moved.sort(
    (a, b) =>
      TIER_ORDER[a.entry.tier] - TIER_ORDER[b.entry.tier] ||
      (b.entry.scoreBasisPoints ?? -1) - (a.entry.scoreBasisPoints ?? -1) ||
      (b.entry.mustHavesMet ?? -1) - (a.entry.mustHavesMet ?? -1) ||
      a.before - b.before,
  );

  const rankable = moved.filter(({ entry }) => entry.tier !== 'not_evaluated');
  const tieKey = (entry: RankedCandidate): string => `${entry.tier}|${entry.scoreBasisPoints}|${entry.mustHavesMet}`;
  const ranks = new Map<string, { rank: number; size: number }>();
  rankable.forEach(({ entry }, index) => {
    const existing = ranks.get(tieKey(entry));
    if (existing) existing.size += 1;
    else ranks.set(tieKey(entry), { rank: index + 1, size: 1 });
  });

  const entries: RankedCandidate[] = moved.map(({ entry }, index) => {
    const tie = entry.tier === 'not_evaluated' ? null : ranks.get(tieKey(entry));
    const renumbered = { ...entry, position: index + 1, rank: tie?.rank ?? null, tiedWith: tie ? tie.size - 1 : 0 };
    const place = placeOf(renumbered, rankable.length);
    const labels = entry.evaluationId === null ? undefined : routed.get(entry.evaluationId);
    if (flagged.some((candidate) => candidate.candidateId === entry.candidateId) && labels) {
      return {
        ...renumbered,
        rationale:
          `${place} Scored ${formatScore(entry.scoreBasisPoints ?? 0)} and meets ${entry.mustHavesMet} of ${entry.mustHavesTotal} must-haves, ` +
          `but on ${labels.map((label) => `"${label}"`).join(', ')} the quote shares no words with the requirement; ` +
          'a person should check.' +
          // A candidate can be worth a look for two reasons at once: say both, not only the flag.
          (entry.unclearMustHaves.length > 0
            ? ` The resume also said nothing about ${entry.unclearMustHaves.map((label) => `"${label}"`).join(', ')}, so that is unresolved rather than failed.`
            : ''),
      };
    }
    return { ...renumbered, rationale: PLACE_SENTENCE.test(entry.rationale) ? entry.rationale.replace(PLACE_SENTENCE, place) : entry.rationale };
  });

  return { ...ranking, entries };
}
