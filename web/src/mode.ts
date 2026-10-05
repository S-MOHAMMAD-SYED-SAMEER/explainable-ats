// Which product this page is talking to.
//
// ONE BUNDLE, TWO DEPLOYMENTS, AND THE ANSWER COMES FROM THE SERVER
//
// The same built client is served by the real application and by the portfolio
// demo. Nothing about that can be baked into the bundle: a build-time flag would
// be right for exactly one of the two, and a build that was deployed to the wrong
// one would draw a sign-in screen against a server with no sign-in, or a demo
// against a server with a recruiter's data. So the client asks. `GET /api/health`
// is the one route both deployments register, and it says which one it is.
//
// WHAT IT DOES WHEN IT CANNOT TELL
//
// Nothing. A health answer with no mode, an unknown one, or no answer at all is
// not "probably the application" — drawing the wrong product's screens against the
// wrong server is the one thing this layer exists to prevent. The visitor is told
// the service could not be identified and offered a retry.
//
// Pure, so it is tested without a browser.

export const APP_MODES = ['app', 'demo'] as const;
export type AppMode = (typeof APP_MODES)[number];

export function isAppMode(value: unknown): value is AppMode {
  return typeof value === 'string' && (APP_MODES as readonly string[]).includes(value);
}

/**
 * The mode a health answer names, or null if it names none we know.
 *
 * Strict: the value must be exactly one of the two literals. No trimming, no case
 * folding and no default — a server that says "Demo" or "demo " is not one this
 * client understands, and failing toward "unknown" is the safe direction.
 */
export function modeFromHealth(body: unknown): AppMode | null {
  if (!body || typeof body !== 'object') return null;
  const { mode } = body as { mode?: unknown };
  return isAppMode(mode) ? mode : null;
}

/** What the page knows about the deployment it is talking to. */
export type ModeState =
  | { status: 'loading' }
  | { status: 'ready'; mode: AppMode }
  | { status: 'error'; message: string };

/** What a visitor is told when the deployment cannot be identified. */
export const MODE_UNKNOWN_MESSAGE =
  'This page could not tell which service it is talking to. Reload to try again.';

export const MODE_UNREACHABLE_MESSAGE = 'Could not reach the server. Check your connection and try again.';
