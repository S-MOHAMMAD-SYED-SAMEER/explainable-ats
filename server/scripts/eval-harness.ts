import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config/env.ts';
import { createAnthropicProvider } from '../src/adapters/llm/anthropic.ts';
import type { LlmProvider } from '../src/adapters/llm/types.ts';
import { createJob, ingestResume } from '../src/agent/ingest.ts';
import { openEvaluation } from '../src/agent/extract.ts';
import { extractVerdicts } from '../src/agent/extractVerdicts.ts';
import { VERDICT_PROMPT_VERSION } from '../src/agent/verdictExtraction.ts';
import { VERDICT_MODES, type VerdictMode } from '../src/agent/verdictMode.ts';
import { reconcileWithMatcher, type EnforcedVerdict } from '../src/agent/verdictEnforcement.ts';
import { MATCH_MODES, type MatchMode } from '../src/agent/matchRules.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { createTestContext } from '../test/helpers.ts';
import {
  EVAL_DIR,
  HELDOUT_DIR,
  LABELS_PROVENANCE,
  loadCvText,
  loadDataset,
  loadHeldoutDataset,
  parseCsv,
  provenanceFor,
  splitPassages,
  type Dataset,
  type LabelSet,
  type LabelVerdict,
} from './evalLabels.ts';
import {
  locatePassage,
  passageMetrics,
  summarise,
  tierAgreement,
  tierOfVerdicts,
  verdictAgreement,
  verdictFromQuotes,
  verdictsFromGoldPassages,
  type PairRecord,
  type Span,
} from './evalMetrics.ts';
import { PRICES_SOURCE, costOf, formatDollars } from './pricing.ts';

// OPT-IN LIVE EVALUATION OF THE EXTRACTION, VERDICT AND MATCHING STAGES: by hand, never in CI.
//
//   ANTHROPIC_LIVE_TEST=1 ANTHROPIC_MODEL=<id> [ANTHROPIC_TOOL_CHOICE=forced] [ANTHROPIC_TEMPERATURE=0] \
//     env -u ANTHROPIC_API_KEY node --env-file=.env scripts/eval-harness.ts --out=../docs/results/<file>.json
//   node scripts/eval-harness.ts --dry          prints the plan and cost estimate, makes no request, needs no key
//   node scripts/eval-harness.ts --oracle       runs the whole pipeline with a stand-in that returns the labeller's own verdicts and
//                                               passages: free, and checks the harness itself
//
// Options: --set=dev|heldout|both (default both)  --repeats=N (default 1)  --cvs=cv-01,cv-02  --budget=D  --prior-spend=D
//
// ONE REAL REQUEST PER CV PER REPEAT. Through the real adapter and the real pipeline (prompt `extract-v3`: the model proposes a verdict
// per requirement with its passages, the code enforces the rules, the matcher is a second opinion). Retries are off, so the request count
// is exact. It never loops, and it stops at once on a refused request (bad key, no credit, a setting), on a 401, 402, 403, 429 or 529,
// after two outages in a row, or when the next request could take total spend past the budget.
//
// THE TWO SETS ARE REPORTED SEPARATELY. `dev` is the twenty CVs whose labels were drafted by ChatGPT and checked by Sameer; `heldout` is the
// five CVs labelled by Sameer alone, without AI, never used for tuning. Each result block says which labels it was scored against.
//
// BOTH VERDICT MODES, BOTH MATCH MODES, FROM ONE EXTRACTION. `model_checked` scores the verdicts after the code's rules and the second opinion;
// `matcher` scores the matcher alone judging the same verified passages (the old behaviour). The match mode only changes how words are
// compared after the model has answered (and, in `model_checked`, is the second opinion's mode), so all four are scored from the same
// model reply: no extra request.
//
// WHAT IS SAVED: counts, character ranges, verdicts, tokens, latency and cost. Never the key, a prompt, a reply, a reason or a quote
// (passages can be rebuilt from the ranges and the invented CVs).

const BUDGET_DEFAULT = 2.0;
// What the project has spent before this run, from the ledger in the progress notes (2026-10-15): $1.10.
const PRIOR_SPEND_DEFAULT = 1.1;
// Used only for the estimate printed before a run, never for a figure that is reported.
const ASSUMED_OUTPUT_TOKENS_PER_CV: Record<string, number> = { 'claude-haiku-4-5-20251001': 450, 'claude-sonnet-5-5': 1500 };
const PROMPT_OVERHEAD_TOKENS = 1000;

type SetKey = 'dev' | 'heldout';
type CombinationKey = `${VerdictMode}/${MatchMode}`;

type RequirementRow = {
  requirementId: string;
  label: string;
  goldVerdict: LabelVerdict;
  goldSpans: Span[];
  verifiedSpans: Span[];
  /** What the model proposed (null: no answer), and what the code left standing. */
  modelVerdict: LabelVerdict | null;
  enforcedVerdict: LabelVerdict;
  downgraded: boolean;
  verdict: Record<CombinationKey, LabelVerdict>;
  disagreement: Record<MatchMode, 'none' | 'one_step' | 'two_plus'>;
};

type CvRow = {
  id: string;
  set: SetKey;
  repeat: number;
  role: string;
  chars: number;
  contentSha256: string;
  requests: number;
  result: string;
  failureLabel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  maxTokens: number | null;
  latencyMs: number | null;
  costDollars: number | null;
  passagesReturned: number | null;
  proposedValidShape: number | null;
  verified: number | null;
  refusedNotInCv: number | null;
  refusedTooShort: number | null;
  refusedOverMask: number | null;
  malformedDropped: number | null;
  requirements: RequirementRow[];
  tier: Record<CombinationKey, string> & { gold: string };
  routedToReview: Record<MatchMode, boolean>;
};

type LabelSetup = { key: SetKey; labelSet: LabelSet; dataset: Dataset; dir: string; labelsFile: string; labelsText: string; labelFor: Map<string, { passages: string[]; verdict: LabelVerdict | '' }>; labelled: boolean };

function line(text = ''): void {
  console.log(text);
}

function safeMessage(err: unknown, secret: string): string {
  const text = err instanceof Error ? err.message : 'unknown error';
  return secret === '' ? text.slice(0, 300) : text.split(secret).join('[redacted]').slice(0, 300);
}

const percent = (value: number | null): string => (value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`);
const sha256 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex');
const combos: CombinationKey[] = VERDICT_MODES.flatMap((verdictMode) => MATCH_MODES.map((matchMode): CombinationKey => `${verdictMode}/${matchMode}`));

/** Whether a failure is one that must stop the run at once: a refused request, or a 401, 402, 403, 429 or 529. */
function mustStopNow(result: string, label: string | null): boolean {
  if (result === 'rejected') return true;
  return label !== null && /\bHTTP (401|402|403|429|529)\b|credit|billing/i.test(label);
}

function loadSet(key: SetKey): LabelSetup {
  const heldout = key === 'heldout';
  const dataset = heldout ? loadHeldoutDataset() : loadDataset();
  const dir = heldout ? HELDOUT_DIR : EVAL_DIR;
  const labelsFile = path.join(EVAL_DIR, heldout ? 'labels_heldout_TODO.csv' : 'labels_TODO.csv');
  const labelsText = fs.readFileSync(labelsFile, 'utf8');
  const labelFor = new Map(
    parseCsv(labelsText)
      .slice(1)
      .map((cells) => [`${cells[0]?.trim()}\u0000${cells[1]?.trim()}`, { passages: splitPassages(cells[2] ?? ''), verdict: ((cells[3] ?? '').trim() as LabelVerdict | '') }]),
  );
  const labelled = labelFor.size > 0 && [...labelFor.values()].every((label) => label.verdict !== '');
  return { key, labelSet: heldout ? 'heldout' : 'main', dataset, dir, labelsFile, labelsText, labelFor, labelled };
}

const rangeOf = (values: readonly (number | null)[]): { min: number | null; median: number | null; max: number | null } => {
  const present = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (present.length === 0) return { min: null, median: null, max: null };
  const middle = Math.floor(present.length / 2);
  return { min: present[0] as number, median: present.length % 2 === 1 ? (present[middle] as number) : ((present[middle - 1] as number) + (present[middle] as number)) / 2, max: present[present.length - 1] as number };
};

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const oracle = args.includes('--oracle');
  const argValue = (name: string): string | null => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const outPath = argValue('--out');
  const only = argValue('--cvs')?.split(',') ?? null;
  const budget = Number(argValue('--budget') ?? BUDGET_DEFAULT);
  const priorSpend = Number(argValue('--prior-spend') ?? PRIOR_SPEND_DEFAULT);
  const repeats = Math.max(1, Math.floor(Number(argValue('--repeats') ?? 1)));
  const setArg = argValue('--set') ?? 'both';
  if (!['dev', 'heldout', 'both'].includes(setArg)) {
    line(`--set must be dev, heldout or both, not "${setArg}".`);
    return 1;
  }

  const requested: SetKey[] = setArg === 'both' ? ['dev', 'heldout'] : [setArg as SetKey];
  const setups = requested.map(loadSet);
  const selectedOf = (setup: LabelSetup) => setup.dataset.cvs.filter((cv) => only === null || only.includes(cv.id) || only.includes(cv.id.replace('cv-', '')));
  const skipped = setups.filter((setup) => !setup.labelled);
  const active = setups.filter((setup) => setup.labelled);
  const model = oracle ? "oracle (the labeller's own verdicts and passages)" : config.anthropicModel;
  const temperature = config.anthropicTemperature === null ? 'unset (not sent)' : String(config.anthropicTemperature);

  // --- the plan, printed before anything is spent ---------------------------------------------------------
  const planned = active.reduce((sum, setup) => sum + selectedOf(setup).length, 0) * repeats;
  const estimatedInput = active.reduce((sum, setup) => sum + selectedOf(setup).reduce((inner, cv) => inner + Math.ceil(loadCvText(cv, setup.dir).length / 4) + PROMPT_OVERHEAD_TOKENS, 0), 0) * repeats;
  const estimatedOutput = planned * (ASSUMED_OUTPUT_TOKENS_PER_CV[config.anthropicModel] ?? 1500);
  const estimatedCost = oracle ? 0 : costOf(config.anthropicModel, { inputTokens: estimatedInput, outputTokens: estimatedOutput });

  line(`== evaluation: ${setups.map((setup) => `${setup.key} (${selectedOf(setup).length} CVs, labels: ${LABELS_PROVENANCE[setup.labelSet]})`).join(' and ')}; repeats ${repeats} ==`);
  for (const setup of skipped) line(`NOT RUN: the ${setup.key} set's labels are not filled in (${path.basename(setup.labelsFile)}). Nothing can be scored against empty labels.`);
  line(`model            : ${model}`);
  line(`tool choice      : ${config.anthropicToolChoice}    temperature: ${temperature}    prompt: ${VERDICT_PROMPT_VERSION}    retries: 0`);
  line(`verdict modes    : ${VERDICT_MODES.join(' and ')}; match modes: ${MATCH_MODES.join(' and ')} (all four scored from the same extraction)`);
  line(`expected requests: ${oracle ? 0 : planned}`);
  line(
    `expected cost    : ${estimatedCost === null ? 'unknown (no recorded price for this model)' : formatDollars(estimatedCost)}` +
      ` (estimate: about ${estimatedInput.toLocaleString('en')} input and ${estimatedOutput.toLocaleString('en')} output tokens; ${PRICES_SOURCE})`,
  );
  line(`spend limit      : ${formatDollars(budget)} for the whole project; spent before this run ${formatDollars(priorSpend)}`);

  if (dry) {
    line('DRY RUN: no request was made.');
    return 0;
  }
  if (active.length === 0) {
    line('STOPPED: no set has labels to score against. No request was made.');
    return 1;
  }

  // --- the key: where it comes from, shown without being shown ------------------------------------------------
  let apiKey = '';
  if (!oracle) {
    apiKey = process.env.ANTHROPIC_API_KEY ?? '';
    if (apiKey.trim() === '' || process.env.ANTHROPIC_LIVE_TEST !== '1') {
      line('SKIPPED: set ANTHROPIC_API_KEY (from server/.env) and ANTHROPIC_LIVE_TEST=1 to run. No request was made.');
      return 0;
    }
    const envText = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
    const fromFile = envText
      .split(/\r?\n/)
      .find((entry) => /^\s*ANTHROPIC_API_KEY\s*=/.test(entry))
      ?.split('=')
      .slice(1)
      .join('=')
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (fromFile === undefined || fromFile !== apiKey) {
      line('STOPPED: the key in the environment is not the one in server/.env (a stale environment variable?). No request was made.');
      return 1;
    }
    line(`key              : from server/.env, prefix "${apiKey.slice(0, 13)}", length ${apiKey.length}; identical to the process environment's value`);
  }

  // --- the run ----------------------------------------------------------------------------------------------
  const rows: CvRow[] = [];
  type Pair = { gold: LabelVerdict; predicted: LabelVerdict };
  type Tier = ReturnType<typeof tierOfVerdicts>;
  const pairs: Record<string, Record<CombinationKey, Pair[]>> = {};
  const tiers: Record<string, Record<CombinationKey, Array<{ gold: Tier; predicted: Tier }>>> = {};
  const goldMatcherPairs: Record<string, Record<MatchMode, Pair[]>> = {};
  const goldMatcherTiers: Record<string, Record<MatchMode, Array<{ gold: Tier; predicted: Tier }>>> = {};
  const modelRawPairs: Record<string, Pair[]> = {};
  const pairRecordsByScope: Record<string, PairRecord[]> = {};
  const emptyByCombo = <T,>(make: () => T): Record<CombinationKey, T> => Object.fromEntries(combos.map((combo) => [combo, make()])) as Record<CombinationKey, T>;
  const emptyByMode = <T,>(make: () => T): Record<MatchMode, T> => Object.fromEntries(MATCH_MODES.map((mode) => [mode, make()])) as Record<MatchMode, T>;
  const scope = (setKey: SetKey, repeat: number): string => `${setKey}#${repeat}`;
  const ensure = (id: string): void => {
    pairs[id] ??= emptyByCombo<Pair[]>(() => []);
    tiers[id] ??= emptyByCombo<Array<{ gold: Tier; predicted: Tier }>>(() => []);
    goldMatcherPairs[id] ??= emptyByMode<Pair[]>(() => []);
    goldMatcherTiers[id] ??= emptyByMode<Array<{ gold: Tier; predicted: Tier }>>(() => []);
    modelRawPairs[id] ??= [];
    pairRecordsByScope[id] ??= [];
  };

  let spent = 0;
  let outages = 0;
  let stopped: string | null = null;

  outer: for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const setup of active) {
      const { dataset, dir } = setup;
      for (const cv of selectedOf(setup)) {
        if (!oracle && priorSpend + spent + 0.05 > budget) {
          stopped = `the next request could take total spend past ${formatDollars(budget)}`;
          break outer;
        }
        const id = scope(setup.key, repeat);
        ensure(id);

        const role = dataset.roles[cv.role];
        if (!role) throw new Error(`${cv.id}: unknown role ${cv.role}`);
        const text = loadCvText(cv, dir);

        const ctx = await createTestContext({ idPrefix: cv.id });
        const { logger, entries } = createMemoryLogger(cv.id);
        const { job, requirements } = await createJob({ repos: ctx.repos }, { title: role.title, seniority: 'senior', description: role.description, requirements: role.requirements.map((entry) => ({ label: entry.label, criterion: entry.criterion, kind: entry.kind, weight: entry.weight })) });
        const ingested = await ingestResume({ repos: ctx.repos }, { reference: cv.id, displayName: null, text, source: 'manual' });
        const evaluation = await openEvaluation({ repos: ctx.repos }, { jobId: job.id, candidateId: ingested.candidate.id, resume: ingested.resume });
        const content = ingested.resume.contentText;

        const stored = new Map(role.requirements.map((entry) => [entry.id, requirements.find((requirement) => requirement.label === entry.label)]));
        for (const [reqId, requirement] of stored) if (!requirement) throw new Error(`${cv.id}: requirement ${reqId} was not stored`);

        const gold = role.requirements.map((entry) => {
          const label = setup.labelFor.get(`${cv.id}\u0000${entry.id}`);
          if (!label || label.verdict === '') throw new Error(`${cv.id} / ${entry.id}: no label`);
          const spans = label.passages.map((passage) => {
            const span = locatePassage(passage, content);
            if (!span) throw new Error(`${cv.id} / ${entry.id}: a gold passage cannot be found in the CV (run validate-labels.ts)`);
            return span;
          });
          return { entry, requirement: stored.get(entry.id)!, label: label as { passages: string[]; verdict: LabelVerdict }, spans };
        });

        let requests = 0;
        let provider: LlmProvider;
        if (oracle) {
          provider = {
            name: 'oracle',
            configured: true,
            async complete() {
              requests += 1;
              return {
                output: {
                  requirements: gold.map(({ requirement, label, spans }) => ({
                    requirementId: requirement.id,
                    verdict: label.verdict,
                    passages: spans.map((span) => content.slice(span.start, span.end)),
                    reason: 'the labeller',
                  })),
                },
                model: 'oracle',
                latencyMs: 0,
                usage: { inputTokens: 0, outputTokens: 0 },
              };
            },
          };
        } else {
          const real = createAnthropicProvider({
            apiKey,
            model: config.anthropicModel,
            timeoutMs: Math.max(config.anthropicTimeoutMs, 180_000),
            maxRetries: 0,
            toolChoice: config.anthropicToolChoice,
            ...(config.anthropicTemperature === null ? {} : { temperature: config.anthropicTemperature }),
            logger,
          });
          provider = {
            name: real.name,
            configured: real.configured,
            async complete(request) {
              requests += 1;
              if (requests > 1) throw new Error('Each CV gets exactly one request.');
              return real.complete(request);
            },
          };
        }

        let threw = false;
        try {
          await extractVerdicts({ repos: ctx.repos, provider, logger }, evaluation.id);
        } catch {
          threw = true;
        }

        const after = await ctx.repos.evaluations.getById(evaluation.id);
        const record = await ctx.repos.evaluationRecords.getForEvaluation(evaluation.id);
        const events = await ctx.repos.audit.listForCorrelation(evaluation.id);
        const failureEvent = events.find((event) => event.outcome === 'failed');
        const failureLabel = typeof failureEvent?.payload.label === 'string' ? failureEvent.payload.label : null;

        const usage = record?.inputTokens != null && record.outputTokens != null ? { inputTokens: record.inputTokens, outputTokens: record.outputTokens } : null;
        const cost = oracle ? 0 : usage ? costOf(config.anthropicModel, usage) : null;
        if (cost !== null) spent += cost;

        const extracted = !threw && after?.status === 'extracted';
        const verifiedRows = extracted ? await ctx.repos.evidence.listVerifiedForEvaluation(evaluation.id) : [];
        const checks = extracted ? await ctx.repos.verdictChecks.listForEvaluation(evaluation.id) : [];
        const verifiedEvent = events.find((event) => event.eventType === 'evidence_verified');
        const refusal = events.find((event) => event.eventType === 'unverifiable_evidence_rejected');
        const reasons = Array.isArray(refusal?.payload.reasons) ? (refusal?.payload.reasons as string[]) : [];
        const dropped = events.find((event) => event.eventType === 'malformed_findings_dropped');
        const droppedReasons = Array.isArray(dropped?.payload.reasons) ? (dropped?.payload.reasons as string[]) : [];

        // The enforced verdicts, as the extraction wrote them, then the second opinion in each match mode.
        const requirementList = gold.map((item) => item.requirement);
        const enforced: EnforcedVerdict[] = requirementList.map((requirement) => {
          const check = checks.find((entry) => entry.requirementId === requirement.id);
          return {
            requirementId: requirement.id,
            modelVerdict: check?.modelVerdict ?? null,
            modelReason: null,
            enforcedVerdict: check?.enforcedVerdict ?? 'unclear',
            downgrade: check?.downgradeReason ?? (check ? null : 'no_answer'),
            verifiedPassages: verifiedRows.filter((row) => row.requirementId === requirement.id).length,
          };
        });
        const reconciled = Object.fromEntries(MATCH_MODES.map((mode) => [mode, reconcileWithMatcher(requirementList, enforced, verifiedRows, mode)])) as Record<MatchMode, ReturnType<typeof reconcileWithMatcher>>;

        const requirementRows: RequirementRow[] = [];
        const verdictMaps = emptyByCombo<Map<string, LabelVerdict>>(() => new Map());
        const goldVerdicts = new Map<string, LabelVerdict>();
        gold.forEach(({ entry, requirement, label, spans }, index) => {
          const mine = verifiedRows.filter((row) => row.requirementId === requirement.id);
          const verdict = {} as Record<CombinationKey, LabelVerdict>;
          const disagreement = {} as Record<MatchMode, 'none' | 'one_step' | 'two_plus'>;
          for (const mode of MATCH_MODES) {
            const checked = reconciled[mode][index]!;
            verdict[`model_checked/${mode}`] = checked.scoredVerdict;
            verdict[`matcher/${mode}`] = verdictFromQuotes(requirement, mine.map((row) => row.quote), mode);
            disagreement[mode] = checked.disagreement;
            verdictMaps[`model_checked/${mode}`].set(requirement.id, verdict[`model_checked/${mode}`]);
            verdictMaps[`matcher/${mode}`].set(requirement.id, verdict[`matcher/${mode}`]);
          }
          for (const combo of combos) pairs[id]![combo].push({ gold: label.verdict, predicted: verdict[combo] });
          const modelVerdict = enforced[index]!.modelVerdict;
          modelRawPairs[id]!.push({ gold: label.verdict, predicted: modelVerdict ?? 'unclear' });
          goldVerdicts.set(requirement.id, label.verdict);
          const verifiedSpans = mine.map((row) => ({ start: row.charStart, end: row.charEnd }));
          pairRecordsByScope[id]!.push({ cvId: cv.id, requirementId: entry.id, goldVerdict: label.verdict, goldSpans: spans, verifiedSpans });
          requirementRows.push({
            requirementId: entry.id,
            label: entry.label,
            goldVerdict: label.verdict,
            goldSpans: spans,
            verifiedSpans,
            modelVerdict,
            enforcedVerdict: enforced[index]!.enforcedVerdict,
            downgraded: enforced[index]!.downgrade === 'no_verified_passage',
            verdict,
            disagreement,
          });
        });

        const goldTier = tierOfVerdicts(requirementList, goldVerdicts);
        const tier = { gold: goldTier } as CvRow['tier'];
        const routedToReview = {} as Record<MatchMode, boolean>;
        for (const combo of combos) {
          tier[combo] = tierOfVerdicts(requirementList, verdictMaps[combo]);
          tiers[id]![combo].push({ gold: goldTier, predicted: tier[combo] as Tier });
        }
        for (const mode of MATCH_MODES) {
          routedToReview[mode] = reconciled[mode].some((entry) => entry.disagreement === 'two_plus');
          // The matcher alone, with the labeller's own passages as the evidence: the ceiling the matcher puts on any model.
          const goldQuotes = new Map(gold.map(({ requirement, spans }) => [requirement.id, spans.map((span) => content.slice(span.start, span.end))]));
          const ceiling = verdictsFromGoldPassages(requirementList, goldQuotes, mode);
          for (const { requirement, label } of gold) goldMatcherPairs[id]![mode].push({ gold: label.verdict, predicted: ceiling.get(requirement.id) as LabelVerdict });
          goldMatcherTiers[id]![mode].push({ gold: goldTier, predicted: tierOfVerdicts(requirementList, ceiling) });
        }

        const row: CvRow = {
          id: cv.id,
          set: setup.key,
          repeat,
          role: cv.role,
          chars: content.length,
          contentSha256: sha256(content),
          requests,
          result: record?.result ?? 'no record',
          failureLabel,
          inputTokens: record?.inputTokens ?? null,
          outputTokens: record?.outputTokens ?? null,
          maxTokens: record?.maxTokens ?? null,
          latencyMs: record?.latencyMs ?? null,
          costDollars: cost,
          passagesReturned: record?.findingsReturned ?? null,
          proposedValidShape: extracted ? Number(verifiedEvent?.payload.verified ?? 0) + Number(verifiedEvent?.payload.rejected ?? 0) : null,
          verified: extracted ? verifiedRows.length : null,
          refusedNotInCv: extracted ? reasons.filter((reason) => reason === 'not_found_in_resume').length : null,
          refusedTooShort: extracted ? reasons.filter((reason) => reason === 'quote_too_short').length : null,
          refusedOverMask: extracted ? reasons.filter((reason) => reason === 'quotes_redacted_text').length : null,
          malformedDropped: extracted ? droppedReasons.length : null,
          requirements: requirementRows,
          tier,
          routedToReview,
        };
        rows.push(row);

        if (!oracle && JSON.stringify([entries, events, after, record]).includes(apiKey)) {
          line('STOPPED: the API key reached a log, the audit trail or a record.');
          return 1;
        }
        await ctx.close();

        const agree = (combo: CombinationKey): string => `${requirementRows.filter((r) => r.verdict[combo] === r.goldVerdict).length}/${requirementRows.length}`;
        line(
          `${setup.key}${repeats > 1 ? `#${repeat}` : ''} ${cv.id} (${role.title.split(' ')[0]}, ${content.length} chars): ${row.result}` +
            (row.failureLabel ? ` [${row.failureLabel}]` : '') +
            `  ${row.inputTokens ?? '-'} in / ${row.outputTokens ?? '-'} out, ${row.latencyMs ?? '-'} ms, ${cost === null ? '-' : formatDollars(cost)}` +
            `  passages ${row.proposedValidShape ?? '-'} proposed, ${row.verified ?? '-'} verified, ${row.refusedNotInCv ?? '-'} not in CV` +
            `  verdicts checked ${MATCH_MODES.map((mode) => agree(`model_checked/${mode}`)).join(' ')}; matcher ${MATCH_MODES.map((mode) => agree(`matcher/${mode}`)).join(' ')} (${MATCH_MODES.join(' ')})` +
            `  tier gold ${goldTier} / checked ${MATCH_MODES.map((mode) => tier[`model_checked/${mode}`]).join(' ')}${routedToReview.folded || routedToReview.strict ? '  ROUTED' : ''}`,
        );

        if (!oracle) {
          if (mustStopNow(row.result, row.failureLabel)) {
            stopped = `the service refused a request (${row.failureLabel ?? row.result}): a key, credit, rate-limit or configuration problem, not something to retry`;
            break outer;
          }
          outages = row.result === 'unavailable' ? outages + 1 : 0;
          if (outages >= 2) {
            stopped = 'two requests in a row did not get an answer';
            break outer;
          }
        }
      }
    }
  }

  // --- the numbers ---------------------------------------------------------------------------------------------
  const totals = rows.reduce(
    (sum, row) => ({ requests: sum.requests + row.requests, inputTokens: sum.inputTokens + (row.inputTokens ?? 0), outputTokens: sum.outputTokens + (row.outputTokens ?? 0) }),
    { requests: 0, inputTokens: 0, outputTokens: 0 },
  );
  const totalCost = oracle ? 0 : costOf(config.anthropicModel, { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens });
  const latency = summarise(rows.map((row) => row.latencyMs).filter((value): value is number => value !== null));
  const perCvCost = summarise(rows.map((row) => row.costDollars).filter((value): value is number => value !== null));

  type SetResult = {
    repeat: number;
    cvs: number;
    succeeded: number;
    extraction: { passagesProposed: number; passagesVerified: number; refusedNotInCv: number; refusedTooShort: number; refusedOverMask: number; fabricatedQuoteRate: number | null };
    passage: Record<'half' | 'any', ReturnType<typeof passageMetrics>>;
    byMode: Record<CombinationKey, { verdictAgreement: ReturnType<typeof verdictAgreement>; tierAgreement: ReturnType<typeof tierAgreement> }>;
    modelProposedAgreement: ReturnType<typeof verdictAgreement>;
    enforcement: { verdictsProposed: number; downgraded: number; downgradeRate: number | null };
    secondOpinion: Record<MatchMode, { requirements: number; agree: number; oneStep: number; twoPlus: number; twoPlusRate: number | null; candidates: number; routed: number; routedRate: number | null }>;
    goldThroughMatcher: Record<MatchMode, { verdictAgreement: ReturnType<typeof verdictAgreement>; tierAgreement: ReturnType<typeof tierAgreement> }>;
  };
  const results: Record<SetKey, SetResult[]> = { dev: [], heldout: [] };

  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    for (const setup of active) {
      const id = scope(setup.key, repeat);
      if (!pairs[id]) continue;
      const mine = rows.filter((row) => row.set === setup.key && row.repeat === repeat);
      const succeeded = mine.filter((row) => row.result === 'succeeded');
      const proposed = succeeded.reduce((sum, row) => sum + (row.proposedValidShape ?? 0), 0);
      const notInCv = succeeded.reduce((sum, row) => sum + (row.refusedNotInCv ?? 0), 0);
      const reqRows = mine.flatMap((row) => row.requirements);
      const answered = reqRows.filter((row) => row.modelVerdict !== null).length;
      const downgraded = reqRows.filter((row) => row.downgraded).length;
      results[setup.key].push({
        repeat,
        cvs: mine.length,
        succeeded: succeeded.length,
        extraction: {
          passagesProposed: proposed,
          passagesVerified: succeeded.reduce((sum, row) => sum + (row.verified ?? 0), 0),
          refusedNotInCv: notInCv,
          refusedTooShort: succeeded.reduce((sum, row) => sum + (row.refusedTooShort ?? 0), 0),
          refusedOverMask: succeeded.reduce((sum, row) => sum + (row.refusedOverMask ?? 0), 0),
          fabricatedQuoteRate: proposed === 0 ? null : notInCv / proposed,
        },
        passage: { half: passageMetrics(pairRecordsByScope[id] ?? [], 'half'), any: passageMetrics(pairRecordsByScope[id] ?? [], 'any') },
        byMode: Object.fromEntries(combos.map((combo) => [combo, { verdictAgreement: verdictAgreement(pairs[id]![combo]), tierAgreement: tierAgreement(tiers[id]![combo]) }])) as SetResult['byMode'],
        modelProposedAgreement: verdictAgreement(modelRawPairs[id] ?? []),
        enforcement: { verdictsProposed: answered, downgraded, downgradeRate: answered === 0 ? null : downgraded / answered },
        secondOpinion: Object.fromEntries(
          MATCH_MODES.map((mode) => {
            const cells = reqRows.map((row) => row.disagreement[mode]);
            const twoPlus = cells.filter((cell) => cell === 'two_plus').length;
            const routed = mine.filter((row) => row.routedToReview[mode]).length;
            return [mode, { requirements: cells.length, agree: cells.filter((cell) => cell === 'none').length, oneStep: cells.filter((cell) => cell === 'one_step').length, twoPlus, twoPlusRate: cells.length === 0 ? null : twoPlus / cells.length, candidates: mine.length, routed, routedRate: mine.length === 0 ? null : routed / mine.length }];
          }),
        ) as SetResult['secondOpinion'],
        goldThroughMatcher: Object.fromEntries(MATCH_MODES.map((mode) => [mode, { verdictAgreement: verdictAgreement(goldMatcherPairs[id]![mode]), tierAgreement: tierAgreement(goldMatcherTiers[id]![mode]) }])) as SetResult['goldThroughMatcher'],
      });
    }
  }

  const aggregateOf = (setKey: SetKey) => {
    const list = results[setKey];
    if (list.length === 0) return null;
    return {
      repeats: list.length,
      verdictAgreement: Object.fromEntries(combos.map((combo) => [combo, rangeOf(list.map((entry) => entry.byMode[combo].verdictAgreement.rate))])),
      tierAgreement: Object.fromEntries(combos.map((combo) => [combo, rangeOf(list.map((entry) => entry.byMode[combo].tierAgreement.rate))])),
      modelProposedAgreement: rangeOf(list.map((entry) => entry.modelProposedAgreement.rate)),
      passageRecall: rangeOf(list.map((entry) => entry.passage.half.recall)),
      passagePrecision: rangeOf(list.map((entry) => entry.passage.half.precision)),
      downgradeRate: rangeOf(list.map((entry) => entry.enforcement.downgradeRate)),
      secondOpinionTwoPlusRate: Object.fromEntries(MATCH_MODES.map((mode) => [mode, rangeOf(list.map((entry) => entry.secondOpinion[mode].twoPlusRate))])),
      routedRate: Object.fromEntries(MATCH_MODES.map((mode) => [mode, rangeOf(list.map((entry) => entry.secondOpinion[mode].routedRate))])),
    };
  };

  line();
  line(`== results: ${model} ==`);
  if (stopped) line(`STOPPED EARLY: ${stopped}`);
  line(`requests ${totals.requests}; tokens ${totals.inputTokens.toLocaleString('en')} in / ${totals.outputTokens.toLocaleString('en')} out; cost ${totalCost === null ? 'unknown' : formatDollars(totalCost)}; latency mean ${latency.mean === null ? 'n/a' : Math.round(latency.mean)} ms, median ${latency.median ?? 'n/a'} ms, max ${latency.max ?? 'n/a'} ms`);
  for (const setup of active) {
    const list = results[setup.key];
    line();
    line(`-- ${setup.key}: labels ${LABELS_PROVENANCE[setup.labelSet]} --`);
    for (const result of list) {
      line(`repeat ${result.repeat}: ${result.succeeded}/${result.cvs} extractions succeeded; passages ${result.extraction.passagesProposed} proposed, ${result.extraction.passagesVerified} verified, fabricated-quote rate ${percent(result.extraction.fabricatedQuoteRate)}`);
      line(`  passage recall ${percent(result.passage.half.recall)}, precision ${percent(result.passage.half.precision)} (half-overlap)`);
      line(`  the model's own verdicts against the labels (before the code): ${percent(result.modelProposedAgreement.rate)}`);
      line(`  the code lowered ${result.enforcement.downgraded} of ${result.enforcement.verdictsProposed} verdicts (${percent(result.enforcement.downgradeRate)})`);
      for (const mode of MATCH_MODES) {
        const second = result.secondOpinion[mode];
        line(`  second opinion (${mode}): agree ${second.agree}, one step ${second.oneStep}, two or more ${second.twoPlus} of ${second.requirements} requirements; ${second.routed} of ${second.candidates} candidates routed to a person`);
      }
      for (const combo of combos) {
        const cell = result.byMode[combo];
        line(`  ${combo.padEnd(21)}: verdict agreement ${percent(cell.verdictAgreement.rate)} (${cell.verdictAgreement.agree}/${cell.verdictAgreement.rows}), tier agreement ${percent(cell.tierAgreement.rate)}`);
      }
      for (const mode of MATCH_MODES) line(`  [matcher alone, gold passages as the evidence, ${mode}] verdicts ${percent(result.goldThroughMatcher[mode].verdictAgreement.rate)}, tiers ${percent(result.goldThroughMatcher[mode].tierAgreement.rate)}`);
    }
    if (repeats > 1) {
      const agg = aggregateOf(setup.key);
      const cell = agg?.verdictAgreement['model_checked/folded'] as { min: number | null; median: number | null; max: number | null } | undefined;
      if (agg && cell) line(`  min / median / max over ${agg.repeats} repeats, verdict agreement, model_checked/folded: ${percent(cell.min)} / ${percent(cell.median)} / ${percent(cell.max)}`);
    }
  }

  if (outPath) {
    const file = path.resolve(outPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const setsRun = active.map((setup) => setup.labelSet);
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          kind: 'extraction and matching evaluation',
          date: new Date().toISOString().slice(0, 10),
          model: oracle ? "oracle (the labeller's own verdicts and passages; not a model)" : config.anthropicModel,
          toolChoice: oracle ? 'n/a' : config.anthropicToolChoice,
          temperature: oracle ? 'n/a' : config.anthropicTemperature ?? 'unset (not sent: the model does not accept one)',
          promptVersion: VERDICT_PROMPT_VERSION,
          verdictModes: [...VERDICT_MODES],
          matchModes: [...MATCH_MODES],
          repeats,
          retries: 0,
          stoppedEarly: stopped,
          // Who made the labels each block was scored against, in the exact words (see evalLabels.ts). Never omitted.
          labelsProvenance: provenanceFor(setsRun),
          sets: Object.fromEntries(
            active.map((setup) => [
              setup.key,
              {
                dataset: setup.dataset.version,
                labelsSet: setup.labelSet,
                labelsProvenance: LABELS_PROVENANCE[setup.labelSet],
                labelsFile: path.relative(path.resolve(EVAL_DIR, '..'), setup.labelsFile).replace(/\\/g, '/'),
                labelsSha256: sha256(setup.labelsText.replace(/\r\n/g, '\n')),
                cvs: selectedOf(setup).length,
                runs: results[setup.key],
                aggregate: aggregateOf(setup.key),
              },
            ]),
          ),
          notRun: skipped.map((setup) => ({ set: setup.key, reason: 'labels not filled in' })),
          note: 'Counts, character ranges, verdicts, tokens, latency and cost only. No key, prompt, reply, reason or quote is stored; passages can be rebuilt from the ranges and the CVs (contentSha256 identifies the text the ranges index). All four verdict-mode and match-mode combinations are scored from the same extraction.',
          definitions: {
            hit: 'A verified passage hits a gold passage of the same requirement in the same CV when their character ranges overlap by at least half of the shorter one ("half", the headline) or by at least one character ("any").',
            passageRecall: 'gold passages hit by at least one verified passage / gold passages',
            passagePrecision: 'verified passages that hit a gold passage / verified passages (a verified passage for a requirement with no gold passage is a miss)',
            fabricatedQuoteRate: 'quotes refused as not found in the CV / quotes proposed in a valid shape (refused-as-too-short and over-a-masked-detail are counted apart)',
            verdictAgreement: "requirements where the scored verdict equals the labeller's. model_checked: the model's verdict after the code's rules and the second opinion; matcher: the matcher alone judging the same verified passages",
            modelProposedAgreement: "the model's own verdicts against the labels, before the code lowered any (an unanswered requirement counts as unclear)",
            downgradeRate: 'verdicts the code lowered to unclear because no quoted passage was found in the CV / verdicts the model proposed',
            secondOpinion: "the matcher's verdict from the same verified passages against the model's enforced verdict: agree, one step apart (shown), two steps or more (the candidate is routed to a person and the score uses the lower verdict)",
            tierAgreement: "CVs where the tier from the scored verdicts equals the tier from the labeller's verdicts, by the application's own rule (before any routing to review)",
            goldThroughMatcher: "what the matching stage says when the labeller's own gold passages are the evidence: the matcher's disagreement with the labels before any model is involved",
          },
          prices: PRICES_SOURCE,
          run: { requests: totals.requests, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, costDollars: totalCost, perCvCost, latencyMs: latency },
          cvs: rows,
        },
        null,
        2,
      )}\n`,
    );
    line(`saved ${outPath}`);
  }

  return stopped ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.log(`UNEXPECTED FAILURE: ${safeMessage(err, process.env.ANTHROPIC_API_KEY ?? '')}`);
    process.exitCode = 1;
  },
);
