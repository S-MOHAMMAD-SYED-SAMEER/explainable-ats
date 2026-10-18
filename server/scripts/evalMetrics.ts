import { decideMatch, type MatchMode } from '../src/agent/matchRules.ts';
import { scoreEvaluation } from '../src/agent/score.ts';
import { classify, type RankTier } from '../src/agent/rankRules.ts';
import { normaliseForComparison, type LabelVerdict } from './evalLabels.ts';
import type { Evaluation, JobRequirement, RequirementMatch } from '../src/domain/ats.ts';

// The measures the evaluation harness reports, as pure functions of data.
//
// Nothing here touches a model, a database or a file: it takes what a run recorded (which
// passages the system verified for each requirement, as character ranges in the CV) and what
// the labeller wrote (gold passages and verdicts) and returns numbers. That keeps every figure
// reproducible from a saved result file with no further request, and testable with no key.
//
// THE DEFINITIONS (they are written into every saved result)
//
//   * A proposed passage "hits" a gold passage of the SAME requirement in the SAME CV when their
//     character ranges overlap by at least half of the shorter of the two ("half" rule), or by
//     at least one character ("any" rule). Boundaries are judgement calls, so two readers who
//     quote the same sentence a few words apart should still count as agreeing.
//   * Passage recall    = gold passages hit by at least one verified passage / gold passages.
//   * Passage precision = verified passages that hit a gold passage / verified passages.
//     A verified passage for a requirement the labeller marked unclear (no gold passage) is a miss.
//   * Fabricated-quote rate = quotes refused as "not found in the CV" / quotes the model proposed
//     in a valid shape. Quotes refused as too short, or as quoting masked text, are counted apart.
//   * Verdict agreement = requirements where the pipeline's verdict equals the labeller's.
//   * Tier agreement    = CVs where the tier derived from the pipeline's verdicts equals the tier
//     derived, by the same rule, from the labeller's verdicts.

export type Span = { start: number; end: number };
export type HitRule = 'half' | 'any';
export const HIT_RULES: readonly HitRule[] = ['half', 'any'];

/** Characters two ranges share. */
export function overlapChars(a: Span, b: Span): number {
  return Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
}

export function isHit(a: Span, b: Span, rule: HitRule): boolean {
  const shared = overlapChars(a, b);
  if (shared === 0) return false;
  if (rule === 'any') return true;
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return shared * 2 >= shorter;
}

// --- finding a gold passage in the CV -------------------------------------------------------------

const SINGLE_QUOTES = "['‘’‚‛]";
const DOUBLE_QUOTES = '["“”„‟]';
const DASHES = '[-–—−]';

function escapeChar(char: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(char) ? `\\${char}` : char;
}

/** A pattern for one word of a normalised passage that accepts the look-alike characters in either direction. */
function wordPattern(word: string): string {
  let out = '';
  for (let i = 0; i < word.length; i += 1) {
    const char = word[i] as string;
    if (/['‘’‚‛]/.test(char)) out += SINGLE_QUOTES;
    else if (/["“”„‟]/.test(char)) out += DOUBLE_QUOTES;
    else if (/[-–—−]/.test(char)) out += DASHES;
    else if (word.startsWith('...', i)) {
      out += '(?:\\.\\.\\.|…)';
      i += 2;
    } else out += escapeChar(char);
  }
  return out;
}

/**
 * Where a gold passage sits in the CV text, or null. Tried exactly first; then with whitespace of
 * any kind between words and look-alike punctuation accepted, which is how `validate-labels.ts`
 * compares them, so a label that validated can be located.
 */
export function locatePassage(passage: string, text: string): Span | null {
  const exact = text.indexOf(passage);
  if (exact >= 0) return { start: exact, end: exact + passage.length };

  const words = normaliseForComparison(passage).split(' ').filter((word) => word !== '');
  if (words.length === 0) return null;
  const found = new RegExp(words.map(wordPattern).join('\\s+'), 'u').exec(text);
  return found ? { start: found.index, end: found.index + found[0].length } : null;
}

// --- one requirement of one CV --------------------------------------------------------------------

export type PairRecord = {
  cvId: string;
  requirementId: string;
  /** The labeller's verdict. */
  goldVerdict: LabelVerdict;
  goldSpans: Span[];
  /** Verified passages the system recorded for this requirement. */
  verifiedSpans: Span[];
};

export type PassageMetrics = {
  rule: HitRule;
  goldPassages: number;
  goldPassagesHit: number;
  /** Null when there are no gold passages. */
  recall: number | null;
  verifiedPassages: number;
  verifiedPassagesHit: number;
  /** Null when nothing was verified. */
  precision: number | null;
  /** Requirements with at least one gold passage, and how many of them had at least one hit. */
  requirementsWithGold: number;
  requirementsWithGoldHit: number;
};

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

export function passageMetrics(pairs: readonly PairRecord[], rule: HitRule): PassageMetrics {
  let goldPassages = 0;
  let goldPassagesHit = 0;
  let verifiedPassages = 0;
  let verifiedPassagesHit = 0;
  let requirementsWithGold = 0;
  let requirementsWithGoldHit = 0;

  for (const pair of pairs) {
    goldPassages += pair.goldSpans.length;
    goldPassagesHit += pair.goldSpans.filter((gold) => pair.verifiedSpans.some((span) => isHit(span, gold, rule))).length;
    verifiedPassages += pair.verifiedSpans.length;
    verifiedPassagesHit += pair.verifiedSpans.filter((span) => pair.goldSpans.some((gold) => isHit(span, gold, rule))).length;
    if (pair.goldSpans.length > 0) {
      requirementsWithGold += 1;
      if (pair.goldSpans.some((gold) => pair.verifiedSpans.some((span) => isHit(span, gold, rule)))) requirementsWithGoldHit += 1;
    }
  }

  return {
    rule,
    goldPassages,
    goldPassagesHit,
    recall: ratio(goldPassagesHit, goldPassages),
    verifiedPassages,
    verifiedPassagesHit,
    precision: ratio(verifiedPassagesHit, verifiedPassages),
    requirementsWithGold,
    requirementsWithGoldHit,
  };
}

// --- verdicts and tiers ------------------------------------------------------------------------------

const VERDICT_ORDER: Readonly<Record<LabelVerdict, number>> = { not_met: 0, unclear: 1, partial: 2, met: 3 };

export type VerdictAgreement = {
  rows: number;
  agree: number;
  rate: number | null;
  /** [gold][predicted] counts. */
  confusion: Record<LabelVerdict, Record<LabelVerdict, number>>;
  /** The pipeline credited more than the labeller did (met over partial, partial over not_met, ...). */
  higherThanGold: number;
  lowerThanGold: number;
};

export function emptyConfusion(): VerdictAgreement['confusion'] {
  const zero = (): Record<LabelVerdict, number> => ({ met: 0, partial: 0, not_met: 0, unclear: 0 });
  return { met: zero(), partial: zero(), not_met: zero(), unclear: zero() };
}

export function verdictAgreement(pairs: ReadonlyArray<{ gold: LabelVerdict; predicted: LabelVerdict }>): VerdictAgreement {
  const confusion = emptyConfusion();
  let agree = 0;
  let higher = 0;
  let lower = 0;
  for (const { gold, predicted } of pairs) {
    confusion[gold][predicted] += 1;
    if (gold === predicted) agree += 1;
    else if (VERDICT_ORDER[predicted] > VERDICT_ORDER[gold]) higher += 1;
    else lower += 1;
  }
  return { rows: pairs.length, agree, rate: ratio(agree, pairs.length), confusion, higherThanGold: higher, lowerThanGold: lower };
}

/**
 * The tier a set of verdicts leads to, by the application's own rule (`classify`): all must-haves
 * met is qualified; otherwise gated if any must-have was found and not demonstrated, needs_review
 * if the only gaps are must-haves the CV was silent on.
 */
export function tierOfVerdicts(
  requirements: readonly JobRequirement[],
  verdicts: ReadonlyMap<string, LabelVerdict>,
): RankTier {
  const mustHaves = requirements.filter((requirement) => requirement.kind === 'must_have');
  const mustHavesMet = mustHaves.filter((requirement) => verdicts.get(requirement.id) === 'met').length;
  const evaluation = { status: 'scored', mustHavesMet, mustHavesTotal: mustHaves.length } as Evaluation;
  const matches = [...verdicts].map(([requirementId, verdict]) => ({ requirementId, verdict }) as RequirementMatch);
  return classify(evaluation, matches, requirements).tier;
}

export type TierAgreement = { cvs: number; agree: number; rate: number | null };

export function tierAgreement(pairs: ReadonlyArray<{ gold: RankTier; predicted: RankTier }>): TierAgreement {
  const agree = pairs.filter((pair) => pair.gold === pair.predicted).length;
  return { cvs: pairs.length, agree, rate: ratio(agree, pairs.length) };
}

/**
 * What the matching stage would say if the extraction stage were perfect: the labeller's own gold
 * passages as the evidence. The gap between this and 100% is the matcher's (term coverage's) own
 * disagreement with the labeller, before any model is involved.
 */
export function verdictsFromGoldPassages(
  requirements: readonly JobRequirement[],
  goldQuotes: ReadonlyMap<string, readonly string[]>,
  mode: MatchMode,
): Map<string, LabelVerdict> {
  const evidence = [...goldQuotes].flatMap(([requirementId, quotes]) =>
    quotes.map((quote) => ({ requirementId, quote, verified: true })),
  );
  const breakdown = scoreEvaluation(requirements, evidence, mode);
  return new Map(breakdown.rows.map((row) => [row.requirement.id, row.decision.verdict as LabelVerdict]));
}

/** The verdict for one requirement from the quotes verified for it. */
export function verdictFromQuotes(requirement: JobRequirement, quotes: readonly string[], mode: MatchMode): LabelVerdict {
  const evidence = quotes.map((quote) => ({ requirementId: requirement.id, quote, verified: true }));
  return decideMatch(requirement, evidence, mode).verdict as LabelVerdict;
}

// --- latency and cost -----------------------------------------------------------------------------------

export type Summary = { count: number; mean: number | null; median: number | null; max: number | null; total: number };

export function summarise(values: readonly number[]): Summary {
  if (values.length === 0) return { count: 0, mean: null, median: null, max: null, total: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? (sorted[middle] as number) : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return { count: sorted.length, mean: total / sorted.length, median, max: sorted[sorted.length - 1] as number, total };
}
