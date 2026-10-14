import path from 'node:path';
import fs from 'node:fs';
import type { Ranking } from '../src/agent/rankRules.ts';
import type { RedactionSpan } from '../src/agent/redact.ts';
import type { ScoreBreakdown } from '../src/agent/score.ts';
import type {
  AuditEvent,
  Candidate,
  Evaluation,
  Evidence,
  Job,
  JobRequirement,
  RequirementMatch,
} from '../src/domain/ats.ts';

// Finding the portfolio's demo runner, for the parity suite.
//
// The runner lives in a different repository (the portfolio, where it is
// deployed from), so there is no package to import it from. This module is the
// one place that knows where to look, and what the parity tests are allowed to
// assume about it once found.
//
// WHERE IT LOOKS, IN ORDER
//
//   1. $PORTFOLIO_DEMO_DIR — an explicit override, resolved against this
//      repository's root when relative. If it is SET, it is authoritative: a
//      wrong value is reported as a misconfiguration rather than quietly
//      replaced by a guess, because a suite that ran against a different
//      checkout than the one you named would be telling you something untrue.
//   2. ../sameer-3d-portfolio/src/demo/p3 — the standalone layout, with this
//      repository and the portfolio checked out side by side.
//   3. ../../sameer-3d-portfolio/sameer-3d-portfolio/src/demo/p3 — the layout
//      from when this project lived inside the monorepo.
//
// Every location is derived from the repository root, so nothing here depends
// on the machine, the drive, or where the repository was cloned.

export const PORTFOLIO_FIXTURE_ENV = 'PORTFOLIO_DEMO_DIR';

const RUNNER_FILE = 'run.ts';

export type FixtureLookup = {
  /** The directory holding `run.ts`, or null if it was not found. */
  dir: string | null;
  /** The runner file, or null. */
  runner: string | null;
  /** Every location examined, in order — what a skip message should name. */
  tried: string[];
  /** True when $PORTFOLIO_DEMO_DIR was set but did not hold a runner. */
  explicitButMissing: boolean;
};

export type FixtureLookupOptions = {
  /** This repository's root (the directory that contains `server/` and `web/`). */
  repoRoot: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Injectable so the lookup can be tested without touching the disk. */
  exists?: (file: string) => boolean;
};

export function resolvePortfolioFixture(options: FixtureLookupOptions): FixtureLookup {
  const { repoRoot } = options;
  const env = options.env ?? process.env;
  const exists = options.exists ?? ((file: string) => fs.existsSync(file));

  const explicit = env[PORTFOLIO_FIXTURE_ENV]?.trim();
  const tried: string[] = [];

  const probe = (dir: string): FixtureLookup | null => {
    tried.push(dir);
    const runner = path.join(dir, RUNNER_FILE);
    return exists(runner) ? { dir, runner, tried, explicitButMissing: false } : null;
  };

  if (explicit) {
    const found = probe(path.resolve(repoRoot, explicit));
    return found ?? { dir: null, runner: null, tried, explicitButMissing: true };
  }

  const defaults = [
    path.resolve(repoRoot, '..', 'sameer-3d-portfolio', 'src', 'demo', 'p3'),
    path.resolve(repoRoot, '..', '..', 'sameer-3d-portfolio', 'sameer-3d-portfolio', 'src', 'demo', 'p3'),
  ];
  for (const dir of defaults) {
    const found = probe(dir);
    if (found) return found;
  }

  return { dir: null, runner: null, tried, explicitButMissing: false };
}

/** What a parity test is told when the runner is absent. */
export function skipReason(lookup: FixtureLookup): string {
  return (
    `The portfolio demo runner was not found. Looked in: ${lookup.tried.join(', ')}. ` +
    `Check out the portfolio beside this repository, or set ${PORTFOLIO_FIXTURE_ENV} ` +
    "to the portfolio's src/demo/p3 directory, to run the parity check."
  );
}

// --- the runner's shape, as far as the parity tests rely on it ---------------
//
// Declared here, from the server's own domain types, rather than inferred from a
// `typeof import('../path/to/portfolio/run.ts')`. The inferred form made the
// whole suite typecheck only when a sibling checkout happened to sit at one
// hard-coded location, and degrade to implicit-`any` everywhere when it did not.
// The runner is dynamically imported, so the compiler cannot know its shape; the
// honest thing is to state the shape the tests depend on and let the tests fail
// at runtime if the runner stops matching it.

export type PortfolioResume = {
  id: string;
  contentText: string;
  redactedText: string;
  spans: RedactionSpan[];
  charCount: number;
};

export type PortfolioCandidateRun = {
  candidate: Candidate;
  resume: PortfolioResume;
  evaluation: Evaluation;
  assessed: boolean;
  evidence: Evidence[];
  verifiedEvidence: Evidence[];
  matches: RequirementMatch[];
  score: ScoreBreakdown | null;
  audit: AuditEvent[];
};

export type PortfolioDemoResult = {
  job: Job;
  requirements: JobRequirement[];
  candidates: PortfolioCandidateRun[];
  ranking: Ranking;
  audit: AuditEvent[];
};

export type PortfolioDemoModule = {
  DEMO_TIMESTAMP: string;
  runDemo(): Promise<PortfolioDemoResult>;
};

// --- the 2D portfolio's copy of the runner -----------------------------------
//
// The 2D portfolio site (`portfolio`) runs the same vendored pipeline over the
// same generated dataset as the 3D one, from its own `src/demo/p3`. It is a
// separate copy that can drift on its own, so the parity suite runs against it
// too. The lookup is the same shape as the one above, with its own override.

export const PORTFOLIO_2D_FIXTURE_ENV = 'PORTFOLIO_2D_DEMO_DIR';

export function resolvePortfolio2dFixture(options: FixtureLookupOptions): FixtureLookup {
  const { repoRoot } = options;
  const env = options.env ?? process.env;
  const exists = options.exists ?? ((file: string) => fs.existsSync(file));

  const explicit = env[PORTFOLIO_2D_FIXTURE_ENV]?.trim();
  const dir = explicit
    ? path.resolve(repoRoot, explicit)
    : path.resolve(repoRoot, '..', 'portfolio', 'src', 'demo', 'p3');
  const runner = path.join(dir, RUNNER_FILE);

  return exists(runner)
    ? { dir, runner, tried: [dir], explicitButMissing: false }
    : { dir: null, runner: null, tried: [dir], explicitButMissing: Boolean(explicit) };
}
