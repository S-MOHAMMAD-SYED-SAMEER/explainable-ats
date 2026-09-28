import { Router, type NextFunction, type Request, type Response } from 'express';
import { handleDemoRun, type DemoDeps } from '../handlers/demo.ts';

// The public demo execution route.
//
// Deliberately its own router, not an addition to `recruiter.ts`. That
// router's own header comment states its whole premise: "Mounted after
// requireSession... GET only." This route is neither — it is mounted before
// the session gate in `app.ts`, reachable by an anonymous visitor by design.
//
// It is also deliberately NOT folded into the read-only public-demo mechanism
// (`auth/middleware.ts::PUBLIC_DEMO_READS` / `requireSessionOrPublicRead`).
// That allow-list is anchored to GET only, on purpose, and widening it to
// cover a POST would change what "read-only" means for every route already
// on that list. This route is a second, independent, narrowly-scoped public
// operation — the one deliberate write in this codebase that an anonymous
// caller may perform — not an extension of the read-only window.
//
// It is the one POST in this codebase an anonymous stranger can reach. Every
// other write requires a session; this is a server-validated exception with
// its own scenario allow-list (`demo/runScenario.ts`) and its own rate-limit
// class (`http/rateLimit.ts`'s `demoRun`), not a hole in that rule.

export function createDemoRouter(deps: DemoDeps): Router {
  const router = Router();

  router.post(
    '/demo/scenarios/:scenario/run',
    (req: Request, res: Response, next: NextFunction): void => {
      handleDemoRun(deps, req.params.scenario, req.body)
        .then((result) => res.status(result.status).json(result.body))
        .catch(next);
    },
  );

  return router;
}
