import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  EVAL_DIR,
  HELDOUT_DIR,
  LABELS_PROVENANCE,
  LABEL_COLUMNS,
  expectedPairs,
  loadCvText,
  loadDataset,
  loadHeldoutDataset,
  parseCsv,
  provenanceFor,
  requireProvenance,
  validateLabels,
} from '../scripts/evalLabels.ts';
import { ingestResume } from '../src/agent/ingest.ts';
import { createTestContext } from './helpers.ts';

// The held-out set (five CVs that have no labels and are excluded from every run) and the label provenance that every
// results file must carry. Nothing here depends on the held-out labels being empty or filled in.

const SERVER_DIR = path.resolve(EVAL_DIR, '../server');
const main = loadDataset();
const heldout = loadHeldoutDataset();
const heldoutTexts = new Map(heldout.cvs.map((cv) => [cv.id, loadCvText(cv, HELDOUT_DIR)]));
const heldoutLabels = fs.readFileSync(path.join(EVAL_DIR, 'labels_heldout_TODO.csv'), 'utf8');

// --- the held-out set --------------------------------------------------------------------------------

test('the held-out set is five invented CVs for the two existing roles, in files that exist', () => {
  assert.equal(heldout.version, 'heldout-v1');
  assert.deepEqual(heldout.cvs.map((cv) => cv.id), ['cv-h1', 'cv-h2', 'cv-h3', 'cv-h4', 'cv-h5']);
  assert.deepEqual(heldout.roles, main.roles, 'the held-out set uses the main set\'s roles, defined once');
  assert.ok(heldout.cvs.some((cv) => cv.role === 'demo') && heldout.cvs.some((cv) => cv.role === 'data'), 'both roles are covered');
  for (const cv of heldout.cvs) {
    assert.ok(fs.existsSync(path.join(HELDOUT_DIR, cv.file)), `${cv.file} is missing`);
    assert.ok(!main.cvs.some((other) => other.id === cv.id), `${cv.id} clashes with a main-set CV`);
  }
  assert.equal(fs.readdirSync(HELDOUT_DIR).filter((file) => /^cv-h\d+\.txt$/.test(file)).length, 5);

  const manifest = JSON.parse(fs.readFileSync(path.join(HELDOUT_DIR, 'dataset.json'), 'utf8')) as { labelsProvenance: string };
  assert.equal(manifest.labelsProvenance, LABELS_PROVENANCE.heldout);
});

test('no held-out CV is a copy of, or close to, a main-set CV', () => {
  const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  for (const [id, text] of heldoutTexts) {
    for (const cv of main.cvs) {
      const a = words(text);
      const b = words(loadCvText(cv));
      const shared = [...a].filter((word) => b.has(word)).length;
      assert.ok(shared / Math.min(a.size, b.size) < 0.85, `${id} shares ${shared} of its words with ${cv.id}`);
    }
  }
});

test('the held-out CVs are invented and redaction masks every personal detail in them', async (t) => {
  const ctx = await createTestContext({ idPrefix: 'heldout' });
  t.after(() => ctx.close());
  for (const cv of heldout.cvs) {
    const text = heldoutTexts.get(cv.id) as string;
    assert.match(text, /@example\.invalid/, `${cv.id}: not an invented address`);
    assert.match(text, /\+44 20 7946 0\d\d\d/, `${cv.id}: not a number from the range set aside for fiction`);
    const { resume } = await ingestResume({ repos: ctx.repos }, { reference: cv.id, displayName: cv.displayName, text, source: 'manual' });
    assert.ok(!resume.redactedText.includes(cv.displayName), `${cv.id}: the name survived redaction`);
    assert.ok(!/@example\.invalid/.test(resume.redactedText), `${cv.id}: the email survived redaction`);
    assert.ok(!/\+44 20 7946/.test(resume.redactedText), `${cv.id}: the phone number survived redaction`);
  }
});

// --- the held-out labels file: it stays empty, so nothing may be suggested ------------------------------

test('the held-out labels file has the five columns and one row for every CV and requirement', () => {
  const table = parseCsv(heldoutLabels);
  assert.deepEqual(table[0], [...LABEL_COLUMNS]);
  assert.equal(table.length - 1, expectedPairs(heldout).length);
  assert.deepEqual(table.slice(1).map((row) => `${row[0]}/${row[1]}`), expectedPairs(heldout).map((pair) => `${pair.cvId}/${pair.requirementId}`));
  assert.equal(expectedPairs(heldout).length, 17);
});

test('the held-out file validates, and while it is a template nothing is suggested: the three label columns are empty', () => {
  const report = validateLabels(heldoutLabels, heldout, heldoutTexts);
  const structural = report.problems.filter((problem) => !problem.message.endsWith('has no expected_verdict.'));
  const unlabelled = report.problems.length - structural.length;
  assert.deepEqual(structural, [], structural.map((problem) => problem.message).join('\n'));
  // Either nothing is labelled yet (the template as shipped) or every row is. A half-labelled file is for the validator to report.
  assert.ok(unlabelled === 0 || unlabelled === report.counts.total, `${unlabelled} of ${report.counts.total} rows are unlabelled`);
  if (unlabelled === report.counts.total) {
    for (const row of parseCsv(heldoutLabels).slice(1)) assert.deepEqual(row.slice(2), ['', '', ''], `${row[0]}/${row[1]} has something filled in before Sameer labelled it`);
  }
});

test('the validator checks the held-out file the same way as the main one', () => {
  const header = LABEL_COLUMNS.join(',');
  const wrongPassage = `${header}\ncv-h1,demo-node,Led a team of fifty engineers at a household name,met,\n`;
  const messages = validateLabels(wrongPassage, heldout, heldoutTexts).problems.map((problem) => problem.message).join('\n');
  assert.match(messages, /not in the CV, word for word/);
  assert.match(messages, /row for cv-h2 \/ data-python is missing/);
  assert.match(messages, /"cv-h1" with "demo-node"|row for cv-h1 \/ demo-postgres is missing/);
  // A main-set pair is not a held-out pair.
  const notHeldout = validateLabels(`${header}\ncv-01,demo-node,,unclear,\n`, heldout, heldoutTexts).problems.map((problem) => problem.message).join('\n');
  assert.match(notHeldout, /not a pair in the dataset/);
});

function runValidate(args: string[]): { status: number | null; out: string } {
  const result = spawnSync(process.execPath, ['scripts/validate-labels.ts', ...args], { cwd: SERVER_DIR, encoding: 'utf8' });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

test('validate-labels checks both files by default, and says who made each set of labels', () => {
  const both = runValidate([]);
  assert.equal(both.status, 0, both.out);
  assert.match(both.out, /set\s+: main .*drafted by ChatGPT, reviewed by ChatGPT and Claude, final decisions approved by Sameer/);
  assert.match(both.out, /set\s+: heldout .*none: these five CVs are unlabelled/);

  const only = runValidate(['--heldout']);
  assert.equal(only.status, 0, only.out);
  assert.doesNotMatch(only.out, /set\s+: main/);

  // A held-out file with one label filled in and the rest empty is half-labelled: that is an error, not "waiting".
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heldout-'));
  const half = path.join(dir, 'half.csv');
  fs.writeFileSync(half, heldoutLabels.replace('cv-h1,demo-node,,,', 'cv-h1,demo-node,,unclear,'));
  const result = runValidate(['--heldout', half]);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /NOT READY/);
});

// --- label provenance in every results file -------------------------------------------------------------

test('the provenance is stated exactly, once, in code', () => {
  assert.equal(LABELS_PROVENANCE.main, 'drafted by ChatGPT, reviewed by ChatGPT and Claude, final decisions approved by Sameer');
  assert.equal(LABELS_PROVENANCE.heldout, 'none: these five CVs are unlabelled and are not used in any run');
  assert.deepEqual(provenanceFor(['main', 'heldout']), { main: LABELS_PROVENANCE.main, heldout: LABELS_PROVENANCE.heldout });
});

test('requireProvenance fails when labelsProvenance is missing, empty, unknown or reworded', () => {
  assert.throws(() => requireProvenance({}), /labelsProvenance is missing/);
  assert.throws(() => requireProvenance({ labelsProvenance: null }), /missing/);
  assert.throws(() => requireProvenance({ labelsProvenance: {} }), /empty/);
  assert.throws(() => requireProvenance({ labelsProvenance: { main: 'hand-labelled by Sameer' } }), /not "drafted by ChatGPT/);
  assert.throws(() => requireProvenance({ labelsProvenance: { gold: 'x' } }), /unknown label set/);
  assert.throws(() => requireProvenance({ labelsProvenance: provenanceFor(['main']) }, ['main', 'heldout']), /no entry for the "heldout" set/);
  assert.doesNotThrow(() => requireProvenance({ labelsProvenance: provenanceFor(['main', 'heldout']) }, ['main', 'heldout']));
});

test('the harness writes labelsProvenance into the results it produces', () => {
  const source = fs.readFileSync(path.join(SERVER_DIR, 'scripts/eval-harness.ts'), 'utf8');
  assert.match(source, /labelsProvenance: provenanceFor\(/);

  // And for real: a free oracle run (no model, no key) on one CV, written to a file and read back.
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-')), 'results.json');
  const run = spawnSync(process.execPath, ['scripts/eval-harness.ts', '--oracle', '--cvs=cv-01', `--out=${out}`], { cwd: SERVER_DIR, encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '' } });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  const results = JSON.parse(fs.readFileSync(out, 'utf8')) as { labelsProvenance?: unknown };
  assert.doesNotThrow(() => requireProvenance(results, ['main']));
});

test('every saved evaluation result in docs/results says who made the labels', () => {
  const dir = path.resolve(SERVER_DIR, '../docs/results');
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.json'));
  for (const file of files) {
    const results = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { kind?: string; labelsProvenance?: unknown };
    if (results.kind !== 'extraction and matching evaluation') continue;
    assert.doesNotThrow(() => requireProvenance(results), `${file} does not say who made the labels`);
  }
});
