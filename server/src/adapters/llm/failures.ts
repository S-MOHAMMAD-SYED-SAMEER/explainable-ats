import { LlmError } from './types.ts';

// Why a model call failed, as a fact the pipeline can act on.
//
// `LlmError` says only that something went wrong, which is all a caller needs to
// stop. The pipeline needs more: "the model declined", "the answer was cut off",
// "the service did not answer" and "the answer was not in the required shape" are
// different facts about a run, they call for different messages and different
// audit events, and none of them says anything about the candidate. A provider
// that knows which one it hit says so by throwing this instead of a bare
// `LlmError`; one that does not (the mock, or a future provider) still throws
// `LlmError`, which the pipeline treats as an unavailable service.

export const LLM_FAILURE_KINDS = [
  /** The model declined to produce an answer. */
  'refusal',
  /** The answer hit the output limit before it was complete. */
  'truncated',
  /** An answer arrived but not in the required shape (no tool call, wrong tool, bad payload). */
  'malformed',
  /** The service did not answer: a timeout, a dropped connection, a 5xx or a rate limit that outlasted the retries. */
  'unavailable',
  /** The service refused the request itself (bad key, bad setting, unknown model): a configuration problem. */
  'rejected',
  /** Anything else. A bug, not a property of the service or the CV. */
  'unexpected',
] as const;
export type LlmFailureKind = (typeof LLM_FAILURE_KINDS)[number];

export type LlmFailureDetails = {
  /** A short, key-free description, such as "timeout" or "HTTP 529". For the audit trail. */
  label?: string;
  /** How many requests were made, retries included. */
  attempts?: number;
  /** The model the call went to, when known. */
  model?: string;
  /** Time spent on the call, retries included. */
  latencyMs?: number;
  /** Present only when the provider reported it on a reply that was then refused. */
  usage?: { inputTokens: number; outputTokens: number };
  /** The tool input exactly as received, when there was one. Partial for a truncated answer. */
  raw?: unknown;
};

export class LlmFailure extends LlmError {
  readonly kind: LlmFailureKind;
  readonly details: LlmFailureDetails;

  constructor(provider: string, kind: LlmFailureKind, message: string, details: LlmFailureDetails = {}) {
    super(provider, message);
    this.name = 'LlmFailure';
    this.kind = kind;
    this.details = details;
  }
}

/** What kind of failure this is, for any error a provider may throw. */
export function failureKindOf(err: unknown): LlmFailureKind {
  if (err instanceof LlmFailure) return err.kind;
  // A provider that throws a plain `LlmError` is saying it could not answer.
  if (err instanceof LlmError) return 'unavailable';
  return 'unexpected';
}
