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

export const DEMO_LEAD = 'Explore a complete candidate screening workflow using synthetic job and candidate data.';

export const DEMO_DISCLOSURE = 'Deterministic and explainable demo — no external AI/API call is required.';

/** What the product is for, in the three claims it makes. */
export const WHAT_IT_DOES: readonly string[] = [
  'Ranks candidates against a role, using the requirements the recruiter sets.',
  'Backs every placement with a line quoted from the candidate’s own CV.',
  'Masks personal details first, and keeps the recruiter’s decision, with its written reason, on the record.',
];

/** What a visitor can do once they are in. */
export const EXPLORE_ITEMS: readonly string[] = [
  'The role, and what it asks for.',
  'Five candidates, ranked — including two who score the same and are placed differently.',
  'The passages quoted from each CV, checked against the original.',
  'A requirement-by-requirement match breakdown, and the score it adds up to.',
  'A demo recruiter decision, saved only to your own session.',
];

/** The facts about the data and about what the demo touches. */
export const DEMO_FACTS: ReadonlyArray<{ heading: string; body: string }> = [
  {
    heading: 'Synthetic data',
    body: 'The job and all five candidates are invented. No real person, employer or CV appears anywhere in the demo.',
  },
  {
    heading: 'Private to you',
    body: 'You get your own copy. What you do in it is visible only to you, and it never touches a real recruiter’s records.',
  },
  {
    heading: 'No key, no account',
    body: 'No sign-in, API key or external AI service is needed. Every score comes from fixed rules, so the demo behaves the same way every time.',
  },
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
