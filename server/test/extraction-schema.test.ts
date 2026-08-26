import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXTRACTION_TOOL, validateExtraction } from '../src/agent/extractionSchema.ts';

// Structural validation of what the model returned.
//
// Everything here is about failing closed. A coerced field is a fabricated one:
// a missing quote turned into an empty string becomes evidence that says
// nothing and cites nothing, and it would be shown to a recruiter as if the
// model had found something.

const KNOWN = new Set(['req-1', 'req-2']);

function finding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requirementId: 'req-1',
    quote: 'Designed and shipped a Node.js settlement service.',
    charStart: 10,
    charEnd: 59,
    reasoning: 'Names the runtime and the outcome.',
    ...overrides,
  };
}

/** Runs one bad finding alongside one good one, so per-finding isolation is proved too. */
function checkOne(bad: Record<string, unknown>) {
  const result = validateExtraction({ findings: [finding(), bad] }, KNOWN);
  assert.equal(result.accepted.length, 1, 'the good finding should survive its neighbour');
  assert.equal(result.rejected.length, 1);
  return result.rejected[0];
}

test('the tool gives the model no way to judge or to score', () => {
  // The central architectural commitment, asserted structurally rather than
  // trusted to a prompt. A verdict field here would let a number arrive that
  // deterministic code never computed, and it could not then be explained or
  // reproduced.
  const properties = EXTRACTION_TOOL.inputSchema.properties as Record<string, { items: { properties: object } }>;
  const fields = Object.keys(properties.findings?.items.properties ?? {});

  assert.deepEqual(fields.sort(), ['charEnd', 'charStart', 'quote', 'reasoning', 'requirementId']);
  for (const forbidden of ['verdict', 'score', 'confidence', 'rating', 'met']) {
    assert.ok(!fields.includes(forbidden), `the tool must not accept "${forbidden}"`);
  }
});

test('a well-formed finding is accepted intact', () => {
  const result = validateExtraction({ findings: [finding()] }, KNOWN);

  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.accepted, [
    {
      requirementId: 'req-1',
      quote: 'Designed and shipped a Node.js settlement service.',
      charStart: 10,
      charEnd: 59,
      reasoning: 'Names the runtime and the outcome.',
    },
  ]);
});

test('extra fields the model invented are dropped rather than carried through', () => {
  // A model that returns `verdict: "met"` anyway must not have it survive into
  // anything downstream. Building the accepted object field by field is what
  // makes that true; spreading the raw object would not.
  const result = validateExtraction({ findings: [finding({ verdict: 'met', score: 95 })] }, KNOWN);

  assert.equal(result.accepted.length, 1);
  assert.deepEqual(Object.keys(result.accepted[0] as object).sort(), [
    'charEnd',
    'charStart',
    'quote',
    'reasoning',
    'requirementId',
  ]);
});

test('output that is not an object is rejected outright', () => {
  for (const output of ['findings', 42, null, undefined, ['a']]) {
    const result = validateExtraction(output, KNOWN);
    assert.equal(result.accepted.length, 0);
    assert.equal(result.rejected[0]?.reason, 'not_an_object', `for ${JSON.stringify(output)}`);
  }
});

test('a missing or mistyped findings array is rejected', () => {
  assert.equal(validateExtraction({}, KNOWN).rejected[0]?.reason, 'missing_field');
  assert.equal(validateExtraction({ findings: 'none' }, KNOWN).rejected[0]?.reason, 'missing_field');
});

test('a missing field is distinguished from a wrong type', () => {
  // Both are dropped, but the audit trail needs to say which: "the model
  // omitted the quote" and "the model returned a number as the quote" are
  // different bugs to chase.
  assert.equal(checkOne(finding({ quote: undefined }))?.reason, 'missing_field');
  assert.equal(checkOne(finding({ quote: 12 }))?.reason, 'wrong_type');
  assert.equal(checkOne(finding({ requirementId: undefined }))?.reason, 'missing_field');
  assert.equal(checkOne(finding({ reasoning: null }))?.reason, 'wrong_type');
  assert.equal(checkOne(finding({ charStart: undefined }))?.reason, 'missing_field');
  assert.equal(checkOne(finding({ charStart: '10' }))?.reason, 'wrong_type');
});

test('a non-integer offset is a wrong type, not something to round', () => {
  assert.equal(checkOne(finding({ charStart: 10.5 }))?.reason, 'wrong_type');
  assert.equal(checkOne(finding({ charEnd: Number.NaN }))?.reason, 'wrong_type');
});

test('an empty or whitespace-only quote is rejected', () => {
  assert.equal(checkOne(finding({ quote: '' }))?.reason, 'empty_quote');
  assert.equal(checkOne(finding({ quote: '   \n ' }))?.reason, 'empty_quote');
});

test('a finding citing a requirement this job does not have is rejected', () => {
  // Not re-homed onto some other requirement: the model answered a question
  // nobody asked, and attaching the quote elsewhere would invent a claim.
  const rejection = checkOne(finding({ requirementId: 'req-from-another-job' }));

  assert.equal(rejection?.reason, 'unknown_requirement');
});

test('impossible offsets are rejected', () => {
  assert.equal(checkOne(finding({ charStart: 50, charEnd: 50 }))?.reason, 'invalid_offsets');
  assert.equal(checkOne(finding({ charStart: 60, charEnd: 50 }))?.reason, 'invalid_offsets');
  assert.equal(checkOne(finding({ charStart: -1, charEnd: 10 }))?.reason, 'invalid_offsets');
});

test('a finding that is not an object at all is dropped without taking its neighbours', () => {
  const result = validateExtraction({ findings: [finding(), 'nonsense', finding({ requirementId: 'req-2' })] }, KNOWN);

  assert.equal(result.accepted.length, 2);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0]?.reason, 'not_an_object');
});

test('an empty findings array is a valid answer, not an error', () => {
  // "This candidate addressed none of the requirements" is a real result and
  // must be distinguishable from a malformed reply.
  const result = validateExtraction({ findings: [] }, KNOWN);

  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected, []);
});
