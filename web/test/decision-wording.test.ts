import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OUTCOMES, OUTCOME_WORDING } from '../src/copy.ts';

// A recruiter's decision has three outcomes, and the code names them `shortlist`,
// `reject` and `hold`. The app, the demo and the two portfolio sites all have to use
// those words for them. An earlier version of the interface called two of them
// "Advance" and "Review", and the demo's prose kept saying "advance, review or reject"
// after the buttons had been renamed, so the demo contradicted the app it describes.
// This is the check that would have caught it.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/** Every line of every file under web/src that matches, as "file:line: text". */
function offending(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(SRC)) {
    fs.readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (pattern.test(line)) hits.push(`${path.relative(SRC, file)}:${index + 1}: ${line.trim()}`);
      });
  }
  return hits;
}

test('the three outcomes are labelled Shortlist, Reject and Hold', () => {
  assert.deepEqual(
    OUTCOMES.map((outcome) => OUTCOME_WORDING[outcome].label),
    ['Shortlist', 'Reject', 'Hold'],
  );
});

test('"advance" is not used anywhere in web/src', () => {
  assert.deepEqual(offending(/\badvance\b/i), []);
});

test('"review" is never offered as one of the decisions', () => {
  // "Review the score" (a verb) and a "Review" navigation word are fine; a list of outcomes that
  // includes review is not: "shortlist, review or reject", "advance or review", "review, reject".
  const asDecision =
    /\b(?:shortlist|advance|hold|reject)\s*,?\s*(?:or\s+)?review\b|\breview\s*,?\s*(?:or\s+)?(?:shortlist|advance|hold|reject)\b/i;
  assert.deepEqual(offending(asDecision), []);
});

test('no outcome label or button text reads "Review" or "Advance"', () => {
  assert.deepEqual(offending(/label:\s*['"`](?:Review|Advance)['"`]/), []);
});
