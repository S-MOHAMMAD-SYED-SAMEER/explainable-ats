import { ingestResume } from '../agent/ingest.ts';
import { openEvaluation, extractEvidence } from '../agent/extract.ts';
import { matchAndScore } from '../agent/match.ts';
import { createMockLlmProvider } from '../adapters/llm/mock.ts';
import { installDeterministicExtractor } from '../agent/mockExtractor.ts';
import { DEMO_JOB, DEMO_CANDIDATES, ingestInputFor, type DemoCandidate } from './dataset.ts';
import { AppError } from '../lib/errors.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { Logger } from '../lib/logger.ts';
import type { Evaluation, Job } from '../domain/ats.ts';

// The demo execution boundary (Option B).
//
// This is the one place allowed to say "run the real pipeline against exactly
// this fixed candidate, against exactly the fixed demo job." It calls the same
// functions `demo/seed.ts::seedCandidate` calls — ingestResume, openEvaluation,
// extractEvidence, matchAndScore — in the same order, with the same
// deterministic-provider setup. No business logic is duplicated: everything
// that decides redaction, extraction, verification, matching or scoring still
// lives exactly where it already lived.
//
// WHY THIS FILE EXISTS SEPARATELY FROM `seed.ts`
//
// `seed.ts` is an operator's tool: it creates the demo job, loops over every
// demo candidate, and is meant to be run once, deliberately, from a trusted
// shell. This file is the opposite: it is reachable by an anonymous visitor,
// repeatedly, concurrently, and it must be able to do exactly one thing and
// nothing else. Sharing the same job-creation code between them would mean an
// HTTP request could end up on the path that creates a job — which is
// precisely what must never happen here (see `findDemoJob` below). Keeping the
// two orchestration paths separate, thin, and independently readable was
// judged safer than forcing one shared function to serve both a trusted
// operator script and an anonymous public endpoint.
//
// ISOLATION IS ENFORCED HERE, NOT IN THE PIPELINE
//
// `ingestResume`, `openEvaluation`, `extractEvidence` and `matchAndScore` stay
// exactly as generic as they were — none of them knows what "demo" means. The
// guarantee that a request can only ever touch the fixed demo job and one of
// five fixed demo candidates is enforced entirely in this module, by never
// accepting a job id or a candidate id from outside it.

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

export type RunScenarioDeps = {
  repos: Repositories;
  logger?: Logger;
};

/**
 * Finds the demo job by its fixed title. Read-only.
 *
 * Deliberately NOT a find-or-create. `agent/ingest.ts::createJob` has no
 * uniqueness guard — calling it twice makes two rows titled "Senior Backend
 * Engineer" — and an anonymous, repeatable, concurrently-callable HTTP route
 * must never be the thing that decides whether the demo job gets created.
 * That stays a deliberate, single, operator act (`npm run seed:demo`). If the
 * job is missing, `runDemoScenario` fails closed rather than creating one, so
 * two concurrent first visitors can never race into producing a duplicate job.
 */
async function findDemoJob(repos: Repositories): Promise<Job | null> {
  // `list` already exists and is read-only; no repository change was needed
  // to add this lookup. The limit matches the repository's own maximum, which
  // is generous for a dataset that should only ever contain one demo job.
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

/**
 * Runs one fixed demo scenario through the real pipeline and returns the
 * resulting evaluation.
 *
 * `scenario` must already be a `DemoScenarioId` — callers are expected to have
 * checked `isDemoScenarioId` first (the HTTP handler does). Nothing about the
 * job or the candidate is ever taken from a caller: both are resolved from
 * fixed, hardcoded sources inside this module, and each is asserted to be the
 * expected demo record immediately before anything is written, as a second,
 * structural check beyond "the registry currently only contains these five."
 */
export async function runDemoScenario(deps: RunScenarioDeps, scenario: DemoScenarioId): Promise<Evaluation> {
  const { repos, logger } = deps;

  const job = await findDemoJob(repos);
  if (!job) {
    throw new AppError('INVALID_STATE', 'The demo is not available right now.', {
      internal: 'Demo job not found — has `npm run seed:demo` been run against this database?',
    });
  }
  // Belt-and-suspenders: `findDemoJob` already filtered on this title, so this
  // can only fail if that function's own filter is changed incorrectly later.
  if (job.title !== DEMO_JOB.title) {
    throw new Error('Resolved job does not match the expected demo job.');
  }

  const candidate = demoCandidateFor(scenario);
  // Same reasoning as above: today this can only be true, and the check stays
  // here so a future edit to the registry or the dataset cannot silently widen
  // what this function is willing to run.
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
  // per candidate — never a shared, module-level instance. That keeps two
  // concurrent runs (see the concurrency test) from being able to interfere
  // with each other's registered fixtures, and it is what makes this endpoint
  // "no dependencies, no state to leak between requests" true rather than
  // merely intended.
  const provider = createMockLlmProvider();
  installDeterministicExtractor(provider);

  await extractEvidence({ repos, provider, logger }, evaluation.id);
  const { evaluation: scored } = await matchAndScore({ repos, logger }, evaluation.id);

  return scored;
}
