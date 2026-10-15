import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  EVAL_DIR,
  LABEL_COLUMNS,
  PASSAGE_SEPARATOR,
  VERDICTS,
  expectedPairs,
  loadCvText,
  loadDataset,
  normaliseForComparison,
  parseCsv,
  passageInCv,
  splitPassages,
  validateLabels,
} from '../scripts/evalLabels.ts';
import { DEMO_JOB } from '../src/demo/dataset.ts';
import { ingestResume } from '../src/agent/ingest.ts';
import { createTestContext } from './helpers.ts';

// The evaluation set's structure, and the machinery for checking the labels that will be
// written against it. NOTHING here depends on the labels being filled in or empty: the
// labels file is the owner's to fill in, and this suite must keep passing afterwards.

const dataset = loadDataset();
const cvTexts = new Map(dataset.cvs.map((cv) => [cv.id, loadCvText(cv)]));

// --- the dataset -----------------------------------------------------------------------------

test('the set is twenty invented CVs over two roles, in files that exist', () => {
  assert.equal(dataset.version, 'eval-set-v1');
  assert.equal(dataset.cvs.length, 20);
  assert.deepEqual(dataset.cvs.map((cv) => cv.id), Array.from({ length: 20 }, (_, i) => `cv-${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(Object.keys(dataset.roles).sort(), ['data', 'demo']);
  assert.equal(dataset.cvs.filter((cv) => cv.role === 'demo').length, 12);
  assert.equal(dataset.cvs.filter((cv) => cv.role === 'data').length, 8);

  for (const cv of dataset.cvs) {
    assert.ok(dataset.roles[cv.role], `${cv.id} names a role that does not exist`);
    assert.ok(fs.existsSync(path.join(EVAL_DIR, cv.file)), `${cv.file} is missing`);
  }
  assert.equal(fs.readdirSync(path.join(EVAL_DIR, 'cvs')).length, 20, 'a CV file that is not in dataset.json');
});

test('the first role is the demo role, word for word, so the demo and the evaluation cannot drift apart', () => {
  const role = dataset.roles.demo;
  assert.ok(role);
  assert.equal(role.title, DEMO_JOB.title);
  assert.equal(role.seniority, DEMO_JOB.seniority);
  assert.equal(role.description, DEMO_JOB.description);
  assert.deepEqual(
    role.requirements.map(({ label, criterion, kind, weight }) => ({ label, criterion, kind, weight })),
    DEMO_JOB.requirements,
  );
});

test('requirement ids are unique, readable and carry the role', () => {
  const ids = Object.values(dataset.roles).flatMap((role) => role.requirements.map((requirement) => requirement.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const [name, role] of Object.entries(dataset.roles)) {
    for (const requirement of role.requirements) {
      assert.match(requirement.id, new RegExp(`^${name}-[a-z]+$`));
      assert.ok(requirement.weight >= 1 && requirement.weight <= 10);
      assert.ok(requirement.criterion.length > 10);
    }
  }
  assert.equal(expectedPairs(dataset).length, 12 * 3 + 8 * 4);
});

test('every CV is invented and carries only reserved contact details', () => {
  for (const cv of dataset.cvs) {
    const text = cvTexts.get(cv.id) as string;
    const emails = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g) ?? [];
    assert.ok(emails.length >= 1, `${cv.id}: no email to redact`);
    for (const email of emails) assert.ok(email.endsWith('@example.invalid'), `${cv.id}: ${email} is not on the reserved domain`);
    for (const phone of text.match(/\+\d[\d ]{8,}\d/g) ?? []) {
      assert.match(phone, /^\+44 20 7946 0\d{3}$/, `${cv.id}: ${phone} is not in the range reserved for fiction`);
    }
    assert.ok(text.includes(cv.displayName), `${cv.id}: the name in dataset.json is not in the CV`);
  }
});

test('the set has the mix it claims: short and long, tidy and messy', () => {
  const lengths = dataset.cvs.map((cv) => (cvTexts.get(cv.id) as string).length);
  assert.ok(Math.min(...lengths) < 400, 'no short CV');
  assert.ok(Math.max(...lengths) > 3000, 'no long CV');
  assert.ok([...cvTexts.values()].some((text) => text.includes('\t')), 'no CV with tab-separated fields');
  assert.ok([...cvTexts.values()].some((text) => /^[A-Z ]{3,}:/m.test(text) && /^\s*[*>~-]/m.test(text)), 'no messy formatting');
});

test('redaction masks the name, email and phone in every CV, so the harness can run on all of them', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  for (const cv of dataset.cvs) {
    const text = cvTexts.get(cv.id) as string;
    const { resume } = await ingestResume(
      { repos: ctx.repos },
      { reference: cv.id, displayName: cv.displayName, text, source: 'manual' },
    );
    assert.ok(!resume.redactedText.includes(cv.displayName), `${cv.id}: the name survived redaction`);
    assert.ok(!/@example\.invalid/.test(resume.redactedText), `${cv.id}: the email survived redaction`);
    assert.ok(!/\+44 20 7946/.test(resume.redactedText), `${cv.id}: the phone number survived redaction`);
  }
});

// --- the labels file -----------------------------------------------------------------------------

const labelsFile = fs.readFileSync(path.join(EVAL_DIR, 'labels_TODO.csv'), 'utf8');

test('the labels file has the five columns and one row for every CV and requirement', () => {
  const table = parseCsv(labelsFile);
  assert.deepEqual(table[0], [...LABEL_COLUMNS]);
  assert.equal(table.length - 1, expectedPairs(dataset).length);

  const found = table.slice(1).map((row) => `${row[0]}/${row[1]}`);
  assert.deepEqual(found, expectedPairs(dataset).map((pair) => `${pair.cvId}/${pair.requirementId}`));
  for (const row of table.slice(1)) assert.equal(row.length, LABEL_COLUMNS.length);
});

test('the shipped file validates apart from the labels themselves, whether or not they are filled in', () => {
  const report = validateLabels(labelsFile, dataset, cvTexts);
  const structural = report.problems.filter((problem) => !problem.message.endsWith('has no expected_verdict.'));
  const unlabelled = report.problems.length - structural.length;

  // Either nothing is labelled yet (template) or everything is (and every other check holds).
  assert.ok(unlabelled === 0 || unlabelled === report.counts.total, `${unlabelled} of ${report.counts.total} rows are unlabelled: half-labelled files are checked by the validator, not by this test`);
  if (unlabelled === 0) assert.deepEqual(structural, [], structural.map((problem) => problem.message).join('\n'));
  else assert.equal(report.counts.total, expectedPairs(dataset).length);
});

// --- the validator, on files of its own making -----------------------------------------------------

function csvLine(cells: string[]): string {
  return cells.map((cell) => (/[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(',');
}

/** A complete, valid file in which every row is `unclear` (the CV is silent), with edits applied by key. */
function build(edits: Record<string, string[]> = {}, options: { header?: readonly string[]; drop?: string[]; repeat?: string[] } = {}): string {
  const lines = [csvLine([...(options.header ?? LABEL_COLUMNS)])];
  for (const pair of expectedPairs(dataset)) {
    const key = `${pair.cvId}/${pair.requirementId}`;
    if (options.drop?.includes(key)) continue;
    const cells = edits[key] ?? [pair.cvId, pair.requirementId, '', 'unclear', ''];
    lines.push(csvLine(cells));
    if (options.repeat?.includes(key)) lines.push(csvLine(cells));
  }
  return `${lines.join('\n')}\n`;
}

function messages(csv: string): string {
  return validateLabels(csv, dataset, cvTexts).problems.map((problem) => problem.message).join('\n');
}

test('a complete, consistent file validates', () => {
  const report = validateLabels(build(), dataset, cvTexts);
  assert.deepEqual(report.problems, []);
  assert.equal(report.counts.total, 68);
  assert.equal(report.counts.unclear, 68);
});

test('a real passage from the CV is accepted, however it is spaced or punctuated on the way', () => {
  const cv = cvTexts.get('cv-08') as string;
  // cv-08 hard-wraps its sentences, and a spreadsheet may curl quotes and dashes.
  const wrapped = 'Designed and shipped production Node.js\nservices for a freight tracking product';
  // (A checkout with Windows line endings has \r\n; the sentence is the same.)
  assert.ok(cv.replace(/\r\n/g, '\n').includes(wrapped), 'precondition: this wrapped sentence is really in cv-08');

  const asTyped = 'Designed and shipped production Node.js services for a freight tracking product';
  assert.deepEqual(validateLabels(build({ 'cv-08/demo-node': ['cv-08', 'demo-node', asTyped, 'met', ''] }), dataset, cvTexts).problems, []);

  assert.equal(normaliseForComparison('“quoted” – dash space'), '"quoted" - dash space');
  assert.ok(passageInCv('ran PostgreSQL at   scale', cvTexts.get('cv-08') as string));
  assert.ok(!passageInCv('ran postgresql at scale', cvTexts.get('cv-08') as string), 'case is not ignored: a passage is copied, not retyped');
});

test('every kind of mistake is reported, with the row it is on', () => {
  const cases: Array<[string, string, RegExp]> = [
    ['a passage that is not in the CV', build({ 'cv-01/demo-node': ['cv-01', 'demo-node', 'Led a team of fifty engineers at a household name', 'met', ''] }), /not in the CV, word for word/],
    ['unclear with a passage', build({ 'cv-01/demo-node': ['cv-01', 'demo-node', 'Mentored six junior engineers over four years', 'unclear', ''] }), /"unclear" means the CV is silent/],
    ['met with no passage', build({ 'cv-01/demo-node': ['cv-01', 'demo-node', '', 'met', ''] }), /"met" needs at least one gold passage/],
    ['a verdict that is not one of the four', build({ 'cv-01/demo-node': ['cv-01', 'demo-node', '', 'mostly', ''] }), /"mostly" is not a verdict/],
    ['no verdict at all', build({ 'cv-01/demo-node': ['cv-01', 'demo-node', '', '', ''] }), /has no expected_verdict/],
    ['a row that is missing', build({}, { drop: ['cv-05/demo-postgres'] }), /row for cv-05 \/ demo-postgres is missing/],
    ['a row that appears twice', build({}, { repeat: ['cv-05/demo-postgres'] }), /cv-05 \/ demo-postgres appears more than once/],
    ['a pair that is not in the dataset', build({ 'cv-01/demo-node': ['cv-01', 'data-python', '', 'unclear', ''] }), /not a pair in the dataset/],
    ['the wrong header', build({}, { header: ['cv', 'req', 'gold', 'verdict', 'notes'] }), /header must be exactly/],
  ];
  for (const [what, csv, expected] of cases) assert.match(messages(csv), expected, what);

  const report = validateLabels(build({ 'cv-01/demo-node': ['cv-01', 'demo-node', 'nonsense nobody wrote', 'met', ''] }), dataset, cvTexts);
  assert.equal(report.problems[0]?.line, 2, 'the first data row is line 2, counting the header');
});

test('a wrong cell count is reported as a quoting problem', () => {
  const csv = `${LABEL_COLUMNS.join(',')}\ncv-01,demo-node,Built it, and shipped it,met,\n`;
  assert.match(messages(csv), /Expected 5 columns and found 6/);
});

test('several passages are separated by two bars, and each is checked on its own', () => {
  const first = 'Mentored six junior engineers over four years';
  const second = 'Ran the graduate onboarding programme for the engineering team in 2017';
  const ok = build({ 'cv-01/demo-mentoring': ['cv-01', 'demo-mentoring', `${first} ${PASSAGE_SEPARATOR} ${second}`, 'met', ''] });
  assert.deepEqual(validateLabels(ok, dataset, cvTexts).problems, []);
  assert.deepEqual(splitPassages(`${first} ${PASSAGE_SEPARATOR} ${second} ${PASSAGE_SEPARATOR} `), [first, second]);

  const bad = build({ 'cv-01/demo-mentoring': ['cv-01', 'demo-mentoring', `${first} ${PASSAGE_SEPARATOR} an invented second passage`, 'met', ''] });
  assert.match(messages(bad), /invented second passage/);
});

test('the CSV reader copes with what spreadsheets produce', () => {
  assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
  assert.deepEqual(parseCsv('﻿a,b\n1,2'), [['a', 'b'], ['1', '2']], 'a byte-order mark is dropped');
  assert.deepEqual(parseCsv('a,b\n"line one\nline two",2\n'), [['a', 'b'], ['line one\nline two', '2']], 'a line break inside quotes stays in the cell');
  assert.deepEqual(parseCsv('a,b\n\n,\n1,2\n'), [['a', 'b'], ['1', '2']], 'empty lines are ignored');
});

test('every passage in the guide\'s worked examples round-trips through the CSV reader', () => {
  const guide = fs.readFileSync(path.join(EVAL_DIR, 'LABELLING_GUIDE.md'), 'utf8');
  const row = /^cv-XX,data-stakeholders,.*$/m.exec(guide)?.[0] ?? '';
  assert.notEqual(row, '', 'the guide shows a CSV row');
  const cells = parseCsv(row)[0] ?? [];
  assert.equal(cells.length, 5);
  assert.equal(cells[2], 'Agreed the definition of "active customer" with the marketing and finance analysts, and documented it.');
  assert.equal(cells[3], 'met');
  assert.ok((VERDICTS as readonly string[]).includes(cells[3] as string));
});

test('the guide names the same requirements and ids as the dataset', () => {
  const guide = fs.readFileSync(path.join(EVAL_DIR, 'LABELLING_GUIDE.md'), 'utf8');
  for (const role of Object.values(dataset.roles)) {
    for (const requirement of role.requirements) {
      assert.ok(guide.includes(`\`${requirement.id}\``), `the guide does not list ${requirement.id}`);
      assert.ok(guide.includes(requirement.criterion), `the guide does not state "${requirement.criterion}"`);
    }
  }
  for (const verdict of VERDICTS) assert.ok(guide.includes(`\`${verdict}\``));
  assert.ok(!dataset.cvs.some((cv) => cvTexts.get(cv.id)?.includes('Harbourlight Retail') || cvTexts.get(cv.id)?.includes('Fordham Mutual')), 'a worked example uses a CV that is in the set');
});
