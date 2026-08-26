import { classify, type RankTier } from '../agent/rankRules.ts';
import { formatScore } from '../agent/score.ts';
import { AppError } from '../lib/errors.ts';
import { ProblemCollector, requireObject, requireOneOf, requireString } from '../lib/validate.ts';
import { DECISION_OUTCOMES, type ConfidenceLevel, type DecisionOutcome, type MatchVerdict, type RequirementKind } from '../domain/ats.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { Logger } from '../lib/logger.ts';
import type { HandlerResult } from './types.ts';

// One candidate, against one job — the screen a hiring decision is actually
// made on.
//
// TWO RULES SHAPE EVERY RESPONSE HERE
//
//   1. Only verified evidence is sent. Unverified rows exist so a fabrication
//      stays visible in the audit trail; sending them to a screen that renders
//      quotes would put a sentence the candidate never wrote in front of a
//      recruiter, attributed to them.
//   2. Protected attributes are reported as categories and counts. There is no
//      value to send — the quarantine table has no column for one — and this
//      response is where that design pays off.
//
// The browser is also sent every number already computed, including the
// rounded percentage. Nothing here asks the client to work anything out: a
// score computed in two places is a score that can differ in two places.

export type EvaluationDeps = {
  repos: Repositories;
  logger?: Logger;
};

export type EvidenceView = {
  id: string;
  quote: string;
  charStart: number;
  charEnd: number;
};

export type RequirementOutcome = {
  requirementId: string;
  label: string;
  criterion: string;
  kind: RequirementKind;
  weight: number;
  verdict: MatchVerdict | null;
  confidence: ConfidenceLevel | null;
  contributionBasisPoints: number | null;
  contributionPercent: string | null;
  rationale: string | null;
  /** Verified passages only. Never anything the verifier rejected. */
  evidence: EvidenceView[];
};

export type DecisionView = {
  outcome: DecisionOutcome;
  reason: string;
  decidedBy: string;
  decidedAt: string;
};

export type EvaluationDetail = {
  evaluationId: string;
  job: { id: string; title: string };
  candidate: { id: string; reference: string; displayName: string | null };
  status: string;
  /** False when a newer evaluation has replaced this one. */
  isCurrent: boolean;
  supersededBy: string | null;
  scoreBasisPoints: number | null;
  scorePercent: string | null;
  mustHavesMet: number | null;
  mustHavesTotal: number | null;
  tier: RankTier;
  failedMustHaves: string[];
  unclearMustHaves: string[];
  requirements: RequirementOutcome[];
  /** Categories and a count. Never a value — there is none stored. */
  protectedAttributes: { categories: string[]; count: number };
  /** How the evidence was produced, for the details area. */
  model: string | null;
  promptVersion: string | null;
  evidenceRejectedCount: number;
  decision: DecisionView | null;
  createdAt: string;
};

export async function handleEvaluationDetail(
  deps: EvaluationDeps,
  evaluationId: string,
): Promise<HandlerResult<EvaluationDetail>> {
  const { repos } = deps;

  const evaluation = await repos.evaluations.getById(evaluationId);
  if (!evaluation) throw new AppError('NOT_FOUND', 'That evaluation does not exist.');

  const [job, candidate, requirements, matches, verified, all, findings, decision] = await Promise.all([
    repos.jobs.getById(evaluation.jobId),
    repos.candidates.getById(evaluation.candidateId),
    repos.requirements.listForJob(evaluation.jobId),
    repos.matches.listForEvaluation(evaluation.id),
    repos.evidence.listVerifiedForEvaluation(evaluation.id),
    repos.evidence.listForEvaluation(evaluation.id),
    repos.sensitiveFindings.listForResume(evaluation.resumeId),
    repos.decisions.getForEvaluation(evaluation.id),
  ]);

  if (!job || !candidate) throw new AppError('NOT_FOUND', 'That evaluation does not exist.');

  const { tier, failedMustHaves, unclearMustHaves } = classify(evaluation, matches, requirements);

  const matchByRequirement = new Map(matches.map((match) => [match.requirementId, match]));
  const evidenceByRequirement = new Map<string, EvidenceView[]>();
  for (const item of verified) {
    if (!item.requirementId) continue;
    const list = evidenceByRequirement.get(item.requirementId) ?? [];
    list.push({ id: item.id, quote: item.quote, charStart: item.charStart, charEnd: item.charEnd });
    evidenceByRequirement.set(item.requirementId, list);
  }

  return {
    status: 200,
    body: {
      evaluationId: evaluation.id,
      job: { id: job.id, title: job.title },
      candidate: { id: candidate.id, reference: candidate.reference, displayName: candidate.displayName },
      status: evaluation.status,
      isCurrent: evaluation.supersededBy === null,
      supersededBy: evaluation.supersededBy,
      scoreBasisPoints: evaluation.scoreBasisPoints,
      scorePercent: evaluation.scoreBasisPoints === null ? null : formatScore(evaluation.scoreBasisPoints),
      mustHavesMet: evaluation.mustHavesMet,
      mustHavesTotal: evaluation.mustHavesTotal,
      tier,
      failedMustHaves,
      unclearMustHaves,
      requirements: requirements.map((requirement) => {
        const match = matchByRequirement.get(requirement.id) ?? null;
        return {
          requirementId: requirement.id,
          label: requirement.label,
          criterion: requirement.criterion,
          kind: requirement.kind,
          weight: requirement.weight,
          verdict: match?.verdict ?? null,
          confidence: match?.confidence ?? null,
          contributionBasisPoints: match?.contributionBasisPoints ?? null,
          contributionPercent: match ? formatScore(match.contributionBasisPoints) : null,
          rationale: match?.rationale ?? null,
          evidence: evidenceByRequirement.get(requirement.id) ?? [],
        };
      }),
      protectedAttributes: {
        categories: [...new Set(findings.map((finding) => finding.category))].sort(),
        count: findings.length,
      },
      model: evaluation.model,
      promptVersion: evaluation.promptVersion,
      // Reported as a number so the details area can say the check ran and what
      // it caught. The rejected quotes themselves are never sent.
      evidenceRejectedCount: all.length - verified.length,
      decision: decision
        ? {
            outcome: decision.outcome,
            reason: decision.reason,
            decidedBy: decision.decidedBy,
            decidedAt: decision.decidedAt,
          }
        : null,
      createdAt: evaluation.createdAt,
    },
  };
}

export type AuditEntryView = {
  id: string;
  sequence: number;
  stage: string;
  eventType: string;
  actor: string;
  actorId: string | null;
  outcome: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

/**
 * Everything that happened to this candidate, in order.
 *
 * Two correlations are merged: the resume (ingestion and redaction) and the
 * evaluation (extraction, verification, matching, scoring, the decision). A
 * history that started at extraction would omit the step a candidate would most
 * want to see — the moment their protected details were removed.
 */
export async function handleEvaluationAudit(
  deps: EvaluationDeps,
  evaluationId: string,
): Promise<HandlerResult<{ events: AuditEntryView[] }>> {
  const { repos } = deps;

  const evaluation = await repos.evaluations.getById(evaluationId);
  if (!evaluation) throw new AppError('NOT_FOUND', 'That evaluation does not exist.');

  const [resumeEvents, evaluationEvents] = await Promise.all([
    repos.audit.listForCorrelation(evaluation.resumeId),
    repos.audit.listForCorrelation(evaluation.id),
  ]);

  const events = [...resumeEvents, ...evaluationEvents]
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.sequence - b.sequence))
    .map((event) => ({
      id: event.id,
      sequence: event.sequence,
      stage: event.stage,
      eventType: event.eventType,
      actor: event.actor,
      actorId: event.actorId,
      outcome: event.outcome,
      summary: event.summary,
      payload: event.payload,
      createdAt: event.createdAt,
    }));

  return { status: 200, body: { events } };
}

// --- the decision ------------------------------------------------------------

/**
 * A reason short enough to be meaningless is not a reason.
 *
 * The column is NOT NULL, so the schema already refuses an absent one. This is
 * the other half: an unexplained rejection is what this product exists to
 * prevent, and "no" in a mandatory field is an unexplained rejection with extra
 * steps.
 */
const MIN_REASON_CHARS = 10;
const MAX_REASON_CHARS = 2000;

export type DecisionInput = { outcome: DecisionOutcome; reason: string };

export function parseDecision(input: unknown): DecisionInput {
  const problems = new ProblemCollector();
  const body = requireObject(input ?? {}, 'body', problems);

  const outcome = requireOneOf(body.outcome, 'outcome', DECISION_OUTCOMES, problems);
  const reason = requireString(body.reason, 'reason', problems, { maxLength: MAX_REASON_CHARS });

  if (reason.trim().length > 0 && reason.trim().length < MIN_REASON_CHARS) {
    problems.add(
      `"reason" must be at least ${MIN_REASON_CHARS} characters — a decision on a person needs a reason someone can read back`,
    );
  }

  problems.throwIfAny();
  return { outcome, reason: reason.trim() };
}

export type DecisionResult = {
  decision: DecisionView;
  evaluation: EvaluationDetail;
};

export async function handleDecision(
  deps: EvaluationDeps,
  evaluationId: string,
  input: unknown,
  decidedBy: string,
): Promise<HandlerResult<DecisionResult>> {
  const { repos, logger } = deps;
  const { outcome, reason } = parseDecision(input);

  const evaluation = await repos.evaluations.getById(evaluationId);
  if (!evaluation) throw new AppError('NOT_FOUND', 'That evaluation does not exist.');

  // A decision on an unscored evaluation is a decision taken with no evidence
  // in front of the person taking it.
  if (evaluation.status !== 'scored') {
    throw new AppError('INVALID_STATE', 'This candidate has not been assessed yet, so there is nothing to decide on.');
  }

  // A superseded evaluation has already been replaced. Recording a decision
  // against it would attach today's judgement to yesterday's assessment.
  if (evaluation.supersededBy !== null) {
    throw new AppError('INVALID_STATE', 'This assessment has been replaced by a newer one. Open that one to decide.');
  }

  // One decision per evaluation. The UNIQUE constraint is the backstop; this
  // is the answer a person should get.
  const existing = await repos.decisions.getForEvaluation(evaluation.id);
  if (existing) {
    throw new AppError(
      'CONFLICT',
      'A decision has already been recorded for this assessment. Re-assess the candidate to decide again.',
    );
  }

  const decision = await repos.decisions.record({
    evaluationId: evaluation.id,
    outcome,
    reason,
    decidedBy,
  });

  await repos.audit.append({
    correlationId: evaluation.id,
    stage: 'decide',
    eventType: 'decision_recorded',
    actor: 'human',
    actorId: decidedBy,
    outcome: 'ok',
    summary: `Recorded a decision of "${outcome}" for this candidate.`,
    // The reason is deliberately included: the trail is where an explanation
    // has to survive, and this one was written by a person about a person.
    payload: { outcome, reason, scoreBasisPoints: evaluation.scoreBasisPoints },
    entityType: 'evaluation',
    entityId: evaluation.id,
  });

  logger?.info('Recorded a recruiter decision', { evaluationId, outcome });

  // The caller is sent the resulting state rather than being asked to refetch
  // it, so the screen it renders is the state the server actually holds.
  const detail = await handleEvaluationDetail(deps, evaluation.id);

  return {
    status: 201,
    body: {
      decision: {
        outcome: decision.outcome,
        reason: decision.reason,
        decidedBy: decision.decidedBy,
        decidedAt: decision.decidedAt,
      },
      evaluation: detail.body,
    },
  };
}
