import { Router, type Request, type Response, type NextFunction } from 'express';
import { handleJobList, handleJobDetail, handleJobRanking, type JobDeps } from '../handlers/jobs.ts';
import {
  handleDecision,
  handleEvaluationAudit,
  handleEvaluationDetail,
  type EvaluationDeps,
} from '../handlers/evaluations.ts';
import { operatorOf } from '../auth/middleware.ts';
import type { DemoSandbox } from '../demo/sandbox.ts';
import { AppError } from '../lib/errors.ts';

// The recruiter API.
//
// Mounted after `requireSession`, so every route below is authenticated by
// position rather than by remembering to check. Routes stay thin on purpose:
// read the parameters, call a handler, send what it returns. Nothing here
// decides anything, which is why the handlers can be tested with an in-memory
// database and no port.

const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

/** Ids come from our own generator, so anything wild is refused before a query. */
function readId(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    throw new AppError('VALIDATION_ERROR', `That ${what} is not valid.`);
  }
  return value;
}

export type RecruiterDeps = JobDeps &
  EvaluationDeps & {
    /**
     * Where public demo-run results live. Consulted only by the two evaluation
     * reads below, and never by the decision route: a sandbox id is unknown to
     * the canonical database, so nothing in the sandbox can be decided on.
     */
    sandbox?: DemoSandbox;
  };

export function createRecruiterRouter(deps: RecruiterDeps): Router {
  const router = Router();

  router.get(
    '/jobs',
    wrap(async (_req, res) => {
      const result = await handleJobList(deps);
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/jobs/:jobId',
    wrap(async (req, res) => {
      const result = await handleJobDetail(deps, readId(req.params.jobId, 'job'));
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/jobs/:jobId/ranking',
    wrap(async (req, res) => {
      const result = await handleJobRanking(deps, readId(req.params.jobId, 'job'));
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/evaluations/:evaluationId',
    wrap(async (req, res) => {
      const evaluationId = readId(req.params.evaluationId, 'assessment');
      const sandboxed = deps.sandbox?.find(evaluationId) ?? null;
      if (sandboxed) {
        const result = await handleEvaluationDetail({ ...deps, repos: sandboxed.repos }, evaluationId);
        // The sandbox's own job has its own id. Name the canonical one, so the
        // link back to the role lands on the real ranking.
        res.status(result.status).json({
          ...result.body,
          job: { ...result.body.job, id: sandboxed.canonicalJobId },
        });
        return;
      }
      const result = await handleEvaluationDetail(deps, evaluationId);
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/evaluations/:evaluationId/audit',
    wrap(async (req, res) => {
      const evaluationId = readId(req.params.evaluationId, 'assessment');
      const sandboxed = deps.sandbox?.find(evaluationId) ?? null;
      const result = await handleEvaluationAudit(
        sandboxed ? { ...deps, repos: sandboxed.repos } : deps,
        evaluationId,
      );
      res.status(result.status).json(result.body);
    }),
  );

  // The one write in this router. `operatorOf` reads only what `attachSession`
  // set from a verified session — never a header — so a decision about a person
  // is always attributable to a signed-in operator.
  router.post(
    '/evaluations/:evaluationId/decision',
    wrap(async (req, res) => {
      const result = await handleDecision(
        deps,
        readId(req.params.evaluationId, 'assessment'),
        req.body,
        operatorOf(req),
      );
      res.status(result.status).json(result.body);
    }),
  );

  return router;
}
