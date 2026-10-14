import { LLM_FAILURE_KINDS, type LlmFailureKind } from '../adapters/llm/failures.ts';

// What each way an extraction can fail is called, said, and recorded as.
//
// One table, so the three places that need it (the audit event, the message a
// recruiter reads, the stored failure kind) cannot drift apart. The messages are
// written for a person deciding what to do next, and they all say the same two
// things first: that nothing was scored, and what kind of problem it was. None of
// them names a provider, a model or a setting, and none says anything about the
// candidate, because none of these failures is a fact about the candidate.

export type FailureWording = {
  /** The audit event type. One per kind, so the trail says which it was. */
  eventType: string;
  /** Shown to a recruiter as the reason the assessment failed. */
  message: string;
  /** The audit event's own summary line. */
  summary: string;
};

export const FAILURE_WORDING: Readonly<Record<LlmFailureKind, FailureWording>> = Object.freeze({
  refusal: {
    eventType: 'extraction_refused',
    message:
      'The model declined to read this CV, so nothing was scored. Running it again sometimes helps; if it declines every time, the CV text itself may need a look.',
    summary: 'The model declined to process this resume, so no evidence was gathered.',
  },
  truncated: {
    eventType: 'extraction_truncated',
    message:
      "The model's answer was cut off before it finished, so nothing was scored. This CV or role is larger than the answer limit allows for. It is not a verdict on the candidate.",
    summary: 'The answer reached its length limit before it was complete, so none of it was used.',
  },
  malformed: {
    eventType: 'extraction_malformed',
    message:
      "The model's answer was not in the form the system requires, so nothing was scored. Running it again usually fixes this.",
    summary: 'The answer was not in the required shape, so none of it was used.',
  },
  unavailable: {
    eventType: 'extraction_unavailable',
    message:
      'The model service could not be reached, or took too long to answer, so nothing was scored. Try again in a few minutes.',
    summary: 'The extraction service did not answer, so no evidence was gathered.',
  },
  rejected: {
    eventType: 'extraction_rejected',
    message:
      'The model service refused the request. That points to how the system is set up rather than to this CV, so nothing was scored. Tell whoever runs the system.',
    summary: 'The extraction service refused the request itself, so no evidence was gathered.',
  },
  unexpected: {
    eventType: 'extraction_unexpected_error',
    message: 'The assessment could not be completed because of an unexpected error. Nothing was scored. Try running it again.',
    summary: 'Extraction stopped on an unexpected error, so no evidence was gathered.',
  },
});

/** Every audit event type that means "extraction failed", for screens that read the trail. */
export const EXTRACTION_FAILURE_EVENTS: readonly string[] = LLM_FAILURE_KINDS.map(
  (kind) => FAILURE_WORDING[kind].eventType,
);

/** Not a failure: the model answered properly and found nothing. Never a failed evaluation. */
export const EXTRACTION_EMPTY_EVENT = 'extraction_empty';
