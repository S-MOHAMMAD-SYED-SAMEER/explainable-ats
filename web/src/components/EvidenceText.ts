import { createElement, Fragment, type ReactElement } from 'react';
import type { Segment } from '../demo/evidence.ts';

// Draws resume text with its verified evidence highlighted.
//
// THIS FILE IS DELIBERATELY NOT TSX
//
// It is the one place resume text — content that came from outside, and may
// contain anything a person can type — is turned into page elements. Written with
// `createElement` in a plain `.ts` file, it can be rendered to a string by Node's
// own test runner (`react-dom/server`, no browser and no transform), which means
// the claim "markup in a resume is shown as text, never run" is tested by
// rendering hostile text through the real component rather than by reading its
// source and hoping. The rest of the front end is TSX; this file is small enough
// that the difference costs nothing.
//
// HOW TEXT STAYS TEXT
//
// Every segment's text is passed to React as a string child. React escapes string
// children when it renders them, so `<script>` in a resume reaches the page as the
// characters `<script>`. There is no `dangerouslySetInnerHTML` here or anywhere in
// the front end, and nothing is concatenated into markup. The text is never
// changed: the segments it is given concatenate back to the resume exactly, and
// each is rendered whole.
//
// NO MEANING DEPENDS ON COLOUR
//
// A highlighted stretch is underlined as well as tinted, and carries the number
// of the requirement it supports as visible text after it. Assistive technology
// is told the same thing in words.

const MARK_CLASS =
  'rounded-sm bg-brand-tint px-0.5 text-ink underline decoration-brand decoration-2 underline-offset-2';

export type HighlightedTextProps = {
  segments: readonly Segment[];
  /** Requirement names, indexed from 0, for the words assistive technology hears. */
  requirementNames: readonly string[];
};

function nameFor(names: readonly string[], requirement: number): string {
  return names[requirement - 1] ?? `requirement ${requirement}`;
}

export function HighlightedText({ segments, requirementNames }: HighlightedTextProps): ReactElement {
  const children = segments.map((segment, index) => {
    if (segment.requirements.length === 0) {
      return createElement(Fragment, { key: index }, segment.text);
    }

    const supports = segment.requirements.map((n) => nameFor(requirementNames, n)).join(', ');
    const parts = [
      segment.text,
      // The number, as visible text, only where a piece of evidence ends.
      ...(segment.endsFor.length > 0
        ? [
            createElement(
              'sup',
              { key: 'label', 'aria-hidden': 'true', className: 'ml-0.5 text-meta font-semibold text-brand' },
              segment.endsFor.join(','),
            ),
          ]
        : []),
      createElement('span', { key: 'sr', className: 'sr-only' }, ` (verified evidence for ${supports})`),
    ];

    return createElement(
      'mark',
      { key: index, className: MARK_CLASS, title: `Verified evidence for ${supports}` },
      ...parts,
    );
  });

  return createElement(Fragment, null, ...children);
}
