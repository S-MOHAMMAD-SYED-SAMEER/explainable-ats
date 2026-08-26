import { overlapsRedaction, type RedactionSpan } from './redact.ts';
import type { RawFinding } from './extractionSchema.ts';

// Verification — the control that makes a fabricated citation impossible to
// display or score.
//
// A model that is asked to quote will sometimes produce a quote that reads
// perfectly and does not exist. Nothing about the text betrays it, so the only
// defence is to go and look: the quote must be present, character for
// character, in the resume that was actually submitted.
//
// OFFSETS ARE A HINT, NOT A FACT
//
// Models are unreliable at counting characters and reliable at copying words.
// So the quote is the claim being checked, and the offsets are treated as a
// suggestion: if the text sits where the model said, those offsets are used;
// otherwise the passage is located in the source. A quote that cannot be found
// anywhere is a fabrication and is rejected.
//
// Rejecting on a mistyped offset would throw away true evidence for a clerical
// error, and searching for a quote that is not there cannot invent one — so
// this is strict where it matters and forgiving where it does not.

export type VerifiedEvidence = {
  finding: RawFinding;
  /** Where the quote really is in `content_text`. */
  charStart: number;
  charEnd: number;
  /** True when the model's own offsets were already correct. */
  offsetsWereCorrect: boolean;
};

export type EvidenceRejection = {
  finding: RawFinding;
  reason: 'not_found_in_resume' | 'quotes_redacted_text';
  detail: string;
};

export type VerificationResult = {
  verified: VerifiedEvidence[];
  rejected: EvidenceRejection[];
};

export type VerifyOptions = {
  /** The original text. Every quote is checked against THIS, not the redacted copy. */
  contentText: string;
  /** Masked regions. A quote overlapping one is impossible and is refused. */
  redactionSpans: readonly RedactionSpan[];
};

/**
 * Checks every finding against the resume it claims to come from.
 *
 * Whitespace is normalised for the comparison only: a model that reproduces a
 * wrapped line as a single space has copied the words correctly, and the words
 * are the claim. Nothing else is normalised — case, punctuation and wording
 * must match, because those are what a recruiter would read back.
 */
export function verifyEvidence(findings: readonly RawFinding[], options: VerifyOptions): VerificationResult {
  const verified: VerifiedEvidence[] = [];
  const rejected: EvidenceRejection[] = [];

  const { contentText, redactionSpans } = options;

  for (const finding of findings) {
    const quote = finding.quote;

    // 1. Does it sit exactly where the model said?
    const atHint = contentText.slice(finding.charStart, finding.charEnd);
    if (atHint === quote) {
      if (overlapsRedaction(redactionSpans, finding.charStart, finding.charEnd)) {
        rejected.push({
          finding,
          reason: 'quotes_redacted_text',
          detail: 'The passage overlaps a masked protected attribute, which the model was never shown.',
        });
        continue;
      }
      verified.push({ finding, charStart: finding.charStart, charEnd: finding.charEnd, offsetsWereCorrect: true });
      continue;
    }

    // 2. If not, is it anywhere at all? The quote is the claim; the offsets
    //    were only a hint.
    const located = locate(contentText, quote);
    if (located === null) {
      rejected.push({
        finding,
        reason: 'not_found_in_resume',
        detail: 'This passage does not appear in the resume. It was not written by the candidate.',
      });
      continue;
    }

    if (overlapsRedaction(redactionSpans, located.start, located.end)) {
      rejected.push({
        finding,
        reason: 'quotes_redacted_text',
        detail: 'The passage overlaps a masked protected attribute, which the model was never shown.',
      });
      continue;
    }

    verified.push({ finding, charStart: located.start, charEnd: located.end, offsetsWereCorrect: false });
  }

  return { verified, rejected };
}

/**
 * Finds a quote in the source, tolerating differences in whitespace only.
 *
 * Returns the span in the ORIGINAL text, so an offset recorded against a
 * whitespace-normalised copy can never be stored.
 */
function locate(source: string, quote: string): { start: number; end: number } | null {
  const exact = source.indexOf(quote);
  if (exact !== -1) return { start: exact, end: exact + quote.length };

  // Whitespace-flexible: a wrapped line reproduced with single spaces has still
  // copied the words. Build a pattern from the quote's non-space runs.
  const words = quote.trim().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return null;

  // No `i` flag: whitespace is the only thing normalised. A model that
  // changed the case of a quote did not copy it, and a recruiter reading the
  // evidence back against the document would see the difference.
  const pattern = new RegExp(words.map(escapeRegExp).join('\\s+'));
  const match = pattern.exec(source);
  if (match === null) return null;

  return { start: match.index, end: match.index + match[0].length };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
