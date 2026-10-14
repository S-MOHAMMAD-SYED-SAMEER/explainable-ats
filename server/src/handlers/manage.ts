import { createJob, ingestResume, type CreateJobInput } from '../agent/ingest.ts';
import { openEvaluation } from '../agent/extract.ts';
import { handleJobDetail, type JobDeps, type JobDetail } from './jobs.ts';
import { AppError } from '../lib/errors.ts';
import { ProblemCollector, requireObject, requireOneOf, requireString } from '../lib/validate.ts';
import { REQUIREMENT_KINDS, SENIORITIES, type EvaluationStatus } from '../domain/ats.ts';
import type { EvaluationRunner } from '../agent/runner.ts';
import type { HandlerResult } from './types.ts';

// The recruiter's writes: a job, a pasted CV, and starting or restarting an
// assessment.
//
// Everything here is the recruiter acting, so each handler is handed the signed-in
// operator (read from the verified session, never a header) and records it in the
// audit trail. Starting work is separate from adding a CV on purpose: adding a CV
// stores and redacts it and opens an evaluation, and running it is the step that
// reaches a model (and costs money), so it is an explicit request that answers 202
// and does the work in the background.

export type ManageDeps = JobDeps & { runner: EvaluationRunner };

// --- limits --------------------------------------------------------------
//
// Sized for a person typing, with room, and small enough that nothing can be used
// to push an unreasonable prompt at the model. The criterion is what the model is
// asked to find evidence for, so it has its own cap.
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 4000;
const MAX_REQUIREMENTS = 25;
const MAX_LABEL_CHARS = 100;
const MAX_CRITERION_CHARS = 500;
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 10;
const MAX_REFERENCE_CHARS = 64;
const MAX_DISPLAY_NAME_CHARS = 120;
// The same ceiling `ingestResume` enforces, checked here too so a too-long paste
// is a 400 naming the field rather than an error from further in.
export const MAX_CV_CHARS = 200_000;

// A reference is what the system calls a person in logs, filenames and audit
// summaries, so it is held to a plain alphabet. The person's real name goes in
// `displayName`, which is redacted out of the CV text before a model sees it.
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// --- parsing -------------------------------------------------------------

function isValidWeight(value: unknown): value is number {
  // `typeof` first: a weight arriving as "3" would concatenate rather than add
  // once it reached the scorer.
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_WEIGHT && value <= MAX_WEIGHT;
}

export function parseJobInput(input: unknown): CreateJobInput {
  const problems = new ProblemCollector();
  const body = requireObject(input ?? {}, 'body', problems);

  const title = requireString(body.title, 'title', problems, { maxLength: MAX_TITLE_CHARS }).trim();
  const seniority = requireOneOf(body.seniority, 'seniority', SENIORITIES, problems);
  const description =
    body.description === undefined || body.description === null
      ? ''
      : requireString(body.description, 'description', problems, { maxLength: MAX_DESCRIPTION_CHARS, allowEmpty: true });

  const requirements: CreateJobInput['requirements'] = [];
  if (!Array.isArray(body.requirements)) {
    problems.add('"requirements" is required and must be a list');
  } else if (body.requirements.length === 0) {
    problems.add('"requirements" needs at least one requirement to evaluate anyone against');
  } else if (body.requirements.length > MAX_REQUIREMENTS) {
    problems.add(`"requirements" can have at most ${MAX_REQUIREMENTS} entries (received ${body.requirements.length})`);
  } else {
    body.requirements.forEach((raw: unknown, index: number) => {
      const where = `requirements[${index}]`;
      const entry = requireObject(raw, where, problems);
      const label = requireString(entry.label, `${where}.label`, problems, { maxLength: MAX_LABEL_CHARS }).trim();
      const criterion = requireString(entry.criterion, `${where}.criterion`, problems, {
        maxLength: MAX_CRITERION_CHARS,
      }).trim();
      const kind = requireOneOf(entry.kind, `${where}.kind`, REQUIREMENT_KINDS, problems);
      if (!isValidWeight(entry.weight)) {
        problems.add(`"${where}.weight" must be a whole number from ${MIN_WEIGHT} to ${MAX_WEIGHT}`);
        return;
      }
      requirements.push({ label, criterion, kind, weight: entry.weight });
    });
  }

  // Any problem refuses the whole job, so the partial list above is never used.
  problems.throwIfAny();
  return { title, seniority, description, requirements };
}

export type CandidateInput = { reference: string; displayName: string | null; text: string };

export function parseCandidateInput(input: unknown): CandidateInput {
  const problems = new ProblemCollector();
  const body = requireObject(input ?? {}, 'body', problems);

  const reference = requireString(body.reference, 'reference', problems, { maxLength: MAX_REFERENCE_CHARS }).trim();
  if (reference !== '' && !REFERENCE_PATTERN.test(reference)) {
    problems.add(
      '"reference" may use only letters, digits, dots, hyphens and underscores, and must start with a letter or digit',
    );
  }

  const displayName =
    body.displayName === undefined || body.displayName === null || body.displayName === ''
      ? null
      : requireString(body.displayName, 'displayName', problems, { maxLength: MAX_DISPLAY_NAME_CHARS }).trim();

  const text = requireString(body.text, 'text', problems, { maxLength: MAX_CV_CHARS });

  problems.throwIfAny();
  return { reference, displayName, text };
}

// --- handlers ------------------------------------------------------------

export async function handleCreateJob(
  deps: ManageDeps,
  input: unknown,
  operator: string,
): Promise<HandlerResult<JobDetail>> {
  const parsed = parseJobInput(input);
  const { job } = await createJob({ repos: deps.repos, ...(deps.logger ? { logger: deps.logger } : {}) }, parsed, operator);
  deps.logger?.info('Job created', { jobId: job.id });

  const detail = await handleJobDetail(deps, job.id);
  return { status: 201, body: detail.body };
}

export type AddedCandidate = {
  evaluationId: string;
  status: EvaluationStatus;
  candidate: { id: string; reference: string; displayName: string | null };
  /** How many protected attributes were masked before anything can read the CV. */
  redactedCount: number;
};

/**
 * Stores a pasted CV, redacts it, and opens an evaluation against the job.
 * Nothing here calls a model.
 *
 * The same CV pasted twice for the same person is refused rather than quietly
 * opening a second evaluation that would supersede (and hide from the list) one
 * that may already carry a decision. A changed CV for the same reference is a new
 * document and opens a new evaluation, which supersedes the old one on purpose.
 */
export async function handleAddCandidate(
  deps: ManageDeps,
  jobId: string,
  input: unknown,
  operator: string,
): Promise<HandlerResult<AddedCandidate>> {
  const { repos, logger } = deps;
  const parsed = parseCandidateInput(input);

  const job = await repos.jobs.getById(jobId);
  if (!job) throw new AppError('NOT_FOUND', 'That job does not exist.');

  const { candidate, resume, redactedCount } = await ingestResume(
    { repos, ...(logger ? { logger } : {}) },
    { reference: parsed.reference, displayName: parsed.displayName, text: parsed.text, source: 'manual' },
  );

  const current = await repos.evaluations.getCurrent(job.id, candidate.id);
  if (current && current.resumeId === resume.id && current.status !== 'failed') {
    throw new AppError(
      'CONFLICT',
      'This CV has already been added for this candidate and job. Open their assessment instead.',
      { details: { evaluationId: current.id } },
    );
  }

  const evaluation = await openEvaluation(
    { repos },
    { jobId: job.id, candidateId: candidate.id, resume, openedBy: operator },
  );
  logger?.info('Candidate added', { jobId: job.id, evaluationId: evaluation.id });

  return {
    status: 201,
    body: {
      evaluationId: evaluation.id,
      status: evaluation.status,
      candidate: { id: candidate.id, reference: candidate.reference, displayName: candidate.displayName },
      redactedCount,
    },
  };
}

export type RunAccepted = {
  evaluationId: string;
  status: EvaluationStatus;
  /** Set when this started a new evaluation that replaced a failed one. */
  previousEvaluationId?: string;
};

/**
 * Starts extraction and scoring for a pending evaluation, and answers at once.
 *
 * Asking again while it is still running is not an error: the answer is the same
 * 202, because the caller's goal (it should be running) is already true.
 */
export async function handleRunEvaluation(
  deps: ManageDeps,
  evaluationId: string,
  operator: string,
): Promise<HandlerResult<RunAccepted>> {
  const { repos, runner, logger } = deps;

  const evaluation = await repos.evaluations.getById(evaluationId);
  if (!evaluation) throw new AppError('NOT_FOUND', 'That evaluation does not exist.');
  if (evaluation.supersededBy !== null) {
    throw new AppError('INVALID_STATE', 'This assessment has been replaced by a newer one. Run that one instead.');
  }

  if (runner.isRunning(evaluation.id)) {
    return { status: 202, body: { evaluationId: evaluation.id, status: evaluation.status } };
  }
  if (evaluation.status !== 'pending') {
    throw new AppError(
      'INVALID_STATE',
      evaluation.status === 'failed'
        ? 'This assessment failed. Re-run it to try again.'
        : `This assessment has already been ${evaluation.status}.`,
    );
  }

  await repos.audit.append({
    correlationId: evaluation.id,
    stage: 'extract',
    eventType: 'extraction_requested',
    actor: 'human',
    actorId: operator,
    outcome: 'ok',
    summary: 'A recruiter started the assessment.',
    payload: {},
    entityType: 'evaluation',
    entityId: evaluation.id,
  });

  runner.start(evaluation.id);
  logger?.info('Assessment started', { evaluationId: evaluation.id });
  return { status: 202, body: { evaluationId: evaluation.id, status: 'pending' } };
}

/**
 * Re-runs a failed assessment as a NEW evaluation that supersedes it.
 *
 * The failed one is kept exactly as it was, with its failure reason and its
 * audit trail, so the history shows that a first attempt failed and why. Allowed
 * for a failed evaluation, and for a pending one that this process is not running
 * (what a restart in the middle of a run leaves behind). A scored assessment is
 * not re-run here: that is a different act, with a decision possibly attached.
 */
export async function handleRerunEvaluation(
  deps: ManageDeps,
  evaluationId: string,
  operator: string,
): Promise<HandlerResult<RunAccepted>> {
  const { repos, runner, logger } = deps;

  const previous = await repos.evaluations.getById(evaluationId);
  if (!previous) throw new AppError('NOT_FOUND', 'That evaluation does not exist.');
  if (previous.supersededBy !== null) {
    throw new AppError('INVALID_STATE', 'This assessment has already been replaced by a newer one.');
  }

  const stuck = previous.status === 'pending' && !runner.isRunning(previous.id);
  if (previous.status !== 'failed' && !stuck) {
    throw new AppError(
      'INVALID_STATE',
      previous.status === 'pending' || previous.status === 'extracted'
        ? 'This assessment is still running. Wait for it to finish.'
        : 'Only a failed assessment can be re-run.',
    );
  }

  const resume = await repos.resumes.getById(previous.resumeId);
  if (!resume) throw new AppError('INVALID_STATE', 'The CV for this assessment is missing.');

  // Superseding happens inside `create`, in one transaction with the insert.
  const next = await openEvaluation(
    { repos },
    { jobId: previous.jobId, candidateId: previous.candidateId, resume, openedBy: operator },
  );

  await repos.audit.append({
    correlationId: next.id,
    stage: 'extract',
    eventType: 'evaluation_rerun',
    actor: 'human',
    actorId: operator,
    outcome: 'ok',
    summary: 'A recruiter re-ran an assessment that had not finished. It replaces the earlier one, which is kept.',
    payload: {
      previousEvaluationId: previous.id,
      previousStatus: previous.status,
      previousFailureReason: previous.failureReason,
    },
    entityType: 'evaluation',
    entityId: next.id,
  });
  await repos.audit.append({
    correlationId: previous.id,
    stage: 'extract',
    eventType: 'evaluation_superseded_by_rerun',
    actor: 'human',
    actorId: operator,
    outcome: 'ok',
    summary: 'This assessment was replaced by a re-run.',
    payload: { supersededBy: next.id },
    entityType: 'evaluation',
    entityId: previous.id,
  });

  runner.start(next.id);
  logger?.info('Assessment re-run', { evaluationId: next.id, previousEvaluationId: previous.id });
  return { status: 202, body: { evaluationId: next.id, status: 'pending', previousEvaluationId: previous.id } };
}

export type EvaluationStatusView = {
  evaluationId: string;
  status: EvaluationStatus;
  /** False once a newer evaluation has replaced this one. */
  isCurrent: boolean;
  supersededBy: string | null;
  /** A message written for a person. Null unless the status is "failed". */
  failureReason: string | null;
};

/** The cheap thing a screen polls while an assessment runs. */
export async function handleEvaluationStatus(
  deps: JobDeps,
  evaluationId: string,
): Promise<HandlerResult<EvaluationStatusView>> {
  const evaluation = await deps.repos.evaluations.getById(evaluationId);
  if (!evaluation) throw new AppError('NOT_FOUND', 'That evaluation does not exist.');
  return {
    status: 200,
    body: {
      evaluationId: evaluation.id,
      status: evaluation.status,
      isCurrent: evaluation.supersededBy === null,
      supersededBy: evaluation.supersededBy,
      failureReason: evaluation.status === 'failed' ? evaluation.failureReason : null,
    },
  };
}
