import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createJob, ingestResume } from '../src/agent/ingest.ts';
import { MATCH_MODES, type MatchMode } from '../src/agent/matchRules.ts';
import { createTestContext } from '../test/helpers.ts';
import { LABELS_PROVENANCE, loadCvText, loadDataset, requireProvenance, type LabelVerdict } from './evalLabels.ts';
import { passageMetrics, tierAgreement, tierOfVerdicts, verdictAgreement, verdictFromQuotes, type PairRecord, type Span } from './evalMetrics.ts';

// OFFLINE RE-SCORE OF A SAVED RUN, UNDER THE `matcher` VERDICT MODE. No model, no key, no request.
//
//   node scripts/rescore-saved.ts <saved-results.json> [--out=<file>]
//
// A saved run (the quotes-only `extract-v2` prompt) records, for every requirement, the character ranges of the passages the model
// quoted that were found in the CV. This rebuilds those passages from the ranges and the CVs (checking each CV's hash, so the ranges
// index the text they were taken from), and scores them again with the matcher alone, in both match modes, against the labels as
// they are now. That is the BASELINE for `model_checked`.
//
// What it cannot do: `model_checked` needs the model's own verdicts, and a quotes-only run asked for none. So a saved run of that
// kind CANNOT be re-scored under `model_checked`, and this script does not pretend to: the first `model_checked` numbers come from a new
// run (prompt `extract-v3`).
//
// The labels it scores against are the main set's: "Labels drafted by ChatGPT; reviewed independently by ChatGPT and Claude (agreed on 64 of 68 rows); final decisions approved by Sameer. Not an independent human labelling.".

type SavedRequirement = { requirementId: string; label: string; verifiedSpans: Span[]; goldSpans: Span[]; goldVerdict: LabelVerdict };
type SavedCv = { id: string; contentSha256: string; result: string; requirements: SavedRequirement[] };

function main(): Promise<number> {
  return (async () => {
    const args = process.argv.slice(2);
    const file = args.find((value) => !value.startsWith('--'));
    const outArg = args.find((value) => value.startsWith('--out='))?.slice('--out='.length);
    if (!file || !fs.existsSync(file)) {
      console.log('Usage: node scripts/rescore-saved.ts <saved-results.json> [--out=<file>]');
      return 1;
    }
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { model: string; promptVersion: string; dataset: string; cvs: SavedCv[]; labelsProvenance?: unknown };
    if (saved.promptVersion === 'extract-v3') {
      console.log('This run used the verdict prompt (extract-v3); it already carries the model\'s verdicts. Nothing to re-score offline.');
      return 1;
    }
    if (saved.labelsProvenance !== undefined) requireProvenance(saved as { labelsProvenance: unknown });

    const dataset = loadDataset();
    if (saved.dataset !== dataset.version) throw new Error(`The saved run is of ${saved.dataset}; the dataset is ${dataset.version}.`);
    const labels = fs.readFileSync(path.join(path.dirname(path.resolve(file)), '../../eval/labels_TODO.csv'), 'utf8');
    void labels;

    type Pair = { gold: LabelVerdict; predicted: LabelVerdict };
    const pairs: Record<MatchMode, Pair[]> = { strict: [], folded: [] };
    type Tier = ReturnType<typeof tierOfVerdicts>;
    const tiers: Record<MatchMode, Array<{ gold: Tier; predicted: Tier }>> = { strict: [], folded: [] };
    const records: PairRecord[] = [];
    let cvs = 0;
    let skipped = 0;

    for (const cv of saved.cvs) {
      const entry = dataset.cvs.find((candidate) => candidate.id === cv.id);
      if (!entry) throw new Error(`${cv.id} is not in the dataset.`);
      if (cv.result !== 'succeeded') {
        skipped += 1;
        continue;
      }
      const role = dataset.roles[entry.role]!;
      const ctx = await createTestContext({ idPrefix: cv.id });
      try {
        const { requirements } = await createJob({ repos: ctx.repos }, { title: role.title, seniority: 'senior', description: role.description, requirements: role.requirements.map((r) => ({ label: r.label, criterion: r.criterion, kind: r.kind, weight: r.weight })) });
        const ingested = await ingestResume({ repos: ctx.repos }, { reference: cv.id, displayName: null, text: loadCvText(entry), source: 'manual' });
        const content = ingested.resume.contentText;
        if (crypto.createHash('sha256').update(content).digest('hex') !== cv.contentSha256) {
          throw new Error(`${cv.id}: the CV text is not the text the saved ranges were taken from (hash differs).`);
        }
        const verdicts: Record<MatchMode, Map<string, LabelVerdict>> = { strict: new Map(), folded: new Map() };
        const goldVerdicts = new Map<string, LabelVerdict>();
        const list = role.requirements.map((r) => requirements.find((stored) => stored.label === r.label)!);
        for (const row of cv.requirements) {
          const requirement = requirements.find((stored) => stored.label === row.label)!;
          const quotes = row.verifiedSpans.map((span) => content.slice(span.start, span.end));
          for (const mode of MATCH_MODES) {
            const verdict = verdictFromQuotes(requirement, quotes, mode);
            verdicts[mode].set(requirement.id, verdict);
            pairs[mode].push({ gold: row.goldVerdict, predicted: verdict });
          }
          goldVerdicts.set(requirement.id, row.goldVerdict);
          records.push({ cvId: cv.id, requirementId: row.requirementId, goldVerdict: row.goldVerdict, goldSpans: row.goldSpans, verifiedSpans: row.verifiedSpans });
        }
        const goldTier = tierOfVerdicts(list, goldVerdicts);
        for (const mode of MATCH_MODES) tiers[mode].push({ gold: goldTier, predicted: tierOfVerdicts(list, verdicts[mode]) });
        cvs += 1;
      } finally {
        await ctx.close();
      }
    }

    const result = {
      source: path.basename(file),
      model: saved.model,
      promptVersion: saved.promptVersion,
      verdictMode: 'matcher',
      labelsProvenance: { main: LABELS_PROVENANCE.main },
      cvs,
      skippedFailedExtractions: skipped,
      passage: { half: passageMetrics(records, 'half'), any: passageMetrics(records, 'any') },
      byMatchMode: Object.fromEntries(MATCH_MODES.map((mode) => [mode, { verdictAgreement: verdictAgreement(pairs[mode]), tierAgreement: tierAgreement(tiers[mode]) }])),
      note: 'Re-scored offline from the saved character ranges, under the matcher alone. model_checked cannot be re-scored from a quotes-only run: it needs the model\'s verdicts, which that run did not ask for.',
    };
    const pct = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
    console.log(`== offline re-score of ${result.source} (${saved.model}, ${saved.promptVersion}), verdict mode: matcher ==`);
    console.log(`labels: ${LABELS_PROVENANCE.main}`);
    console.log(`${cvs} CVs${skipped ? `, ${skipped} skipped (the extraction failed)` : ''}; passage recall ${pct(result.passage.half.recall)}, precision ${pct(result.passage.half.precision)} (half-overlap)`);
    for (const mode of MATCH_MODES) {
      const cell = result.byMatchMode[mode] as { verdictAgreement: ReturnType<typeof verdictAgreement>; tierAgreement: ReturnType<typeof tierAgreement> };
      console.log(`${mode.padEnd(7)}: verdict agreement ${pct(cell.verdictAgreement.rate)} (${cell.verdictAgreement.agree}/${cell.verdictAgreement.rows}), tier agreement ${pct(cell.tierAgreement.rate)}`);
    }
    console.log('model_checked: NOT re-scorable offline (the saved run is the quotes-only schema: it holds no model verdicts).');
    if (outArg) {
      fs.mkdirSync(path.dirname(path.resolve(outArg)), { recursive: true });
      fs.writeFileSync(outArg, `${JSON.stringify(result, null, 2)}\n`);
      console.log(`saved ${outArg}`);
    }
    return 0;
  })();
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
