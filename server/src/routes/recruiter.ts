import { Router, type Request, type Response, type NextFunction } from 'express';
import { handleJobList, handleJobDetail, handleJobRanking, type JobDeps } from '../handlers/jobs.ts';
import {
  handleDecision,
  handleEvaluationAudit,
  handleEvaluationDetail,
  type EvaluationDeps,
} from '../handlers/evaluations.ts';
import { operatorOf } from '../auth/middleware.ts';
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

export type RecruiterDeps = JobDeps & EvaluationDeps;

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
      const result = await handleEvaluationDetail(deps, readId(req.params.evaluationId, 'assessment'));
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/evaluations/:evaluationId/audit',
    wrap(async (req, res) => {
      const result = await handleEvaluationAudit(deps, readId(req.params.evaluationId, 'assessment'));
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
