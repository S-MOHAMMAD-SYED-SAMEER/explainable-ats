// A hash router in sixty lines (D4).
//
// The portfolio ships two pages with no router at all; a dashboard with ten
// screens needs one, but not a dependency's worth. What react-router adds over
// this is nested routes, loaders, and data APIs — none of which a screen switch
// requires. If deep-linking or nested layouts genuinely arrive later, swapping
// this file for react-router is a contained change, because everything else
// only ever imports `parseRoute` and `useRoute`.
//
// Hash routing rather than the History API because it needs no server-side
// rewrite rule: opening a URL directly works from `vite preview`, from a static
// host, and from a file:// path with no configuration anywhere.
//
// The parsing is a pure function, so it is unit-tested in `test/router.test.ts`
// with Node's test runner and no browser, no jsdom, and no test framework.

export const ROUTES = [
  // A nav item pointing at an empty screen is a promise the product has not
  // kept, so each of these arrived with the feature that fills it.
  'overview',
  'jobs',
  // `#/candidates/<evaluationId>` — the id is the ASSESSMENT, not the person.
  // One candidate can be assessed against several roles, and can be re-assessed
  // against one; addressing the assessment is what keeps a link pointing at the
  // evidence it was written about rather than at whatever is newest.
  'candidates',
  // `#/demo` — the demo deployment's first page: what this project is. It is a
  // place to ENTER from, not a screen in the dashboard: it starts (or resumes) the
  // visitor's own sandbox and moves on to its job. Reachable with no sign-in, by
  // design — and only in the demo deployment (`DEMO_ROUTES`).
  'demo',
] as const;

export type RouteName = (typeof ROUTES)[number];

export type Route = {
  name: RouteName;
  /** The record id in `#/candidates/abc123`, when there is one. */
  id: string | null;
};

/**
 * Where someone lands after signing in, and where a bad hash falls back to.
 *
 * Roles, not Status. The first screen a recruiter sees should be the work, not
 * a diagnostics panel reporting which database driver is configured — that
 * screen answers a question only the person who deployed this ever asks.
 */
export const DEFAULT_ROUTE: Route = { name: 'jobs', id: null };

// WHICH ROUTES EXIST DEPENDS ON THE DEPLOYMENT
//
// The two deployments share one bundle (see `mode.ts`), so the router has to know
// which of them it is in. A route that does not belong to the running mode is not
// "hidden" — it is simply not a route there, and its hash resolves to that mode's
// front page like any other unrecognised one. That is what keeps the recruiter's
// Status screen out of the demo, and the demo's front page out of the application.

/** The real application: the recruiter's screens. Sign-in is the gate, not a route. */
export const RECRUITER_ROUTES: readonly RouteName[] = ['overview', 'jobs', 'candidates'];

/** The demo: its first page, then the dashboard inside a visitor's own session. */
export const DEMO_ROUTES: readonly RouteName[] = ['demo', 'jobs', 'candidates'];

/** Where the demo opens, and where leaving it returns to: the project explanation. */
export const DEMO_DEFAULT_ROUTE: Route = { name: 'demo', id: null };

function isRouteName(value: string): value is RouteName {
  return (ROUTES as readonly string[]).includes(value);
}

export type ParseOptions = {
  /** The routes that exist in the running mode. Anything else falls back. */
  allowed?: readonly RouteName[];
  /** Where an unrecognised or disallowed hash lands. */
  fallback?: Route;
};

/**
 * Parses a location hash into a route.
 *
 * Anything unrecognised resolves to the default route rather than throwing or
 * rendering an error screen: a bad hash is almost always a stale link or a
 * typo, and dropping someone on the front page is a better answer than a dead
 * end. A genuinely missing *record* is a different case, and that 404 belongs
 * to the screen that looked it up, not to the router.
 */
export function parseRoute(hash: string, { allowed = ROUTES, fallback = DEFAULT_ROUTE }: ParseOptions = {}): Route {
  const path = hash.replace(/^#\/?/, '').split('?')[0] ?? '';
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);

  const [name, id] = segments;
  if (name === undefined || !isRouteName(name) || !allowed.includes(name)) return fallback;

  return { name, id: id ?? null };
}

export function routeToHash(route: Route): string {
  return route.id === null ? `#/${route.name}` : `#/${route.name}/${encodeURIComponent(route.id)}`;
}

export function navigate(route: Route): void {
  window.location.hash = routeToHash(route);
}
