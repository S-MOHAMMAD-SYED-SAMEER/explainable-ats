// What a model call costs, from the token counts the API reports.
//
// The prices are the list prices on the Anthropic pricing page, in US dollars per
// million tokens, as given by the project's owner on 2026-10-15. The Models API does
// not report prices, so they cannot be read from the service and have to be written
// down; when a price changes this file is the one place to change, and every figure
// that was computed from the old one is a figure for the old price.
//
// Token counts are always the API's own (`usage` on the reply), never estimated. Cost
// is computed from them, never reported by the API, and is rounded only for display.

export const PRICES_SOURCE = 'Anthropic list prices, US dollars per million tokens, as given by the owner on 2026-10-15';

export type Price = { input: number; output: number };

export const PRICES_PER_MILLION: Readonly<Record<string, Price>> = Object.freeze({
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
});

export type Usage = { inputTokens: number; outputTokens: number };

/** Dollars for one call, or null when the model has no recorded price (never a guess). */
export function costOf(model: string, usage: Usage): number | null {
  const price = PRICES_PER_MILLION[model];
  if (!price) return null;
  return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
}

/** Dollars for several calls, or null if any of them has no recorded price. */
export function totalCost(calls: ReadonlyArray<{ model: string; usage: Usage }>): number | null {
  let total = 0;
  for (const call of calls) {
    const cost = costOf(call.model, call.usage);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

export function formatDollars(amount: number): string {
  return `$${amount.toFixed(amount < 0.1 ? 4 : 2)}`;
}
