import { createSessionRepository } from './sessions.ts';
import { createJobRepository, createRequirementRepository } from './jobs.ts';
import {
  createCandidateRepository,
  createResumeRepository,
  createSensitiveFindingRepository,
} from './candidates.ts';
import {
  createEvaluationRepository,
  createEvidenceRepository,
  createRecruiterDecisionRepository,
  createRequirementMatchRepository,
} from './evaluations.ts';
import { createAuditRepository } from './audit.ts';
import { systemClock, type Clock } from '../../lib/clock.ts';
import { newId as randomId, type IdGenerator } from '../../lib/ids.ts';
import type { Database } from '../types.ts';

// The repository set.
//
// One place that knows every table. Nothing outside this directory writes SQL.
//
// `sensitiveFindings` is here and is deliberately never read by anything that
// scores. It exists so the system can show a recruiter what it detected and
// excluded — the quarantine is a feature, not a side effect.
//
// There is no ranking repository: a ranking is a pure function of the current
// evaluations, computed on read in P3-E. A stored one would be a second source
// of truth able to disagree with the first.
//
// `transaction` rebinds every repository onto the transaction's connection.
// That is not a convenience: calling `repos.db.transaction(...)` and then using
// the outer `repos` inside it silently writes outside the transaction on
// PostgreSQL, where a transaction holds one pooled client. Handing the callback
// a fully rebound set removes the chance to get that wrong.

export type Repositories = {
  db: Database;
  sessions: ReturnType<typeof createSessionRepository>;
  jobs: ReturnType<typeof createJobRepository>;
  requirements: ReturnType<typeof createRequirementRepository>;
  candidates: ReturnType<typeof createCandidateRepository>;
  resumes: ReturnType<typeof createResumeRepository>;
  sensitiveFindings: ReturnType<typeof createSensitiveFindingRepository>;
  evaluations: ReturnType<typeof createEvaluationRepository>;
  evidence: ReturnType<typeof createEvidenceRepository>;
  matches: ReturnType<typeof createRequirementMatchRepository>;
  decisions: ReturnType<typeof createRecruiterDecisionRepository>;
  audit: ReturnType<typeof createAuditRepository>;
  transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T>;
};

export type RepositoryOptions = { clock?: Clock; newId?: IdGenerator };

export function createRepositories(db: Database, options: RepositoryOptions = {}): Repositories {
  const clock = options.clock ?? systemClock;
  const newId = options.newId ?? randomId;
  const deps = { db, clock, newId };

  return {
    db,
    sessions: createSessionRepository(deps),
    jobs: createJobRepository(deps),
    requirements: createRequirementRepository(deps),
    candidates: createCandidateRepository(deps),
    resumes: createResumeRepository(deps),
    sensitiveFindings: createSensitiveFindingRepository(deps),
    evaluations: createEvaluationRepository(deps),
    evidence: createEvidenceRepository(deps),
    matches: createRequirementMatchRepository(deps),
    decisions: createRecruiterDecisionRepository(deps),
    audit: createAuditRepository(deps),
    transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T> {
      return db.transaction((txDb) => fn(createRepositories(txDb, options)));
    },
  };
}
