// What the server sends.
//
// Hand-written mirrors of the server's response shapes rather than generated
// ones: the API is small, and a type that has to be kept in step deliberately
// is a type someone reads when the server changes.

export type ErrorEnvelope = {
  error: { code: string; message: string; details?: Record<string, unknown> };
};

export type Health = {
  status: 'ok' | 'degraded';
  database: { driver: string; reachable: boolean; migrationsApplied: number };
  /** Reported as configured-or-not. Never a value, never a key. */
  adapters: Record<string, string | boolean | number>;
  version: string;
};

// --- the recruiter API (P3-F) ------------------------------------------------
//
// Every number below is computed on the server. Nothing here is a hint the
// browser is expected to finish: `scorePercent` arrives already rounded and
// `position` already ordered, because a score worked out in two places is a
// score that can differ in two places.

export type JobSummary = {
  id: string;
  title: string;
  seniority: string;
  status: string;
  requirementCount: number;
  mustHaveCount: number;
  candidateCount: number;
  createdAt: string;
};

export type JobRequirement = {
  id: string;
  label: string;
  criterion: string;
  kind: string;
  weight: number;
};

export type JobDetail = {
  id: string;
  title: string;
  seniority: string;
  status: string;
  description: string;
  requirements: JobRequirement[];
  candidateCount: number;
  createdAt: string;
};

export type RankedCandidate = {
  candidateId: string;
  reference: string;
  displayName: string | null;
  evaluationId: string | null;
  tier: string;
  scoreBasisPoints: number | null;
  /** Already rounded by the server. The browser never divides a score. */
  scorePercent: string | null;
  mustHavesMet: number | null;
  mustHavesTotal: number | null;
  failedMustHaves: string[];
  unclearMustHaves: string[];
  position: number;
  rank: number | null;
  tiedWith: number;
  rationale: string;
};

export type Ranking = {
  jobId: string;
  entries: RankedCandidate[];
  rankedCount: number;
  notEvaluatedCount: number;
};

export type Evidence = { id: string; quote: string; charStart: number; charEnd: number };

export type RequirementOutcome = {
  requirementId: string;
  label: string;
  criterion: string;
  kind: string;
  weight: number;
  verdict: string | null;
  confidence: string | null;
  contributionBasisPoints: number | null;
  contributionPercent: string | null;
  rationale: string | null;
  evidence: Evidence[];
};

export type Decision = {
  outcome: string;
  reason: string;
  decidedBy: string;
  decidedAt: string;
};

export type EvaluationDetail = {
  evaluationId: string;
  job: { id: string; title: string };
  candidate: { id: string; reference: string; displayName: string | null };
  status: string;
  isCurrent: boolean;
  supersededBy: string | null;
  scoreBasisPoints: number | null;
  scorePercent: string | null;
  mustHavesMet: number | null;
  mustHavesTotal: number | null;
  tier: string;
  failedMustHaves: string[];
  unclearMustHaves: string[];
  requirements: RequirementOutcome[];
  /** Categories and a count. There is no value to send. */
  protectedAttributes: { categories: string[]; count: number };
  model: string | null;
  promptVersion: string | null;
  evidenceRejectedCount: number;
  decision: Decision | null;
  createdAt: string;
};

export type AuditEntry = {
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

export type DecisionResult = { decision: Decision; evaluation: EvaluationDetail };
