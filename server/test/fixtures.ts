import { createJob, ingestResume } from '../src/agent/ingest.ts';
import { openEvaluation } from '../src/agent/extract.ts';
import { createMockLlmProvider, type MockLlmProvider } from '../src/adapters/llm/mock.ts';
import { installDeterministicExtractor } from '../src/agent/mockExtractor.ts';
import type { Repositories } from '../src/db/repositories/index.ts';

// One synthetic resume, used by every test that needs a realistic document.
//
// It carries a protected attribute of every category the redactor knows about,
// AND real evidence that must survive redaction untouched. Both halves matter:
// a fixture with only sensitive data would let an over-eager redactor pass, and
// a fixture with only evidence would let a broken one pass.

export const CANDIDATE_NAME = 'Priya Raman';

export const RESUME_TEXT = [
  'Name: Priya Raman',
  'Email: priya.raman@example.com',
  'Phone: +91 98765 43210',
  'Date of birth: 4 March 1993',
  'Nationality: Indian',
  'Gender: Female',
  'Address: 14 Nehru Road, Bengaluru 560001',
  '',
  'SUMMARY',
  'Backend engineer with six years building payment systems.',
  '',
  'EXPERIENCE',
  'Senior Engineer, Northwind Payments',
  'Designed and shipped a Node.js settlement service handling 40,000 transactions a day.',
  // Indented on purpose: the extractor has to report the offset of the quoted
  // text, not of the line it sits on.
  '  Led the migration from a single PostgreSQL instance to a replicated cluster.',
  'Mentored three junior engineers through their first production deployments.',
  '',
  'SKILLS',
  'TypeScript, Docker, Kubernetes',
].join('\n');

/** Every protected value in the fixture, for "this must not appear" assertions. */
export const SENSITIVE_VALUES = [
  'Priya Raman',
  'priya.raman@example.com',
  '+91 98765 43210',
  '4 March 1993',
  'Indian',
  'Female',
  '14 Nehru Road, Bengaluru 560001',
];

/** Evidence that must survive redaction verbatim. */
export const EVIDENCE_PHRASES = [
  'Designed and shipped a Node.js settlement service',
  'Led the migration from a single PostgreSQL instance',
  'Mentored three junior engineers',
];

export const JOB_INPUT = {
  title: 'Backend Engineer',
  seniority: 'senior' as const,
  description: 'Owns a payments service end to end.',
  requirements: [
    {
      label: 'Node.js services',
      criterion: 'Has designed and shipped production Node.js services',
      kind: 'must_have' as const,
      weight: 3,
    },
    {
      label: 'PostgreSQL',
      criterion: 'Has run PostgreSQL migrations at scale',
      kind: 'must_have' as const,
      weight: 2,
    },
    {
      label: 'Mentoring',
      criterion: 'Has mentored junior engineers',
      kind: 'nice_to_have' as const,
      weight: 1,
    },
  ],
};

export type Scenario = Awaited<ReturnType<typeof seedScenario>>;

/**
 * Builds a job, a candidate with an ingested resume, and a pending evaluation.
 *
 * Nothing is extracted yet — every extraction test wants to drive that step
 * itself, and a helper that ran it would hide the lifecycle the tests are here
 * to pin down.
 */
export async function seedScenario(
  repos: Repositories,
  options: { resumeText?: string; deterministicExtractor?: boolean } = {},
) {
  const { job, requirements } = await createJob({ repos }, JOB_INPUT);

  const ingested = await ingestResume(
    { repos },
    {
      reference: 'cand-001',
      displayName: CANDIDATE_NAME,
      text: options.resumeText ?? RESUME_TEXT,
      source: 'upload',
    },
  );

  const evaluation = await openEvaluation(
    { repos },
    { jobId: job.id, candidateId: ingested.candidate.id, resume: ingested.resume },
  );

  const provider: MockLlmProvider = createMockLlmProvider();
  if (options.deterministicExtractor !== false) installDeterministicExtractor(provider);

  return { job, requirements, ...ingested, evaluation, provider };
}
