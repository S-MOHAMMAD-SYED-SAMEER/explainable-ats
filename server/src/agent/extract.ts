import { EXTRACTION_PROMPT_VERSION, EXTRACTION_TOOL, validateExtraction } from './extractionSchema.ts';
import { verifyEvidence } from './verifyEvidence.ts';
import { buildSystemPrompt, buildUserMessage } from './extractionPrompt.ts';
import { AppError } from '../lib/errors.ts';
import { systemClock, type Clock } from '../lib/clock.ts';
import type { LlmProvider } from '../adapters/llm/types.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { Logger } from '../lib/logger.ts';
import type { Evaluation, Resume } from '../domain/ats.ts';
import type { RedactionSpan } from './redact.ts';

// EXTRACT — the one stage that talks to a model.
//
// Everything after it is deterministic. This stage's whole job is to turn a
// resume into cited passages, and then to prove each citation before anyone can
// use it. Two rules make that work:
//
//   1. The model is shown `redacted_text` and never the original.
//   2. Every quote is checked against `content_text` — the real document —
//      before `verified` is set. Nothing downstream reads unverified evidence.
//
// A quote that cannot be found is recorded as rejected rather than discarded
// silently. A fabrication that leaves no trace is a fabrication nobody can
// learn from, and the audit trail is where that lesson lives.

export type ExtractDeps = {
  repos: Repositories;
  provider: LlmProvider;
  logger?: Logger;
  clock?: Clock;
};

export type ExtractionOutcome = {
  evaluation: Evaluation;
  /** Passages that were found in the resume and stored as usable evidence. */
  verified: number;
  /** Quotes that were not in the resume, or that quoted masked text. */
  rejected: number;
  /** Findings the model returned in a shape the contract does not allow. */
  malformed: number;
};

const MAX_TOKENS = 2048;

/**
 * Runs extraction for one evaluation.
 *
 * The evaluation must already exist and be `pending`: opening it is a separate
 * step so that re-running is an explicit act that supersedes, rather than
 * something that happens implicitly whenever a resume is read.
 */
export async function extractEvidence(deps: ExtractDeps, evaluationId: string): Promise<ExtractionOutcome> {
  const { repos, provider, logger } = deps;
  const clock = deps.clock ?? systemClock;

  const evaluation = await repos.evaluations.getById(evaluationId);
  if (!evaluation) throw new AppError('NOT_FOUND', 'That evaluation does not exist.');
  if (evaluation.status !== 'pending') {
    throw new AppError('INVALID_STATE', `This evaluation has already been ${evaluation.status}.`);
  }

  const resume = await repos.resumes.getById(evaluation.resumeId);
  if (!resume) throw new AppError('INVALID_STATE', 'The resume for this evaluation is missing.');

  const requirements = await repos.requirements.listForJob(evaluation.jobId);
  if (requirements.length === 0) {
    throw new AppError('INVALID_STATE', 'This job has no requirements, so there is nothing to look for.');
  }

  const findings = await repos.sensitiveFindings.listForResume(resume.id);
  const redactionSpans: RedactionSpan[] = findings.map((finding) => ({
    category: finding.category,
    charStart: finding.charStart,
    charEnd: finding.charEnd,
  }));

  // --- the model call ------------------------------------------------------
  //
  // `redactedText` and nothing else. The original never enters this scope.
  const started = clock.nowIso();
  let output: Record<string, unknown>;
  let model: string;
  let latencyMs: number;

  try {
    const response = await provider.complete({
      purpose: 'extract_evidence',
      promptVersion: EXTRACTION_PROMPT_VERSION,
      systemPrompt: buildSystemPrompt(),
      messages: [{ role: 'user', content: buildUserMessage(requirements, resume.redactedText) }],
      tool: EXTRACTION_TOOL,
      maxTokens: MAX_TOKENS,
    });
    output = response.output;
    model = response.model;
    latencyMs = response.latencyMs;
  } catch (err) {
    // A provider failure is recorded as a failure. It never becomes an empty
    // result, because "the model found nothing" and "the model could not be
    // reached" are different facts and only one of them says anything about
    // the candidate.
    const message = err instanceof Error ? err.message : String(err);
    await repos.evaluations.recordFailure(evaluationId, 'The extraction provider could not be reached.');
    await repos.audit.append({
      correlationId: evaluation.id,
      stage: 'extract',
      eventType: 'extraction_failed',
      actor: 'system',
      outcome: 'failed',
      summary: 'The extraction provider could not be reached, so no evidence was gathered.',
      payload: { provider: provider.name },
      entityType: 'evaluation',
      entityId: evaluation.id,
    });
    logger?.error('Extraction failed', { evaluationId, internal: message });
    throw new AppError('PROVIDER_UNAVAILABLE', 'The extraction provider could not be reached.');
  }
  void started;

  // --- validate the shape --------------------------------------------------

  const known = new Set(requirements.map((requirement) => requirement.id));
  const { accepted, rejected: malformed } = validateExtraction(output, known);

  if (malformed.length > 0) {
    await repos.audit.append({
      correlationId: evaluation.id,
      stage: 'extract',
      eventType: 'malformed_findings_dropped',
      actor: 'system',
      outcome: 'blocked',
      summary: `${malformed.length} finding(s) did not match the required shape and were dropped.`,
      payload: { reasons: malformed.map((entry) => entry.reason), details: malformed.map((entry) => entry.detail) },
      entityType: 'evaluation',
      entityId: evaluation.id,
    });
  }

  // --- verify every quote against the REAL resume --------------------------

  const { verified, rejected } = verifyEvidence(accepted, {
    contentText: resume.contentText,
    redactionSpans,
  });

  for (const entry of verified) {
    await repos.evidence.record({
      evaluationId: evaluation.id,
      resumeId: resume.id,
      requirementId: entry.finding.requirementId,
      quote: entry.finding.quote,
      charStart: entry.charStart,
      charEnd: entry.charEnd,
      verified: true,
    });
  }

  // Stored, but never verified — so `listVerifiedForEvaluation` excludes them
  // and nothing downstream can show or score them. They exist so a fabrication
  // is visible rather than invisible.
  for (const entry of rejected) {
    await repos.evidence.record({
      evaluationId: evaluation.id,
      resumeId: resume.id,
      requirementId: entry.finding.requirementId,
      quote: entry.finding.quote,
      charStart: Math.max(0, entry.finding.charStart),
      charEnd: Math.max(1, entry.finding.charEnd),
      verified: false,
    });
  }

  if (rejected.length > 0) {
    await repos.audit.append({
      correlationId: evaluation.id,
      stage: 'verify',
      eventType: 'unverifiable_evidence_rejected',
      actor: 'system',
      outcome: 'blocked',
      summary:
        `${rejected.length} quoted passage(s) could not be found in the resume and were rejected. ` +
        'Nothing that cannot be found in the document is shown or counted.',
      payload: { reasons: rejected.map((entry) => entry.reason) },
      entityType: 'evaluation',
      entityId: evaluation.id,
    });
  }

  await repos.audit.append({
    correlationId: evaluation.id,
    stage: 'verify',
    eventType: 'evidence_verified',
    actor: 'system',
    outcome: 'ok',
    summary: `${verified.length} passage(s) were found in the resume exactly as quoted.`,
    payload: {
      verified: verified.length,
      rejected: rejected.length,
      malformed: malformed.length,
      offsetsCorrected: verified.filter((entry) => !entry.offsetsWereCorrect).length,
    },
    entityType: 'evaluation',
    entityId: evaluation.id,
  });

  const updated = await repos.evaluations.recordExtraction(evaluation.id, {
    model,
    promptVersion: EXTRACTION_PROMPT_VERSION,
    latencyMs,
  });
  if (!updated) throw new AppError('INVALID_STATE', 'This evaluation moved on while extraction was running.');

  await repos.audit.append({
    correlationId: evaluation.id,
    stage: 'extract',
    eventType: 'extraction_recorded',
    actor: 'ai',
    actorId: model,
    outcome: 'ok',
    summary: `Read the resume against ${requirements.length} requirement(s).`,
    payload: { model, promptVersion: EXTRACTION_PROMPT_VERSION, requirements: requirements.length },
    entityType: 'evaluation',
    entityId: evaluation.id,
  });

  logger?.info('Extraction complete', {
    evaluationId,
    verified: verified.length,
    rejected: rejected.length,
    malformed: malformed.length,
  });

  return { evaluation: updated, verified: verified.length, rejected: rejected.length, malformed: malformed.length };
}

/** Opens an evaluation for a job/candidate pair, superseding any earlier one. */
export async function openEvaluation(
  deps: Pick<ExtractDeps, 'repos'>,
  input: { jobId: string; candidateId: string; resume: Resume },
): Promise<Evaluation> {
  const evaluation = await deps.repos.evaluations.create({
    jobId: input.jobId,
    candidateId: input.candidateId,
    resumeId: input.resume.id,
  });

  await deps.repos.audit.append({
    correlationId: evaluation.id,
    stage: 'extract',
    eventType: 'evaluation_opened',
    actor: 'human',
    outcome: 'ok',
    summary: 'Opened an evaluation of this candidate against this job.',
    payload: { jobId: input.jobId, candidateId: input.candidateId },
    entityType: 'evaluation',
    entityId: evaluation.id,
  });

  return evaluation;
}
