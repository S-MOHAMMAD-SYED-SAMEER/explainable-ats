import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createHealthRouter } from './routes/health.ts';
import { createAuthRouter } from './routes/auth.ts';
import { createRecruiterRouter } from './routes/recruiter.ts';
import { attachSession, requireSessionOrPublicRead } from './auth/middleware.ts';
import { requireCsrf } from './auth/csrf.ts';
import { cors } from './http/cors.ts';
import { rateLimit } from './http/rateLimit.ts';
import { createRepositories } from './db/repositories/index.ts';
import { createLlmProvider } from './adapters/llm/index.ts';
import { config as defaultConfig, type AppConfig } from './config/env.ts';
import { toErrorEnvelope } from './lib/errors.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import type { LlmProvider } from './adapters/llm/types.ts';
import type { Database } from './db/types.ts';

// Application assembly, separate from the server bootstrap so a test can build
// the app without binding a port.

export type AppDeps = {
  db: Database;
  logger?: Logger;
  config?: AppConfig;
  /** Injectable so a test can drive the limiter with a fixed clock. */
  rateLimiter?: ReturnType<typeof rateLimit>;
  /** Injectable so a test can supply a deterministic provider. */
  provider?: LlmProvider;
};

// Large enough for a long resume pasted as text, small enough that a request
// cannot be used to exhaust memory. Uploads get their own, tighter cap in P3-C.
const MAX_BODY_BYTES = 512 * 1024;

export function createApp({
  db,
  logger = createLogger('http'),
  config = defaultConfig,
  provider,
  rateLimiter = rateLimit(),
}: AppDeps): Express {
  const app = express();
  const repos = createRepositories(db);

  // Built here so a misconfigured provider fails at startup rather than on the
  // first request. Nothing calls it until P3-C.
  const llm = provider ?? createLlmProvider(config);
  void llm;

  app.disable('x-powered-by');

  // How many reverse proxies stand in front of us. Set before anything reads
  // `req.ip`, because everything that does — the rate limiter above all —
  // inherits the answer. Too low behind a real proxy puts every caller in one
  // rate-limit bucket; too high lets a caller forge `X-Forwarded-For` and pick
  // its own. No single value is safe in both cases, so it is configuration.
  app.set('trust proxy', config.trustProxy);

  // CORS first, so a preflight is answered before anything reads a body and a
  // disallowed cross-origin write is refused before it reaches a route. The
  // default allow-list is empty, which is not "CORS is broken" — the front end
  // is served from this same origin, so there are no cross-origin clients.
  app.use('/api', cors({ allowedOrigins: config.corsAllowedOrigins }));

  app.use(express.json({ limit: MAX_BODY_BYTES }));

  // Malformed JSON otherwise reaches Express's default HTML error page, which
  // carries a stack trace and file paths. Answer like every other input failure.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const candidate = err as { type?: string } | null;
    if (candidate?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'The request body is not valid JSON.' } });
      return;
    }
    if (candidate?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'VALIDATION_ERROR', message: 'The request body is too large.' } });
      return;
    }
    next(err);
  });

  // The order below IS the security boundary, so it is worth reading as one:
  //
  //   1. health         — liveness, before anything. A monitor must not need a
  //                       password to learn the service is up, and health
  //                       reports capabilities, never secrets.
  //   2. attachSession  — resolves a session if one is presented. Never rejects.
  //   3. rate limiting  — after attachSession, so a signed-in caller is keyed by
  //                       their session rather than sharing an IP bucket with
  //                       everyone behind the same NAT.
  //   4. CSRF           — between "who is this?" and "may they?".
  //   5. auth routes    — sign in and out. The only endpoints reachable without
  //                       a session, which is why they sit above the gate.
  //   6. requireSession — the gate. Everything past it is authenticated.
  //
  // Anything added after step 6 is protected by default. That is deliberate:
  // the failure mode of a deny-list is the route someone forgot to add to it.
  app.use('/api', createHealthRouter(db, config));
  app.use('/api', attachSession({ repos }));
  app.use('/api', rateLimiter);
  app.use('/api', requireCsrf());
  app.use('/api', createAuthRouter({ repos, config, logger }));
  app.use('/api', requireSessionOrPublicRead({ publicReadsEnabled: config.demoPublicReadonly }));

  // Everything from here on is behind the gate.
  app.use('/api', createRecruiterRouter({ repos, logger }));

  app.use('/api', (_req: Request, res: Response) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'That endpoint does not exist.' } });
  });

  // The front end, on the same origin as the API.
  //
  // Mounted last, so it can never shadow a route: every API path is under
  // `/api`, and the catch-all above answers anything there that did not match.
  //
  // Same origin is not a preference. The session and CSRF cookies are
  // `SameSite=Strict`, which a browser will not send to a different site at
  // all, and the client calls `/api` with no host. Serving both halves from one
  // origin is what makes both true, and it leaves no CORS surface to misconfigure.
  //
  // No history-API fallback: the client is a hash router, so the only path a
  // browser requests is `/` and the hashed assets beside it. A fallback would
  // turn every genuine 404 into a 200 serving the app. A missing `dist/` is not
  // an error either — `express.static` calls next(), which is the normal state
  // in development where Vite serves the front end.
  app.use(express.static(config.webDistDir));

  // Terminal error handler. Everything reaching here goes through one function,
  // so a response can never carry an internal message by accident: the safe
  // envelope goes to the client, the real detail goes to the log.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const { status, body, internal } = toErrorEnvelope(err);
    logger.error('Unhandled request error', { status, code: body.error.code, internal });
    res.status(status).json(body);
  });

  return app;
}
