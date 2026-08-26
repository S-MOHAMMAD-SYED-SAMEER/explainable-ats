import { CSRF_HEADER, currentCsrfToken, needsCsrf, type SessionResponse } from '../auth/session.ts';
import type {
  AuditEntry,
  DecisionResult,
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

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(csrf ? { [CSRF_HEADER]: csrf } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
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
    if (error.status === 401 && path !== '/auth/session' && path !== '/auth/login') {
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
  /** Public. The only call that works without a session. */
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

  decide: (evaluationId: string, outcome: string, reason: string): Promise<DecisionResult> =>
    request<DecisionResult>(`/evaluations/${encodeURIComponent(evaluationId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ outcome, reason }),
    }),
};
