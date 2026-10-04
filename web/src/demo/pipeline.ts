import type { AuditEntry, EvaluationDetail } from '../api/types.ts';
import { outcomeWording } from '../copy.ts';
import { DEMO_LABELS } from './copy.ts';
import { asRecord, formatInt, readCount, readRecords, readText, readTextList, rejectionReason, wordsOf } from './audit.ts';

// The pipeline a candidate went through, from what was actually recorded.
//
// WHAT IS AND IS NOT CLAIMED
//
// Each stage is drawn from the audit events the pipeline wrote for THIS
// evaluation, and from nothing else. A stage with no event is "Not run", not
// quietly shown as done. Timestamps are the stored ones, never made up or
// rounded into existence. Ranking is the one stage with no audit event, because
// the ranking is derived each time the list is read rather than recorded; it is
// shown as exactly that, with the position the live ranking reports — and as
// "Unavailable" if that could not be read. A stage whose events could not be
// loaded at all is "Unavailable" too: not knowing is a different fact from not
// having run.
//
// It is a pure function of its inputs, so it can be tested over the real
// pipeline's output for every demo candidate.

export const PIPELINE_STAGES = [
  { id: 'ingest', label: 'Ingest' },
  { id: 'redact', label: 'Redaction' },
  { id: 'extract', label: 'Extraction' },
  { id: 'verify', label: 'Evidence verification' },
  { id: 'match', label: 'Matching' },
  { id: 'score', label: 'Scoring' },
  { id: 'rank', label: 'Ranking' },
  { id: 'decide', label: 'Recruiter decision' },
] as const;

export type StageId = (typeof PIPELINE_STAGES)[number]['id'];

export type StageStatus = 'recorded' | 'warning' | 'failed' | 'not_run' | 'derived' | 'unavailable';

/** The status as a word. It is shown as text beside the stage, never as colour alone. */
export const STATUS_LABEL: Readonly<Record<StageStatus, string>> = Object.freeze({
  recorded: 'Recorded',
  warning: 'Recorded, with a warning',
  failed: 'Failed',
  not_run: 'Not run',
  derived: 'Derived on read',
  unavailable: 'Unavailable',
});

export type PipelineStage = {
  id: StageId;
  label: string;
  status: StageStatus;
  statusLabel: string;
  /** When it happened, as stored. Null when nothing was recorded — never a guess. */
  at: string | null;
  /** One sentence on what happened, limited to what the data supports. */
  explanation: string;
  /** Short facts read from the events themselves. */
  facts: string[];
};

/** What the live ranking says about this evaluation, or that it could not be read. */
export type RankingInput =
  | { state: 'ready'; rank: number | null; position: number | null; rankedCount: number; total: number }
  | { state: 'unavailable' };

export type PipelineInput = {
  /** The evaluation's audit events, or null if they could not be loaded. */
  events: readonly AuditEntry[] | null;
  detail: Pick<EvaluationDetail, 'model' | 'scorePercent' | 'mustHavesMet' | 'mustHavesTotal' | 'decision'>;
  ranking: RankingInput;
};

function outcomeOf(events: readonly AuditEntry[]): StageStatus {
  if (events.length === 0) return 'not_run';
  if (events.some((event) => event.outcome === 'failed')) return 'failed';
  if (events.some((event) => event.outcome === 'blocked')) return 'warning';
  return 'recorded';
}

function latest(events: readonly AuditEntry[]): string | null {
  let best: string | null = null;
  for (const event of events) {
    if (best === null || event.createdAt > best) best = event.createdAt;
  }
  return best;
}

function find(events: readonly AuditEntry[], eventType: string): AuditEntry | undefined {
  return events.find((event) => event.eventType === eventType);
}

function plural(count: number, one: string, many: string): string {
  return `${formatInt(count)} ${count === 1 ? one : many}`;
}

export function buildPipeline({ events, detail, ranking }: PipelineInput): PipelineStage[] {
  return PIPELINE_STAGES.map(({ id, label }): PipelineStage => {
    const make = (
      status: StageStatus,
      at: string | null,
      explanation: string,
      facts: string[] = [],
    ): PipelineStage => ({ id, label, status, statusLabel: STATUS_LABEL[status], at, explanation, facts });

    // Ranking is not an audit stage. It is read from the live ranking.
    if (id === 'rank') {
      if (ranking.state === 'unavailable') {
        return make('unavailable', null, 'The ranking could not be read, so this stage cannot be described.');
      }
      const facts =
        ranking.rank !== null && ranking.position !== null
          ? [`Rank ${ranking.rank} of ${ranking.rankedCount} ranked`, `${plural(ranking.total, 'candidate', 'candidates')} listed in all`]
          : ['Not ranked: this candidate has no score yet', `${plural(ranking.total, 'candidate', 'candidates')} listed in all`];
      return make(
        'derived',
        null,
        'Candidates were ordered using the deterministic ranking rules. Ranking is worked out each time the list is read, so it is not stored as an event.',
        facts,
      );
    }

    // The decision is read from the evaluation and, for its time, from its event.
    if (id === 'decide') {
      if (events === null && detail.decision === null) {
        return make('unavailable', null, 'The audit trail could not be loaded, so this stage cannot be described.');
      }
      const event = events ? find(events, 'decision_recorded') : undefined;
      if (detail.decision === null) {
        return make('not_run', null, 'No decision has been recorded for this candidate yet.');
      }
      return make(
        'recorded',
        event?.createdAt ?? detail.decision.decidedAt,
        'Demo recruiter decision recorded in this private demo session.',
        [`Outcome: ${outcomeWording(detail.decision.outcome).label}`],
      );
    }

    if (events === null) {
      return make('unavailable', null, 'The audit trail could not be loaded, so this stage cannot be described.');
    }

    // `evaluation_opened` is filed under the extract stage but is not extraction.
    const own = events.filter((event) => event.stage === id && event.eventType !== 'evaluation_opened');
    const status = outcomeOf(own);
    const at = latest(own);

    switch (id) {
      case 'ingest': {
        if (own.length === 0) return make('not_run', null, 'No resume was recorded as entering the pipeline.');
        const ingested = find(own, 'resume_ingested');
        const chars = ingested ? readCount(asRecord(ingested.payload) ?? {}, 'charCount') : null;
        const facts = chars !== null ? [`${plural(chars, 'character', 'characters')} stored`] : [];
        if (find(own, 'resume_already_present')) facts.push('This document had already been stored; nothing was written twice');
        return make(status, at, 'Resume text entered the evaluation pipeline.', facts);
      }

      case 'redact': {
        if (own.length === 0) return make('not_run', null, 'No redaction was recorded for this resume.');
        const masked = find(own, 'sensitive_attributes_masked');
        if (!masked) {
          return make(status, at, 'The resume was checked for personal identifiers before anything read it.', [
            'No protected attributes were detected',
          ]);
        }
        const payload = asRecord(masked.payload) ?? {};
        const count = readCount(payload, 'count');
        const categories = readTextList(payload, 'categories').map(wordsOf);
        const facts: string[] = [];
        if (count !== null) facts.push(`${plural(count, 'detail', 'details')} masked`);
        if (categories.length > 0) facts.push(`Categories: ${categories.join(', ')}`);
        facts.push('Only the category and position are recorded, never the value');
        return make(status, at, 'Personal identifiers were masked before anything read the resume.', facts);
      }

      case 'extract': {
        if (own.length === 0) {
          return make('not_run', null, 'Extraction has not run for this candidate, so there is nothing further to show.');
        }
        if (find(own, 'extraction_failed')) {
          return make('failed', at, 'Extraction did not complete, so no evidence was gathered.');
        }
        const recorded = find(own, 'extraction_recorded');
        const payload = recorded ? (asRecord(recorded.payload) ?? {}) : {};
        const standIn = detail.model === 'mock' || readText(payload, 'model') === 'mock' || recorded?.actorId === 'mock';
        const facts: string[] = [];
        const requirements = readCount(payload, 'requirements');
        if (requirements !== null) facts.push(`Read against ${plural(requirements, 'requirement', 'requirements')}`);
        const dropped = find(own, 'malformed_findings_dropped');
        if (dropped) facts.push('Some findings did not match the required shape and were dropped');
        return make(
          status,
          at,
          standIn
            ? `${DEMO_LABELS.extraction}: passages were picked from the redacted resume by a fixed keyword matcher — no language model was used.`
            : 'Candidate passages were proposed from the redacted resume.',
          facts,
        );
      }

      case 'verify': {
        if (own.length === 0) return make('not_run', null, 'No evidence was checked for this candidate.');
        const done = find(own, 'evidence_verified');
        const payload = done ? (asRecord(done.payload) ?? {}) : {};
        const facts: string[] = [];
        const verified = readCount(payload, 'verified');
        const rejected = readCount(payload, 'rejected');
        if (verified !== null) facts.push(`${plural(verified, 'passage', 'passages')} found in the resume exactly as quoted`);
        if (rejected !== null && rejected > 0) facts.push(`${plural(rejected, 'passage', 'passages')} rejected and never counted`);
        const refused = find(own, 'unverifiable_evidence_rejected');
        if (refused) {
          const reasons = readTextList(asRecord(refused.payload) ?? {}, 'reasons').map(rejectionReason);
          if (reasons.length > 0) facts.push(`Why: ${[...new Set(reasons)].join('; ')}`);
        }
        return make(status, at, 'Evidence was checked against the resume text.', facts);
      }

      case 'match': {
        if (own.length === 0) return make('not_run', null, 'No requirement was matched for this candidate.');
        const matched = find(own, 'requirements_matched');
        const payload = matched ? (asRecord(matched.payload) ?? {}) : {};
        const judged = readRecords(payload, 'verdicts').length;
        const counted = readCount(payload, 'evidenceCounted');
        const facts: string[] = [];
        if (judged > 0) {
          facts.push(
            `${plural(judged, 'requirement', 'requirements')} judged` +
              (counted !== null ? ` against ${plural(counted, 'verified passage', 'verified passages')}` : ''),
          );
        }
        if (find(own, 'unverified_evidence_ignored')) facts.push('Unverified passages were present and took no part');
        return make(status, at, 'Each job requirement was evaluated using deterministic rules.', facts);
      }

      case 'score': {
        if (own.length === 0) return make('not_run', null, 'No score was recorded for this candidate.');
        const scored = find(own, 'score_computed');
        const payload = scored ? (asRecord(scored.payload) ?? {}) : {};
        const facts: string[] = [];
        if (detail.scorePercent !== null) facts.push(`Score: ${detail.scorePercent}`);
        const met = readCount(payload, 'mustHavesMet') ?? detail.mustHavesMet;
        const total = readCount(payload, 'mustHavesTotal') ?? detail.mustHavesTotal;
        if (met !== null && total !== null) facts.push(`Essential requirements met: ${met} of ${total}`);
        return make(status, at, 'Requirement outcomes and weights produced the candidate score.', facts);
      }

      default:
        return make('unavailable', null, 'This stage cannot be described.');
    }
  });
}
