// The domain vocabulary.
//
// Every closed set is declared once, here, and mirrored by a CHECK constraint
// in the schema. `test/schema-parity.test.ts` reads both and fails if they
// diverge — a value the code can produce and the database rejects is a runtime
// error waiting for the one input that triggers it.

// =================================================================== job

export const SENIORITIES = ['junior', 'mid', 'senior', 'lead'] as const;
export type Seniority = (typeof SENIORITIES)[number];

export const JOB_STATUSES = ['draft', 'open', 'closed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type Job = {
  id: string;
  title: string;
  seniority: Seniority;
  description: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
};

/**
 * Must-have or nice-to-have.
 *
 * The distinction is not cosmetic and is not just a bigger weight. A must-have
 * that is not met caps what the candidate can be called, however high the
 * arithmetic comes out — "strong overall but cannot do the job" is a sentence
 * a ranking should never produce.
 */
export const REQUIREMENT_KINDS = ['must_have', 'nice_to_have'] as const;
export type RequirementKind = (typeof REQUIREMENT_KINDS)[number];

export type JobRequirement = {
  id: string;
  jobId: string;
  label: string;
  /** The sentence that decides whether something counts. Shown to both sides. */
  criterion: string;
  kind: RequirementKind;
  weight: number;
  position: number;
  createdAt: string;
};

// ============================================================= candidate

export const CANDIDATE_SOURCES = ['upload', 'demo', 'manual'] as const;
export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];

export type Candidate = {
  id: string;
  /** What the system calls this person. Safe for a log or a filename. */
  reference: string;
  /** What a recruiter reads. Never an input to scoring. */
  displayName: string | null;
  source: CandidateSource;
  createdAt: string;
};

export type Resume = {
  id: string;
  candidateId: string;
  /** The canonical text. Every evidence offset indexes into this. */
  contentText: string;
  /** The same text with protected spans removed — what the model is shown. */
  redactedText: string;
  contentHash: string;
  charCount: number;
  ingestedAt: string;
};

/**
 * What must never reach the scorer.
 *
 * Recorded as a category and a location, never a value. The table exists to
 * prove such data was found and excluded; storing it again would defeat the
 * exclusion.
 */
export const SENSITIVE_CATEGORIES = [
  'name',
  'age',
  'gender',
  'nationality',
  'photo',
  'address',
  'marital_status',
  'religion',
  'contact',
  'other',
] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

export type SensitiveFinding = {
  id: string;
  resumeId: string;
  category: SensitiveCategory;
  charStart: number;
  charEnd: number;
  createdAt: string;
};

// ============================================================ evaluation

export const EVALUATION_STATUSES = ['pending', 'extracted', 'scored', 'failed'] as const;
export type EvaluationStatus = (typeof EVALUATION_STATUSES)[number];

export type Evaluation = {
  id: string;
  jobId: string;
  candidateId: string;
  resumeId: string;
  status: EvaluationStatus;
  model: string | null;
  promptVersion: string | null;
  latencyMs: number | null;
  /** Basis points, 0–10000. Null until the deterministic scorer has run. */
  scoreBasisPoints: number | null;
  mustHavesMet: number | null;
  mustHavesTotal: number | null;
  failureReason: string | null;
  supersededBy: string | null;
  createdAt: string;
};

export type Evidence = {
  id: string;
  evaluationId: string;
  resumeId: string;
  requirementId: string | null;
  quote: string;
  charStart: number;
  charEnd: number;
  /** True only once the quote was found verbatim at those offsets. */
  verified: boolean;
  createdAt: string;
};

/**
 * The four answers, and why there are four.
 *
 * `unclear` is not a polite `not_met`. "The resume says nothing about this" and
 * "the resume says something ambiguous" are different facts, and collapsing
 * them would let the system report an absence of evidence as evidence of
 * absence — which is how a good candidate gets silently filtered out.
 */
export const MATCH_VERDICTS = ['met', 'partial', 'not_met', 'unclear'] as const;
export type MatchVerdict = (typeof MATCH_VERDICTS)[number];

export const CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export type RequirementMatch = {
  id: string;
  evaluationId: string;
  requirementId: string;
  verdict: MatchVerdict;
  confidence: ConfidenceLevel;
  /** Stored as applied, so an old explanation still adds up after a spec edit. */
  weightApplied: number;
  contributionBasisPoints: number;
  rationale: string;
  createdAt: string;
};

// =============================================================== decision

export const DECISION_OUTCOMES = ['shortlist', 'reject', 'hold'] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export type RecruiterDecision = {
  id: string;
  evaluationId: string;
  outcome: DecisionOutcome;
  /** Mandatory. An unexplained rejection is what this product exists to prevent. */
  reason: string;
  decidedBy: string;
  decidedAt: string;
};

// ================================================================== audit

export const AUDIT_STAGES = [
  'job',
  'ingest',
  'redact',
  'extract',
  'verify',
  'match',
  'score',
  'decide',
  'system',
] as const;
export type AuditStage = (typeof AUDIT_STAGES)[number];

export const AUDIT_ACTORS = ['system', 'ai', 'human'] as const;
export type AuditActor = (typeof AUDIT_ACTORS)[number];

export const AUDIT_OUTCOMES = ['ok', 'blocked', 'failed', 'skipped'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export type AuditEvent = {
  id: string;
  correlationId: string;
  sequence: number;
  stage: AuditStage;
  eventType: string;
  actor: AuditActor;
  actorId: string | null;
  outcome: AuditOutcome;
  summary: string;
  payload: Record<string, unknown>;
  entityType: string | null;
  entityId: string | null;
  createdAt: string;
};

// ================================================= scoring, as a contract

/**
 * Scores are integer basis points, 0–10000.
 *
 * Not a float and not NUMERIC. A float makes the same inputs produce different
 * last digits on different machines, and `pg` returns NUMERIC as a string, so a
 * weight arriving as "3" would concatenate rather than add. A recruiter has to
 * be able to reproduce this arithmetic by hand, so it stays integer arithmetic.
 */
export const BASIS_POINTS_MAX = 10_000;

/**
 * What each verdict is worth, as a fraction of its requirement's weight.
 *
 * Declared here rather than inside the scorer so the explanation screen and the
 * scorer cannot disagree about what "partial" means. `unclear` earns nothing —
 * but it is surfaced separately, because a candidate held back by ambiguity
 * deserves a second look rather than a low number with no reason.
 */
export const VERDICT_BASIS_POINTS: Readonly<Record<MatchVerdict, number>> = Object.freeze({
  met: 10_000,
  partial: 5_000,
  not_met: 0,
  unclear: 0,
});
