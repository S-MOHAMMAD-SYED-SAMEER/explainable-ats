import { rankCandidates, type RankInput, type Ranking } from './rankRules.ts';
import { AppError } from '../lib/errors.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { Logger } from '../lib/logger.ts';

// Loading the inputs a ranking needs, and nothing else.
//
// This function performs FIVE queries whatever the number of candidates. That
// is deliberate rather than incidental: Project 2 shipped a list screen that
// issued 57 round trips and took ten seconds, and the fix was the same shape as
// the batch calls below. A ranking is the screen a recruiter opens first.
//
// IT WRITES NOTHING
//
// No table, no audit event, no cached order. Running it twice changes nothing,
// which is what "derived on read" has to mean to be worth anything — and it is
// why the append-only audit model is preserved here by not being touched. A
// ranking is not an event; it is a view of the events that already happened.
//
// IT NEVER READS EVIDENCE
//
// Not `evidence`, not `resumes`, not `sensitive_findings`. Everything it needs
// was committed by the scorer, from verified evidence only, and re-deriving any
// of it here would create a second answer able to disagree with the first.

export type RankDeps = {
  repos: Repositories;
  logger?: Logger;
};

export type RankOptions = {
  /**
   * Candidates to include even if they have no evaluation for this job.
   *
   * Someone who was never evaluated must be visibly absent rather than
   * silently missing: a list that quietly omits them looks complete and is not.
   */
  includeCandidateIds?: readonly string[];
};

export async function rankJob(deps: RankDeps, jobId: string, options: RankOptions = {}): Promise<Ranking> {
  const { repos, logger } = deps;

  const job = await repos.jobs.getById(jobId);
  if (!job) throw new AppError('NOT_FOUND', 'That job does not exist.');

  const requirements = await repos.requirements.listForJob(jobId);

  // Current only. A superseded evaluation keeps its own history and its own
  // number, but it is not an answer about this candidate any more.
  const current = await repos.evaluations.listCurrentForJob(jobId);

  const matchesByEvaluation = await repos.matches.listForEvaluations(current.map((entry) => entry.id));

  const candidateIds = [
    ...new Set([...current.map((entry) => entry.candidateId), ...(options.includeCandidateIds ?? [])]),
  ];
  const candidates = await repos.candidates.listByIds(candidateIds);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  const evaluationByCandidate = new Map(current.map((entry) => [entry.candidateId, entry]));

  const inputs: RankInput[] = [];
  for (const candidateId of candidateIds) {
    const candidate = byId.get(candidateId);
    // A candidate id that no longer resolves is skipped rather than invented.
    // Ranking a row we cannot name would put an anonymous entry in front of a
    // recruiter with no way to act on it.
    if (!candidate) continue;

    const evaluation = evaluationByCandidate.get(candidateId) ?? null;
    inputs.push({
      candidate: {
        id: candidate.id,
        reference: candidate.reference,
        displayName: candidate.displayName,
      },
      evaluation,
      matches: evaluation ? (matchesByEvaluation.get(evaluation.id) ?? []) : [],
    });
  }

  const ranking = rankCandidates(jobId, requirements, inputs);

  logger?.info('Ranked a job', {
    jobId,
    ranked: ranking.rankedCount,
    notEvaluated: ranking.notEvaluatedCount,
  });

  return ranking;
}
