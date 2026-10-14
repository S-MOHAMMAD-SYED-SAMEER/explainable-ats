// Adding roles and CVs, and watching an assessment run: the parts that are
// decisions rather than drawing, kept pure so they are tested without a browser.
//
// The limits below mirror the server's (`handlers/manage.ts`), which is what
// actually enforces them; a test reads the server's numbers and fails if these
// drift. They exist here so a person is told what is wrong before a round trip,
// not so the browser is trusted.

import type { NewCandidateInput, NewJobInput, NewRequirementInput } from './api/types.ts';

export const MAX_TITLE_CHARS = 200;
export const MAX_DESCRIPTION_CHARS = 4000;
export const MAX_REQUIREMENTS = 25;
export const MAX_LABEL_CHARS = 100;
export const MAX_CRITERION_CHARS = 500;
export const MIN_WEIGHT = 1;
export const MAX_WEIGHT = 10;
export const MAX_REFERENCE_CHARS = 64;
export const MAX_DISPLAY_NAME_CHARS = 120;
export const MAX_CV_CHARS = 200_000;

export const SENIORITY_OPTIONS = ['junior', 'mid', 'senior', 'lead'] as const;

/** How often a screen asks whether a running assessment has finished. */
export const POLL_INTERVAL_MS = 1500;
/** Consecutive failed polls before the screen stops asking and says so. */
export const POLL_MAX_CONSECUTIVE_ERRORS = 5;

/** `scored` and `failed` are the two ways an assessment ends; anything else is still running. */
export function isFinished(status: string): boolean {
  return status === 'scored' || status === 'failed';
}

// Held as strings while typing: a number input's value is text, and "3" must be
// turned into 3 once, here, before it is sent (the server refuses "3").
export type RequirementDraft = {
  label: string;
  criterion: string;
  kind: 'must_have' | 'nice_to_have';
  weight: string;
};

export type JobDraft = {
  title: string;
  seniority: string;
  description: string;
  requirements: RequirementDraft[];
};

export function emptyRequirement(): RequirementDraft {
  return { label: '', criterion: '', kind: 'must_have', weight: '3' };
}

export function emptyJobDraft(): JobDraft {
  return { title: '', seniority: 'mid', description: '', requirements: [emptyRequirement()] };
}

export type Validated<T> = { ok: true; input: T } | { ok: false; problems: string[] };

export function validateJobDraft(draft: JobDraft): Validated<NewJobInput> {
  const problems: string[] = [];

  const title = draft.title.trim();
  if (title === '') problems.push('Give the role a title.');
  if (title.length > MAX_TITLE_CHARS) problems.push(`The title can be at most ${MAX_TITLE_CHARS} characters.`);
  if (draft.description.length > MAX_DESCRIPTION_CHARS) {
    problems.push(`The description can be at most ${MAX_DESCRIPTION_CHARS} characters.`);
  }
  if (!(SENIORITY_OPTIONS as readonly string[]).includes(draft.seniority)) problems.push('Pick a seniority.');

  if (draft.requirements.length === 0) problems.push('Add at least one requirement.');
  if (draft.requirements.length > MAX_REQUIREMENTS) {
    problems.push(`A role can have at most ${MAX_REQUIREMENTS} requirements.`);
  }

  const requirements: NewRequirementInput[] = [];
  draft.requirements.forEach((entry, index) => {
    const where = `Requirement ${index + 1}`;
    const label = entry.label.trim();
    const criterion = entry.criterion.trim();
    const weight = Number(entry.weight);

    if (label === '') problems.push(`${where} needs a short name.`);
    if (label.length > MAX_LABEL_CHARS) problems.push(`${where}: the name can be at most ${MAX_LABEL_CHARS} characters.`);
    if (criterion === '') problems.push(`${where} needs a description of what to look for.`);
    if (criterion.length > MAX_CRITERION_CHARS) {
      problems.push(`${where}: the description can be at most ${MAX_CRITERION_CHARS} characters.`);
    }
    if (entry.weight.trim() === '' || !Number.isInteger(weight) || weight < MIN_WEIGHT || weight > MAX_WEIGHT) {
      problems.push(`${where}: the weight must be a whole number from ${MIN_WEIGHT} to ${MAX_WEIGHT}.`);
    }
    requirements.push({ label, criterion, kind: entry.kind, weight });
  });

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    input: { title, seniority: draft.seniority, description: draft.description.trim(), requirements },
  };
}

export type CandidateDraft = { reference: string; displayName: string; text: string };

export function emptyCandidateDraft(): CandidateDraft {
  return { reference: '', displayName: '', text: '' };
}

const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateCandidateDraft(draft: CandidateDraft): Validated<NewCandidateInput> {
  const problems: string[] = [];

  const reference = draft.reference.trim();
  if (reference === '') {
    problems.push('Give the candidate a reference, such as cv-014.');
  } else if (!REFERENCE_PATTERN.test(reference)) {
    problems.push('The reference can use only letters, digits, dots, hyphens and underscores.');
  }
  if (reference.length > MAX_REFERENCE_CHARS) problems.push(`The reference can be at most ${MAX_REFERENCE_CHARS} characters.`);

  const displayName = draft.displayName.trim();
  if (displayName.length > MAX_DISPLAY_NAME_CHARS) {
    problems.push(`The name can be at most ${MAX_DISPLAY_NAME_CHARS} characters.`);
  }

  if (draft.text.trim() === '') problems.push('Paste the CV text.');
  if (draft.text.length > MAX_CV_CHARS) problems.push(`The CV can be at most ${MAX_CV_CHARS.toLocaleString('en')} characters.`);

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, input: { reference, displayName: displayName === '' ? null : displayName, text: draft.text } };
}
