import { CSRF_HEADER, currentCsrfToken, needsCsrf, type SessionResponse } from '../auth/session.ts';
import { isDemoSessionPath, resolveApiPath, type ApiScope } from '../demo/session.ts';
import type {
  AuditEntry,
  DecisionResult,
  DemoResume,
  ErrorEnvelope,
  EvaluationDetail,
  Health,
  JobDetail,
  JobSummary,
  Ranking,
} from './types.ts';



// The API client.
//
// One place that knows how to talk to the server, so no component ever calls
// `fetch` directly. Two consequences worth the file:
//
//   * Errors arrive as one type. The server always answers a failure with the
//     same envelope, so the client can turn any failure — including a network
//     drop, which has no envelope at all — into the same `ApiError`. A screen
//     then has exactly one error shape to render.
//   * No secret ever reaches this layer, because there is nothing to send. The
//     browser holds no key and no token: every provider call happens on the
//     server (§19). If this file ever grows an API key, something has gone
//     badly wrong upstream of it.

const BASE_URL = '/api';

// --- authentication events (M6-A) -------------------------------------------
//
// The client cannot navigate, and the app cannot see inside a fetch. These two
// hooks are the seam: the client reports what the server said, and the app
// decides what to show. A module-level subscriber rather than a context because
// exactly one thing subscribes — the session gate in App.tsx — and threading a
// callback through every screen to reach `fetch` would be worse.

type AuthListener = () => void;

let onUnauthorized: AuthListener | null = null;
let onCsrfFailure: AuthListener | null = null;

/** Called when the server says the session is gone. The app returns to Login. */
export function setUnauthorizedHandler(handler: AuthListener | null): void {
  onUnauthorized = handler;
}

/** Called when a state-changing request fails CSRF verification. */
export function setCsrfFailureHandler(handler: AuthListener | null): void {
  onCsrfFailure = handler;
}

// --- which half of the API the dashboard is reading --------------------------
//
// The screens call `api.job(id)` and friends and know nothing about demos. In
// the `demo` scope — the demo deployment's, where the recruiter API does not
// exist — those same calls are answered by the visitor's own sandbox (see
// `resolveApiPath`), so there is one set of screens and no second copy to drift.
// Module-level, like the two handlers above, because exactly one thing sets it —
// the running app (`RecruiterApp` or `DemoApp`) — and every request reads it.

let apiScope: ApiScope = 'recruiter';

/** Idempotent: setting the scope it already has is a no-op, so it is safe to call from render. */
export function setApiScope(scope: ApiScope): void {
  apiScope = scope;
}

let onDemoSessionLost: AuthListener | null = null;

/** Called when the server says the visitor's demo session is gone. Not a sign-out. */
export function setDemoSessionLostHandler(handler: AuthListener | null): void {
  onDemoSessionLost = handler;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // The CSRF token rides along on every state-changing request (M5-B). It is
  // read from the readable cookie at call time rather than cached, so a fresh
  // sign-in cannot leave a stale token behind. The session cookie itself is
  // HttpOnly and is never touched here — the browser attaches it.
  const csrf = needsCsrf(init?.method) ? currentCsrfToken() : null;

  // Where this logical path lives for the current scope. The error handling
  // below keys on `path`, the logical name, except where it says `target`.
  const target = resolveApiPath(path, apiScope);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${target}`, {
      ...init,
      // Explicit rather than relying on the default. The API is same-origin —
      // the dev proxy makes that true locally too — and this is the line that
      // says the session cookie is meant to travel.
      credentials: 'same-origin',
      // After `...init`, so a caller cannot accidentally drop the content type
      // or the CSRF token by passing its own headers object.
      headers,
    });
  } catch (cause) {
    // A network failure has no envelope, so one is supplied here — otherwise
    // every caller would need a second, different error path for "the server
    // was not reachable at all".
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server.', {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const text = await response.text();
  const parsed: unknown = text === '' ? null : safeParse(text);

  if (!response.ok) {
    const envelope = parsed as ErrorEnvelope | null;
    const error = new ApiError(
      response.status,
      envelope?.error?.code ?? 'INTERNAL_ERROR',
      envelope?.error?.message ?? 'Something went wrong.',
      envelope?.error?.details ?? {},
    );

    // A 401 means the session ended — expired, revoked, or never there. The app
    // is told once and returns to Login; the error still propagates so the
    // caller does not mistake it for an empty result.
    //
    // `/auth/session` is exempt because it answers 200 for anonymous by design,
    // and `/auth/login` because a wrong password is a failed sign-in rather
    // than a lost session. Notifying on either would put the app in a loop
    // between "check the session" and "the session is gone".
    if (error.status === 401 && isDemoSessionPath(target)) {
      // A visitor's demo session ending is not the operator's session ending.
      // Reporting it as a sign-out would send a visitor to a password box for
      // an account they never had; it has its own handler, and its own answer
      // (start the demo again).
      onDemoSessionLost?.();
    } else if (error.status === 401 && path !== '/auth/session' && path !== '/auth/login') {
      onUnauthorized?.();
    }

    if (error.status === 403 && error.details.reason === 'csrf_token_invalid') {
      onCsrfFailure?.();
    }

    throw error;
  }

  return parsed as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  /** Public. The only call both deployments answer, and how the page learns which one it is. */
  health: (): Promise<Health> => request<Health>('/health'),

  session: (): Promise<SessionResponse> => request<SessionResponse>('/auth/session'),

  login: (password: string): Promise<{ operator: string; expiresAt: string }> =>
    request<{ operator: string; expiresAt: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),

  logout: (): Promise<{ signedOut: boolean }> =>
    request<{ signedOut: boolean }>('/auth/logout', { method: 'POST', body: JSON.stringify({}) }),

  // --- the recruiter API (P3-F) ---------------------------------------------

  jobs: (): Promise<{ jobs: JobSummary[] }> => request<{ jobs: JobSummary[] }>('/jobs'),

  job: (jobId: string): Promise<JobDetail> => request<JobDetail>(`/jobs/${encodeURIComponent(jobId)}`),

  ranking: (jobId: string): Promise<Ranking> => request<Ranking>(`/jobs/${encodeURIComponent(jobId)}/ranking`),

  evaluation: (evaluationId: string): Promise<EvaluationDetail> =>
    request<EvaluationDetail>(`/evaluations/${encodeURIComponent(evaluationId)}`),

  evaluationAudit: (evaluationId: string): Promise<{ events: AuditEntry[] }> =>
    request<{ events: AuditEntry[] }>(`/evaluations/${encodeURIComponent(evaluationId)}/audit`),

  /**
   * The redacted resume. Exists only in a visitor's demo session: the recruiter API
   * has no such route, so this is only ever called in the `demo` scope.
   */
  evaluationResume: (evaluationId: string): Promise<DemoResume> =>
    request<DemoResume>(`/evaluations/${encodeURIComponent(evaluationId)}/resume`),

  decide: (evaluationId: string, outcome: string, reason: string): Promise<DecisionResult> =>
    request<DecisionResult>(`/evaluations/${encodeURIComponent(evaluationId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ outcome, reason }),
    }),

  // --- the visitor-scoped demo session ---------------------------------------
  //
  // Each of these answers with the session's view, or a status saying there is
  // none. None of them sends or receives a token: the session is named by an
  // HttpOnly cookie the browser attaches by itself. They are left unresolved by
  // `resolveApiPath` — they are the session, not reads inside it.

  demoSession: (): Promise<unknown> => request<unknown>('/demo/session'),

  startDemoSession: (): Promise<unknown> =>
    request<unknown>('/demo/session', { method: 'POST', body: JSON.stringify({}) }),

  resetDemoSession: (): Promise<unknown> =>
    request<unknown>('/demo/session/reset', { method: 'POST', body: JSON.stringify({}) }),

  endDemoSession: (): Promise<{ ended: boolean }> =>
    request<{ ended: boolean }>('/demo/session', { method: 'DELETE' }),

};
