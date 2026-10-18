import { extractEvidence } from './extract.ts';
import { extractVerdicts } from './extractVerdicts.ts';
import { DEFAULT_VERDICT_MODE, type VerdictMode } from './verdictMode.ts';
import { matchAndScore } from './match.ts';
import { FAILURE_WORDING } from './failures.ts';
import type { MatchMode } from './matchRules.ts';
import type { LlmProvider } from '../adapters/llm/types.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { Logger } from '../lib/logger.ts';

// The background runner: takes an opened evaluation through extraction and
// scoring without holding an HTTP request open.
//
// A request to run an evaluation answers 202 at once; this does the work. There
// is deliberately no job queue, no worker process and no retry schedule. The work
// is a promise in this process, and what makes that acceptable is that the
// database, not the promise, is the record of where it got to:
//
//   * `pending` means "not finished", and the status endpoint reports exactly
//     that. A process that dies mid-run leaves an evaluation `pending` that this
//     process no longer knows about (`isRunning` is false), which is the one
//     case where a person may start it again.
//   * Every way the run can end writes a terminal state (`scored` or `failed`)
//     and an audit event. A failure the pipeline did not record itself is
//     recorded here, so nothing is left `pending` by a crash of the code, only
//     by a crash of the process.
//
// A small concurrency cap keeps one person pasting twenty CVs from firing
// twenty simultaneous model requests (and from tripping the provider's own rate
// limit, which would turn most of them into failures).

export type EvaluationRunner = {
  /** Starts the work and returns at once. Never throws; a second start for the same id is ignored. */
  start(evaluationId: string): void;
  /** True while the evaluation is queued or running in THIS process. */
  isRunning(evaluationId: string): boolean;
  /** Resolves when nothing is queued or running. For tests and a graceful shutdown. */
  idle(): Promise<void>;
};

export type RunnerDeps = {
  repos: Repositories;
  provider: LlmProvider;
  logger?: Logger;
  /** At most this many evaluations are in flight at once. */
  maxConcurrent?: number;
  /** How words are compared when an assessment is scored (in `model_checked` mode: the second opinion's mode). */
  matchMode?: MatchMode;
  /** Who decides a verdict. `model_checked` (the default) asks the model for verdicts and checks them; `matcher` asks it only to quote. */
  verdictMode?: VerdictMode;
};

export const DEFAULT_MAX_CONCURRENT_EVALUATIONS = 3;

// What a person sees when the code failed in a way the pipeline did not itself
// describe. The real error goes to the log, never to a response.
export const UNEXPECTED_FAILURE_MESSAGE = FAILURE_WORDING.unexpected.message;

export function createEvaluationRunner(deps: RunnerDeps): EvaluationRunner {
  const { repos, provider, logger } = deps;
  const maxConcurrent = Math.max(1, deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_EVALUATIONS);

  const queued: string[] = [];
  const running = new Set<string>();
  const known = new Set<string>();
  let waiters: Array<() => void> = [];

  const settle = (): void => {
    if (known.size > 0) return;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  const runOne = async (evaluationId: string): Promise<void> => {
    try {
      const evaluation = await repos.evaluations.getById(evaluationId);
      // Not ours to run: gone, already finished, or already failed.
      if (!evaluation || evaluation.status !== 'pending') return;

      const verdictMode = deps.verdictMode ?? DEFAULT_VERDICT_MODE;
      const extract = verdictMode === 'model_checked' ? extractVerdicts : extractEvidence;
      await extract({ repos, provider, ...(logger ? { logger } : {}) }, evaluationId);
      await matchAndScore(
        { repos, ...(logger ? { logger } : {}), ...(deps.matchMode ? { matchMode: deps.matchMode } : {}), verdictMode },
        evaluationId,
      );
    } catch (err) {
      logger?.error('Evaluation run failed', {
        evaluationId,
        internal: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      await failIfUnfinished(evaluationId);
    }
  };

  // The pipeline records a provider failure itself. Anything else (a database
  // error, a bug) would otherwise leave the evaluation `pending` for good, so it
  // is closed here with a message that does not pass an internal error to a person.
  const failIfUnfinished = async (evaluationId: string): Promise<void> => {
    try {
      const evaluation = await repos.evaluations.getById(evaluationId);
      if (!evaluation || (evaluation.status !== 'pending' && evaluation.status !== 'extracted')) return;

      await repos.evaluations.recordFailure(evaluationId, UNEXPECTED_FAILURE_MESSAGE);
      await repos.audit.append({
        correlationId: evaluationId,
        stage: 'extract',
        eventType: 'evaluation_failed',
        actor: 'system',
        outcome: 'failed',
        summary: 'The assessment stopped on an unexpected error, so it was marked failed.',
        payload: { reachedStatus: evaluation.status },
        entityType: 'evaluation',
        entityId: evaluationId,
      });
    } catch (err) {
      logger?.error('Could not record an evaluation failure', {
        evaluationId,
        internal: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  };

  const pump = (): void => {
    while (running.size < maxConcurrent && queued.length > 0) {
      const next = queued.shift() as string;
      running.add(next);
      void runOne(next).finally(() => {
        running.delete(next);
        known.delete(next);
        pump();
        settle();
      });
    }
  };

  return {
    start(evaluationId) {
      if (known.has(evaluationId)) return;
      known.add(evaluationId);
      queued.push(evaluationId);
      pump();
    },
    isRunning(evaluationId) {
      return known.has(evaluationId);
    },
    idle() {
      if (known.size === 0) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push(resolve));
    },
  };
}
