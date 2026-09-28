import { isDemoScenarioId, runDemoScenario } from '../demo/runScenario.ts';
import { AppError } from '../lib/errors.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { Logger } from '../lib/logger.ts';
import type { HandlerResult } from './types.ts';

// The public demo-run endpoint's handler.
//
// This is the only place that decides what counts as "a request to run a demo
// scenario." Two rules make that decision narrow:
//
//   1. The scenario comes from the path and nothing else. `scenarioParam` is
//      whatever Express matched at `:scenario` — a string or, at worst,
//      something malformed — and it is the only piece of the request this
//      handler ever reads to decide what to run.
//   2. A request body is refused outright rather than silently ignored. An
//      endpoint that quietly tolerates an unused body is one edit away from a
//      later change starting to read a field from it "just this once." This
//      handler makes that impossible rather than merely unlikely today.

export type DemoDeps = {
  repos: Repositories;
  logger?: Logger;
};

export type DemoRunResult = { evaluationId: string };

/** True for "no body was sent" — `undefined`, `null`, or an empty object. */
function hasBodyContent(body: unknown): boolean {
  if (body === undefined || body === null) return false;
  if (typeof body === 'object' && !Array.isArray(body)) return Object.keys(body as object).length > 0;
  return true;
}

export async function handleDemoRun(
  deps: DemoDeps,
  scenarioParam: unknown,
  body: unknown,
): Promise<HandlerResult<DemoRunResult>> {
  if (hasBodyContent(body)) {
    throw new AppError('VALIDATION_ERROR', 'This endpoint does not accept a request body.');
  }

  if (!isDemoScenarioId(scenarioParam)) {
    throw new AppError('NOT_FOUND', 'That demo scenario does not exist.');
  }

  const evaluation = await runDemoScenario(deps, scenarioParam);

  return { status: 201, body: { evaluationId: evaluation.id } };
}
