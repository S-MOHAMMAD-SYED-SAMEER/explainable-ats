import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.ts';
import { systemClock, type Clock } from '../lib/clock.ts';

// Rate limiting (M5-C, audit F-02, spec §11).
//
// IN-MEMORY AND SINGLE-PROCESS. THIS IS NOT DISTRIBUTED RATE LIMITING.
//
// Counters live in this process's heap. Two instances behind a load balancer
// each enforce the limit separately, so the effective limit is the configured
// one multiplied by the instance count, and a restart forgets everything. That
// is stated plainly because a limiter people believe is stronger than it is is
// worse than none: it invites the assumption that the API is protected from
// abuse when it is protected only from accidents and casual scripts.
//
// It is the right shape for this application today — one process, one operator,
// no Redis — and the spec asked for exactly this. When it needs to be real,
// the interface below is what a shared store would implement.
//
// WHY A FIXED WINDOW AND NOT A TOKEN BUCKET
//
// A fixed window is trivially explainable ("20 in a minute"), trivially
// testable, and its worst case — twice the limit across a window boundary — is
// irrelevant at these numbers. A token bucket would be more elegant and would
// buy nothing here.
//
// THE KEY IS DERIVED SERVER-SIDE, ALWAYS.
//
// Session identity when authenticated, remote address when not. Never a header:
// `x-operator` was the reason F-01 existed, and a limiter keyed on anything the
// caller can set is a limiter the caller can step around by changing it.

export type RateLimitRule = {
  /** Requests permitted per window. */
  limit: number;
  windowMs: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. For `Retry-After`. */
  retryAfterSeconds: number;
};

/**
 * A fixed-window counter keyed by an opaque string.
 *
 * Exported so it can be tested as a pure unit with an injected clock — the
 * behaviour that matters (a window resetting, two clients not colliding) should
 * not need an HTTP server to verify.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private readonly clock: Clock;

  // A plain assignment rather than a parameter property: this project runs
  // TypeScript through Node's type stripping (`erasableSyntaxOnly`), which
  // forbids syntax that emits code.
  constructor(clock: Clock = systemClock) {
    this.clock = clock;
  }

  check(key: string, rule: RateLimitRule): RateLimitDecision {
    const now = Date.parse(this.clock.nowIso());
    const existing = this.windows.get(key);

    if (!existing || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + rule.windowMs });
      return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
    }

    existing.count++;
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));

    if (existing.count > rule.limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }
    return { allowed: true, remaining: rule.limit - existing.count, retryAfterSeconds };
  }

  /**
   * Drops windows that have already reset.
   *
   * Without this the map grows once per distinct key forever, which for
   * IP-keyed login attempts is an unbounded allocation driven by strangers.
   */
  prune(): number {
    const now = Date.parse(this.clock.nowIso());
    let removed = 0;
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) {
        this.windows.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.windows.size;
  }

  reset(): void {
    this.windows.clear();
  }
}

/**
 * The classes of traffic, per spec §11 plus the public demo-run endpoint.
 *
 * `expensive` is the one that matters most among the original three: those
 * endpoints call a model, so exceeding them costs real money rather than
 * merely load. That is why its limit is the tightest of the three.
 *
 * `demoRun` is its own class rather than falling through to `mutation`. It
 * performs a real pipeline execution — ingest, extraction, verification,
 * matching, scoring, several audit writes — on every call, and unlike every
 * other write in this API it needs no session to reach at all. Sizing it at
 * `mutation`'s 120/minute would let an anonymous script run the pipeline two
 * orders of magnitude more often than a person clicking through five demo
 * scenarios ever would. It is set to the same cadence as `login` (10/minute):
 * conservative, and paced for a human, not a session.
 */
export const RATE_LIMITS = Object.freeze({
  login: { limit: 10, windowMs: 60_000 },
  expensive: { limit: 20, windowMs: 60_000 },
  mutation: { limit: 120, windowMs: 60_000 },
  demoRun: { limit: 10, windowMs: 60_000 },
} satisfies Record<string, RateLimitRule>);

export type RateLimitClass = keyof typeof RATE_LIMITS;

/** Endpoints that trigger a model call, and therefore spend. */
const EXPENSIVE_PATHS = [/^\/emails\/understand$/, /^\/emails\/[^/]+\/understand$/, /^\/emails\/decide$/, /^\/emails\/[^/]+\/decide$/];

/** The one public demo-run endpoint (`routes/demo.ts`). POST only. */
const DEMO_RUN_PATH = /^\/demo\/scenarios\/[^/]+\/run$/;

export function classify(method: string, path: string): RateLimitClass | null {
  if (path === '/auth/login') return 'login';
  if (method === 'POST' && DEMO_RUN_PATH.test(path)) return 'demoRun';
  // Reads are not limited: they are cheap, and limiting them would make a busy
  // dashboard look like an attack.
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;
  if (EXPENSIVE_PATHS.some((pattern) => pattern.test(path))) return 'expensive';
  return 'mutation';
}

/**
 * The bucket key for a request.
 *
 * Session first, remote address second, and nothing else ever. Returning the
 * session's *token hash* rather than the operator name matters: with one
 * operator, keying on the name would put every session in one bucket, so a
 * second sign-in would inherit the first one's exhausted budget.
 */
export function keyFor(req: Request): string {
  if (req.session) return `session:${req.session.tokenHash}`;
  return `ip:${req.ip ?? req.socket.remoteAddress ?? 'unknown'}`;
}

export type RateLimitDeps = {
  limiter?: FixedWindowLimiter;
  clock?: Clock;
  limits?: Record<RateLimitClass, RateLimitRule>;
};

export function rateLimit(deps: RateLimitDeps = {}) {
  const limiter = deps.limiter ?? new FixedWindowLimiter(deps.clock);
  const limits = deps.limits ?? RATE_LIMITS;
  let sinceLastPrune = 0;

  return (req: Request, res: Response, next: NextFunction): void => {
    const rateClass = classify(req.method, req.path);
    if (rateClass === null) {
      next();
      return;
    }

    // Opportunistic housekeeping, cheap and amortised. No background worker.
    if (++sinceLastPrune >= 500) {
      sinceLastPrune = 0;
      limiter.prune();
    }

    const decision = limiter.check(`${rateClass}:${keyFor(req)}`, limits[rateClass]);
    res.setHeader('X-RateLimit-Limit', String(limits[rateClass].limit));
    res.setHeader('X-RateLimit-Remaining', String(decision.remaining));

    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      // No key, no identity, no path detail in the message — a refusal should
      // not describe the bucket it came from.
      next(
        new AppError('RATE_LIMITED', 'Too many requests. Wait a moment and try again.', {
          details: { retryAfterSeconds: decision.retryAfterSeconds },
        }),
      );
      return;
    }

    next();
  };
}
