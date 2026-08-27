import type { CreateJobInput, IngestResumeInput } from '../agent/ingest.ts';
import type { RankTier } from '../agent/rankRules.ts';

// The demo dataset.
//
// Five invented candidates against one invented role, chosen so that the four
// outcomes the product distinguishes are all visible on one screen — and so
// that the most important of them, the must-have gate, is impossible to miss.
//
// THE POINT OF THE NUMBERS
//
// Devi and Marcus both score 71%. Devi is placed above Marcus, and the only
// reason is that Marcus's CV does not demonstrate an essential requirement.
// Same number, different placement, and the ranking says why in a sentence. A
// dataset where the qualified candidate simply scored higher would demonstrate
// nothing: it would look like ordinary sorting.
//
// EVERYTHING HERE IS INVENTED
//
// No real person, employer, address, email or phone number appears. Emails use
// the `.invalid` top-level domain and phone numbers come from the ranges
// reserved for fiction, both of which are guaranteed never to reach anyone.
// The personal details exist only so a demo can show them being removed before
// the model reads anything — which is the fairness story, and it needs
// something real-looking to remove.
//
// THE VERDICTS ARE NOT ASSERTED HERE, THEY ARE DERIVED
//
// `expected` below records what each candidate is meant to demonstrate, and
// `test/demo-dataset.test.ts` runs the real pipeline and checks the dataset
// actually produces it. Nothing in the seeding path reads `expected` — it is a
// statement of intent that a test can falsify, not a shortcut that makes the
// intent true.

export const DEMO_JOB: CreateJobInput = {
  title: 'Senior Backend Engineer',
  seniority: 'senior',
  description:
    'Owns a payments service end to end: the API, the database behind it, and the people who work on it.',
  requirements: [
    {
      label: 'Node.js',
      criterion: 'Has shipped production services in Node.js',
      kind: 'must_have',
      weight: 3,
    },
    {
      label: 'PostgreSQL',
      criterion: 'Has run PostgreSQL at scale',
      kind: 'must_have',
      weight: 2,
    },
    {
      label: 'Mentoring',
      criterion: 'Has mentored junior engineers',
      kind: 'nice_to_have',
      weight: 2,
    },
  ],
};

/** The header every invented CV carries, so redaction has something to remove. */
function header(name: string, email: string, phone: string, born: string, nationality: string, gender: string, address: string): string[] {
  return [
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
    `Date of birth: ${born}`,
    `Nationality: ${nationality}`,
    `Gender: ${gender}`,
    `Address: ${address}`,
    '',
  ];
}

export type DemoCandidate = {
  reference: string;
  displayName: string;
  resume: string;
  /**
   * How far the assessment gets at seed time.
   *
   * `queued` opens an evaluation and stops. It does NOT skip the evaluation
   * entirely: a candidate with no evaluation row for a job was never put
   * forward for that job, and the ranking correctly declines to invent them
   * into the list. "Received, not yet assessed" is the state a real queue
   * produces, and it is the one a recruiter can actually see.
   */
  assess: 'scored' | 'queued';
  /** What this candidate is in the dataset to demonstrate. Checked by a test. */
  expected: {
    tier: RankTier;
    scoreBasisPoints: number | null;
    /** Verdict per requirement, in the order the requirements are declared. */
    verdicts: Array<'met' | 'partial' | 'not_met' | 'unclear'>;
    /** One line, for the report and for a human reading this file. */
    demonstrates: string;
  };
};

export const DEMO_CANDIDATES: readonly DemoCandidate[] = [
  {
    reference: 'demo-001',
    displayName: 'Rowan Ashfield',
    assess: 'scored',
    resume: [
      ...header(
        'Rowan Ashfield',
        'rowan.ashfield@example.invalid',
        '+44 20 7946 0102',
        '12 June 1990',
        'British',
        'Female',
        '14 Foundry Lane, Bristol BS1 4TR',
      ),
      'SUMMARY',
      'Backend engineer, eight years on payment and booking systems.',
      '',
      'EXPERIENCE',
      'Senior Engineer, Halden Freight',
      'Designed and shipped production Node.js services for a freight booking platform.',
      'Running PostgreSQL at scale, moving a single instance to a replicated cluster.',
      'Mentoring: mentored four junior engineers through their first releases.',
      '',
      'SKILLS',
      'TypeScript, Docker, Kubernetes, Terraform',
    ].join('\n'),
    expected: {
      tier: 'qualified',
      scoreBasisPoints: 10_000,
      verdicts: ['met', 'met', 'met'],
      demonstrates: 'Every requirement demonstrated, each backed by a quoted line. The top of the list.',
    },
  },

  {
    reference: 'demo-002',
    displayName: 'Devi Narayanan',
    assess: 'scored',
    resume: [
      ...header(
        'Devi Narayanan',
        'devi.narayanan@example.invalid',
        '+44 20 7946 0247',
        '3 March 1992',
        'Indian',
        'Female',
        '8 Peartree Court, Manchester M4 5JW',
      ),
      'SUMMARY',
      'Backend engineer focused on billing and reconciliation.',
      '',
      'EXPERIENCE',
      'Backend Engineer, Corvid Systems',
      'Designed and shipped production Node.js services behind a payments API.',
      'Running PostgreSQL at scale for a multi-tenant billing system.',
      'Reduced tail latency by tuning slow queries and adding read replicas.',
      '',
      'SKILLS',
      'TypeScript, Redis, Docker',
    ].join('\n'),
    expected: {
      tier: 'qualified',
      // (3x10000 + 2x10000 + 2x0) / 7
      scoreBasisPoints: 7_142,
      verdicts: ['met', 'met', 'unclear'],
      demonstrates:
        'Meets both essentials; the CV says nothing about the desirable one. Scores the same as Marcus and is placed above him.',
    },
  },

  {
    reference: 'demo-003',
    displayName: 'Marcus Oyelaran',
    assess: 'scored',
    resume: [
      ...header(
        'Marcus Oyelaran',
        'marcus.oyelaran@example.invalid',
        '+44 20 7946 0388',
        '27 October 1994',
        'Nigerian',
        'Male',
        '52 Kilnbrook Road, Leeds LS2 8QT',
      ),
      'SUMMARY',
      'Full-stack engineer, strongest on the service layer.',
      '',
      'EXPERIENCE',
      'Full-stack Engineer, Lumen Retail',
      'Designed and shipped production Node.js services for an online storefront.',
      'Used PostgreSQL for a final-year university project.',
      'Mentoring: mentored three junior engineers joining the team.',
      '',
      'SKILLS',
      'TypeScript, React, Docker',
    ].join('\n'),
    expected: {
      tier: 'gated',
      // (3x10000 + 2x0 + 2x10000) / 7 — the same number as Devi, one tier lower.
      scoreBasisPoints: 7_142,
      verdicts: ['met', 'not_met', 'met'],
      demonstrates:
        'THE CENTREPIECE. Scores exactly what Devi scores, and is placed below her: the CV speaks to PostgreSQL and what it says does not show the requirement. The score is not reduced — only the placement changes.',
    },
  },

  {
    reference: 'demo-004',
    displayName: 'Ines Fabre',
    assess: 'scored',
    resume: [
      ...header(
        'Ines Fabre',
        'ines.fabre@example.invalid',
        '+44 20 7946 0451',
        '19 January 1996',
        'French',
        'Female',
        '3 Marlow Street, Glasgow G3 8AA',
      ),
      'SUMMARY',
      'Platform engineer working on data ingestion.',
      '',
      'EXPERIENCE',
      'Platform Engineer, Sable Analytics',
      'Designed and shipped production Node.js services for an analytics dashboard.',
      'Built ingestion pipelines and a scheduled reporting job.',
      'Mentored a junior developer during onboarding.',
      '',
      'SKILLS',
      'TypeScript, Kafka, Docker',
    ].join('\n'),
    expected: {
      tier: 'needs_review',
      // (3x10000 + 2x0 + 2x5000) / 7
      scoreBasisPoints: 5_714,
      verdicts: ['met', 'unclear', 'partial'],
      demonstrates:
        'The CV says nothing at all about PostgreSQL — neither for nor against. Held for a human to look at rather than ruled out, because an absence of evidence is not evidence of absence.',
    },
  },

  {
    reference: 'demo-005',
    displayName: 'Toby Kestrel',
    assess: 'queued',
    resume: [
      ...header(
        'Toby Kestrel',
        'toby.kestrel@example.invalid',
        '+44 20 7946 0519',
        '5 September 1993',
        'Irish',
        'Male',
        '77 Ardwick Green, Liverpool L1 9BG',
      ),
      'SUMMARY',
      'Backend engineer, most recently on logistics tooling.',
      '',
      'EXPERIENCE',
      'Engineer, Northgate Logistics',
      'Built and shipped production Node.js services for depot scheduling.',
      'Running PostgreSQL at scale behind a routing API.',
      '',
      'SKILLS',
      'TypeScript, Go, Docker',
    ].join('\n'),
    expected: {
      tier: 'not_evaluated',
      scoreBasisPoints: null,
      verdicts: [],
      demonstrates:
        'CV received, assessment queued but not run. Listed and visibly unranked with no score, because a list that quietly omits someone looks complete and is not. On the strength of the CV they would likely do well — which is exactly why they are shown rather than hidden.',
    },
  },
];

/** Everything the seeder writes, as one value a test can read. */
export const DEMO_DATASET = {
  job: DEMO_JOB,
  candidates: DEMO_CANDIDATES,
} as const;

/** Ingestion input for one demo candidate. */
export function ingestInputFor(candidate: DemoCandidate): IngestResumeInput {
  return {
    reference: candidate.reference,
    displayName: candidate.displayName,
    text: candidate.resume,
    source: 'demo',
  };
}

/**
 * The personal details in the dataset: contact, age, nationality, gender,
 * address.
 *
 * These must never leave the server. They are removed before the model reads
 * anything, AND they are absent from every API response — a recruiter has no
 * business seeing a candidate's date of birth on a screening screen, and the
 * quarantine stores no value to send even if someone asked for one.
 */
export function demoPersonalDetails(): string[] {
  const values: string[] = [];
  for (const candidate of DEMO_CANDIDATES) {
    for (const line of candidate.resume.split('\n')) {
      const match = /^(?:Email|Phone|Date of birth|Nationality|Gender|Address):\s*(.+)$/.exec(line);
      if (match?.[1]) values.push(match[1].trim());
    }
  }
  return [...new Set(values)];
}

/**
 * The candidate names.
 *
 * A different rule applies to these, and the difference is deliberate. A name
 * is masked out of the copy the MODEL reads, so it cannot influence a reading.
 * It is shown to the recruiter, because a list of anonymous reference codes is
 * not a tool anyone can use. What matters is that nothing in the scoring or
 * ordering path reads it — which `rank-rules.test.ts` asserts directly, by
 * renaming everyone and requiring the order not to move.
 */
export function demoCandidateNames(): string[] {
  return DEMO_CANDIDATES.map((candidate) => candidate.displayName);
}
