// What the server sends.
//
// Hand-written mirrors of the server's response shapes rather than generated
// ones: the API is small, and a type that has to be kept in step deliberately
// is a type someone reads when the server changes.

export type ErrorEnvelope = {
  error: { code: string; message: string; details?: Record<string, unknown> };
};

export type Health = {
  /** Which deployment answered. Read by the page before it draws anything. */
  mode: 'app' | 'demo';
  status: 'ok' | 'degraded';
  /** `null` in the demo, which has no canonical database to report on. */
  database: { driver: string; reachable: boolean; migrationsApplied: number } | null;
  /** Reported as configured-or-not. Never a value, never a key. */
  adapters: Record<string, string | boolean | number>;
  version: string;
};

// --- the recruiter API ------------------------------------------------
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

/** What the model said about one requirement and what the code made of it (`model_checked` mode). Absent when the matcher alone judged. */
export type VerdictCheck = {
  modelVerdict: string | null;
  modelReason: string | null;
  /** After the code's rules: never above the model's. */
  enforcedVerdict: string;
  /** Set when the code lowered the model's verdict because no passage it quoted was found in the CV. */
  downgradeReason: 'no_verified_passage' | 'no_answer' | null;
  matcherVerdict: string | null;
  matcherMode: 'strict' | 'folded' | null;
  /** How far apart the model and the matcher are: none, one_step, two_plus. Always shown. */
  disagreement: 'none' | 'one_step' | 'two_plus';
  /** True when this requirement sends the candidate to a person: a must-have where the model is two steps or more above the matcher. */
  scoreLowered: boolean;
  routed: boolean;
  /** The verdict the score used. */
  scoredVerdict: string;
};

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
  /** The model's verdict and the second opinion. Absent (or null) for an assessment the matcher alone judged. */
  check?: VerdictCheck | null;
};

export type Decision = {
  outcome: string;
  reason: string;
  decidedBy: string;
  decidedAt: string;
};

/** How the model call went. Never the model's raw answer, which stays on the server. */
export type ExtractionView = {
  /** `succeeded`, or the kind of failure. */
  result: string;
  model: string | null;
  maxTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  /** How many passages the model quoted, before any were checked. */
  findingsReturned: number | null;
};

export type EvaluationDetail = {
  evaluationId: string;
  job: { id: string; title: string };
  candidate: { id: string; reference: string; displayName: string | null };
  status: string;
  /** A message for a person, set only when the status is "failed". */
  failureReason: string | null;
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
  /** Null for an assessment that has no extraction record. */
  extraction: ExtractionView | null;
  /** The model answered properly and quoted nothing. */
  modelFoundNothing: boolean;
  /** Who decided the verdicts that were scored. Absent means the matcher alone. */
  verdictMode?: 'model_checked' | 'matcher';
  /** On some must-have the model was two steps or more above the second opinion: a person should look. */
  needsReview?: boolean;
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

// --- what the recruiter sends and what comes back ----------------------

export type NewRequirementInput = {
  label: string;
  criterion: string;
  kind: 'must_have' | 'nice_to_have';
  weight: number;
};

export type NewJobInput = {
  title: string;
  seniority: string;
  description: string;
  requirements: NewRequirementInput[];
};

export type NewCandidateInput = { reference: string; displayName: string | null; text: string };

export type AddedCandidate = {
  evaluationId: string;
  status: string;
  candidate: { id: string; reference: string; displayName: string | null };
  /** How many protected attributes were masked before anything could read the CV. */
  redactedCount: number;
};

export type RunAccepted = { evaluationId: string; status: string; previousEvaluationId?: string };

export type EvaluationStatusView = {
  evaluationId: string;
  status: string;
  isCurrent: boolean;
  supersededBy: string | null;
  failureReason: string | null;
};

export type DecisionResult = { decision: Decision; evaluation: EvaluationDetail };

/** A demo candidate's resume as the pipeline saw it: the redacted text, and nothing else. */
export type DemoResume = { text: string };
