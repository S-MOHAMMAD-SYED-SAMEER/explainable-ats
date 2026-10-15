import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The evaluation set's labels: reading the CSV and checking it.
//
// Used by `validate-labels.ts` (which the person labelling can run on their own file,
// before telling anyone it is done) and by the tests. Plain TypeScript, no dependencies.

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const EVAL_DIR = path.resolve(HERE, '../../eval');

export const LABEL_COLUMNS = ['cv_id', 'requirement_id', 'gold_passages', 'expected_verdict', 'notes'] as const;
export const VERDICTS = ['met', 'partial', 'not_met', 'unclear'] as const;
export type LabelVerdict = (typeof VERDICTS)[number];

/** Passages in one cell are separated by this, with a space either side. */
export const PASSAGE_SEPARATOR = '||';

export type Requirement = { id: string; label: string; criterion: string; kind: 'must_have' | 'nice_to_have'; weight: number };
export type Role = { title: string; seniority: string; description: string; requirements: Requirement[] };
export type CvEntry = { id: string; role: string; displayName: string; file: string };
export type Dataset = { version: string; roles: Record<string, Role>; cvs: CvEntry[] };

export function loadDataset(dir = EVAL_DIR): Dataset {
  return JSON.parse(fs.readFileSync(path.join(dir, 'dataset.json'), 'utf8')) as Dataset;
}

export function loadCvText(entry: CvEntry, dir = EVAL_DIR): string {
  return fs.readFileSync(path.join(dir, entry.file), 'utf8');
}

/** Every (cv, requirement) pair, in the order the labels file lists them. */
export function expectedPairs(dataset: Dataset): Array<{ cvId: string; requirementId: string }> {
  return dataset.cvs.flatMap((cv) =>
    (dataset.roles[cv.role]?.requirements ?? []).map((requirement) => ({ cvId: cv.id, requirementId: requirement.id })),
  );
}

// --- CSV --------------------------------------------------------------------------------

/**
 * Reads CSV: quoted fields, doubled quotes, commas and line breaks inside quotes, CRLF or LF,
 * and a leading byte-order mark (spreadsheets add one). Returns rows of cells.
 */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i] as string;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((value) => value.trim() !== ''));
}

export type LabelRow = {
  /** 1-based line of the row in the file, counting the header, for messages. */
  line: number;
  cvId: string;
  requirementId: string;
  goldPassages: string[];
  expectedVerdict: string;
  notes: string;
};

export function splitPassages(cell: string): string[] {
  return cell
    .split(PASSAGE_SEPARATOR)
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '');
}

// --- comparing passages with the CV ------------------------------------------------------------

/**
 * Text as compared: whitespace collapsed, and the characters word processors and spreadsheets
 * quietly swap (curly quotes, en and em dashes, non-breaking spaces) put back to plain ones, so
 * a passage that survived a round trip through one still matches the CV it was copied from.
 */
export function normaliseForComparison(text: string): string {
  return text
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[   ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Whether a gold passage is in the CV, as compared above. */
export function passageInCv(passage: string, cvText: string): boolean {
  return normaliseForComparison(cvText).includes(normaliseForComparison(passage));
}

// --- validation ---------------------------------------------------------------------------------

export type Problem = { line: number | null; message: string };
export type ValidationReport = {
  problems: Problem[];
  warnings: Problem[];
  rows: LabelRow[];
  counts: Record<LabelVerdict, number> & { total: number; withPassages: number };
};

const LONG_PASSAGE_CHARS = 600;

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 60)}...` : flat;
}

/**
 * Checks a filled-in labels file against the dataset.
 *
 * Errors stop the harness; warnings do not. The rules, which the labelling guide states:
 *   * the header is exactly the five columns, and every CV x requirement appears once;
 *   * every row has a verdict, and it is one of met, partial, not_met, unclear;
 *   * a gold passage must be in the CV, copied exactly (whitespace and look-alike punctuation aside);
 *   * unclear means the CV is silent, so it has no passage; every other verdict needs at least one.
 */
export function validateLabels(csvText: string, dataset: Dataset, cvTexts: Map<string, string>): ValidationReport {
  const problems: Problem[] = [];
  const warnings: Problem[] = [];
  const rows: LabelRow[] = [];
  const counts = { met: 0, partial: 0, not_met: 0, unclear: 0, total: 0, withPassages: 0 };

  const table = parseCsv(csvText);
  const header = (table[0] ?? []).map((cell) => cell.trim());
  if (header.join(',') !== LABEL_COLUMNS.join(',')) {
    problems.push({ line: 1, message: `The header must be exactly: ${LABEL_COLUMNS.join(', ')}. Found: ${header.join(', ') || '(nothing)'}.` });
    return { problems, warnings, rows, counts };
  }

  const wanted = new Map(expectedPairs(dataset).map((pair) => [`${pair.cvId}\u0000${pair.requirementId}`, pair]));
  const seen = new Set<string>();

  table.slice(1).forEach((cells, index) => {
    const line = index + 2;
    if (cells.length !== LABEL_COLUMNS.length) {
      problems.push({ line, message: `Expected ${LABEL_COLUMNS.length} columns and found ${cells.length}. A passage containing a comma or a quote needs to be in quotes.` });
      return;
    }
    const [cvId, requirementId, , verdict, notes] = cells.map((cell) => cell.trim()) as [string, string, string, string, string];
    const key = `${cvId}\u0000${requirementId}`;

    if (!wanted.has(key)) {
      problems.push({ line, message: `"${cvId}" with "${requirementId}" is not a pair in the dataset.` });
      return;
    }
    if (seen.has(key)) {
      problems.push({ line, message: `${cvId} / ${requirementId} appears more than once.` });
      return;
    }
    seen.add(key);

    const passages = splitPassages(cells[2] as string);
    const row: LabelRow = { line, cvId, requirementId, goldPassages: passages, expectedVerdict: verdict, notes };
    rows.push(row);
    counts.total += 1;

    if (verdict === '') {
      problems.push({ line, message: `${cvId} / ${requirementId} has no expected_verdict.` });
    } else if (!(VERDICTS as readonly string[]).includes(verdict)) {
      problems.push({ line, message: `${cvId} / ${requirementId}: "${verdict}" is not a verdict. Use one of: ${VERDICTS.join(', ')}.` });
    } else {
      counts[verdict as LabelVerdict] += 1;
    }

    const cvText = cvTexts.get(cvId) ?? '';
    for (const passage of passages) {
      if (!passageInCv(passage, cvText)) {
        problems.push({ line, message: `${cvId} / ${requirementId}: this passage is not in the CV, word for word: "${preview(passage)}"` });
      }
      if (passage.length > LONG_PASSAGE_CHARS) {
        warnings.push({ line, message: `${cvId} / ${requirementId}: a passage of ${passage.length} characters is very long. Gold passages are meant to be the sentence or bullet that shows it.` });
      }
    }
    if (passages.length > 0) counts.withPassages += 1;

    if (verdict === 'unclear' && passages.length > 0) {
      problems.push({ line, message: `${cvId} / ${requirementId}: "unclear" means the CV is silent, so it should have no gold passage. If something speaks to it, the verdict is partial or not_met.` });
    }
    if ((verdict === 'met' || verdict === 'partial' || verdict === 'not_met') && passages.length === 0) {
      problems.push({ line, message: `${cvId} / ${requirementId}: "${verdict}" needs at least one gold passage, the text that shows it.` });
    }
  });

  for (const [key, pair] of wanted) {
    if (!seen.has(key)) problems.push({ line: null, message: `The row for ${pair.cvId} / ${pair.requirementId} is missing.` });
  }

  return { problems, warnings, rows, counts };
}
