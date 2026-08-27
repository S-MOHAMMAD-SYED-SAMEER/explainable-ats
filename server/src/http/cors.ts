import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.ts';

// CORS, written out rather than installed (M5-B).
//
// The `cors` package is ~200 lines of option handling for a policy this
// application states in one sentence: *the API answers its own front end and
// nothing else, unless an operator names an origin explicitly.*
//
// THE RULE THAT MATTERS
//
// `Access-Control-Allow-Origin: *` and `Access-Control-Allow-Credentials: true`
// are incompatible — browsers reject the pair — and any implementation that
// works around that by reflecting whatever `Origin` arrives has built a wildcard
// with extra steps. This one echoes an origin only after finding it in a
// configured allow-list, so the response can never name an origin nobody
// approved.
//
// SAME-ORIGIN REQUESTS ARE NOT CORS
//
// The front end is served from the same origin as the API, so the default
// configuration — an empty allow-list — is not "CORS is broken", it is "there
// are no cross-origin clients", which is the correct posture until there are.
//
// Recognising a same-origin request takes more than checking for the ABSENCE of
// `Origin`, and an earlier version of this file got that wrong. A browser omits
// `Origin` on a same-origin GET, but per the Fetch specification it attaches one
// to EVERY request whose method is not GET or HEAD — including same-origin ones.
// So an empty allow-list rejected every POST the application's own front end
// made, starting with sign-in, while every GET worked. Worse, no test caught it:
// curl and Node's `fetch` send no `Origin` unless told to, so the entire suite
// exercised a code path no browser ever takes.
//
// The fix is to compare the presented `Origin` against the origin of the request
// itself. A cross-origin page still presents its own `Origin` against our `Host`
// and still fails the comparison — the browser sets `Host` from the URL it is
// actually contacting, so a page cannot forge the pair.
//
// CROSS-ORIGIN STATE CHANGES ARE REFUSED OUTRIGHT
//
// A disallowed `Origin` on a mutating request is rejected server-side rather
// than merely having the CORS headers withheld. Withholding headers stops the
// *browser* reading the response — the request still executed. For anything that
// writes, that is far too late.

export type CorsOptions = {
  /** Exact origins permitted to make credentialed requests. Empty = same-origin only. */
  allowedOrigins: readonly string[];
};

const ALLOWED_HEADERS = 'content-type, x-csrf-token';
const ALLOWED_METHODS = 'GET, POST, OPTIONS';

/**
 * True when `Origin` names the very server the request was sent to.
 *
 * `req.protocol` honours the `trust proxy` setting, so behind a TLS-terminating
 * proxy this needs `TRUST_PROXY` set to the number of hops — otherwise the
 * request reads as `http` while the browser presents `https` and a genuine
 * same-origin request stops matching.
 *
 * `req.headers.host` is used rather than `req.hostname` because it carries the
 * port, and an origin without its port would treat `:3200` and `:3100` on the
 * same host as one origin.
 */
export function isSameOrigin(req: Request, origin: string): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string' || host === '') return false;
  return origin === `${req.protocol}://${host}`;
}

export function cors({ allowedOrigins }: CorsOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

    // Three separate questions, deliberately not collapsed: whether this is a
    // browser speaking CORS at all, whether it is our own front end, and
    // whether an operator has named it.
    const allowListed = origin !== undefined && allowedOrigins.includes(origin);
    const sameOrigin = origin !== undefined && isSameOrigin(req, origin);
    const permitted = origin === undefined || sameOrigin || allowListed;

    if (origin && allowListed) {
      // Echoed only after an allow-list match, never reflected blindly. A
      // same-origin request gets no CORS headers because it needs none — the
      // browser does not apply CORS to its own origin, and emitting `Vary:
      // Origin` for it would fragment caches for nothing.
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      // The response varies by Origin, so a shared cache must not serve one
      // origin's response to another.
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      if (!permitted) {
        // No CORS headers: the browser refuses the preflight, and the real
        // request is never sent.
        res.status(403).end();
        return;
      }
      res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }

    if (!permitted && req.method !== 'GET' && req.method !== 'HEAD') {
      // Server-side refusal. Withholding headers would let the write happen and
      // only stop the attacker reading the answer.
      next(
        new AppError('FORBIDDEN', 'This request came from an origin that is not allowed.', {
          details: { reason: 'origin_not_allowed' },
        }),
      );
      return;
    }

    next();
  };
}
