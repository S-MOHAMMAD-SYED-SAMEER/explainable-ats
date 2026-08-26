import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyEvidence } from '../src/agent/verifyEvidence.ts';
import { redact } from '../src/agent/redact.ts';
import { RESUME_TEXT, CANDIDATE_NAME } from './fixtures.ts';
import type { RawFinding } from '../src/agent/extractionSchema.ts';

// Verification is the control that makes a fabricated citation impossible to
// display or score. A model asked to quote will occasionally produce a quote
// that reads perfectly and does not exist; nothing about the text betrays it,
// so the only defence is to go and look.

const QUOTE = 'Designed and shipped a Node.js settlement service handling 40,000 transactions a day.';

function findingFor(quote: string, charStart: number, charEnd = charStart + quote.length): RawFinding {
  return { requirementId: 'req-1', quote, charStart, charEnd, reasoning: 'because' };
}

function spansFor(text: string) {
  return redact(text, { knownNames: [CANDIDATE_NAME] }).spans;
}

test('a quote that sits exactly where the model said is verified as-is', () => {
  const at = RESUME_TEXT.indexOf(QUOTE);
  assert.notEqual(at, -1, 'the fixture must still contain the quote');

  const result = verifyEvidence([findingFor(QUOTE, at)], {
    contentText: RESUME_TEXT,
    redactionSpans: spansFor(RESUME_TEXT),
  });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.verified.length, 1);
  assert.equal(result.verified[0]?.offsetsWereCorrect, true);
  assert.equal(result.verified[0]?.charStart, at);
  assert.equal(RESUME_TEXT.slice(result.verified[0]!.charStart, result.verified[0]!.charEnd), QUOTE);
});

test('a real quote with wrong offsets is kept, and the offsets are corrected', () => {
  // Models are unreliable at counting characters and reliable at copying
  // words, so the quote is the claim and the offsets are only a hint.
  // Rejecting here would throw away true evidence over a clerical error.
  const truth = RESUME_TEXT.indexOf(QUOTE);
  const wrong = truth + 17;

  // Precondition: the hinted span really does NOT contain the quote, so the
  // test cannot pass by the hint accidentally being right.
  assert.notEqual(RESUME_TEXT.slice(wrong, wrong + QUOTE.length), QUOTE);

  const result = verifyEvidence([findingFor(QUOTE, wrong)], {
    contentText: RESUME_TEXT,
    redactionSpans: spansFor(RESUME_TEXT),
  });

  assert.equal(result.rejected.length, 0);
  assert.equal(result.verified[0]?.offsetsWereCorrect, false);
  assert.equal(result.verified[0]?.charStart, truth);
  assert.equal(RESUME_TEXT.slice(result.verified[0]!.charStart, result.verified[0]!.charEnd), QUOTE);
});

test('a fabricated quote is rejected', () => {
  // The headline case. This sentence is plausible, well written, and nowhere
  // in the document.
  const invented = 'Led a team of twelve engineers across three continents.';
  assert.ok(!RESUME_TEXT.includes(invented), 'the fixture must not contain the invented sentence');

  const result = verifyEvidence([findingFor(invented, 100)], {
    contentText: RESUME_TEXT,
    redactionSpans: spansFor(RESUME_TEXT),
  });

  assert.equal(result.verified.length, 0);
  assert.equal(result.rejected[0]?.reason, 'not_found_in_resume');
});

test('a quote that is almost right is still rejected', () => {
  // "Node.js settlement service" exists; "Node.js billing service" does not.
  // A near-miss is the shape a real hallucination takes, and a verifier that
  // matched loosely would wave it through.
  const nearMiss = 'Designed and shipped a Node.js billing service';
  assert.ok(!RESUME_TEXT.includes(nearMiss));

  const result = verifyEvidence([findingFor(nearMiss, 0)], {
    contentText: RESUME_TEXT,
    redactionSpans: spansFor(RESUME_TEXT),
  });

  assert.equal(result.rejected[0]?.reason, 'not_found_in_resume');
});

test('a quote wrapped across lines is verified, and the stored span points at the original', () => {
  // A model that reproduced a wrapped line with single spaces copied the
  // words, and the words are the claim. But the recorded offsets must index
  // the real document, not the normalised copy — otherwise highlighting the
  // evidence in the UI would point at the wrong place.
  const source = 'SUMMARY\nBackend engineer with six\nyears building payment systems.\n';
  const flattened = 'Backend engineer with six years building payment systems.';
  assert.ok(!source.includes(flattened), 'the source must genuinely be wrapped');

  const result = verifyEvidence([findingFor(flattened, 0)], { contentText: source, redactionSpans: [] });

  assert.equal(result.rejected.length, 0);
  const span = result.verified[0]!;
  assert.equal(
    source.slice(span.charStart, span.charEnd),
    'Backend engineer with six\nyears building payment systems.',
  );
});

test('a quote whose case was changed is rejected', () => {
  // Whitespace is the only thing normalised. Changing the case is not copying,
  // and a recruiter reading the evidence back against the document would see
  // the difference.
  const lowered = QUOTE.toLowerCase();
  assert.notEqual(lowered, QUOTE);

  const result = verifyEvidence([findingFor(lowered, 0)], {
    contentText: RESUME_TEXT,
    redactionSpans: spansFor(RESUME_TEXT),
  });

  assert.equal(result.rejected[0]?.reason, 'not_found_in_resume');
});

test('a quote overlapping a masked attribute is refused even though it is genuinely in the resume', () => {
  // This is the interesting one. The email IS in `content_text`, so a
  // find-it-in-the-document check alone would pass it. But the model was never
  // shown it, so producing it means either a guess or a leak — and either way
  // it must not become evidence.
  const email = 'priya.raman@example.com';
  const at = RESUME_TEXT.indexOf(email);
  assert.notEqual(at, -1, 'the fixture must contain the email in the original text');

  const spans = spansFor(RESUME_TEXT);
  const result = verifyEvidence([findingFor(email, at)], { contentText: RESUME_TEXT, redactionSpans: spans });

  assert.equal(result.verified.length, 0);
  assert.equal(result.rejected[0]?.reason, 'quotes_redacted_text');

  // Negative control: with no redaction spans declared, the very same finding
  // verifies. So the rejection above is caused by the span, not by the quote.
  const unguarded = verifyEvidence([findingFor(email, at)], { contentText: RESUME_TEXT, redactionSpans: [] });
  assert.equal(unguarded.verified.length, 1);
});

test('a quote that merely touches a masked attribute is refused too', () => {
  // Located by search rather than by the hint, so both code paths are covered.
  const line = 'Nationality: Indian';
  assert.notEqual(RESUME_TEXT.indexOf(line), -1);

  const result = verifyEvidence([findingFor(line, 0)], {
    contentText: RESUME_TEXT,
    redactionSpans: spansFor(RESUME_TEXT),
  });

  assert.equal(result.rejected[0]?.reason, 'quotes_redacted_text');
});

test('one bad finding does not take the good ones with it', () => {
  const good = RESUME_TEXT.indexOf(QUOTE);
  const other = 'Mentored three junior engineers through their first production deployments.';
  assert.ok(RESUME_TEXT.includes(other));

  const result = verifyEvidence(
    [
      findingFor(QUOTE, good),
      findingFor('Nowhere in this document.', 5),
      findingFor(other, RESUME_TEXT.indexOf(other)),
    ],
    { contentText: RESUME_TEXT, redactionSpans: spansFor(RESUME_TEXT) },
  );

  assert.equal(result.verified.length, 2);
  assert.equal(result.rejected.length, 1);
});

test('no findings produces no verdict either way', () => {
  const result = verifyEvidence([], { contentText: RESUME_TEXT, redactionSpans: [] });

  assert.deepEqual(result.verified, []);
  assert.deepEqual(result.rejected, []);
});
