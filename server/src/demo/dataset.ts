import type { CreateJobInput, IngestResumeInput } from '../agent/ingest.ts';
import type { RankTier } from '../agent/rankRules.ts';
import type { MatchMode } from '../agent/matchRules.ts';

// The demo dataset.
//
// Five invented candidates against one invented role, written so that the four
// outcomes the product distinguishes are all visible on one screen — and so
// that the most important of them, the must-have gate, is impossible to miss.
//
// THE POINT OF THE NUMBERS
//
// The demo compares words the way the application does by default (`MATCH_MODE=folded`, `DEMO_MATCH_MODE`): plural, -ing and -ed
// endings are reduced first, so "Running" meets "run". Under it Devi and Marcus both score 71%. Devi is placed above Marcus, and the
// only reason is that Marcus's CV does not demonstrate an essential requirement. Same number, different placement, and the ranking
// says why in a sentence. A dataset where the qualified candidate simply scored higher would demonstrate nothing: it would look like
// ordinary sorting.
//
// WHOLE-WORD MATCHING TELLS A DIFFERENT STORY, AND THE DATA IS NOT BENT TO HIDE IT
//
// The CVs were written to say "Running PostgreSQL at scale" against the criterion "Has run PostgreSQL at scale". Under `strict`
// matching, "running" is not the criterion's word "run", so PostgreSQL covers two of three terms: partial. Rowan and Devi, who are
// qualified when endings are folded, are gated, and nobody is qualified. That is the cost of whole-word matching, shown on this data
// and left as it is: the CVs were not reworded to fit either rule. `expected` is what the demo's mode (folded) produces and
// `expectedStrict` is what whole-word matching produces; the tests check both.
//
// THE BLURBS ARE CLAIMS, AND A TEST HOLDS THEM
//
// `expected.demonstrates` is the one line a reader sees for each candidate. It once described one matching mode while the demo ran
// the other. `test/demo-dataset.test.ts` now reads every blurb for a tier, a "top of the list" or a "placed above/below <name>" and
// fails if the computed ranking says otherwise, so a blurb cannot drift from the result it describes.
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
  /** What the demo's mode (`DEMO_MATCH_MODE`, folded) produces for this candidate. Checked by a test. */
  expected: DemoOutcome & {
    /** One line, for the report and for a human reading this file. */
    demonstrates: string;
  };
  /** What whole-word (`strict`) matching produces for the same CV. Checked by a test. */
  expectedStrict: DemoOutcome;
};

export type DemoOutcome = {
  tier: RankTier;
  scoreBasisPoints: number | null;
  /** Verdict per requirement, in the order the requirements are declared. */
  verdicts: Array<'met' | 'partial' | 'not_met' | 'unclear'>;
};

/**
 * How words are compared in the demo: the application's own default, and the setting the evaluation used. The library default
 * (`DEFAULT_MATCH_MODE`, in a file the portfolio sites copy) stays `strict`; the demo passes this explicitly.
 */
export const DEMO_MATCH_MODE: MatchMode = 'folded';

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
      demonstrates:
        'Qualified: every requirement demonstrated, each backed by a quoted line. The top of the list.',
    },
    // (3x10000 + 2x5000 + 2x10000) / 7. "Running PostgreSQL at scale" covers two of the three words of "Has run PostgreSQL at scale"
    // when "running" is not "run", so PostgreSQL is only partly met and a must-have is missed.
    expectedStrict: { tier: 'gated', scoreBasisPoints: 8_571, verdicts: ['met', 'partial', 'met'] },
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
    // Folded, the job title "Backend Engineer" shares a folded word with "engineers", so the extractor quotes it for mentoring and a
    // requirement the CV is silent on reads not_met instead of unclear. Her tier does not change (mentoring is desirable), her verdict does.
    expected: {
      tier: 'qualified',
      scoreBasisPoints: 7_142,
      verdicts: ['met', 'met', 'not_met'],
      demonstrates:
        'Qualified: meets both essentials. Her CV says nothing about mentoring, yet it reads "does not meet": with word endings folded, her title "Backend Engineer" shares "engineer" with the requirement. That is the matcher\'s limit, not a finding about her. Same score as Marcus, placed above him.',
    },
    // (3x10000 + 2x5000 + 2x0) / 7
    expectedStrict: { tier: 'gated', scoreBasisPoints: 5_714, verdicts: ['met', 'partial', 'unclear'] },
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
    // (3x10000 + 2x0 + 2x10000) / 7 — the same number as Devi, one tier lower.
    expected: {
      tier: 'gated',
      scoreBasisPoints: 7_142,
      verdicts: ['met', 'not_met', 'met'],
      demonstrates:
        'THE CENTREPIECE. Gated (missing an essential): scores exactly what Devi scores and is placed below Devi, because the CV speaks to PostgreSQL and what it says does not show the requirement. The score is not reduced — only the placement changes.',
    },
    expectedStrict: { tier: 'gated', scoreBasisPoints: 7_142, verdicts: ['met', 'not_met', 'met'] },
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
    // (3x10000 + 2x0 + 2x10000) / 7. Whole-word matching scores her mentoring partial ("mentored" is not "mentoring").
    expected: {
      tier: 'needs_review',
      scoreBasisPoints: 7_142,
      verdicts: ['met', 'unclear', 'met'],
      demonstrates:
        'Worth a look: the CV says nothing at all about PostgreSQL — neither for nor against. Held for a human to look at rather than ruled out, because an absence of evidence is not evidence of absence. Scores the same as Devi and Marcus, and is placed below Devi and above Marcus.',
    },
    // (3x10000 + 2x0 + 2x5000) / 7
    expectedStrict: { tier: 'needs_review', scoreBasisPoints: 5_714, verdicts: ['met', 'unclear', 'partial'] },
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
        'Not assessed yet: CV received, assessment queued but not run. Listed and visibly unranked with no score, because a list that quietly omits someone looks complete and is not. On the strength of the CV they would likely do well — which is exactly why they are shown rather than hidden.',
    },
    expectedStrict: { tier: 'not_evaluated', scoreBasisPoints: null, verdicts: [] },
  },
];

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
