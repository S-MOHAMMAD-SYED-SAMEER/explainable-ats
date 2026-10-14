import { Router, type Request, type Response, type NextFunction } from 'express';
import { handleJobList, handleJobDetail, handleJobRanking, type JobDeps } from '../handlers/jobs.ts';
import {
  handleDecision,
  handleEvaluationAudit,
  handleEvaluationDetail,
  type EvaluationDeps,
} from '../handlers/evaluations.ts';
import {
  handleAddCandidate,
  handleCreateJob,
  handleEvaluationStatus,
  handleRerunEvaluation,
  handleRunEvaluation,
  type ManageDeps,
} from '../handlers/manage.ts';
import { operatorOf } from '../auth/middleware.ts';
import { AppError } from '../lib/errors.ts';

// The recruiter API.
//
// Registered in app mode only (`config/mode.ts`) and mounted after
// `requireSession`, so every route below is authenticated by position rather than
// by remembering to check. Routes stay thin on purpose:
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

export type RecruiterDeps = JobDeps & EvaluationDeps & ManageDeps;

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

  router.get(
    '/evaluations/:evaluationId/status',
    wrap(async (req, res) => {
      const result = await handleEvaluationStatus(deps, readId(req.params.evaluationId, 'assessment'));
      res.status(result.status).json(result.body);
    }),
  );

  // The writes. `operatorOf` reads only what `attachSession` set from a verified
  // session — never a header — so everything done to a job or a person is
  // attributable to a signed-in operator.
  router.post(
    '/jobs',
    wrap(async (req, res) => {
      const result = await handleCreateJob(deps, req.body, operatorOf(req));
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/jobs/:jobId/candidates',
    wrap(async (req, res) => {
      const result = await handleAddCandidate(deps, readId(req.params.jobId, 'job'), req.body, operatorOf(req));
      res.status(result.status).json(result.body);
    }),
  );

  // Answers 202: the work continues in the background and the caller polls
  // `/evaluations/:id/status`.
  router.post(
    '/evaluations/:evaluationId/run',
    wrap(async (req, res) => {
      const result = await handleRunEvaluation(deps, readId(req.params.evaluationId, 'assessment'), operatorOf(req));
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/evaluations/:evaluationId/rerun',
    wrap(async (req, res) => {
      const result = await handleRerunEvaluation(deps, readId(req.params.evaluationId, 'assessment'), operatorOf(req));
      res.status(result.status).json(result.body);
    }),
  );

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
