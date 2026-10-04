import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MASK_CHAR,
  checkSpan,
  contextFor,
  highlightEvidence,
  normaliseSpace,
  spansFromRequirements,
  type EvidenceSpan,
} from '../src/demo/evidence.ts';
import { HighlightedText } from '../src/components/EvidenceText.ts';

// Evidence in context (Phase 3C.4): which words in the redacted resume are
// verified evidence, and — as important — which are not.
//
// Everything here runs the real functions, and the rendering tests run the real
// component through `react-dom/server`, so "resume text is shown as text" is
// checked on what the component actually produces for hostile input.

const SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/src');

const TEXT = ['Name: ███████', 'Backend engineer.', 'Shipped Node.js services.', 'Used PostgreSQL at scale.'].join('\n');
const at = (needle: string): { start: number; end: number } => {
  const start = TEXT.indexOf(needle);
  assert.notEqual(start, -1, `fixture does not contain "${needle}"`);
  return { start, end: start + needle.length };
};
const span = (requirement: number, needle: string): EvidenceSpan => ({ requirement, quote: needle, ...at(needle) });

/** Segments joined back together, which must always be the input. */
const rejoin = (text: string, spans: readonly EvidenceSpan[]): string =>
  highlightEvidence(text, spans).segments.map((s) => s.text).join('');

/** Turns rendered markup back into the text a reader sees, minus what the component adds. */
function textOf(markup: string): string {
  return markup
    .replace(/<sup[^>]*>.*?<\/sup>/g, '')
    .replace(/<span class="sr-only">.*?<\/span>/g, '')
    .replace(/<\/?mark[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

const render = (text: string, spans: readonly EvidenceSpan[], names: readonly string[] = []): string =>
  renderToStaticMarkup(createElement(HighlightedText, { segments: highlightEvidence(text, spans).segments, requirementNames: names }));

// =========================================================== the mask character

test('the mask character is the one the server redacts with', () => {
  const source = fs.readFileSync(path.join(SERVER, 'agent/redact.ts'), 'utf8');
  assert.equal(/export const MASK_CHAR = '(.)'/.exec(source)?.[1], MASK_CHAR);
});

// ===================================================== what may be highlighted

test('with no evidence the resume is one plain stretch, unchanged', () => {
  const result = highlightEvidence(TEXT, []);
  assert.equal(result.segments.length, 1);
  assert.equal(result.segments[0]?.text, TEXT);
  assert.deepEqual(result.segments[0]?.requirements, []);
  assert.deepEqual(result.skipped, []);
});

test('verified evidence is highlighted exactly where it sits, and the text is never altered', () => {
  const spans = [span(1, 'Shipped Node.js services.')];
  const result = highlightEvidence(TEXT, spans);

  const marked = result.segments.filter((s) => s.requirements.length > 0);
  assert.equal(marked.length, 1);
  assert.equal(marked[0]?.text, 'Shipped Node.js services.');
  assert.deepEqual(marked[0]?.requirements, [1]);
  assert.deepEqual(marked[0]?.endsFor, [1], 'the label is drawn where the evidence ends');
  assert.equal(rejoin(TEXT, spans), TEXT);
  assert.equal(result.used.length, 1);
});

test('several spans, for different requirements, are each highlighted in order', () => {
  const spans = [span(2, 'Used PostgreSQL at scale.'), span(1, 'Shipped Node.js services.')];
  const result = highlightEvidence(TEXT, spans);

  assert.deepEqual(
    result.segments.filter((s) => s.requirements.length > 0).map((s) => [s.text, s.requirements]),
    [['Shipped Node.js services.', [1]], ['Used PostgreSQL at scale.', [2]]],
  );
  assert.equal(rejoin(TEXT, spans), TEXT);
});

test('adjacent spans touch without a gap or an overlap', () => {
  const first = at('Shipped Node.js services.');
  const second = at('\nUsed PostgreSQL');
  assert.equal(first.end, second.start, 'precondition: these two are adjacent');

  const spans: EvidenceSpan[] = [
    { requirement: 1, quote: 'Shipped Node.js services.', ...first },
    { requirement: 2, quote: 'Used PostgreSQL', start: second.start + 1, end: second.end },
  ];
  // The second starts one character in, to keep leading whitespace out of a quote.
  const result = highlightEvidence(TEXT, spans);
  assert.equal(result.skipped.length, 0);
  assert.equal(rejoin(TEXT, spans), TEXT);

  const marked = result.segments.filter((s) => s.requirements.length > 0);
  assert.equal(marked.length, 2);
  for (const s of result.segments) assert.ok(s.end > s.start, 'a stretch is empty');
  for (let i = 1; i < result.segments.length; i++) {
    assert.equal(result.segments[i]?.start, result.segments[i - 1]?.end, 'stretches must meet exactly');
  }
});

test('truly adjacent spans (end of one is the start of the next) are two stretches, each labelled', () => {
  const text = 'alpha beta';
  const spans: EvidenceSpan[] = [
    { requirement: 1, quote: 'alpha', start: 0, end: 5 },
    { requirement: 2, quote: ' beta', start: 5, end: 10 },
  ];
  const result = highlightEvidence(text, spans);
  assert.deepEqual(result.segments.map((s) => [s.text, s.requirements, s.endsFor]), [['alpha', [1], [1]], [' beta', [2], [2]]]);
});

test('overlapping spans share the stretch they have in common, and each keeps its own label', () => {
  const text = 'abcdefghijklmno';
  const spans: EvidenceSpan[] = [
    { requirement: 1, quote: 'abcdefghij', start: 0, end: 10 },
    { requirement: 2, quote: 'fghijklmno', start: 5, end: 15 },
  ];
  const result = highlightEvidence(text, spans);

  assert.deepEqual(
    result.segments.map((s) => [s.text, s.requirements, s.endsFor]),
    [['abcde', [1], []], ['fghij', [1, 2], [1]], ['klmno', [2], [2]]],
  );
  assert.equal(rejoin(text, spans), text);
});

test('nested and identical spans are handled: one stretch, every requirement counted once', () => {
  const text = 'abcdefghij';
  const nested = highlightEvidence(text, [
    { requirement: 1, quote: 'abcdefghij', start: 0, end: 10 },
    { requirement: 2, quote: 'cde', start: 2, end: 5 },
  ]);
  assert.deepEqual(nested.segments.map((s) => [s.text, s.requirements]), [['ab', [1]], ['cde', [1, 2]], ['fghij', [1]]]);

  const same = highlightEvidence(text, [
    { requirement: 2, quote: 'cde', start: 2, end: 5 },
    { requirement: 1, quote: 'cde', start: 2, end: 5 },
    { requirement: 1, quote: 'cde', start: 2, end: 5 },
  ]);
  const cde = same.segments.find((s) => s.text === 'cde');
  assert.deepEqual(cde?.requirements, [1, 2]);
  assert.deepEqual(cde?.endsFor, [1, 2]);
});

// ============================================================ offset bounds

test('an offset outside the stored text can never cause anything outside it to be drawn', () => {
  const cases: Array<[string, number, number, string]> = [
    ['negative start', -5, 10, 'out_of_bounds'],
    ['end past the end', 0, TEXT.length + 1, 'out_of_bounds'],
    ['end far past the end', 5, 10 ** 9, 'out_of_bounds'],
    ['start after end', 20, 10, 'out_of_bounds'],
    ['start past the end', TEXT.length + 5, TEXT.length + 9, 'out_of_bounds'],
    ['empty range', 7, 7, 'empty'],
    ['fractional', 1.5, 9, 'not_a_range'],
    ['NaN', Number.NaN, 9, 'not_a_range'],
    ['Infinity', 0, Number.POSITIVE_INFINITY, 'not_a_range'],
  ];

  for (const [label, start, end, reason] of cases) {
    const bad: EvidenceSpan = { requirement: 1, quote: 'whatever', start, end };
    assert.equal(checkSpan(TEXT, bad), reason, label);

    const result = highlightEvidence(TEXT, [bad]);
    assert.equal(result.used.length, 0, label);
    assert.equal(result.skipped[0]?.reason, reason, label);
    assert.equal(result.segments.map((s) => s.text).join(''), TEXT, `${label}: the text changed`);
    assert.ok(result.segments.every((s) => s.start >= 0 && s.end <= TEXT.length), `${label}: a stretch left the text`);
    assert.ok(result.segments.every((s) => s.requirements.length === 0), `${label}: something was highlighted`);
  }
});

test('non-numeric offsets, as a hostile or broken server might send them, are refused without throwing', () => {
  for (const [start, end] of [['0', '5'], [null, 5], [undefined, undefined], [{}, []], [true, false]]) {
    const bad = { requirement: 1, quote: 'x', start, end } as unknown as EvidenceSpan;
    assert.doesNotThrow(() => highlightEvidence(TEXT, [bad]));
    assert.equal(highlightEvidence(TEXT, [bad]).used.length, 0);
  }
});

// ========================================= only what verification would accept

test('a passage that is not at its recorded position is not highlighted — it is reported instead', () => {
  // A fabricated quote with perfectly plausible offsets: this is what rejected
  // evidence would look like if it ever reached the screen.
  const fabricated: EvidenceSpan = { requirement: 1, quote: 'Led a team of fifty engineers', ...at('Shipped Node.js services.') };
  const result = highlightEvidence(TEXT, [fabricated]);

  assert.equal(result.used.length, 0);
  assert.deepEqual(result.skipped.map((s) => s.reason), ['text_differs']);
  assert.ok(result.segments.every((s) => s.requirements.length === 0));
  assert.equal(result.segments.map((s) => s.text).join(''), TEXT);
});

test('a span that touches a masked character is refused, however well its quote matches', () => {
  const masked: EvidenceSpan = { requirement: 1, quote: 'Name: ███████', start: 0, end: 13 };
  assert.equal(checkSpan(TEXT, masked), 'touches_mask');

  // Even a single masked character inside a longer span.
  const partly: EvidenceSpan = { requirement: 1, quote: 'ame: ███', start: 1, end: 9 };
  assert.equal(checkSpan(TEXT, partly), 'touches_mask');
});

test('whitespace is the one difference tolerated, as it is by the verifier', () => {
  const text = 'Designed and\nshipped  production services.';
  const accepted: EvidenceSpan = { requirement: 1, quote: 'Designed and shipped production services.', start: 0, end: text.length };
  assert.equal(checkSpan(text, accepted), null);
  assert.equal(normaliseSpace('a \n\t b'), 'a b');

  // Case and wording are not.
  assert.equal(checkSpan(text, { ...accepted, quote: 'designed and shipped production services.' }), 'text_differs');
  assert.equal(checkSpan(text, { ...accepted, quote: 'Designed and shipped production service.' }), 'text_differs');
});

test('whitespace alone is not evidence', () => {
  const text = 'one   two';
  assert.equal(checkSpan(text, { requirement: 1, quote: '   ', start: 3, end: 6 }), 'empty');
  assert.equal(checkSpan(text, { requirement: 1, quote: '', start: 3, end: 6 }), 'empty');
});

test('one bad span does not stop the good ones', () => {
  const good = span(1, 'Shipped Node.js services.');
  const bad: EvidenceSpan = { requirement: 2, quote: 'nothing like it', start: 0, end: 4 };
  const result = highlightEvidence(TEXT, [bad, good]);

  assert.equal(result.used.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.segments.filter((s) => s.requirements.length > 0).length, 1);
  assert.equal(rejoin(TEXT, [bad, good]), TEXT);
});

test('the text is preserved exactly for awkward input: empty, unicode, line breaks, surrogate pairs', () => {
  for (const text of ['', ' ', '\n\n', 'naïve café — “quotes” ✓', 'emoji 👩‍💻 here', 'a\r\nb', 'x'.repeat(5000)]) {
    assert.equal(rejoin(text, []), text === '' ? '' : text);
    const whole: EvidenceSpan[] = text.trim() === '' ? [] : [{ requirement: 1, quote: text, start: 0, end: text.length }];
    assert.equal(rejoin(text, whole), text);
  }
});

// ================================================================ the real component

test('markup inside a resume is rendered as text, and nothing in it is live', () => {
  const hostile = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(2)">',
    '"><svg onload=alert(3)>',
    '<a href="javascript:alert(4)">click</a>',
    '&lt;already escaped&gt; & ampersand',
  ].join('\n');
  const evidence = '<img src=x onerror="alert(2)">';
  const start = hostile.indexOf(evidence);
  const spans: EvidenceSpan[] = [{ requirement: 1, quote: evidence, start, end: start + evidence.length }];

  const markup = render(hostile, spans, ['Node.js']);

  // Nothing the resume contained became an element or an attribute.
  for (const live of ['<script', '<img', '<svg', '<a ']) {
    assert.ok(!markup.includes(live), `the rendered output contains live markup: ${live}`);
  }
  // `onerror=` DOES appear — as escaped text, inside the characters of the resume.
  // What must not exist is an element carrying it: every attribute on every element
  // the component made is one it chose.
  const attributes = [...markup.matchAll(/<(?:mark|span|sup)([^>]*)>/g)].flatMap((tag) =>
    [...(tag[1] ?? '').matchAll(/\s([a-zA-Z-]+)=/g)].map((attr) => attr[1]),
  );
  assert.ok(attributes.length > 0, 'precondition: the scan found the component\'s own attributes');
  for (const attribute of attributes) {
    assert.ok(['class', 'title', 'aria-hidden'].includes(attribute ?? ''), `an unexpected attribute: ${attribute}`);
  }
  // It is there as characters, escaped.
  assert.ok(markup.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(markup.includes('&lt;img src=x onerror=&quot;alert(2)&quot;&gt;'));
  assert.ok(markup.includes('&amp;lt;already escaped&amp;gt; &amp; ampersand'), 'existing entities must be shown, not decoded');

  // The only elements are the ones the component makes.
  const tags = [...markup.matchAll(/<(\/?)([a-z0-9]+)/g)].map((m) => m[2]);
  assert.deepEqual([...new Set(tags)].sort(), ['mark', 'span', 'sup']);

  // And what a reader sees is the resume, exactly.
  assert.equal(textOf(markup), hostile);
});

test('the rendered text equals the stored text for the real shape of a resume', () => {
  const spans = [span(1, 'Shipped Node.js services.'), span(2, 'Used PostgreSQL at scale.')];
  const markup = render(TEXT, spans, ['Node.js', 'PostgreSQL']);
  assert.equal(textOf(markup), TEXT);
  assert.equal(render(TEXT, [], []), TEXT.replace(/&/g, '&amp;'), 'with no evidence the output is the escaped text and nothing more');
});

test('a highlighted stretch is underlined and numbered in words, not only tinted', () => {
  const markup = render(TEXT, [span(2, 'Used PostgreSQL at scale.')], ['Node.js', 'PostgreSQL']);

  assert.match(markup, /<mark[^>]*class="[^"]*underline[^"]*"/);
  assert.match(markup, /<sup[^>]*aria-hidden="true"[^>]*>2<\/sup>/, 'the visible number');
  assert.match(markup, /sr-only">\s*\(verified evidence for PostgreSQL\)/, 'the same thing for assistive technology');
  assert.match(markup, /title="Verified evidence for PostgreSQL"/);
});

test('overlapping evidence names every requirement it supports', () => {
  const text = 'abcdefghijklmno';
  const markup = render(
    text,
    [{ requirement: 1, quote: 'abcdefghij', start: 0, end: 10 }, { requirement: 2, quote: 'fghijklmno', start: 5, end: 15 }],
    ['First', 'Second'],
  );
  assert.match(markup, /verified evidence for First, Second/);
  assert.equal(textOf(markup), text);
});

test('a requirement name that is itself markup is escaped too', () => {
  const markup = render('hello world', [{ requirement: 1, quote: 'hello', start: 0, end: 5 }], ['<img src=x onerror=alert(1)>']);
  assert.ok(!markup.includes('<img'));
  assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('no HTML-injection API is used anywhere in the front end', () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : /\.tsx?$/.test(entry.name) ? [full] : [];
    });
  const files = walk(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src'));
  assert.ok(files.length > 20, 'the scan found too few files — it would be vacuous');

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write\b|\beval\s*\(|new Function\s*\(/, `${path.basename(file)} can inject markup`);
  }
});

// ============================================================== context and numbering

test('requirements are numbered by their position, and only verified evidence becomes a span', () => {
  const spans = spansFromRequirements([
    { evidence: [{ quote: 'a', charStart: 0, charEnd: 1 }] },
    { evidence: [] },
    { evidence: [{ quote: 'b', charStart: 2, charEnd: 3 }, { quote: 'c', charStart: 4, charEnd: 5 }] },
  ]);
  assert.deepEqual(spans.map((s) => [s.requirement, s.quote, s.start, s.end]), [[1, 'a', 0, 1], [3, 'b', 2, 3], [3, 'c', 4, 5]]);
});

test('the context for a requirement is the line its evidence sits on, with that evidence highlighted', () => {
  const spans = [span(1, 'Node.js'), span(2, 'PostgreSQL')];
  const { blocks, more } = contextFor(TEXT, spans, 1);

  assert.equal(more, 0);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.segments.map((s) => s.text).join(''), 'Shipped Node.js services.');
  assert.deepEqual(blocks[0]?.segments.filter((s) => s.requirements.length > 0).map((s) => s.text), ['Node.js']);
  // Another requirement's evidence is not in this requirement's context.
  assert.ok(!blocks[0]?.segments.some((s) => s.text.includes('PostgreSQL')));
});

test('context handles evidence on the first line, on the last line, and across a line break', () => {
  const text = 'first line has Node.js\nmiddle\nlast line has PostgreSQL';
  const first = contextFor(text, [{ requirement: 1, quote: 'Node.js', start: 15, end: 22 }], 1);
  assert.equal(first.blocks[0]?.segments.map((s) => s.text).join(''), 'first line has Node.js');

  const lastStart = text.indexOf('PostgreSQL');
  const last = contextFor(text, [{ requirement: 1, quote: 'PostgreSQL', start: lastStart, end: lastStart + 10 }], 1);
  assert.equal(last.blocks[0]?.segments.map((s) => s.text).join(''), 'last line has PostgreSQL');

  // A span starting at offset 0 must not be confused by the search for a previous break.
  const zero = contextFor('Node.js here\nnext', [{ requirement: 1, quote: 'Node.js', start: 0, end: 7 }], 1);
  assert.equal(zero.blocks[0]?.segments.map((s) => s.text).join(''), 'Node.js here');

  const across = 'one two\nthree four';
  const crossing = contextFor(across, [{ requirement: 1, quote: 'two three', start: 4, end: 13 }], 1);
  assert.equal(crossing.blocks.length, 1);
  assert.equal(crossing.blocks[0]?.segments.map((s) => s.text).join(''), across, 'a span is never cut in half');
});

test('context is capped, and says how many lines it left out', () => {
  const text = ['x Node.js 1', 'x Node.js 2', 'x Node.js 3', 'x Node.js 4', 'x Node.js 5'].join('\n');
  const spans = [...text.matchAll(/Node\.js/g)].map((m): EvidenceSpan => ({ requirement: 1, quote: 'Node.js', start: m.index ?? 0, end: (m.index ?? 0) + 7 }));
  const capped = contextFor(text, spans, 1);
  assert.equal(capped.blocks.length, 3);
  assert.equal(capped.more, 2);
  assert.equal(contextFor(text, spans, 1, 10).more, 0);
});

test('context never shows a span the full view would refuse', () => {
  const bad: EvidenceSpan = { requirement: 1, quote: 'fabricated', ...at('Shipped Node.js services.') };
  assert.deepEqual(contextFor(TEXT, [bad], 1), { blocks: [], more: 0 });
  assert.deepEqual(contextFor(TEXT, [span(1, 'Node.js')], 2), { blocks: [], more: 0 }, 'a requirement with no evidence has no context');
});
