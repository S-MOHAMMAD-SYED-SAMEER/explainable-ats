import type { SensitiveCategory } from '../domain/ats.ts';

// Redaction — the fairness boundary, made structural.
//
// This runs BEFORE the model sees anything. The model is handed
// `redacted_text` and never the original, so a protected attribute cannot
// influence an extraction: it is not in the input. That is a stronger guarantee
// than instructing a model to ignore something, because it does not depend on
// the model complying.
//
// THE MASK IS THE SAME LENGTH AS WHAT IT REPLACES, AND THAT IS THE WHOLE TRICK
//
// Every span is replaced by a run of block characters of exactly equal length,
// so `redacted_text` and `content_text` have identical character offsets. An
// offset the model produces against the redacted text therefore indexes the
// original directly, with no mapping table to build and no off-by-one to get
// wrong. Shortening the text — replacing a name with "[NAME]" — would shift
// every offset after it, and the resulting evidence would quote the right words
// from the wrong place.
//
// WHAT THIS IS NOT
//
// It is not a PII scrubber for real applicant data. It is a demonstrable
// boundary over a synthetic dataset: conservative patterns, labelled fields,
// and names supplied by the caller. Over-redaction destroys the evidence the
// product exists to find, so a pattern that is merely plausible does not earn
// a place here.

export const MASK_CHAR = '█';

export type RedactionSpan = {
  category: SensitiveCategory;
  charStart: number;
  charEnd: number;
};

export type RedactionResult = {
  redactedText: string;
  spans: RedactionSpan[];
};

type Rule = {
  category: SensitiveCategory;
  pattern: RegExp;
  /**
   * Which capture group to mask. Group 0 masks the whole match.
   *
   * Labelled fields mask only the value: "Date of birth: 4 March 1990" keeps
   * the label, because a recruiter should see WHAT was removed. Masking the
   * label too would hide the fact that a date of birth was ever there.
   */
  group?: number;
};

const RULES: Rule[] = [
  // Contact details. Distinctive enough to match safely.
  { category: 'contact', pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g },
  { category: 'contact', pattern: /\+?\d[\d\s()-]{8,}\d/g },

  // Labelled fields: mask the value, keep the label.
  { category: 'age', pattern: /\b(?:date of birth|d\.o\.b\.?|born)\s*:?\s*([^\n,]{4,24})/gi, group: 1 },
  { category: 'age', pattern: /\bage[d]?\s*:?\s*(\d{1,2})\b/gi, group: 1 },
  { category: 'nationality', pattern: /\bnationality\s*:?\s*([^\n,]{2,24})/gi, group: 1 },
  { category: 'marital_status', pattern: /\bmarital status\s*:?\s*([^\n,]{2,20})/gi, group: 1 },
  { category: 'gender', pattern: /\bgender\s*:?\s*([^\n,]{2,20})/gi, group: 1 },
  { category: 'address', pattern: /\baddress\s*:?\s*([^\n]{4,80})/gi, group: 1 },
  { category: 'photo', pattern: /\b(?:photo|photograph)\s*:?\s*([^\n]{2,60})/gi, group: 1 },
  { category: 'religion', pattern: /\breligion\s*:?\s*([^\n,]{2,24})/gi, group: 1 },
  { category: 'name', pattern: /\bname\s*:\s*([^\n,]{2,60})/gi, group: 1 },
];

export type RedactOptions = {
  /**
   * Names to remove wherever they appear.
   *
   * Supplied by the caller rather than guessed. General name detection over
   * free text is unreliable in both directions, and a false positive here
   * deletes the evidence the product exists to find — "Java" is a name in some
   * countries, and a scrubber that decides so has broken the product to protect
   * a value that was not private.
   */
  knownNames?: readonly string[];
};

/** Escapes a string for safe use inside a regular expression. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Merges overlapping spans, so a character is never masked twice. */
function merge(spans: RedactionSpan[]): RedactionSpan[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.charStart - b.charStart || a.charEnd - b.charEnd);

  const merged: RedactionSpan[] = [sorted[0] as RedactionSpan];
  for (const span of sorted.slice(1)) {
    const last = merged[merged.length - 1] as RedactionSpan;
    if (span.charStart <= last.charEnd) {
      // Overlapping. Keep the earlier category — the first rule to claim a
      // character is the one that explains it.
      last.charEnd = Math.max(last.charEnd, span.charEnd);
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

/**
 * Finds protected attributes and masks them in place.
 *
 * Returns the masked text and the spans that were masked. The spans are what
 * `sensitive_findings` records — a category and a location, never a value.
 */
export function redact(text: string, options: RedactOptions = {}): RedactionResult {
  const found: RedactionSpan[] = [];

  for (const rule of RULES) {
    // Fresh regex per call: a `g` flag carries `lastIndex` between uses, and a
    // shared one would skip matches on the second document it saw.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
      const group = rule.group ?? 0;
      const value = match[group];
      if (value === undefined || value.length === 0) continue;

      const start = group === 0 ? match.index : match.index + match[0].indexOf(value);
      found.push({ category: rule.category, charStart: start, charEnd: start + value.length });

      // A zero-length match would loop forever.
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }

  for (const name of options.knownNames ?? []) {
    const trimmed = name.trim();
    if (trimmed.length < 2) continue;
    const pattern = new RegExp(escapeRegExp(trimmed), 'gi');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      found.push({ category: 'name', charStart: match.index, charEnd: match.index + match[0].length });
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }

  const spans = merge(found);

  // Masked in place, character for character, so offsets are preserved.
  let redactedText = text;
  for (const span of spans) {
    const width = span.charEnd - span.charStart;
    redactedText = redactedText.slice(0, span.charStart) + MASK_CHAR.repeat(width) + redactedText.slice(span.charEnd);
  }

  return { redactedText, spans };
}

/** True when a span touches any masked region. */
export function overlapsRedaction(
  spans: readonly RedactionSpan[],
  charStart: number,
  charEnd: number,
): boolean {
  return spans.some((span) => charStart < span.charEnd && charEnd > span.charStart);
}
