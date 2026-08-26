import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MASK_CHAR, redact, overlapsRedaction } from '../src/agent/redact.ts';
import { RESUME_TEXT, SENSITIVE_VALUES, EVIDENCE_PHRASES, CANDIDATE_NAME } from './fixtures.ts';

// Redaction is the fairness boundary. Two properties carry the whole design:
//
//   1. The protected values are gone.
//   2. Every offset still means the same thing in both copies.
//
// (2) is what makes evidence offsets usable at all, so it is asserted directly
// rather than inferred from extraction working.

test('the redacted copy is exactly as long as the original', () => {
  // The offset guarantee, stated as one number. If this ever fails, every
  // stored evidence offset silently starts pointing at the wrong words — and
  // the quotes would still read correctly, so nothing else would notice.
  const { redactedText } = redact(RESUME_TEXT, { knownNames: [CANDIDATE_NAME] });

  assert.equal(redactedText.length, RESUME_TEXT.length);
});

test('every protected value is present before redaction and absent after', () => {
  // The precondition half is not decoration. Without it, a fixture that
  // silently lost its sensitive lines would make this test pass by having
  // nothing to find.
  for (const value of SENSITIVE_VALUES) {
    assert.ok(RESUME_TEXT.includes(value), `fixture no longer contains ${value}`);
  }

  const { redactedText } = redact(RESUME_TEXT, { knownNames: [CANDIDATE_NAME] });

  for (const value of SENSITIVE_VALUES) {
    assert.ok(!redactedText.includes(value), `${value} survived redaction`);
  }
});

test('the labels stay, so a recruiter can see what was removed', () => {
  // Masking "Nationality: Indian" entirely would hide the fact that
  // nationality was ever asked for. The exclusion has to be visible to be
  // auditable.
  const { redactedText } = redact(RESUME_TEXT, { knownNames: [CANDIDATE_NAME] });

  for (const label of ['Nationality:', 'Gender:', 'Date of birth:', 'Address:', 'Email:']) {
    assert.ok(redactedText.includes(label), `${label} should survive`);
  }
});

test('evidence is left completely untouched', () => {
  // The failure this guards against is the opposite one: a redactor that
  // over-matches destroys the very passages the product exists to find, and
  // does it quietly.
  const { redactedText } = redact(RESUME_TEXT, { knownNames: [CANDIDATE_NAME] });

  for (const phrase of EVIDENCE_PHRASES) {
    assert.ok(redactedText.includes(phrase), `${phrase} should not have been touched`);
  }
});

test('each span indexes the same characters in both copies', () => {
  // The offset mapping, checked span by span rather than in aggregate: a
  // length-preserving redactor that masked the wrong range would still pass
  // the length assertion.
  const { redactedText, spans } = redact(RESUME_TEXT, { knownNames: [CANDIDATE_NAME] });

  assert.ok(spans.length > 0, 'the fixture should produce spans to check');

  for (const span of spans) {
    const original = RESUME_TEXT.slice(span.charStart, span.charEnd);
    const masked = redactedText.slice(span.charStart, span.charEnd);

    assert.ok(original.length > 0);
    assert.equal(masked, MASK_CHAR.repeat(original.length));
    assert.notEqual(masked, original);
  }
});

test('unmasked characters are identical, position for position', () => {
  // Everything outside a span must be byte-identical. This is the strongest
  // form of the offset guarantee: the two strings differ only where a span says
  // they differ.
  const { redactedText, spans } = redact(RESUME_TEXT, { knownNames: [CANDIDATE_NAME] });

  for (let i = 0; i < RESUME_TEXT.length; i += 1) {
    const inSpan = overlapsRedaction(spans, i, i + 1);
    if (!inSpan) {
      assert.equal(redactedText[i], RESUME_TEXT[i], `character ${i} moved`);
    }
  }
});

test('spans never overlap each other', () => {
  // "Name: Priya Raman" is claimed by both the labelled-field rule and the
  // known-name rule. Merging matters because a character masked twice would be
  // reported as two findings, and the quarantine count shown to a recruiter
  // would be wrong.
  const { spans } = redact(RESUME_TEXT, { knownNames: [CANDIDATE_NAME] });

  const sorted = [...spans].sort((a, b) => a.charStart - b.charStart);
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1] as (typeof sorted)[number];
    const current = sorted[i] as (typeof sorted)[number];
    assert.ok(current.charStart >= previous.charEnd, `spans ${i - 1} and ${i} overlap`);
  }
});

test('a name is removed everywhere it appears, not only where it is labelled', () => {
  const text = 'Name: Priya Raman\nReferences available. Ask for Priya Raman.';
  const { redactedText, spans } = redact(text, { knownNames: [CANDIDATE_NAME] });

  assert.equal(text.split(CANDIDATE_NAME).length - 1, 2, 'the fixture should contain the name twice');
  assert.ok(!redactedText.includes(CANDIDATE_NAME));
  assert.ok(spans.some((span) => span.category === 'name'));
});

test('a resume with nothing protected in it is returned unchanged', () => {
  // The negative control for over-redaction. If this ever produces spans, the
  // patterns have started matching ordinary prose.
  const clean = [
    'SUMMARY',
    'Backend engineer with six years building payment systems.',
    'Designed and shipped a Node.js settlement service.',
    'TypeScript, Docker, Kubernetes',
  ].join('\n');

  const { redactedText, spans } = redact(clean);

  assert.deepEqual(spans, []);
  assert.equal(redactedText, clean);
});

test('redacting twice gives the same answer', () => {
  // Every rule builds a fresh regex per call. A shared one with the `g` flag
  // carries `lastIndex` between documents and would skip matches on the second
  // resume it saw — which would look like a redactor that works fine until it
  // is used more than once.
  const first = redact(RESUME_TEXT, { knownNames: [CANDIDATE_NAME] });
  const second = redact(RESUME_TEXT, { knownNames: [CANDIDATE_NAME] });

  assert.equal(second.redactedText, first.redactedText);
  assert.deepEqual(second.spans, first.spans);
});

test('a one-character name is ignored rather than masking every occurrence of a letter', () => {
  const text = 'A senior engineer who ships.';
  const { redactedText, spans } = redact(text, { knownNames: ['A'] });

  assert.deepEqual(spans, []);
  assert.equal(redactedText, text);
});

test('overlapsRedaction is exclusive at the boundaries', () => {
  const spans = [{ category: 'name' as const, charStart: 10, charEnd: 20 }];

  assert.equal(overlapsRedaction(spans, 0, 10), false, 'ending where a span begins does not overlap');
  assert.equal(overlapsRedaction(spans, 20, 30), false, 'starting where a span ends does not overlap');
  assert.equal(overlapsRedaction(spans, 9, 11), true);
  assert.equal(overlapsRedaction(spans, 19, 25), true);
  assert.equal(overlapsRedaction(spans, 12, 15), true, 'a span fully inside overlaps');
});
