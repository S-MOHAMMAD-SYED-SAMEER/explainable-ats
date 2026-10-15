import fs from 'node:fs';
import path from 'node:path';
import { EVAL_DIR, LABEL_COLUMNS, loadCvText, loadDataset, validateLabels } from './evalLabels.ts';

// Checks a filled-in labels file, so the person labelling can find mistakes before
// anything is run on it.
//
//   node server/scripts/validate-labels.ts [path-to-csv]      (default: eval/labels_TODO.csv)
//
// It reads two things, the labels file and the CVs, and writes nothing. Exit code 0 means
// the file is complete and consistent; 1 means there is something to fix.

function main(): number {
  const arg = process.argv[2];
  const file = arg ? path.resolve(arg) : path.join(EVAL_DIR, 'labels_TODO.csv');
  if (!fs.existsSync(file)) {
    console.log(`No such file: ${file}`);
    return 1;
  }

  const dataset = loadDataset();
  const cvTexts = new Map(dataset.cvs.map((cv) => [cv.id, loadCvText(cv)]));
  const report = validateLabels(fs.readFileSync(file, 'utf8'), dataset, cvTexts);

  // Unlabelled rows are one thing, not sixty-eight: say it once.
  const unlabelled = report.problems.filter((problem) => problem.message.endsWith('has no expected_verdict.'));
  const others = report.problems.filter((problem) => !problem.message.endsWith('has no expected_verdict.'));

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

  const clean = report.problems.length === 0;
  console.log(clean ? 'OK: the labels are complete and consistent.' : `NOT READY: ${report.problems.length} problem${report.problems.length === 1 ? '' : 's'}.`);
  return clean ? 0 : 1;
}

process.exitCode = main();
