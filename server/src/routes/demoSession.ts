import { Router, type NextFunction, type Request, type Response } from 'express';
import { buildCookie, clearCookie, readCookie } from '../auth/cookies.ts';
import {
  demoEvaluationAudit,
  demoEvaluationDetail,
  demoEvaluationResume,
  demoJobDetail,
  demoJobList,
  demoJobRanking,
  handleDemoDecision,
  handleDemoSessionStatus,
  noDemoSession,
  refuseDemoBody,
  viewOf,
  type DemoSessionDeps,
} from '../handlers/demoSession.ts';
import { AppError } from '../lib/errors.ts';
import type { VisitorSandbox } from '../demo/sessions.ts';
import type { AppConfig } from '../config/env.ts';

// The visitor-scoped public demo.
//
//   POST   /demo/session                        start (or resume) a session
//   GET    /demo/session                        is there one? never an error
//   POST   /demo/session/reset                  restore THIS visitor's copy
//   DELETE /demo/session                        end THIS visitor's session
//   GET    /demo/session/jobs[/:id[/ranking]]   the dashboard's reads
//   GET    /demo/session/evaluations/:id[/audit|/resume]   (the resume is the REDACTED text)
//   POST   /demo/session/evaluations/:id/decision   a demo decision, this visitor only
//
// MOUNTED IN DEMO MODE ONLY
//
// `app.ts` registers this router when `APP_MODE=demo` and never otherwise, so in
// the real application these paths are not routes at all. Anonymous by design, and
// answered entirely from a private in-memory database per visitor: the router is
// never given a canonical database, because a demo process has none.
//
// THE DEMO COOKIE IS NOT A SESSION
//
// `ats_demo` names a demo sandbox. A demo process has no operator sessions at all
// — `attachSession` is not mounted there — so `req.session` and `req.operator`
// are never set for any request here. Putting a demo token in the operator's
// cookie slot, or an operator's in this one, opens nothing: each is looked up in
// its own store, and the other store does not exist in that process.
//
// HttpOnly, so script cannot read the token; SameSite=Strict, so a cross-site
// page cannot make a visitor's browser send it — which is also what keeps the
// reset and end routes from being CSRF-able without a second mechanism, for
// state that is synthetic and worth nothing in any case.

export const DEMO_SESSION_COOKIE = 'ats_demo';

/** Longer than any session can live server-side; the server's own expiry governs. */
const COOKIE_MAX_AGE_SECONDS = 24 * 60 * 60;

type Deps = DemoSessionDeps & { config: Pick<AppConfig, 'cookieSecure'> };

const wrap =
  (fn: (req: Request, res: Response) => Promise<void> | void) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve()
      .then(() => fn(req, res))
      .catch(next);
  };

/** Ids come from our own generator, so anything wild is refused before a query. */
function readId(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 128) {
    throw new AppError('VALIDATION_ERROR', `That ${what} is not valid.`);
  }
  return value;
}

export function createDemoSessionRouter(deps: Deps): Router {
  const { store, config } = deps;
  const router = Router();

  const cookieOptions = { secure: config.cookieSecure, httpOnly: true, sameSite: 'Strict' as const };

  const tokenOf = (req: Request): string | null => readCookie(req.headers.cookie, DEMO_SESSION_COOKIE);
  const sandboxOf = (req: Request): VisitorSandbox | null => store.resolve(tokenOf(req));

  /** The session for this request, or the one uniform refusal. */
  const requireSandbox = (req: Request): VisitorSandbox => {
    const sandbox = sandboxOf(req);
    if (!sandbox) throw noDemoSession();
    return sandbox;
  };

  // Every response here depends on who is asking, so none may be stored by a
  // cache that is not keyed on the cookie.
  router.use('/demo/session', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Vary', 'Cookie');
    // Resume text is user-shaped content. It is only ever sent as JSON, and this
    // makes sure no browser decides to treat it as anything else.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  router.post(
    '/demo/session',
    wrap(async (req, res) => {
      refuseDemoBody(req.body);

      // A visitor who already has a live session resumes it. Starting must be
      // safe to repeat — a reload, a double click, a second tab — and silently
      // replacing someone's state is what `reset` is for, said out loud.
      const existing = sandboxOf(req);
      if (existing) {
        res.status(200).json({ active: true, ...viewOf(existing) });
        return;
      }

      const { token, sandbox } = await store.create();
      res.setHeader('Set-Cookie', buildCookie(DEMO_SESSION_COOKIE, token, { ...cookieOptions, maxAgeSeconds: COOKIE_MAX_AGE_SECONDS }));
      res.status(201).json({ active: true, ...viewOf(sandbox) });
    }),
  );

  router.get(
    '/demo/session',
    wrap((req, res) => {
      const sandbox = sandboxOf(req);
      // A cookie that names nothing is cleared, so the browser stops sending it.
      if (!sandbox && tokenOf(req) !== null) {
        res.setHeader('Set-Cookie', clearCookie(DEMO_SESSION_COOKIE, cookieOptions));
      }
      const result = handleDemoSessionStatus(sandbox);
      res.status(result.status).json(result.body);
    }),
  );

  router.post(
    '/demo/session/reset',
    wrap(async (req, res) => {
      refuseDemoBody(req.body);

      // Resets the session the cookie names, and only that one. There is no
      // parameter to name another: the target is not something a caller chooses.
      const sandbox = await store.reset(tokenOf(req));
      if (!sandbox) throw noDemoSession();

      res.status(200).json({ active: true, ...viewOf(sandbox) });
    }),
  );

  router.delete(
    '/demo/session',
    wrap(async (req, res) => {
      await store.end(tokenOf(req));
      res.setHeader('Set-Cookie', clearCookie(DEMO_SESSION_COOKIE, cookieOptions));
      res.status(200).json({ ended: true });
    }),
  );

  router.get(
    '/demo/session/jobs',
    wrap(async (req, res) => {
      const result = await demoJobList(requireSandbox(req));
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/demo/session/jobs/:jobId',
    wrap(async (req, res) => {
      const sandbox = requireSandbox(req);
      const result = await demoJobDetail(sandbox, readId(req.params.jobId, 'job'));
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/demo/session/jobs/:jobId/ranking',
    wrap(async (req, res) => {
      const sandbox = requireSandbox(req);
      const result = await demoJobRanking(sandbox, readId(req.params.jobId, 'job'));
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/demo/session/evaluations/:evaluationId',
    wrap(async (req, res) => {
      const sandbox = requireSandbox(req);
      const result = await demoEvaluationDetail(sandbox, readId(req.params.evaluationId, 'assessment'));
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/demo/session/evaluations/:evaluationId/audit',
    wrap(async (req, res) => {
      const sandbox = requireSandbox(req);
      const result = await demoEvaluationAudit(sandbox, readId(req.params.evaluationId, 'assessment'));
      res.status(result.status).json(result.body);
    }),
  );

  router.get(
    '/demo/session/evaluations/:evaluationId/resume',
    wrap(async (req, res) => {
      const sandbox = requireSandbox(req);
      const result = await demoEvaluationResume(sandbox, readId(req.params.evaluationId, 'assessment'));
      res.status(result.status).json(result.body);
    }),
  );

  // A visitor's decision. Not the recruiter's route and not an extension of it:
  // the session is the demo cookie and nothing else (a token in the URL, a
  // header or the body is never read), the evaluation is looked up in the
  // visitor's own database only, and the actor is fixed by the handler.
  router.post(
    '/demo/session/evaluations/:evaluationId/decision',
    wrap(async (req, res) => {
      const sandbox = requireSandbox(req);
      const result = await handleDemoDecision(sandbox, readId(req.params.evaluationId, 'assessment'), req.body);
      res.status(result.status).json(result.body);
    }),
  );

  return router;
}
