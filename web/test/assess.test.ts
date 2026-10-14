import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_CRITERION_CHARS,
  MAX_CV_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_LABEL_CHARS,
  MAX_REFERENCE_CHARS,
  MAX_REQUIREMENTS,
  MAX_TITLE_CHARS,
  MAX_WEIGHT,
  MIN_WEIGHT,
  SENIORITY_OPTIONS,
  emptyCandidateDraft,
  emptyJobDraft,
  emptyRequirement,
  isFinished,
  validateCandidateDraft,
  validateJobDraft,
  type JobDraft,
} from '../src/assess.ts';

// The recruiter's forms and the status poll, as pure logic. Nothing renders: the
// project has no browser in its tests, so what is checked here is what a person
// is told, what is sent, and that the demo cannot reach any of it.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_SRC = path.resolve(ROOT, '../server/src');

function read(...parts: string[]): string {
  return fs.readFileSync(path.join(...parts), 'utf8');
}

function good(): JobDraft {
  return {
    title: '  Platform Engineer ',
    seniority: 'senior',
    description: ' Owns the platform. ',
    requirements: [
      { label: ' Node.js ', criterion: ' Has shipped Node.js services ', kind: 'must_have', weight: '3' },
      { label: 'Mentoring', criterion: 'Has mentored juniors', kind: 'nice_to_have', weight: '1' },
    ],
  };
}

// --- the job form ------------------------------------------------------------

test('a valid job draft becomes a request with trimmed text and numeric weights', () => {
  const result = validateJobDraft(good());
  assert.ok(result.ok);
  assert.equal(result.input.title, 'Platform Engineer');
  assert.equal(result.input.description, 'Owns the platform.');
  assert.deepEqual(
    result.input.requirements.map((r) => [r.label, r.kind, r.weight, typeof r.weight]),
    [
      ['Node.js', 'must_have', 3, 'number'],
      ['Mentoring', 'nice_to_have', 1, 'number'],
    ],
  );
});

test('an empty job draft is refused, naming every missing thing at once', () => {
  const result = validateJobDraft({ ...emptyJobDraft(), seniority: 'wizard' });
  assert.ok(!result.ok);
  const text = result.problems.join('\n');
  for (const expected of ['title', 'seniority', 'Requirement 1 needs a short name', 'Requirement 1 needs a description']) {
    assert.ok(text.toLowerCase().includes(expected.toLowerCase()), `mentions "${expected}"; got:\n${text}`);
  }
});

test('weights must be whole numbers in range, and "3.5" or "" or "abc" are refused', () => {
  for (const weight of ['0', '11', '3.5', '', 'abc', '-1']) {
    const draft = good();
    draft.requirements[0] = { ...(draft.requirements[0] ?? emptyRequirement()), weight };
    const result = validateJobDraft(draft);
    assert.ok(!result.ok, `weight "${weight}" was accepted`);
    assert.ok(result.problems.some((problem) => problem.includes('weight')));
  }
  for (const weight of [String(MIN_WEIGHT), String(MAX_WEIGHT), '5']) {
    const draft = good();
    draft.requirements[0] = { ...(draft.requirements[0] ?? emptyRequirement()), weight };
    assert.ok(validateJobDraft(draft).ok, `weight "${weight}" was refused`);
  }
});

test('a job needs at least one requirement and at most the limit', () => {
  assert.ok(!validateJobDraft({ ...good(), requirements: [] }).ok);
  const tooMany = Array.from({ length: MAX_REQUIREMENTS + 1 }, () => ({ ...emptyRequirement(), label: 'x', criterion: 'y' }));
  assert.ok(!validateJobDraft({ ...good(), requirements: tooMany }).ok);
});

// --- the CV form -------------------------------------------------------------

test('a valid CV draft keeps the text exactly as pasted and turns a blank name into null', () => {
  const text = '  Name: A\n\n   indented line\n';
  const result = validateCandidateDraft({ reference: ' cv-001 ', displayName: '   ', text });
  assert.ok(result.ok);
  assert.equal(result.input.reference, 'cv-001');
  assert.equal(result.input.displayName, null);
  assert.equal(result.input.text, text, 'whitespace inside a CV is part of the document and its offsets');
});

test('a bad CV draft names each problem', () => {
  const result = validateCandidateDraft({ ...emptyCandidateDraft(), reference: '../etc', text: '   ' });
  assert.ok(!result.ok);
  const text = result.problems.join('\n');
  assert.ok(text.includes('reference'));
  assert.ok(text.includes('Paste the CV text'));

  assert.ok(!validateCandidateDraft({ reference: '', displayName: '', text: 'x' }).ok);
  assert.ok(!validateCandidateDraft({ reference: 'a', displayName: '', text: 'x'.repeat(MAX_CV_CHARS + 1) }).ok);
  assert.ok(!validateCandidateDraft({ reference: 'a'.repeat(MAX_REFERENCE_CHARS + 1), displayName: '', text: 'x' }).ok);
});

// --- the status poll ---------------------------------------------------------

test('only scored and failed end the poll', () => {
  assert.equal(isFinished('scored'), true);
  assert.equal(isFinished('failed'), true);
  for (const running of ['pending', 'extracted', '']) assert.equal(isFinished(running), false);
});

// --- the limits match the server ---------------------------------------------

test('the form limits are the numbers the server enforces', () => {
  const server = read(SERVER_SRC, 'handlers/manage.ts');
  const number = (name: string): number => {
    const match = new RegExp(`const ${name} = ([0-9_]+);`).exec(server);
    assert.ok(match, `could not find ${name} in the server's handlers/manage.ts — this check would be vacuous`);
    return Number((match[1] as string).replaceAll('_', ''));
  };

  assert.equal(MAX_TITLE_CHARS, number('MAX_TITLE_CHARS'));
  assert.equal(MAX_DESCRIPTION_CHARS, number('MAX_DESCRIPTION_CHARS'));
  assert.equal(MAX_REQUIREMENTS, number('MAX_REQUIREMENTS'));
  assert.equal(MAX_LABEL_CHARS, number('MAX_LABEL_CHARS'));
  assert.equal(MAX_CRITERION_CHARS, number('MAX_CRITERION_CHARS'));
  assert.equal(MIN_WEIGHT, number('MIN_WEIGHT'));
  assert.equal(MAX_WEIGHT, number('MAX_WEIGHT'));
  assert.equal(MAX_REFERENCE_CHARS, number('MAX_REFERENCE_CHARS'));
  assert.equal(MAX_DISPLAY_NAME_CHARS, number('MAX_DISPLAY_NAME_CHARS'));
  assert.equal(MAX_CV_CHARS, number('MAX_CV_CHARS'));
});

test('the seniority choices are the server\'s', () => {
  const ats = read(SERVER_SRC, 'domain/ats.ts');
  const block = /SENIORITIES = \[([\s\S]*?)\] as const/.exec(ats);
  assert.ok(block);
  const fromServer = [...(block[1] as string).matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
  assert.deepEqual([...SENIORITY_OPTIONS], fromServer);
});

// --- the demo cannot reach any of it -----------------------------------------

test('the visitor\'s demo draws none of the recruiter\'s write controls', () => {
  const demo = read(ROOT, 'src/DemoApp.tsx');
  assert.ok(!demo.includes('canCreate'), 'the demo must not enable role creation');

  const jobDetail = read(ROOT, 'src/screens/JobDetail.tsx');
  assert.match(jobDetail, /demoSession \? null : <AddCandidateForm/, 'the add-a-CV form is hidden in the demo');

  const candidate = read(ROOT, 'src/screens/CandidateDetail.tsx');
  assert.match(candidate, /demoSession \? null : <AssessmentPanel/, 'the re-run panel is hidden in the demo');

  const recruiter = read(ROOT, 'src/RecruiterApp.tsx');
  assert.equal((recruiter.match(/<Jobs canCreate \/>/g) ?? []).length, 2, 'the recruiter app enables creation on both routes to the list');
});

// --- failures and the empty answer ---------------------------------------------

import { EXTRACTION_EMPTY_EVENT, EXTRACTION_FAILURE_EVENTS, isExtractionFailureEvent } from '../src/failures.ts';

test('the failure events the pipeline view knows are exactly the server\'s', () => {
  const server = read(SERVER_SRC, 'agent/failures.ts');
  const fromServer = [...server.matchAll(/eventType: '([a-z_]+)'/g)].map((match) => match[1]);
  const empty = /EXTRACTION_EMPTY_EVENT = '([a-z_]+)'/.exec(server)?.[1];

  assert.ok(fromServer.length >= 6, 'precondition: the server\'s failure events were found');
  assert.deepEqual([...EXTRACTION_FAILURE_EVENTS], fromServer);
  assert.equal(EXTRACTION_EMPTY_EVENT, empty);
  assert.ok(!isExtractionFailureEvent(EXTRACTION_EMPTY_EVENT), 'found-nothing is not a failure');
  assert.ok(!isExtractionFailureEvent('extraction_recorded'));
  assert.ok(isExtractionFailureEvent('extraction_truncated'));
});

test('the assessment screen says so when the model found nothing, and says what that does not mean', () => {
  const screen = read(ROOT, 'src/screens/CandidateDetail.tsx');
  assert.match(screen, /<NothingFound detail=\{detail\} \/>/);
  assert.match(screen, /found nothing in this CV/);
  assert.match(screen, /not the candidate/);
  assert.match(screen, /detail\.modelFoundNothing/);
});
