import type { ConfidenceLevel, JobRequirement, MatchVerdict } from '../domain/ats.ts';

// MATCHING — deterministic, and deliberately unglamorous.
//
// The model has already done the only thing a model is good at here: it found
// passages and quoted them, and every quote has been checked against the real
// document. What remains is a judgement — does this passage satisfy this
// criterion — and that judgement is made by the rules in this file, in ordinary
// arithmetic, with no model involved.
//
// WHY NOT ASK THE MODEL FOR THE VERDICT
//
// Because a verdict a model produced cannot be reproduced, cannot be explained
// beyond "it said so", and cannot be defended to a candidate who asks why they
// were screened out. These rules can be reproduced by hand from the stored
// evidence, which is the whole product. The cost is that the rules are crude —
// term coverage, not comprehension — and that cost is paid openly: every
// rationale states exactly what was counted, so a recruiter can see when the
// rule has misjudged and overrule it.
//
// NOTHING UNVERIFIED IS EVER COUNTED
//
// `decideMatch` filters on `verified` itself rather than trusting its caller.
// The caller already passes verified-only evidence; this is the second lock on
// the same door, because a fabricated quote reaching the scorer is the one
// failure that would turn this product into the thing it was built to replace.

/** Words too common to tell one requirement apart from another. */
const STOPWORDS = new Set([
  'and', 'are', 'any', 'been', 'for', 'from', 'has', 'have', 'his', 'her', 'its',
  'least', 'must', 'not', 'own', 'per', 'the', 'that', 'their', 'them', 'they',
  'this', 'those', 'with', 'work', 'working', 'able', 'can', 'will', 'who',
  'was', 'were', 'you', 'your', 'our', 'out', 'into', 'over', 'some', 'such',
]);

/**
 * The concrete things a piece of text asks for.
 *
 * Shared with the stand-in extractor on purpose: "what this criterion is
 * asking for" is one idea, and two definitions of it would drift. Note the
 * consequence for tests — evidence chosen by the stand-in is evidence chosen to
 * maximise the very overlap this file then measures, so a test that wants to
 * prove a scoring rule works must supply its own evidence rather than let the
 * stand-in supply it.
 */
export function significantTerms(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ''))
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word));

  return [...new Set(words)].sort();
}

/** What a requirement asks for: its criterion, plus its label. */
export function criterionTerms(requirement: Pick<JobRequirement, 'label' | 'criterion'>): string[] {
  return significantTerms(`${requirement.label} ${requirement.criterion}`);
}

// Thresholds, as percentages so the comparison stays in integers.
//
// A float here would be the one place in the scoring path where the same
// inputs could produce a different answer on a different machine, and the
// entire point of this stage is that the arithmetic is reproducible.
export const MET_COVERAGE_PERCENT = 75;
export const PARTIAL_COVERAGE_PERCENT = 35;

export type EvidenceLike = {
  requirementId: string | null;
  quote: string;
  verified: boolean;
};

export type MatchDecision = {
  requirementId: string;
  verdict: MatchVerdict;
  confidence: ConfidenceLevel;
  /** Criterion terms the quoted passages actually contain. */
  matchedTerms: string[];
  missingTerms: string[];
  /** How many verified passages were quoted against this requirement. */
  evidenceCount: number;
  rationale: string;
};

function buildRationale(
  verdict: MatchVerdict,
  matched: readonly string[],
  missing: readonly string[],
  evidenceCount: number,
): string {
  const total = matched.length + missing.length;
  const passages = `${evidenceCount} quoted passage${evidenceCount === 1 ? '' : 's'}`;
  const absent = missing.map((term) => `"${term}"`).join(', ');

  switch (verdict) {
    case 'met':
      return `Met. The evidence covers ${matched.length} of the ${total} things this requirement asks for, across ${passages}.`;
    case 'partial':
      return `Partially met. The evidence covers ${matched.length} of ${total} — nothing was found for ${absent}. ${passages}.`;
    case 'not_met':
      return `Not met. The best evidence found covers only ${matched.length} of ${total} — nothing was found for ${absent}. ${passages}.`;
    case 'unclear':
      return evidenceCount === 0
        ? 'Unclear. Nothing in the resume was quoted against this requirement, so there is no evidence either way. This is not a finding against the candidate.'
        : 'Unclear. This requirement is worded too loosely to check against the resume, so no verdict was reached.';
  }
}

/**
 * Decides one requirement against the evidence quoted for it.
 *
 * `unclear` is not a quiet `not_met`. "The resume says nothing about this" and
 * "the passage we found does not demonstrate this" are different facts, and
 * reporting the first as the second is how a good candidate gets filtered out
 * for a gap in the reading rather than a gap in their experience.
 */
export function decideMatch(
  requirement: Pick<JobRequirement, 'id' | 'label' | 'criterion'>,
  evidence: readonly EvidenceLike[],
): MatchDecision {
  const usable = evidence.filter(
    (item) => item.verified && item.requirementId === requirement.id,
  );

  const terms = criterionTerms(requirement);

  // A criterion made entirely of common words gives nothing to check against.
  // Calling that `not_met` would blame the candidate for the job spec.
  if (terms.length === 0) {
    return {
      requirementId: requirement.id,
      verdict: 'unclear',
      confidence: 'low',
      matchedTerms: [],
      missingTerms: [],
      evidenceCount: usable.length,
      rationale: buildRationale('unclear', [], [], usable.length),
    };
  }

  if (usable.length === 0) {
    return {
      requirementId: requirement.id,
      verdict: 'unclear',
      confidence: 'low',
      matchedTerms: [],
      missingTerms: terms,
      evidenceCount: 0,
      rationale: buildRationale('unclear', [], terms, 0),
    };
  }

  const haystack = usable.map((item) => item.quote.toLowerCase()).join('\n');
  const matched = terms.filter((term) => haystack.includes(term));
  const missing = terms.filter((term) => !haystack.includes(term));

  // Integer comparison: matched/total >= threshold/100, without the division.
  const covered = matched.length * 100;
  const verdict: MatchVerdict =
    covered >= terms.length * MET_COVERAGE_PERCENT
      ? 'met'
      : covered >= terms.length * PARTIAL_COVERAGE_PERCENT
        ? 'partial'
        : 'not_met';

  // Confidence describes how much the evidence backs the verdict, not how
  // good the candidate is. Two independent passages saying the same thing is
  // a stronger basis than one, whatever the verdict turned out to be.
  const confidence: ConfidenceLevel =
    matched.length === terms.length || usable.length >= 2
      ? 'high'
      : verdict === 'not_met'
        ? 'low'
        : 'medium';

  return {
    requirementId: requirement.id,
    verdict,
    confidence,
    matchedTerms: matched,
    missingTerms: missing,
    evidenceCount: usable.length,
    rationale: buildRationale(verdict, matched, missing, usable.length),
  };
}
