// What the public demo says about itself, in one place.
//
// A pure module with no JSX, so a test can read every sentence a visitor is
// given about the demo and hold it to two standards: it must not claim a model
// or an external service is doing anything, and it must describe stages the
// system actually has.
//
// THE RULE FOR EVERY LINE HERE
//
// The public demo runs the real pipeline over a fixed synthetic dataset, with a
// fixed keyword matcher standing in for the language model. It makes no external
// call, needs no key, and uses no AI. Wording that blurs that — "AI extraction",
// "the model read the CV", a vendor's name — would be the one dishonest thing a
// demo can do, so none of it belongs in this file.

export const DEMO_TITLE = 'Interactive ATS Demo';

/** The one call to action on the front page, and the only button that leads into the demo. */
export const CTA_LABEL = 'Explore the Interactive Demo';

export const PROJECT_LEAD =
  'An evidence-first resume screening system that can explain every ranking it makes. This page says how it works; the interactive demo lets you try it on synthetic candidates.';

export const DEMO_DISCLOSURE = 'Deterministic and explainable demo — no external AI/API call is required.';

/** What a visitor can do once they are in. */
export const EXPLORE_ITEMS: readonly string[] = [
  'The role, and what it asks for.',
  'Five candidates, ranked — including two who score the same and are placed differently.',
  'The passages quoted from each CV, checked against the original.',
  'A requirement-by-requirement match breakdown, and the score it adds up to.',
  'A demo recruiter decision, saved only to your own session.',
];

export type ProjectSection = {
  id: string;
  heading: string;
  /** Short paragraphs, in order. */
  body: readonly string[];
  /** Optional bullets after the paragraphs. */
  points?: readonly string[];
};

/**
 * The project explanation: what a visitor reads before they go in.
 *
 * Twelve topics, in the order a reviewer asks about them. The seventh-stage
 * workflow is not a section of prose here: it is `WORKFLOW_STAGES` below, drawn as
 * its own list, so the section called 'workflow' carries only its introduction.
 *
 * EVERY SENTENCE IS A CLAIM THE CODE KEEPS. Nothing here says a model reads the
 * CVs (in this demo none does), names a vendor, or says the system can do what it
 * cannot — `PROJECT_LIMITS` says plainly what it cannot, and the tests hold both
 * to the same standard as the rest of this file.
 */
export const PROJECT_SECTIONS: readonly ProjectSection[] = [
  {
    id: 'what',
    heading: 'What it is',
    body: [
      'Explainable ATS ranks candidates against a role and shows its working. Every score is built from passages quoted from the candidate’s own CV, and every quote is checked against the original document before it can count for anything.',
    ],
  },
  {
    id: 'problem',
    heading: 'The problem it addresses',
    body: [
      'A resume score nobody can explain is hard to trust, hard to challenge and hard to defend. Screening tools often return a bare number, can be swayed by details that should be irrelevant, and let a model’s wording stand in for proof.',
      'This project is built around the opposite: show the evidence, keep out what should not matter, and leave a person accountable for the decision.',
    ],
  },
  {
    id: 'workflow',
    heading: 'The seven-stage workflow',
    body: ['Every CV goes through the same seven stages, in order. Each one is recorded, so any placement can be explained afterwards.'],
  },
  {
    id: 'evidence',
    heading: 'Evidence-first matching',
    body: [
      'Each requirement is judged only from verified quotes. No quote, no credit: a CV that is silent on a requirement is marked “not demonstrated”, never “failed”.',
      'Every verdict states what was counted, so a reader can check it by hand.',
    ],
  },
  {
    id: 'scoring',
    heading: 'Deterministic scoring and ranking',
    body: [
      'Verdicts become a score with whole-number arithmetic: a weighted average whose parts add up exactly to the total. The same input always gives the same score.',
      'Ranking is worked out from the stored results rather than stored itself. Candidates who meet every essential requirement rank above those who do not, whatever their score, and ties are shown as ties.',
    ],
  },
  {
    id: 'privacy',
    heading: 'Redaction and privacy',
    body: [
      'Before anything reads a CV, personal details — name, contact details, date of birth, gender, nationality, address and similar — are masked in place with blocks of the same length. The system records which category was found and where, never the value, and the extraction step is shown only the masked copy.',
      'Redaction here is pattern-based and tuned for the synthetic CVs; it is not a general-purpose scrubber for real-world documents.',
    ],
  },
  {
    id: 'verification',
    heading: 'Verifying model-produced evidence',
    body: [
      'The extraction step only proposes quotes; deterministic code decides what counts. A quote must be found word for word in the original CV, and one that cannot be found is kept in the audit trail as rejected and takes no part in the score. A quote that overlaps masked text is refused.',
      'In this demo the extraction step is a fixed keyword matcher, not a language model. The same checks apply to either.',
    ],
  },
  {
    id: 'decision',
    heading: 'Recruiter decision and audit trail',
    body: [
      'A person records advance, review or reject, with a written reason, once per assessment. Every stage writes to an append-only audit trail: who acted (the system, a model or a person), what happened, and the data behind it.',
      'In this demo your decision is saved only to your own private session.',
    ],
  },
  {
    id: 'architecture',
    heading: 'Architecture',
    body: [
      'A server that runs the pipeline, a single-page client, and a database behind one interface. The extraction step sits behind its own interface and is the only stage that is not deterministic.',
      'One codebase is deployed as two separate services: the recruiter application, and this demo.',
    ],
  },
  {
    id: 'security',
    heading: 'Security boundaries',
    body: ['This demo is built so that it cannot reach anything real, rather than trusted not to.'],
    points: [
      'It has no sign-in, no database of real records, no credentials and no API key — it refuses to start if given any.',
      'The recruiter application’s routes do not exist here, and this demo’s routes do not exist there.',
      'Your session is a private in-memory copy, named by an unguessable HttpOnly cookie and discarded after two hours without use.',
      'Anonymous requests are rate limited, and no secret ever reaches the browser.',
    ],
  },
  {
    id: 'testing',
    heading: 'How it is tested',
    body: [
      'Automated tests cover the scoring arithmetic, matching rules, redaction, evidence verification, the audit trail, the HTTP API, and the boundary between the two services — including starting the real server in each mode. No test calls a paid API or needs a key.',
      'The browser client’s tests inspect source and pure logic rather than rendered pages, and there is no measurement of accuracy on real CVs.',
    ],
  },
  {
    id: 'stack',
    heading: 'Tech stack',
    body: ['TypeScript throughout.'],
    points: [
      'Server: Node.js 24 running TypeScript natively, Express 5, SQLite (PostgreSQL through the same interface).',
      'Client: React 19, Vite and Tailwind CSS.',
      'Tests: the Node.js built-in test runner, on both sides.',
    ],
  },
];

/** What this demo is not. Said plainly, on the page, rather than left to be discovered. */
export const PROJECT_LIMITS: readonly string[] = [
  'No CV upload. The five candidates are fixed and synthetic, and the system has no PDF or DOCX parsing — resume input is plain text.',
  'No language model runs here. A model-backed extractor exists in the code behind the same interface, but it has not been run against a live service and its quality has not been measured.',
  'Not a multi-user production system. It has one operator, in-memory rate limiting, and no job-description parsing.',
];

/**
 * The stages a CV goes through, in the order it goes through them.
 *
 * Each one is a stage the system has: ingest, redact, verify, match and score
 * are audit stages the pipeline records, ranking is `agent/rank.ts`, and the
 * decision is the recruiter's. There is deliberately no stage for a model reading
 * the CV, because in this demo none does — the keyword matcher that picks the
 * passages is described where it belongs, inside evidence verification.
 */
export const WORKFLOW_STAGES: ReadonlyArray<{ id: string; label: string; summary: string }> = [
  {
    id: 'ingest',
    label: 'Ingest',
    summary:
      'The CV text is stored exactly as received, with a masked copy beside it. In this demo the CVs are fixed and synthetic; nothing can be uploaded.',
  },
  {
    id: 'redact',
    label: 'Redaction',
    summary:
      'Personal details — name, contact details, date of birth, nationality, gender, address — are masked before anything reads the CV. Only the category is recorded, never the value.',
  },
  {
    id: 'verify',
    label: 'Evidence verification',
    summary:
      'Passages are picked from the masked CV by a fixed keyword matcher — not a language model — and each quote is checked against the original. A quote that cannot be found is rejected and never counted.',
  },
  {
    id: 'match',
    label: 'Matching',
    summary:
      'Each requirement is judged by fixed rules from its verified quotes: met, partly met, does not meet, or not demonstrated. A CV that is silent is never treated as a failure.',
  },
  {
    id: 'score',
    label: 'Scoring',
    summary:
      'A weighted average of the requirement results, in whole numbers so the parts add up exactly to the total. The same input always gives the same score.',
  },
  {
    id: 'rank',
    label: 'Ranking',
    summary:
      'Candidates who meet every essential requirement rank above those who do not, whatever their score. Ties are shown as ties, and anyone not yet assessed is listed, unranked.',
  },
  {
    id: 'decide',
    label: 'Recruiter decision',
    summary:
      'A person records advance, review or reject with a written reason. In this demo it is saved only to your private session.',
  },
];

/** The path through a candidate the demo invites a visitor to take. */
export const GUIDE_STEPS: ReadonlyArray<{ label: string; detail: string }> = [
  { label: 'Open a candidate', detail: 'Choose anyone from the ranked list.' },
  { label: 'Inspect the evidence', detail: 'Read the passages quoted from their CV under each requirement.' },
  { label: 'Inspect the match breakdown', detail: 'See how each requirement was judged, and why.' },
  { label: 'Review the score', detail: 'Open “How this score was reached” to see the parts add up.' },
  { label: 'Make a demo decision', detail: 'Record advance, review or reject, with a reason.' },
];

/** What the two header controls do, said in full wherever they are offered. */
export const CONTROL_HELP = {
  reset: 'Reset demo restores your own copy to its starting state, clearing any decision you made. It affects only you.',
  exit: 'Exit demo ends your session and leaves the demo.',
} as const;

/** The labels the candidate screen uses for deterministic demo behaviour. */
export const DEMO_LABELS = {
  extraction: 'Deterministic demo extraction',
  evidence: 'Verified evidence',
  match: 'Rule-based match',
  score: 'Deterministic score',
  decision: 'Demo recruiter decision',
} as const;

/**
 * Who did what, for the history list.
 *
 * `mock` is the name the stand-in extractor records for itself. Anything else
 * with the `ai` actor is a real model, and is described as one.
 */
export function historyActorLabel(actor: string, actorId: string | null): string {
  if (actor === 'ai') return actorId === 'mock' ? 'Deterministic demo extraction (no AI model)' : 'By the model';
  if (actor === 'human') return 'By a person';
  return 'Automatic';
}
