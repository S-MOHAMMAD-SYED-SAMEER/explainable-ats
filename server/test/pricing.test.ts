import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRICES_PER_MILLION, costOf, formatDollars, totalCost } from '../scripts/pricing.ts';

// The prices are the owner's list prices; the arithmetic is what is tested.

test('the three recorded prices are the ones the owner gave', () => {
  assert.deepEqual(PRICES_PER_MILLION['claude-sonnet-5-5'], { input: 2, output: 10 });
  assert.deepEqual(PRICES_PER_MILLION['claude-haiku-4-5-20251001'], { input: 1, output: 5 });
  assert.deepEqual(PRICES_PER_MILLION['claude-haiku-5-5'], { input: 0.1, output: 0.5 });
});

test('cost is tokens times the per-million price, input and output separately', () => {
  assert.equal(costOf('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 0 }), 2);
  assert.equal(costOf('claude-sonnet-5-5', { inputTokens: 0, outputTokens: 1_000_000 }), 10);
  assert.equal(costOf('claude-haiku-4-5-20251001', { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 6);
  assert.ok(Math.abs((costOf('claude-haiku-5-5', { inputTokens: 500_000, outputTokens: 200_000 }) as number) - 0.15) < 1e-12);
});

test('a model with no recorded price has no cost, rather than a guessed one', () => {
  assert.equal(costOf('claude-opus-5-5', { inputTokens: 10, outputTokens: 10 }), null);
  assert.equal(
    totalCost([
      { model: 'claude-sonnet-5-5', usage: { inputTokens: 1, outputTokens: 1 } },
      { model: 'something-new', usage: { inputTokens: 1, outputTokens: 1 } },
    ]),
    null,
  );
});

test('a total adds the calls, and dollars read to the precision the amount deserves', () => {
  const total = totalCost([
    { model: 'claude-sonnet-5-5', usage: { inputTokens: 1_000_000, outputTokens: 100_000 } },
    { model: 'claude-haiku-4-5-20251001', usage: { inputTokens: 1_000_000, outputTokens: 0 } },
  ]);
  assert.equal(total, 4);
  assert.equal(formatDollars(0.0123456), '$0.0123');
  assert.equal(formatDollars(1.2345), '$1.23');
});
