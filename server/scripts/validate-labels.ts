import fs from 'node:fs';
import path from 'node:path';
import {
  EVAL_DIR,
  HELDOUT_DIR,
  LABELS_PROVENANCE,
  LABEL_COLUMNS,
  loadCvText,
  loadDataset,
  loadHeldoutDataset,
  validateLabels,
  type Dataset,
  type LabelSet,
} from './evalLabels.ts';

// Checks a filled-in labels file, so the person labelling can find mistakes before
// anything is run on it.
//
//   node server/scripts/validate-labels.ts                      checks both files: eval/labels_TODO.csv and eval/labels_heldout_TODO.csv
//   node server/scripts/validate-labels.ts <path-to-csv>        checks one file against the main set of twenty CVs
//   node server/scripts/validate-labels.ts --heldout [<path>]   checks the held-out file (default eval/labels_heldout_TODO.csv)
//
// It reads two things, the labels file and the CVs, and writes nothing. Exit code 0 means
// the file is complete and consistent; 1 means there is something to fix.
//
// A held-out file with no labels at all is not an error: Sameer is not labelling these five CVs, and they are excluded from every run.
// A held-out file with SOME labels, or any mistake, is.

type Outcome = { ok: boolean };

function check(set: LabelSet, file: string, dataset: Dataset, cvDir: string, allowEmpty: boolean): Outcome {
  if (!fs.existsSync(file)) {
    console.log(`No such file: ${file}`);
    return { ok: false };
  }

  const cvTexts = new Map(dataset.cvs.map((cv) => [cv.id, loadCvText(cv, cvDir)]));
  const report = validateLabels(fs.readFileSync(file, 'utf8'), dataset, cvTexts);

  // Unlabelled rows are one thing, not sixty-eight: say it once.
  const unlabelled = report.problems.filter((problem) => problem.message.endsWith('has no expected_verdict.'));
  const others = report.problems.filter((problem) => !problem.message.endsWith('has no expected_verdict.'));
  const waiting = allowEmpty && unlabelled.length > 0 && unlabelled.length === report.counts.total && others.length === 0;

  console.log(`set     : ${set} (${dataset.version}); labels: ${LABELS_PROVENANCE[set]}`);
  console.log(`file    : ${file}`);
  console.log(`columns : ${LABEL_COLUMNS.join(', ')}`);
  console.log(`rows    : ${report.counts.total} read, ${unlabelled.length === 0 ? 'every row has a verdict' : `${unlabelled.length} still have no verdict`}`);
  if (unlabelled.length === 0 && report.counts.total > 0) {
    console.log(
      `verdicts: met ${report.counts.met}, partial ${report.counts.partial}, not_met ${report.counts.not_met}, unclear ${report.counts.unclear}; ${report.counts.withPassages} rows have gold passages`,
    );
  }
  if (unlabelled.length > 0) {
    console.log(`          first unlabelled: line ${unlabelled[0]?.line}`);
  }

  for (const problem of others) console.log(`ERROR${problem.line === null ? '' : ` (line ${problem.line})`}: ${problem.message}`);
  for (const warning of report.warnings) console.log(`warning (line ${warning.line}): ${warning.message}`);

  if (waiting) {
    console.log(`OK (empty): the structure is right and no row is labelled. This set is not being labelled and is not used in any run.`);
    return { ok: true };
  }
  const clean = report.problems.length === 0;
  console.log(clean ? 'OK: the labels are complete and consistent.' : `NOT READY: ${report.problems.length} problem${report.problems.length === 1 ? '' : 's'}.`);
  return { ok: clean };
}

function main(): number {
  const args = process.argv.slice(2);
  const heldoutOnly = args.includes('--heldout');
  const pathArg = args.find((value) => !value.startsWith('--'));

  const mainFile = path.join(EVAL_DIR, 'labels_TODO.csv');
  const heldoutFile = path.join(EVAL_DIR, 'labels_heldout_TODO.csv');

  const results: Outcome[] = [];
  if (heldoutOnly) {
    results.push(check('heldout', pathArg ? path.resolve(pathArg) : heldoutFile, loadHeldoutDataset(), HELDOUT_DIR, true));
  } else if (pathArg) {
    results.push(check('main', path.resolve(pathArg), loadDataset(), EVAL_DIR, false));
  } else {
    results.push(check('main', mainFile, loadDataset(), EVAL_DIR, false));
    console.log('');
    results.push(check('heldout', heldoutFile, loadHeldoutDataset(), HELDOUT_DIR, true));
  }
  return results.every((result) => result.ok) ? 0 : 1;
}

process.exitCode = main();
