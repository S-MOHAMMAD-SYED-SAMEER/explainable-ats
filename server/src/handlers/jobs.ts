import { rankJob } from '../agent/rank.ts';
import { AppError } from '../lib/errors.ts';
import type { Ranking } from '../agent/rankRules.ts';
import type { Repositories } from '../db/repositories/index.ts';
import type { Logger } from '../lib/logger.ts';
import type { RequirementKind, Seniority, JobStatus } from '../domain/ats.ts';
import type { HandlerResult } from './types.ts';

// Jobs, and the ranked list of people against one.
//
// The handlers do the reading; the routes do nothing but call them. Everything
// here is a read — no endpoint in this file writes anything, which is what lets
// a list screen be refreshed as often as a recruiter likes.

export type JobDeps = {
  repos: Repositories;
  logger?: Logger;
};

export type JobSummary = {
  id: string;
  title: string;
  seniority: Seniority;
  status: JobStatus;
  requirementCount: number;
  mustHaveCount: number;
  /** Candidates with a current evaluation. Superseded ones are not people. */
  candidateCount: number;
  createdAt: string;
};

export type RequirementView = {
  id: string;
  label: string;
  criterion: string;
  kind: RequirementKind;
  weight: number;
};

export type JobDetail = {
  id: string;
  title: string;
  seniority: Seniority;
  status: JobStatus;
  description: string;
  requirements: RequirementView[];
  candidateCount: number;
  createdAt: string;
};

export async function handleJobList(deps: JobDeps): Promise<HandlerResult<{ jobs: JobSummary[] }>> {
  const { repos } = deps;

  const jobs = await repos.jobs.list({ limit: 200 });
  const ids = jobs.map((job) => job.id);

  // Two batch queries for the whole list, whatever its length.
  const requirementsByJob = await repos.requirements.listForJobs(ids);
  const candidatesByJob = await repos.evaluations.countCurrentByJob(ids);

  return {
    status: 200,
    body: {
      jobs: jobs.map((job) => {
        const requirements = requirementsByJob.get(job.id) ?? [];
        return {
          id: job.id,
          title: job.title,
          seniority: job.seniority,
          status: job.status,
          requirementCount: requirements.length,
          mustHaveCount: requirements.filter((requirement) => requirement.kind === 'must_have').length,
          candidateCount: candidatesByJob.get(job.id) ?? 0,
          createdAt: job.createdAt,
        };
      }),
    },
  };
}

export async function handleJobDetail(deps: JobDeps, jobId: string): Promise<HandlerResult<JobDetail>> {
  const { repos } = deps;

  const job = await repos.jobs.getById(jobId);
  if (!job) throw new AppError('NOT_FOUND', 'That job does not exist.');

  const requirements = await repos.requirements.listForJob(job.id);
  const candidateCount = (await repos.evaluations.countCurrentByJob([job.id])).get(job.id) ?? 0;

  return {
    status: 200,
    body: {
      id: job.id,
      title: job.title,
      seniority: job.seniority,
      status: job.status,
      description: job.description,
      requirements: requirements.map((requirement) => ({
        id: requirement.id,
        label: requirement.label,
        criterion: requirement.criterion,
        kind: requirement.kind,
        weight: requirement.weight,
      })),
      candidateCount,
      createdAt: job.createdAt,
    },
  };
}

/**
 * The ranked list.
 *
 * Straight through to `rankJob`, which derives the order from the current
 * evaluations every time it is called. The browser is sent finished positions,
 * finished ranks and finished sentences — it never sorts, never scores, and
 * never decides who is gated. A second implementation of that logic in the
 * client is a second implementation able to disagree with the first.
 */
export async function handleJobRanking(deps: JobDeps, jobId: string): Promise<HandlerResult<Ranking>> {
  const ranking = await rankJob({ repos: deps.repos, logger: deps.logger }, jobId);
  return { status: 200, body: ranking };
}
