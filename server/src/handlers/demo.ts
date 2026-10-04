import { findDemoJob, isDemoScenarioId } from '../demo/runScenario.ts';
import { AppError } from '../lib/errors.ts';
import type { DemoSandbox } from '../demo/sandbox.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { Logger } from '../lib/logger.ts';
import type { HandlerResult } from './types.ts';

// The public demo-run endpoint's handler.
//
// This is the only place that decides what counts as "a request to run a demo
// scenario." Three rules make that decision narrow:
//
//   1. The scenario comes from the path and nothing else. `scenarioParam` is
//      whatever Express matched at `:scenario` — a string or, at worst,
//      something malformed — and it is the only piece of the request this
//      handler ever reads to decide what to run.
//   2. A request body is refused outright rather than silently ignored. An
//      endpoint that quietly tolerates an unused body is one edit away from a
//      later change starting to read a field from it "just this once." This
//      handler makes that impossible rather than merely unlikely today.
//   3. Nothing is written to the canonical database. The scenario runs in an
//      isolated in-memory sandbox (`demo/sandbox.ts`); `repos` here is used for
//      one read-only lookup and is never handed to the pipeline.

export type DemoDeps = {
  /** Canonical repositories. Read-only here: the demo job is looked up, nothing is written. */
  repos: Repositories;
  sandbox: DemoSandbox;
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

  // A database that was never seeded with the demo dataset offers no public
  // demo. Fails closed, and never creates the job.
  const demoJob = await findDemoJob(deps.repos);
  if (!demoJob) {
    throw new AppError('INVALID_STATE', 'The demo is not available right now.', {
      internal: 'Demo job not found — has `npm run seed:demo` been run against this database?',
    });
  }

  const entry = await deps.sandbox.run(scenarioParam, demoJob.id);

  return { status: 201, body: { evaluationId: entry.evaluationId } };
}
