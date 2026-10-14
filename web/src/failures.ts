// The audit events that mean "extraction failed", and the one that means "the model found nothing".
//
// Mirrors the server's `agent/failures.ts`, which is where they are decided; a test reads
// that file and fails if these drift. Kept here so the demo's pipeline view does not have to
// know the server's module layout, only its vocabulary.

export const EXTRACTION_FAILURE_EVENTS: readonly string[] = [
  'extraction_refused',
  'extraction_truncated',
  'extraction_malformed',
  'extraction_unavailable',
  'extraction_rejected',
  'extraction_unexpected_error',
];

export const EXTRACTION_EMPTY_EVENT = 'extraction_empty';

export function isExtractionFailureEvent(eventType: string): boolean {
  return EXTRACTION_FAILURE_EVENTS.includes(eventType);
}
