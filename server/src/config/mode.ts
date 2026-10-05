// Deployment mode: which of the two products this process is.
//
// THE SAME CODEBASE IS DEPLOYED TWICE
//
//   app   The real application. Recruiter sign-in, the recruiter routes, a real
//         (canonical) database. It exposes nothing anonymous but health.
//
//   demo  The portfolio demo. No sign-in, no canonical database, no credentials.
//         It serves one thing: a private, in-memory copy of the fixed synthetic
//         dataset per visitor.
//
// WHY A MODE AND NOT A CONFIGURATION OF ROUTES
//
// The two used to share one process, and the only thing keeping a demo visitor
// away from the recruiter's routes was that they had no credential, and the only
// thing keeping the recruiter's deployment from offering anonymous endpoints was
// that nobody had turned them off. Both were true by habit. A mode makes them
// true by construction: a route that does not belong to the running mode is never
// registered, so there is nothing to reach, nothing to misconfigure and nothing a
// front end has to hide.
//
// The rest of the code asks `capabilitiesOf(mode)` what it may do rather than
// comparing strings, so adding a third mode would be a change here and nowhere
// else, and "what does demo mode allow?" has one answer in one place.

export const APP_MODES = ['app', 'demo'] as const;
export type AppMode = (typeof APP_MODES)[number];

/** Used when `APP_MODE` is not set. The real application is the default, never the demo. */
export const DEFAULT_APP_MODE: AppMode = 'app';

export function isAppMode(value: unknown): value is AppMode {
  return typeof value === 'string' && (APP_MODES as readonly string[]).includes(value);
}

export type ModeCapabilities = {
  /** Recruiter sign-in, sessions and CSRF protection. */
  readonly authentication: boolean;
  /** The recruiter's reads and the recruiter's decision. */
  readonly recruiterRoutes: boolean;
  /** A persistent database the process opens at boot. */
  readonly canonicalDatabase: boolean;
  /** The anonymous, visitor-scoped demo endpoints. */
  readonly demoRoutes: boolean;
  /** The in-memory store of per-visitor sandboxes. */
  readonly demoSessionStore: boolean;
};

const CAPABILITIES: Readonly<Record<AppMode, ModeCapabilities>> = Object.freeze({
  app: Object.freeze({
    authentication: true,
    recruiterRoutes: true,
    canonicalDatabase: true,
    demoRoutes: false,
    demoSessionStore: false,
  }),
  demo: Object.freeze({
    authentication: false,
    recruiterRoutes: false,
    canonicalDatabase: false,
    demoRoutes: true,
    demoSessionStore: true,
  }),
});

export function capabilitiesOf(mode: AppMode): ModeCapabilities {
  return CAPABILITIES[mode];
}
