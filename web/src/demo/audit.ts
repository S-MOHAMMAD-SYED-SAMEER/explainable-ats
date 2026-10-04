// Reading the audit trail without trusting its shape.
//
// The audit trail is the source of truth for the pipeline and the timeline, and
// its payloads are free-form JSON. These readers take what is there and nothing
// else: a field that is missing, or the wrong type, is simply absent, and no
// reader throws. Everything built from them says only what an event actually
// carried — there is no default that stands in for a missing number, and no
// invented event to fill a gap.
//
// NOTHING HERE RETURNS AN IDENTIFIER. Payloads carry record ids (a requirement's,
// a job's, a candidate's); the readers pick out counts, words and labels, and the
// one id they must use — to find a requirement's name — is looked up and dropped.

export type Payload = Record<string, unknown>;

export function asRecord(value: unknown): Payload | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : null;
}

/** A finite, whole, non-negative count, or null. */
export function readCount(payload: Payload, key: string): number | null {
  const value = payload[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function readText(payload: Payload, key: string, maxLength = 2000): string | null {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value.slice(0, maxLength) : null;
}

export function readTextList(payload: Payload, key: string, limit = 20): string[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string').slice(0, limit);
}

export function readRecords(payload: Payload, key: string, limit = 50): Payload[] {
  const value = payload[key];
  if (!Array.isArray(value)) return [];
  const records: Payload[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record) records.push(record);
    if (records.length >= limit) break;
  }
  return records;
}

/** Whole numbers with thousands separators, the same in every locale. */
export function formatInt(value: number): string {
  return value.toLocaleString('en-US');
}

/** `protected_attribute` -> `protected attribute`, as the candidate screen words categories. */
export function wordsOf(identifier: string): string {
  return identifier.replace(/_/g, ' ');
}

/** The audit stages, in the words a visitor reads. */
export const STAGE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  job: 'Job',
  ingest: 'Ingest',
  redact: 'Redaction',
  extract: 'Extraction',
  verify: 'Evidence verification',
  match: 'Matching',
  score: 'Scoring',
  decide: 'Recruiter decision',
  system: 'System',
});

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? 'Other';
}

/** Why a quoted passage was refused, in words. Unknown reasons are described, not echoed. */
export function rejectionReason(reason: string): string {
  switch (reason) {
    case 'not_found_in_resume':
      return 'the passage was not found in the resume';
    case 'quotes_redacted_text':
      return 'the passage overlapped a masked personal detail';
    default:
      return 'the passage could not be verified';
  }
}
