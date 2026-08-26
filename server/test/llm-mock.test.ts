import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockLlmProvider, createLlmProvider, LlmError, fixtureKey } from '../src/adapters/llm/index.ts';
import { loadConfig } from '../src/config/env.ts';
import type { LlmRequest } from '../src/adapters/llm/types.ts';

// The model boundary.
//
// Nothing calls a model until P3-C. What is being pinned here is the contract
// the extraction stage will depend on — above all, that the mock fails loudly
// rather than inventing a reply. A mock that returns a plausible empty
// structure would let the pipeline carry on, and the fault would surface three
// stages later as "the evidence verifier rejected a quote", which is a long way
// from "no fixture was registered".

function request(purpose: string): LlmRequest {
  return {
    purpose,
    promptVersion: 'v1',
    systemPrompt: 'system',
    messages: [{ role: 'user', content: 'resume text' }],
    tool: { name: 'extract', description: 'Extract evidence', inputSchema: { type: 'object' } },
    maxTokens: 1024,
  };
}

test('the mock replays exactly what was registered', async () => {
  const mock = createMockLlmProvider();
  mock.register('extract', { findings: [{ requirementId: 'r1', verdict: 'met' }] });

  const response = await mock.complete(request('extract'));
  assert.deepEqual(response.output, { findings: [{ requirementId: 'r1', verdict: 'met' }] });
  assert.equal(response.model, 'mock');
});

test('an unregistered fixture raises rather than inventing a reply', async () => {
  // The property that matters most. Silence here would be indistinguishable
  // from a model that found nothing.
  const mock = createMockLlmProvider();

  await assert.rejects(() => mock.complete(request('extract')), LlmError);
  await assert.rejects(() => mock.complete(request('extract')), /never invents a reply/);
});

test('a registered failure is reproducible', async () => {
  // Error handling needs to be exercised deterministically too, or the only
  // way to test a provider outage is to cause one.
  const mock = createMockLlmProvider();
  mock.registerFailure('extract', 'the provider timed out');

  await assert.rejects(() => mock.complete(request('extract')), /timed out/);
});

test('a caller cannot corrupt a fixture for the next call', async () => {
  // Returned by value. Determinism has to survive its callers: a stage that
  // mutates what it got would otherwise change what every later call sees.
  const mock = createMockLlmProvider();
  mock.register('extract', { findings: ['original'] });

  const first = await mock.complete(request('extract'));
  (first.output.findings as string[]).push('mutated');

  const second = await mock.complete(request('extract'));
  assert.deepEqual(second.output, { findings: ['original'] }, 'a caller mutated the stored fixture');
});

test('every call is recorded, in order', async () => {
  const mock = createMockLlmProvider();
  mock.register('extract', {});
  mock.register('summarise', {});

  await mock.complete(request('extract'));
  await mock.complete(request('summarise'));

  assert.deepEqual(mock.calls.map((c) => c.purpose), ['extract', 'summarise']);
});

test('the fixture key is derived in one place', () => {
  // P3-C appends a per-candidate discriminator. Keeping the derivation in one
  // function means that change lands in one place rather than in every caller.
  assert.equal(fixtureKey(request('extract')), 'extract');
});

test('asking for an unimplemented provider fails loudly', () => {
  // Never a silent fall back to the mock. A run that believed it called
  // Sonnet 5 but actually replayed a fixture would invalidate every number
  // taken from it — and that is exactly the sort of result that ends up in a
  // report.
  const { config } = loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'sk-ant-placeholder' });
  assert.throws(() => createLlmProvider(config), LlmError);
  assert.throws(() => createLlmProvider(config), /not implemented yet/);
});

test('the configured model tier is Sonnet 5 and does not drift', () => {
  // CLAUDE.md fixes Sonnet 5 for ranking, and API spend is real money. The
  // default is asserted so a change to it has to be deliberate.
  assert.equal(loadConfig({}).config.anthropicModel, 'claude-sonnet-5');
  assert.equal(loadConfig({}).config.llmProvider, 'mock', 'the default provider should cost nothing to run');
});
