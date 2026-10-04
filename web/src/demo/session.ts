// The frontend's half of the visitor-scoped demo session.
//
// WHAT THE BROWSER HOLDS, AND WHAT IT DOES NOT
//
// It holds nothing. The demo session is named by an `HttpOnly` cookie the server
// sets and the browser attaches on its own; script cannot read it, and nothing
// in this directory tries to. There is no token to store, no localStorage entry
// and no URL parameter — so there is nothing for a reload to lose, and nothing
// for a script or a shared link to leak. A reload survives because the cookie
// does: the app asks the server "is there a session?" and believes the answer,
// exactly as it does for the operator.
//
// Everything in this file is pure, so it is tested without a browser.

/**
 * Which half of the API the dashboard is reading.
 *
 * `recruiter` is the canonical API. `demo` is the visitor's own sandbox: the
 * same screens, the same response shapes, a different place the data lives.
 */
export type ApiScope = 'recruiter' | 'demo';

export type DemoSessionView = {
  /** The visitor's own copy of the demo job. */
  jobId: string;
  jobTitle: string;
  expiresAt: string;
};

export type DemoStatus = { active: false } | { active: true; session: DemoSessionView };

/**
 * Turns the server's answer into a status.
 *
 * Pure and total, and strict in the same way `sessionFromResponse` is: a body
 * that is missing, partial or malformed means "no session", never a half-formed
 * one. Failing toward "inactive" sends a visitor to start again; failing toward
 * "active" would draw a dashboard with nothing behind it.
 */
export function demoSessionFromResponse(body: unknown): DemoStatus {
  if (!body || typeof body !== 'object') return { active: false };

  const response = body as Record<string, unknown>;
  if (response.active !== true) return { active: false };

  const { jobId, jobTitle, expiresAt } = response;
  if (typeof jobId !== 'string' || jobId === '') return { active: false };
  if (typeof jobTitle !== 'string' || typeof expiresAt !== 'string') return { active: false };

  return { active: true, session: { jobId, jobTitle, expiresAt } };
}

/**
 * Where a logical API path lives, for the scope the dashboard is in.
 *
 * The screens call `api.job(id)`, `api.evaluation(id)` and so on, and know
 * nothing about demos. In the `demo` scope the same calls are answered by the
 * visitor's sandbox, so the screens need no second copy and cannot be written
 * to read the wrong one: one function decides, here, and it is tested.
 *
 * Only the recruiter READS and the scenario run are redirected. Authentication,
 * health and the session's own lifecycle paths are left exactly as they are, and
 * so is anything unrecognised — an unrecognised path in the demo scope must fail
 * at the server rather than be quietly sent somewhere it was not meant to go.
 *
 * In particular `/evaluations/:id/decision` is redirected like any other
 * evaluation path, to a route that does not exist. A demo session has no
 * decision endpoint, and this must never turn into a call to the canonical one.
 */
export function resolveApiPath(path: string, scope: ApiScope): string {
  if (scope !== 'demo') return path;

  if (/^\/(?:jobs|evaluations)(?:\/|$)/.test(path)) return `/demo/session${path}`;
  if (path.startsWith('/demo/scenarios/')) return path.replace('/demo/scenarios/', '/demo/session/scenarios/');
  return path;
}

/** Whether a resolved path belongs to a visitor's demo session. */
export function isDemoSessionPath(resolved: string): boolean {
  return resolved === '/demo/session' || resolved.startsWith('/demo/session/');
}

/**
 * Whether the dashboard should be drawn from the visitor's sandbox.
 *
 * An anonymous browser with a live demo session is in the demo — including
 * straight after a reload, which is what makes the session survive one. A
 * signed-in operator is in the recruiter's dashboard unless they chose the demo
 * during this page load, so a demo cookie left in an operator's browser cannot
 * quietly swap their real dashboard for the sandbox.
 */
export function demoSessionInUse(input: {
  sessionActive: boolean;
  authenticated: boolean;
  entered: boolean;
}): boolean {
  return input.sessionActive && (!input.authenticated || input.entered);
}

/** What the app knows about the visitor's demo session at this moment. */
export type DemoState =
  | { status: 'checking' }
  | { status: 'inactive' }
  | { status: 'starting' }
  | { status: 'active'; session: DemoSessionView }
  | { status: 'error'; message: string };

export type LandingView = {
  /** The label of the one primary button. */
  primary: 'Start Demo' | 'Resume demo' | 'Continue demo' | 'Starting…' | 'Try again';
  /** The primary button is doing something and must not be pressed again. */
  busy: boolean;
  /** A live session exists, so the visitor may also start over from a fresh copy. */
  canStartOver: boolean;
  /** Something the visitor should be told before they press it. */
  notice: string | null;
};

/**
 * What the landing screen offers, from what the app knows.
 *
 * The same server call sits behind every one of these buttons — "start" resumes
 * a live session and builds a new one otherwise — so this decides only what the
 * visitor is TOLD, not what happens. It is pure so the four situations a visitor
 * can arrive in are each a tested answer rather than a reading of some JSX.
 */
export function landingView(state: DemoState, entered: boolean): LandingView {
  switch (state.status) {
    case 'starting':
      return { primary: 'Starting…', busy: true, canStartOver: false, notice: null };
    case 'error':
      return { primary: 'Try again', busy: false, canStartOver: false, notice: state.message };
    case 'active':
      // Arrived with a session already live (a reload, a second tab, a return
      // visit) — or came back to this screen from inside the demo.
      return {
        primary: entered ? 'Continue demo' : 'Resume demo',
        busy: false,
        canStartOver: true,
        notice: null,
      };
    case 'inactive':
      return {
        primary: 'Start Demo',
        busy: false,
        canStartOver: false,
        notice: entered ? 'Your demo session ended or expired. Start again for a fresh private copy.' : null,
      };
    default:
      // `checking` never reaches the landing — the app waits for the answer — but
      // if it did, it must not offer a button that would race the check.
      return { primary: 'Starting…', busy: true, canStartOver: false, notice: null };
  }
}
