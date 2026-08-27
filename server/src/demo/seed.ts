import { DEMO_JOB, DEMO_CANDIDATES, ingestInputFor, type DemoCandidate } from './dataset.ts';
import { createJob, ingestResume } from '../agent/ingest.ts';
import { openEvaluation, extractEvidence } from '../agent/extract.ts';
import { matchAndScore } from '../agent/match.ts';
import { createMockLlmProvider } from '../adapters/llm/mock.ts';
import { installDeterministicExtractor } from '../agent/mockExtractor.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { Logger } from '../lib/logger.ts';

// Applying the demo dataset.
//
// This runs the REAL pipeline — ingest, redact, extract, verify, match, score —
// exactly as a genuine upload would. Nothing is inserted directly.
//
// That is not tidiness. A seeder that wrote evidence rows straight into the
// table would produce a demo that proves nothing: the quotes would not have
// passed the verifier, the scores would not have come from the scorer, and the
// audit trail would be missing the very steps the demo exists to show. If the
// pipeline breaks, this seeder must break with it.

export type SeedDeps = {
  repos: Repositories;
  logger?: Logger;
};

export type SeededCandidate = {
  reference: string;
  displayName: string;
  evaluationId: string | null;
  candidateId: string;
  /** How many protected attributes were masked before anything read the CV. */
  redactedCount: number;
};

export type SeedResult = {
  jobId: string;
  jobTitle: string;
  requirementCount: number;
  candidates: SeededCandidate[];
};

/** True when a database holds nothing but demo rows (or nothing at all). */
export async function containsOnlyDemoData(repos: Repositories): Promise<boolean> {
  const candidates = await repos.candidates.list({ limit: 500 });
  return candidates.every((candidate) => candidate.reference.startsWith('demo-'));
}

export async function isEmpty(repos: Repositories): Promise<boolean> {
  return (await repos.jobs.count()) === 0 && (await repos.candidates.count()) === 0;
}

/**
 * Removes the demo dataset.
 *
 * Deliberately narrow: it deletes demo candidates by reference prefix and demo
 * jobs by title, and relies on the schema's ON DELETE CASCADE for everything
 * hanging off them. It has no "delete everything" path, so the worst it can do
 * to a database holding real data is nothing.
 *
 * The audit trail is left alone. It is append-only by design, and a reset that
 * quietly erased history would break the one guarantee the trail makes.
 */
export async function clearDemoData(deps: SeedDeps): Promise<{ candidates: number; jobs: number }> {
  const { repos } = deps;

  const candidates = (await repos.candidates.list({ limit: 500 })).filter((candidate) =>
    candidate.reference.startsWith('demo-'),
  );
  for (const candidate of candidates) {
    await repos.db.execute('DELETE FROM candidates WHERE id = ?', [candidate.id]);
  }

  const jobs = (await repos.jobs.list({ limit: 500 })).filter((job) => job.title === DEMO_JOB.title);
  for (const job of jobs) {
    await repos.db.execute('DELETE FROM jobs WHERE id = ?', [job.id]);
  }

  return { candidates: candidates.length, jobs: jobs.length };
}

async function seedCandidate(
  deps: SeedDeps,
  jobId: string,
  candidate: DemoCandidate,
): Promise<SeededCandidate> {
  const { repos } = deps;

  const ingested = await ingestResume({ repos, logger: deps.logger }, ingestInputFor(candidate));

  // The evaluation is opened for everyone. An evaluation row is what puts a
  // candidate forward for THIS job — without one the ranking rightly declines
  // to invent them into the list, and they would be invisible on the very
  // screen that is supposed to show them.
  const evaluation = await openEvaluation({ repos }, {
    jobId,
    candidateId: ingested.candidate.id,
    resume: ingested.resume,
  });

  if (candidate.assess === 'queued') {
    // Opened and left there: no extraction, no score. The recruiter sees
    // "Not assessed yet" with no number, which is the honest state.
    return {
      reference: candidate.reference,
      displayName: candidate.displayName,
      candidateId: ingested.candidate.id,
      evaluationId: evaluation.id,
      redactedCount: ingested.redactedCount,
    };
  }

  const provider = createMockLlmProvider();
  installDeterministicExtractor(provider);

  await extractEvidence({ repos, provider, logger: deps.logger }, evaluation.id);
  await matchAndScore({ repos, logger: deps.logger }, evaluation.id);

  return {
    reference: candidate.reference,
    displayName: candidate.displayName,
    candidateId: ingested.candidate.id,
    evaluationId: evaluation.id,
    redactedCount: ingested.redactedCount,
  };
}

/**
 * Seeds the demo dataset.
 *
 * Deterministic: the stand-in model is a pure function of the prompt, and every
 * stage after it is integer arithmetic. Seeding twice into two fresh databases
 * produces the same scores, the same verdicts and the same order.
 */
export async function seedDemoData(deps: SeedDeps): Promise<SeedResult> {
  const { repos, logger } = deps;

  const { job, requirements } = await createJob({ repos }, DEMO_JOB);

  const candidates: SeededCandidate[] = [];
  for (const candidate of DEMO_CANDIDATES) {
    candidates.push(await seedCandidate(deps, job.id, candidate));
  }

  logger?.info('Seeded the demo dataset', {
    job: job.title,
    requirements: requirements.length,
    candidates: candidates.length,
  });

  return {
    jobId: job.id,
    jobTitle: job.title,
    requirementCount: requirements.length,
    candidates,
  };
}
