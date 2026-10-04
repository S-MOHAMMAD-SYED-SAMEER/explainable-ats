import { ingestResume } from '../agent/ingest.ts';
import { openEvaluation, extractEvidence } from '../agent/extract.ts';
import { matchAndScore } from '../agent/match.ts';
import { createMockLlmProvider } from '../adapters/llm/mock.ts';
import { installDeterministicExtractor } from '../agent/mockExtractor.ts';
import { DEMO_JOB, DEMO_CANDIDATES, ingestInputFor, type DemoCandidate } from './dataset.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { Logger } from '../lib/logger.ts';
import type { Evaluation, Job } from '../domain/ats.ts';

// The demo execution boundary.
//
// Two things live here: the allow-list of scenarios a public caller may name,
// and the function that runs one of them through the real pipeline. It calls the
// same functions `demo/seed.ts::seedCandidate` calls — ingestResume,
// openEvaluation, extractEvidence, matchAndScore — in the same order, with the
// same deterministic-provider setup. No business logic is duplicated.
//
// WHERE IT RUNS IS NOT DECIDED HERE
//
// `executeDemoScenario` writes into whatever repositories it is handed, so it
// must only ever be handed a private database. The public endpoint reaches it
// exclusively through `demo/sandbox.ts`, which owns an in-memory database per
// scenario. Nothing on the HTTP path passes it the canonical repositories: that
// is how an anonymous request is kept from superseding a recruiter's assessment.
// The only reason it reads the canonical database at all is `findDemoJob`, below,
// which is read-only.
//
// THE SCENARIO IS THE ONLY INPUT
//
// `ingestResume`, `openEvaluation`, `extractEvidence` and `matchAndScore` stay
// exactly as generic as they were. The guarantee that a request can only ever
// run one of five fixed demo candidates is enforced by never accepting a job id,
// a candidate id or any resume text from outside this module.

/** The only scenario identifiers this endpoint will ever run. */
export const DEMO_SCENARIO_IDS = ['demo-001', 'demo-002', 'demo-003', 'demo-004', 'demo-005'] as const;
export type DemoScenarioId = (typeof DEMO_SCENARIO_IDS)[number];

/**
 * Whether a value is one of the fixed scenario ids.
 *
 * A literal array, not `DEMO_CANDIDATES.map(c => c.reference)`. Deriving the
 * allow-list from the dataset would mean a candidate added to `dataset.ts` for
 * an unrelated reason — a future evaluation fixture, say — became runnable by
 * the public endpoint the moment it was added. Naming the five ids here means
 * a sixth one is private until somebody edits this array on purpose.
 */
export function isDemoScenarioId(value: unknown): value is DemoScenarioId {
  return typeof value === 'string' && (DEMO_SCENARIO_IDS as readonly string[]).includes(value);
}

/**
 * Finds the canonical demo job by its fixed title. Read-only.
 *
 * It is the gate for the public endpoint: a database nobody seeded with the
 * demo dataset — a production one, say — does not offer a public demo, and the
 * endpoint answers "not available" instead of running. It is NOT a
 * find-or-create, and nothing is written to the database it reads.
 */
export async function findDemoJob(repos: Repositories): Promise<Job | null> {
  const jobs = await repos.jobs.list({ limit: 500 });
  return jobs.find((job) => job.title === DEMO_JOB.title) ?? null;
}

function demoCandidateFor(scenario: DemoScenarioId): DemoCandidate {
  const candidate = DEMO_CANDIDATES.find((entry) => entry.reference === scenario);
  // Unreachable while DEMO_SCENARIO_IDS and DEMO_CANDIDATES agree — a test
  // asserts they do. Throwing rather than silently falling back to `undefined`
  // is the correct response to a safety-relevant list drifting out of sync
  // with the data it is supposed to describe.
  if (!candidate) {
    throw new Error(`Demo scenario "${scenario}" has no matching entry in DEMO_CANDIDATES.`);
  }
  return candidate;
}

export type ExecuteScenarioDeps = {
  /** MUST be a private database. See the note at the top of this file. */
  repos: Repositories;
  logger?: Logger;
};

/**
 * Runs one fixed demo scenario through the real pipeline and returns the
 * resulting evaluation.
 *
 * `scenario` must already be a `DemoScenarioId`, and `job` is the demo job in
 * the repositories being written to. Nothing about either is taken from a
 * caller's request.
 */
export async function executeDemoScenario(
  deps: ExecuteScenarioDeps,
  job: Job,
  scenario: DemoScenarioId,
): Promise<Evaluation> {
  const { repos, logger } = deps;

  if (job.title !== DEMO_JOB.title) {
    throw new Error('Resolved job does not match the expected demo job.');
  }

  const candidate = demoCandidateFor(scenario);
  // Today this can only be true, and the check stays so a future edit to the
  // registry or the dataset cannot silently widen what this function runs.
  if (!candidate.reference.startsWith('demo-')) {
    throw new Error('Resolved candidate is outside the demo namespace.');
  }

  const ingested = await ingestResume({ repos, logger }, ingestInputFor(candidate));

  const evaluation = await openEvaluation({ repos }, {
    jobId: job.id,
    candidateId: ingested.candidate.id,
    resume: ingested.resume,
  });

  if (candidate.assess === 'queued') {
    // Matches `seedCandidate`'s own behaviour exactly: opened and left there.
    // A visitor selecting this scenario sees the honest "received, not yet
    // assessed" state, not a fabricated score.
    return evaluation;
  }

  // A fresh provider per call, exactly as `seed.ts::seedCandidate` builds one
  // per candidate — never a shared, module-level instance.
  const provider = createMockLlmProvider();
  installDeterministicExtractor(provider);

  await extractEvidence({ repos, provider, logger }, evaluation.id);
  const { evaluation: scored } = await matchAndScore({ repos, logger }, evaluation.id);

  return scored;
}
