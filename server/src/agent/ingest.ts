import { redact } from './redact.ts';
import { AppError } from '../lib/errors.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { Logger } from '../lib/logger.ts';
import type { Candidate, CandidateSource, Resume } from '../domain/ats.ts';

// Ingestion.
//
// One rule shapes this whole file: a resume is redacted before it is stored,
// and `redacted_text` is written in the same transaction as `content_text`. If
// the two could be written separately there would be a window in which a
// resume existed with no redaction, and anything reading it in that window
// would hand the model the original.

export type IngestDeps = {
  repos: Repositories;
  logger?: Logger;
};

export type IngestResumeInput = {
  /** What the system will call this person. Safe for a log or a filename. */
  reference: string;
  /** What a recruiter reads. Also redacted out of the resume text. */
  displayName?: string | null;
  text: string;
  source?: CandidateSource;
};

export type IngestResult = {
  candidate: Candidate;
  resume: Resume;
  /** False when this exact document was already stored for this candidate. */
  created: boolean;
  /** How many protected attributes were found and masked. */
  redactedCount: number;
};

const MAX_RESUME_CHARS = 200_000;

/**
 * Ingests one plain-text resume.
 *
 * Idempotent by content hash: the same document twice is one resume, because
 * every evidence offset indexes into one specific `content_text` and two copies
 * would split one person's evidence across two records.
 */
export async function ingestResume(deps: IngestDeps, input: IngestResumeInput): Promise<IngestResult> {
  const { repos, logger } = deps;

  const text = input.text;
  if (text.trim().length === 0) {
    throw new AppError('VALIDATION_ERROR', 'A resume cannot be empty.');
  }
  if (text.length > MAX_RESUME_CHARS) {
    throw new AppError('VALIDATION_ERROR', `A resume cannot exceed ${MAX_RESUME_CHARS} characters.`);
  }

  const candidate =
    (await repos.candidates.findByReference(input.reference)) ??
    (await repos.candidates.create({
      reference: input.reference,
      displayName: input.displayName ?? null,
      source: input.source ?? 'upload',
    }));

  // Redact BEFORE anything is stored. The candidate's own name is passed in
  // rather than guessed: general name detection over free text is unreliable in
  // both directions, and a false positive deletes the evidence the product
  // exists to find.
  const { redactedText, spans } = redact(text, {
    knownNames: candidate.displayName ? [candidate.displayName] : [],
  });

  const { resume, created } = await repos.resumes.insertIfNew({
    candidateId: candidate.id,
    contentText: text,
    redactedText,
  });

  if (!created) {
    // Already stored, with its findings already recorded. Re-recording them
    // would duplicate the quarantine for one document.
    logger?.info('Resume already ingested; nothing was written.', { candidate: candidate.reference });
    await repos.audit.append({
      correlationId: resume.id,
      stage: 'ingest',
      eventType: 'resume_already_present',
      actor: 'system',
      outcome: 'skipped',
      summary: `This document was already stored for ${candidate.reference}.`,
      payload: { candidateReference: candidate.reference },
      entityType: 'resume',
      entityId: resume.id,
    });
    const existing = await repos.sensitiveFindings.listForResume(resume.id);
    return { candidate, resume, created: false, redactedCount: existing.length };
  }

  for (const span of spans) {
    await repos.sensitiveFindings.record({
      resumeId: resume.id,
      category: span.category,
      charStart: span.charStart,
      charEnd: span.charEnd,
    });
  }

  await repos.audit.append({
    correlationId: resume.id,
    stage: 'ingest',
    eventType: 'resume_ingested',
    actor: 'system',
    outcome: 'ok',
    summary: `Stored a ${text.length}-character resume for ${candidate.reference}.`,
    payload: { candidateReference: candidate.reference, charCount: text.length },
    entityType: 'resume',
    entityId: resume.id,
  });

  // The categories, never the values. This event is the evidence that the
  // boundary was applied, so it has to be safe to read.
  await repos.audit.append({
    correlationId: resume.id,
    stage: 'redact',
    eventType: spans.length > 0 ? 'sensitive_attributes_masked' : 'no_sensitive_attributes_found',
    actor: 'system',
    outcome: 'ok',
    summary:
      spans.length > 0
        ? `Masked ${spans.length} protected attribute(s) before anything read this resume.`
        : 'No protected attributes were detected.',
    payload: { categories: [...new Set(spans.map((span) => span.category))].sort(), count: spans.length },
    entityType: 'resume',
    entityId: resume.id,
  });

  logger?.info('Resume ingested.', { candidate: candidate.reference, redacted: spans.length });
  return { candidate, resume, created: true, redactedCount: spans.length };
}

export type CreateJobInput = {
  title: string;
  seniority: 'junior' | 'mid' | 'senior' | 'lead';
  description?: string;
  requirements: Array<{
    label: string;
    criterion: string;
    kind: 'must_have' | 'nice_to_have';
    weight: number;
  }>;
};

/**
 * Creates a job and its requirements together.
 *
 * A job with no requirements cannot be evaluated against anything, so it is
 * refused here rather than producing an evaluation that scores zero out of
 * zero and looks like a rejection.
 */
export async function createJob(deps: IngestDeps, input: CreateJobInput) {
  const { repos } = deps;

  if (input.requirements.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'A job needs at least one requirement to evaluate anyone against.');
  }

  const job = await repos.jobs.create({
    title: input.title,
    seniority: input.seniority,
    description: input.description ?? '',
    status: 'open',
  });

  for (const requirement of input.requirements) {
    await repos.requirements.create({ jobId: job.id, ...requirement });
  }

  const requirements = await repos.requirements.listForJob(job.id);

  await repos.audit.append({
    correlationId: job.id,
    stage: 'job',
    eventType: 'job_created',
    actor: 'human',
    outcome: 'ok',
    summary: `Created "${job.title}" with ${requirements.length} requirement(s).`,
    payload: {
      mustHaves: requirements.filter((r) => r.kind === 'must_have').length,
      niceToHaves: requirements.filter((r) => r.kind === 'nice_to_have').length,
    },
    entityType: 'job',
    entityId: job.id,
  });

  return { job, requirements };
}
