import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildUserMessage,
  buildSystemPrompt,
  parseExtractionPrompt,
  RESUME_MARKER,
} from '../src/agent/extractionPrompt.ts';
import { createDeterministicExtractor, installDeterministicExtractor } from '../src/agent/mockExtractor.ts';
import { createMockLlmProvider } from '../src/adapters/llm/mock.ts';
import { MASK_CHAR } from '../src/agent/redact.ts';
import type { JobRequirement } from '../src/domain/ats.ts';
import type { LlmRequest } from '../src/adapters/llm/types.ts';

// The prompt and its parser are one contract, so they are tested as one.
//
// If they drifted apart, the stand-in model would quietly start extracting from
// an empty document and every fixture would go silently empty — which reads
// exactly like a candidate who matched nothing.

function requirement(id: string, label: string, criterion: string): JobRequirement {
  return {
    id,
    jobId: 'job-1',
    label,
    criterion,
    kind: 'must_have',
    weight: 1,
    position: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

const REQUIREMENTS = [
  requirement('req-1', 'Node.js services', 'Has designed and shipped production Node.js services'),
  requirement('req-2', 'Mentoring', 'Has mentored junior engineers'),
];

const RESUME = ['EXPERIENCE', 'Designed and shipped a Node.js settlement service.', 'Mentored junior engineers.'].join('\n');

test('a built prompt parses back into exactly what went in', () => {
  const parsed = parseExtractionPrompt(buildUserMessage(REQUIREMENTS, RESUME));

  assert.equal(parsed.resumeText, RESUME);
  assert.deepEqual(parsed.requirements, [
    { id: 'req-1', label: 'Node.js services', criterion: 'Has designed and shipped production Node.js services' },
    { id: 'req-2', label: 'Mentoring', criterion: 'Has mentored junior engineers' },
  ]);
});

test('a resume containing the section marker as ordinary text does not confuse the parser', () => {
  // Precondition: the resume really does carry the marker, so this is not
  // passing because there was nothing to trip over.
  const awkward = `SUMMARY\nWrote a tool that printed ${RESUME_MARKER} as a banner.\nMentored junior engineers.`;
  assert.ok(awkward.includes(RESUME_MARKER));

  const parsed = parseExtractionPrompt(buildUserMessage(REQUIREMENTS, awkward));

  assert.equal(parsed.resumeText, awkward);
  assert.equal(parsed.requirements.length, 2);
});

test('a message that was not built by buildUserMessage is refused, not silently emptied', () => {
  assert.throws(() => parseExtractionPrompt('here is a resume, please extract evidence'), /section markers/);
});

test('the system prompt tells the model what a mask means and forbids quoting it', () => {
  const prompt = buildSystemPrompt();

  assert.ok(prompt.includes(MASK_CHAR));
  assert.match(prompt, /Never quote those runs/);
  assert.match(prompt, /do not produce a score/);
});

test('the stand-in quotes only text that is genuinely in the document', () => {
  const extractor = createDeterministicExtractor();
  const findings = extractor({
    purpose: 'extract_evidence',
    promptVersion: 'extract-v1',
    systemPrompt: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserMessage(REQUIREMENTS, RESUME) }],
    tool: { name: 'record_evidence', description: '', inputSchema: {} },
    maxTokens: 1024,
  }).findings as Array<Record<string, unknown>>;

  assert.equal(findings.length, 2);
  for (const finding of findings) {
    const quote = finding.quote as string;
    assert.equal(RESUME.slice(finding.charStart as number, finding.charEnd as number), quote);
  }
});

test('the stand-in never quotes a line carrying a mask', () => {
  const masked = `EXPERIENCE\nEmail: ${MASK_CHAR.repeat(12)} — Node.js services lead\nMentored junior engineers.`;
  const extractor = createDeterministicExtractor();

  const findings = extractor({
    purpose: 'extract_evidence',
    promptVersion: 'extract-v1',
    systemPrompt: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserMessage(REQUIREMENTS, masked) }],
    tool: { name: 'record_evidence', description: '', inputSchema: {} },
    maxTokens: 1024,
  }).findings as Array<Record<string, unknown>>;

  // Precondition: the masked line is the only one that mentions Node.js, so a
  // stand-in that ignored masks would have quoted it.
  assert.ok(masked.includes('Node.js services lead'));
  for (const finding of findings) {
    assert.ok(!(finding.quote as string).includes(MASK_CHAR));
  }
  assert.ok(!findings.some((finding) => finding.requirementId === 'req-1'));
});

test('an explicit fixture wins over the stand-in', () => {
  // A test that pinned one exact reply is making a point about that reply, and
  // a generic responder quietly overriding it would make the test assert
  // something else.
  const provider = createMockLlmProvider();
  installDeterministicExtractor(provider);
  provider.register('extract_evidence', { findings: [] });

  const request: LlmRequest = {
    purpose: 'extract_evidence',
    promptVersion: 'extract-v1',
    systemPrompt: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserMessage(REQUIREMENTS, RESUME) }],
    tool: { name: 'record_evidence', description: '', inputSchema: {} },
    maxTokens: 1024,
  };

  return provider.complete(request).then((response) => {
    assert.deepEqual(response.output, { findings: [] });
  });
});
