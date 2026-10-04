// A small reader for JSX source, for the tests that scan components.
//
// NFR-9 rules out rendering components in tests, so structural conventions —
// every button typed, every control focusable with a visible ring — are checked
// by reading the source. These helpers are what make that reading reliable.

/**
 * The opening tags of one element, in full.
 *
 * Scans to the `>` that closes the tag, skipping any `>` inside a `{...}`
 * expression or a quoted string. An `onClick={() => ...}` contains one, which is
 * what defeated the first version of this check: it stopped at the arrow and saw
 * a button with no focus ring in it, failing for the wrong reason.
 */
export function openingTags(source: string, tag: string): string[] {
  const tags: string[] = [];
  const start = new RegExp(`<${tag}(?=[\\s>])`, 'g');
  for (let m = start.exec(source); m; m = start.exec(source)) {
    let depth = 0;
    let quote: string | null = null;
    let i = m.index + 1;
    for (; i < source.length; i++) {
      const ch = source[i] as string;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (depth === 0 && (ch === '"' || ch === "'")) quote = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '>' && depth === 0) break;
    }
    tags.push(source.slice(m.index, i + 1));
  }
  return tags;
}

/** Strips comments, so a scan matches code rather than the note explaining it. */
export function stripComments(source: string): string {
  return source.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}
