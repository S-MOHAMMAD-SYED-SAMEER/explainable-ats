import type { AuditEntry, EvaluationDetail } from '../api/types.ts';
import { outcomeWording, verdictWording } from '../copy.ts';
import { DEMO_LABELS } from './copy.ts';
import {
  asRecord,
  formatInt,
  readCount,
  readRecords,
  readText,
  readTextList,
  rejectionReason,
  stageLabel,
  wordsOf,
  type Payload,
} from './audit.ts';

// The audit trail as a timeline a visitor can read.
//
// THE AUDIT TRAIL REMAINS THE SOURCE OF TRUTH
//
// Every item is one event the pipeline actually recorded, in the order it was
// recorded, with the timestamp it was stored with. Nothing is added to fill a
// gap and nothing is reordered to read better. What this module does is word
// each event for a person and, where the event's payload carries the arithmetic
// or the provenance behind it, lay that out as detail lines the visitor can open.
//
// DETAILS COME FROM A SHORT LIST, NOT FROM THE PAYLOAD
//
// Each event type has its own reader that picks out named fields. A payload is
// never dumped, so a field nobody planned for — an id, a count that means
// something internal — cannot reach the screen by being present. An event type
// with no reader shows its summary and no details. Record ids in payloads are
// used only to find a requirement's name and are never returned.

export type DetailLine = { label: string; value: string };

export type TimelineItem = {
  /** Position in the sorted trail. Stable, and not a database id. */
  key: string;
  stage: string;
  stageLabel: string;
  title: string;
  /** The stored timestamp, unchanged. */
  at: string;
  /** Only where it means something: the stand-in extractor, and the demo recruiter. */
  actor: string | null;
  /** Set for anything other than a plain success, in words. */
  outcome: string | null;
  details: DetailLine[];
  /** The demo recruiter's decision. */
  isDecision: boolean;
};

type Named = Pick<EvaluationDetail, 'requirements'>;

const OUTCOME_LABEL: Readonly<Record<string, string>> = Object.freeze({
  blocked: 'Warning',
  failed: 'Failed',
  skipped: 'Skipped',
});

/**
 * Oldest first. Ties on the stored time fall back to the event's own sequence and
 * then to the order received, so the result never depends on the sort algorithm.
 */
export function sortTrail(events: readonly AuditEntry[]): AuditEntry[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) =>
      a.event.createdAt < b.event.createdAt
        ? -1
        : a.event.createdAt > b.event.createdAt
          ? 1
          : a.event.sequence - b.event.sequence || a.index - b.index,
    )
    .map((entry) => entry.event);
}

function nameOfRequirement(detail: Named, requirementId: string | null, fallbackIndex: number): string {
  const found = requirementId === null ? undefined : detail.requirements.find((r) => r.requirementId === requirementId);
  return found?.label ?? `Requirement ${fallbackIndex + 1}`;
}

function actorFor(event: AuditEntry): string | null {
  if (event.actor === 'ai') {
    return event.actorId === 'mock' ? 'Deterministic demo extraction (no AI model)' : 'Language model';
  }
  if (event.eventType === 'decision_recorded') return 'Demo recruiter';
  return null;
}

function detailsFor(event: AuditEntry, detail: Named): DetailLine[] {
  const payload: Payload = asRecord(event.payload) ?? {};
  const lines: DetailLine[] = [];
  const add = (label: string, value: string | number | null): void => {
    if (value === null) return;
    lines.push({ label, value: typeof value === 'number' ? formatInt(value) : value });
  };

  switch (event.eventType) {
    case 'resume_ingested':
      add('Characters stored', readCount(payload, 'charCount'));
      break;

    case 'sensitive_attributes_masked': {
      add('Details masked', readCount(payload, 'count'));
      const categories = readTextList(payload, 'categories').map(wordsOf);
      if (categories.length > 0) add('Categories', categories.join(', '));
      add('Values recorded', 'None — only the category and position are kept');
      break;
    }

    case 'extraction_recorded': {
      const model = readText(payload, 'model', 80);
      add('Extraction', model === 'mock' || event.actorId === 'mock' ? `${DEMO_LABELS.extraction} — a fixed keyword matcher, no language model` : model);
      add('Requirements read', readCount(payload, 'requirements'));
      break;
    }

    case 'malformed_findings_dropped':
      add('Findings dropped', readTextList(payload, 'reasons').length || null);
      break;

    case 'evidence_verified':
      add('Verified against the resume', readCount(payload, 'verified'));
      add('Rejected', readCount(payload, 'rejected'));
      add('Malformed', readCount(payload, 'malformed'));
      add('Offsets corrected', readCount(payload, 'offsetsCorrected'));
      break;

    case 'unverifiable_evidence_rejected': {
      const reasons = [...new Set(readTextList(payload, 'reasons').map(rejectionReason))];
      if (reasons.length > 0) add('Why', reasons.join('; '));
      break;
    }

    case 'unverified_evidence_ignored':
      add('Ignored', readCount(payload, 'ignored'));
      add('Counted', readCount(payload, 'counted'));
      break;

    case 'requirements_matched': {
      readRecords(payload, 'verdicts').forEach((row, index) => {
        const verdict = readText(row, 'verdict', 40);
        const confidence = readText(row, 'confidence', 40);
        const label = readText(row, 'label', 120) ?? nameOfRequirement(detail, readText(row, 'requirementId', 200), index);
        add(label, `${verdictWording(verdict).label}${confidence ? ` (confidence: ${confidence})` : ''}`);
      });
      add('Verified passages counted', readCount(payload, 'evidenceCounted'));
      break;
    }

    case 'score_computed': {
      readRecords(payload, 'contributions').forEach((row, index) => {
        const label = nameOfRequirement(detail, readText(row, 'requirementId', 200), index);
        const weight = readCount(row, 'weightApplied');
        const points = readCount(row, 'contributionBasisPoints');
        const verdict = readText(row, 'verdict', 40);
        const parts = [
          weight !== null ? `weight ${formatInt(weight)}` : null,
          verdict ? verdictWording(verdict).label.toLowerCase() : null,
          points !== null ? `${formatInt(points)} points` : null,
        ].filter((part): part is string => part !== null);
        if (parts.length > 0) add(label, parts.join(' · '));
      });
      add('Total weight', readCount(payload, 'totalWeight'));
      const score = readCount(payload, 'scoreBasisPoints');
      if (score !== null) add('Score', `${formatInt(score)} of 10,000 points`);
      const met = readCount(payload, 'mustHavesMet');
      const total = readCount(payload, 'mustHavesTotal');
      if (met !== null && total !== null) add('Essential requirements met', `${met} of ${total}`);
      const unclear = readCount(payload, 'mustHavesUnclear');
      if (unclear !== null && unclear > 0) add('Essential requirements not demonstrated', unclear);
      break;
    }

    case 'decision_recorded': {
      const outcome = readText(payload, 'outcome', 20);
      if (outcome) add('Outcome', outcomeWording(outcome).label);
      add('Reason', readText(payload, 'reason'));
      add('Recorded by', `Demo recruiter (${event.actorId ?? 'demo'}) — stand-in, not a real recruiter`);
      add('Scope', 'Saved only in your private demo session; it affects no real recruiter record');
      break;
    }

    // `evaluation_opened`, `resume_already_present`, `extraction_failed`,
    // `no_sensitive_attributes_found` and anything not yet known: the summary
    // says it all, and the payload is not shown.
    default:
      break;
  }

  return lines;
}

function titleFor(event: AuditEntry): string {
  if (event.eventType === 'decision_recorded') {
    const outcome = readText(asRecord(event.payload) ?? {}, 'outcome', 20);
    return `${DEMO_LABELS.decision}${outcome ? `: ${outcomeWording(outcome).label}` : ''}`;
  }
  return event.summary;
}

export function buildTimeline(events: readonly AuditEntry[], detail: Named): TimelineItem[] {
  return sortTrail(events).map((event, index): TimelineItem => ({
    key: `event-${index}`,
    stage: event.stage,
    stageLabel: event.eventType === 'evaluation_opened' ? 'Evaluation' : stageLabel(event.stage),
    title: titleFor(event),
    at: event.createdAt,
    actor: actorFor(event),
    outcome: OUTCOME_LABEL[event.outcome] ?? null,
    details: detailsFor(event, detail),
    isDecision: event.eventType === 'decision_recorded',
  }));
}
