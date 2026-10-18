import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEvaluationRunner, UNEXPECTED_FAILURE_MESSAGE } from '../src/agent/runner.ts';
import { createMockLlmProvider } from '../src/adapters/llm/mock.ts';
import { installDeterministicExtractor } from '../src/agent/mockExtractor.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { createTestContext } from './helpers.ts';
import { seedScenario } from './fixtures.ts';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/adapters/llm/types.ts';

// The background runner, without HTTP.

function mockProvider() {
  const provider = createMockLlmProvider();
  installDeterministicExtractor(provider);
  return provider;
}

test('a run takes a pending evaluation to scored and then reports idle', async () => {
  const ctx = await createTestContext();
  try {
    const { evaluation } = await seedScenario(ctx.repos);
    const runner = createEvaluationRunner({ repos: ctx.repos, provider: mockProvider(), verdictMode: 'matcher' });

    runner.start(evaluation.id);
    assert.equal(runner.isRunning(evaluation.id), true);
    await runner.idle();

    assert.equal(runner.isRunning(evaluation.id), false);
    assert.equal((await ctx.repos.evaluations.getById(evaluation.id))?.status, 'scored');
  } finally {
    await ctx.close();
  }
});

test('starting the same evaluation twice runs it once', async () => {
  const ctx = await createTestContext();
  try {
    const { evaluation } = await seedScenario(ctx.repos);
    const provider = mockProvider();
    const runner = createEvaluationRunner({ repos: ctx.repos, provider, verdictMode: 'matcher' });

    runner.start(evaluation.id);
    runner.start(evaluation.id);
    await runner.idle();

    assert.equal(provider.calls.length, 1);
  } finally {
    await ctx.close();
  }
});

test('no more than the cap are in flight at once, and all of them finish', async () => {
  const ctx = await createTestContext();
  try {
    const scenarios = [];
    for (let i = 0; i < 5; i += 1) scenarios.push(await seedScenario(ctx.repos));

    const inner = mockProvider();
    let inFlight = 0;
    let peak = 0;
    const provider: LlmProvider = {
      name: 'counting',
      configured: true,
      async complete(request: LlmRequest): Promise<LlmResponse> {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return inner.complete(request);
      },
    };
    const runner = createEvaluationRunner({ repos: ctx.repos, provider, maxConcurrent: 2, verdictMode: 'matcher' });

    for (const scenario of scenarios) runner.start(scenario.evaluation.id);
    await runner.idle();

    assert.equal(peak, 2, 'the cap was reached and never exceeded');
    for (const scenario of scenarios) {
      assert.equal((await ctx.repos.evaluations.getById(scenario.evaluation.id))?.status, 'scored');
    }
  } finally {
    await ctx.close();
  }
});

test('an unexpected error is recorded as a failure with a safe message, not left pending', async () => {
  const ctx = await createTestContext();
  try {
    const { evaluation } = await seedScenario(ctx.repos);
    const { logger, entries } = createMemoryLogger();

    // The provider works; the database write that follows does not.
    const original = ctx.repos.evidence.record.bind(ctx.repos.evidence);
    ctx.repos.evidence.record = async () => {
      throw new Error('disk on fire: secret-internal-detail');
    };

    const runner = createEvaluationRunner({ repos: ctx.repos, provider: mockProvider(), logger, verdictMode: 'matcher' });
    runner.start(evaluation.id);
    await runner.idle();
    ctx.repos.evidence.record = original;

    const after = await ctx.repos.evaluations.getById(evaluation.id);
    assert.equal(after?.status, 'failed');
    assert.equal(after?.failureReason, UNEXPECTED_FAILURE_MESSAGE);
    assert.ok(!after?.failureReason?.includes('secret-internal-detail'));

    const events = await ctx.repos.audit.listForCorrelation(evaluation.id);
    assert.ok(events.some((event) => event.eventType === 'evaluation_failed' && event.outcome === 'failed'));
    assert.ok(
      entries.some((entry) => JSON.stringify(entry).includes('secret-internal-detail')),
      'the real error went to the log',
    );
  } finally {
    await ctx.close();
  }
});

test('an evaluation that is not pending is left alone', async () => {
  const ctx = await createTestContext();
  try {
    const { evaluation } = await seedScenario(ctx.repos);
    await ctx.repos.evaluations.recordFailure(evaluation.id, 'Already failed.');
    const provider = mockProvider();
    const runner = createEvaluationRunner({ repos: ctx.repos, provider, verdictMode: 'matcher' });

    runner.start(evaluation.id);
    await runner.idle();

    assert.equal(provider.calls.length, 0);
    assert.equal((await ctx.repos.evaluations.getById(evaluation.id))?.failureReason, 'Already failed.');
  } finally {
    await ctx.close();
  }
});
