// Evidence in context: where in the redacted resume each verified quote sits.
//
// A pure module with no React and no DOM, so the rules that decide what may be
// highlighted — and what may not — are tested as functions, over the real
// pipeline's output as well as over hostile input.
//
// WHAT THE OFFSETS MEAN, AND WHY THIS IS SOUND
//
// The server verifies every quote against the ORIGINAL resume and stores where it
// found it. Redaction replaces each protected span with a mask of exactly the
// same length, so the redacted text and the original share every offset, and the
// verifier refuses any quote that overlaps a mask. A verified span therefore
// indexes the redacted text exactly, and never lands on a masked character.
//
// WHY IT CHECKS ANYWAY
//
// The browser is shown offsets by a server, and "the server will have got them
// right" is the sort of assumption this product exists to avoid making about
// anyone else. So nothing is highlighted on the strength of an offset alone: a
// span must be a whole, in-bounds range; the text at that range must be the quote
// (whitespace-normalised, because that is the one thing the verifier is allowed
// to forgive); and it must not touch a mask. A span that fails any of these is
// NOT drawn, and is reported as skipped with its reason, so the screen can say so
// instead of silently dropping it or — worse — highlighting the wrong words.
//
// WHAT IT NEVER DOES
//
// It never changes the text. The segments it returns concatenate back to the
// input exactly, character for character, and the screen renders them as text
// nodes. Highlighting is a matter of where to put boundaries, not of rewriting.

/** The character the server's redaction masks with. A test pins it to `agent/redact.ts`. */
export const MASK_CHAR = '█';

/** One verified quote, as the evaluation reports it, tied to the requirement it supports. */
export type EvidenceSpan = {
  /** 1-based position of the requirement it supports, in the order the role lists them. */
  requirement: number;
  start: number;
  end: number;
  quote: string;
};

export type SkipReason = 'not_a_range' | 'out_of_bounds' | 'empty' | 'text_differs' | 'touches_mask';

export type SkippedSpan = { span: EvidenceSpan; reason: SkipReason };

export type Segment = {
  text: string;
  start: number;
  end: number;
  /** Requirements whose evidence covers this stretch, ascending. Empty for plain text. */
  requirements: number[];
  /** Requirements whose evidence ENDS at the end of this stretch — where its label is drawn. */
  endsFor: number[];
};

export type Highlighted = {
  /** Concatenates back to the input, exactly. */
  segments: Segment[];
  /** The spans that were drawn. */
  used: EvidenceSpan[];
  /** The spans that were not, and why. */
  skipped: SkippedSpan[];
};

/** Collapses every run of whitespace to one space, for comparison only. */
export function normaliseSpace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Whether a span may be drawn on this text, and if not, why not. */
export function checkSpan(text: string, span: EvidenceSpan): SkipReason | null {
  const { start, end } = span;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return 'not_a_range';
  if (start < 0 || end > text.length || start > end) return 'out_of_bounds';
  if (start === end) return 'empty';

  const covered = text.slice(start, end);
  if (covered.includes(MASK_CHAR)) return 'touches_mask';
  // Whitespace alone is not evidence, and would compare equal to any other whitespace.
  if (normaliseSpace(span.quote) === '' || normaliseSpace(covered) === '') return 'empty';
  if (normaliseSpace(covered) !== normaliseSpace(span.quote)) return 'text_differs';
  return null;
}

/**
 * Splits `text` into plain and highlighted stretches.
 *
 * Boundaries are the start and end of every span that passed `checkSpan`, so
 * overlapping spans produce a stretch that carries both requirements, adjacent
 * spans produce two stretches that touch, and a span nested in another is simply
 * a stretch inside it. There is no merging that could swallow a character, and
 * no stretch is ever empty.
 */
export function highlightEvidence(text: string, spans: readonly EvidenceSpan[]): Highlighted {
  const used: EvidenceSpan[] = [];
  const skipped: SkippedSpan[] = [];

  for (const span of spans) {
    const reason = checkSpan(text, span);
    if (reason === null) used.push(span);
    else skipped.push({ span, reason });
  }

  const cuts = new Set<number>([0, text.length]);
  for (const span of used) {
    cuts.add(span.start);
    cuts.add(span.end);
  }
  const points = [...cuts].sort((a, b) => a - b);

  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i] as number;
    const end = points[i + 1] as number;
    if (end <= start) continue;

    const covering = used.filter((span) => span.start <= start && span.end >= end);
    const requirements = [...new Set(covering.map((span) => span.requirement))].sort((a, b) => a - b);
    const endsFor = [...new Set(covering.filter((span) => span.end === end).map((span) => span.requirement))].sort(
      (a, b) => a - b,
    );

    segments.push({ text: text.slice(start, end), start, end, requirements, endsFor });
  }

  return { segments, used, skipped };
}

export type ContextBlock = {
  /** The whole line the evidence sits on, as it is in the redacted text. */
  segments: Segment[];
  /** 1-based requirement numbers highlighted in it. */
  requirements: number[];
};

/**
 * The lines of the resume around one requirement's evidence.
 *
 * "Relevant CV context" is the line each verified quote sits on, with the quote
 * highlighted inside it — the same boundaries as the full view, just narrowed.
 * It reuses `highlightEvidence` on the line, so it inherits every check above and
 * cannot show a span the full view would refuse. At most `limit` lines are
 * returned; `more` says how many were left out.
 */
export function contextFor(
  text: string,
  spans: readonly EvidenceSpan[],
  requirement: number,
  limit = 3,
): { blocks: ContextBlock[]; more: number } {
  const own = spans.filter((span) => span.requirement === requirement);
  const lines = new Map<number, { start: number; end: number; spans: EvidenceSpan[] }>();

  for (const span of own) {
    if (checkSpan(text, span) !== null) continue;

    const lineStart = span.start === 0 ? 0 : text.lastIndexOf('\n', span.start - 1) + 1;
    const next = text.indexOf('\n', span.end);
    const lineEnd = next === -1 ? text.length : next;

    // A span that crosses a line break belongs to the line it starts on, and
    // widens that line to hold it, so it is never cut in half.
    const entry = lines.get(lineStart) ?? { start: lineStart, end: lineEnd, spans: [] };
    entry.end = Math.max(entry.end, lineEnd);
    entry.spans.push(span);
    lines.set(lineStart, entry);
  }

  const ordered = [...lines.values()].sort((a, b) => a.start - b.start);
  const blocks: ContextBlock[] = ordered.slice(0, limit).map((line) => {
    const shifted = line.spans.map((span) => ({ ...span, start: span.start - line.start, end: span.end - line.start }));
    return { segments: highlightEvidence(text.slice(line.start, line.end), shifted).segments, requirements: [requirement] };
  });

  return { blocks, more: Math.max(0, ordered.length - limit) };
}

/** The evaluation's verified evidence, numbered by the requirement it supports. */
export function spansFromRequirements(
  requirements: ReadonlyArray<{ evidence: ReadonlyArray<{ quote: string; charStart: number; charEnd: number }> }>,
): EvidenceSpan[] {
  return requirements.flatMap((requirement, index) =>
    requirement.evidence.map((item) => ({
      requirement: index + 1,
      start: item.charStart,
      end: item.charEnd,
      quote: item.quote,
    })),
  );
}
