import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config/env.ts';
import { createAnthropicProvider } from '../src/adapters/llm/anthropic.ts';
import type { LlmProvider } from '../src/adapters/llm/types.ts';
import { createJob, ingestResume } from '../src/agent/ingest.ts';
import { extractEvidence, openEvaluation } from '../src/agent/extract.ts';
import { EXTRACTION_PROMPT_VERSION } from '../src/agent/extractionSchema.ts';
import { MATCH_MODES, type MatchMode } from '../src/agent/matchRules.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { createTestContext } from '../test/helpers.ts';
import { EVAL_DIR, LABELS_PROVENANCE, loadCvText, loadDataset, parseCsv, provenanceFor, splitPassages, type LabelVerdict } from './evalLabels.ts';
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

// OPT-IN LIVE EVALUATION OF THE EXTRACTION AND MATCHING STAGES — by hand, never in CI.
//
//   ANTHROPIC_LIVE_TEST=1 ANTHROPIC_MODEL=<id> [ANTHROPIC_TOOL_CHOICE=forced] [ANTHROPIC_TEMPERATURE=0] \
//     env -u ANTHROPIC_API_KEY node --env-file=.env scripts/eval-harness.ts --out=../docs/results/<file>.json
//   node scripts/eval-harness.ts --dry          prints the plan and cost estimate, makes no request, needs no key
//   node scripts/eval-harness.ts --oracle       runs the whole pipeline with a stand-in that quotes the gold
//                                               passages exactly: free, and checks the harness itself
//
// ONE REAL REQUEST PER CV (twenty), through the real adapter and the real pipeline. Retries are off,
// so the request count is exact. It never loops, and it stops at once on a refused request (bad key,
// no credit, a setting), on a 401, 402, 403 or 429, after two outages in a row, or when the next
// request could take total spend past the budget.
//
// THE EXTRACTION IS RUN ONCE PER CV. The matching mode only changes how words are compared after the
// model has answered, so `strict` and `folded` are both scored from the same recorded extraction: no
// extra request, and the two modes differ only by the matcher.
//
// WHAT IS SAVED: counts, character ranges, verdicts, tokens, latency and cost. Never the key, a
// prompt, a reply or a quote (the passages can be rebuilt from the ranges and the invented CVs).

const BUDGET_DEFAULT = 2.5;
// What the project has spent before this run, from the ledger in the progress notes (2026-10-15).
const PRIOR_SPEND_DEFAULT = 0.4;
// Used only for the estimate printed before a run, never for a figure that is reported.
const ASSUMED_OUTPUT_TOKENS_PER_CV: Record<string, number> = { 'claude-haiku-4-5-20251001': 250, 'claude-sonnet-5-5': 1250 };
const PROMPT_OVERHEAD_TOKENS = 900;

type ModeResult = {
  matchMode: MatchMode;
  passage: Record<'half' | 'any', ReturnType<typeof passageMetrics>>;
  verdictAgreement: ReturnType<typeof verdictAgreement>;
  tierAgreement: ReturnType<typeof tierAgreement>;
};

type RequirementRow = {
  requirementId: string;
  label: string;
  goldVerdict: LabelVerdict;
  goldSpans: Span[];
  verifiedSpans: Span[];
  verdict: Record<MatchMode, LabelVerdict>;
};

type CvRow = {
  id: string;
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
  findingsReturned: number | null;
  proposedValidShape: number | null;
  verified: number | null;
  refusedNotInCv: number | null;
  refusedTooShort: number | null;
  refusedOverMask: number | null;
  malformedDropped: number | null;
  requirements: RequirementRow[];
  tier: Record<MatchMode, string> & { gold: string };
};

function line(text = ''): void {
  console.log(text);
}

function safeMessage(err: unknown, secret: string): string {
  const text = err instanceof Error ? err.message : 'unknown error';
  return secret === '' ? text.slice(0, 300) : text.split(secret).join('[redacted]').slice(0, 300);
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Whether a failure is one that must stop the run at once: a refused request, or a 401, 402, 403 or 429. */
function mustStopNow(result: string, label: string | null): boolean {
  if (result === 'rejected') return true;
  return label !== null && /\bHTTP (401|402|403|429)\b|credit|billing/i.test(label);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const oracle = args.includes('--oracle');
  const showFabricated = args.includes('--show-fabricated');
  const argValue = (name: string): string | null => args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) ?? null;
  const outPath = argValue('--out');
  const only = argValue('--cvs')?.split(',') ?? null;
  const budget = Number(argValue('--budget') ?? BUDGET_DEFAULT);
  const priorSpend = Number(argValue('--prior-spend') ?? PRIOR_SPEND_DEFAULT);

  const dataset = loadDataset();
  const labelsFile = path.join(EVAL_DIR, 'labels_TODO.csv');
  const labelsText = fs.readFileSync(labelsFile, 'utf8');
  const labelRows = parseCsv(labelsText).slice(1);
  const labelFor = new Map(
    labelRows.map((cells) => [`${cells[0]?.trim()}\u0000${cells[1]?.trim()}`, { passages: splitPassages(cells[2] ?? ''), verdict: (cells[3] ?? '').trim() as LabelVerdict }]),
  );

  const selected = dataset.cvs.filter((cv) => only === null || only.includes(cv.id) || only.includes(cv.id.replace('cv-', '')));
  const model = oracle ? 'oracle (gold passages)' : config.anthropicModel;
  const temperature = config.anthropicTemperature === null ? 'unset (not sent)' : String(config.anthropicTemperature);

  // --- the plan, printed before anything is spent ---------------------------------------------------------
  const estimatedInput = selected.reduce((sum, cv) => sum + Math.ceil(loadCvText(cv).length / 4) + PROMPT_OVERHEAD_TOKENS, 0);
  const assumedOutputPerCv = ASSUMED_OUTPUT_TOKENS_PER_CV[config.anthropicModel] ?? 1250;
  const estimatedOutput = selected.length * assumedOutputPerCv;
  const estimatedCost = oracle ? 0 : costOf(config.anthropicModel, { inputTokens: estimatedInput, outputTokens: estimatedOutput });

  line(`== evaluation ${dataset.version}: ${selected.length} of ${dataset.cvs.length} CVs ==`);
  line(`model            : ${model}`);
  line(`tool choice      : ${config.anthropicToolChoice}    temperature: ${temperature}    prompt: ${EXTRACTION_PROMPT_VERSION}    retries: 0`);
  line(`match modes      : ${MATCH_MODES.join(' and ')} (both scored from the same extraction)`);
  line(`labels           : ${LABELS_PROVENANCE.main}`);
  line(`expected requests: ${oracle ? 0 : selected.length}`);
  line(
    `expected cost    : ${estimatedCost === null ? 'unknown (no recorded price for this model)' : formatDollars(estimatedCost)}` +
      ` (estimate: about ${estimatedInput.toLocaleString('en')} input and ${estimatedOutput.toLocaleString('en')} output tokens; ${PRICES_SOURCE})`,
  );
  line(`spend limit      : ${formatDollars(budget)} for the whole project; spent before this run ${formatDollars(priorSpend)}`);

  if (dry) {
    line('DRY RUN: no request was made.');
    return 0;
  }

  // --- the key: where it comes from, shown without being shown ---------------------------------------------
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
  const pairsByMode: Record<MatchMode, Array<{ gold: LabelVerdict; predicted: LabelVerdict }>> = { strict: [], folded: [] };
  const pairRecords: PairRecord[] = [];
  const tiersByMode: Record<MatchMode, Array<{ gold: ReturnType<typeof tierOfVerdicts>; predicted: ReturnType<typeof tierOfVerdicts> }>> = { strict: [], folded: [] };
  const goldMatcherPairs: Record<MatchMode, Array<{ gold: LabelVerdict; predicted: LabelVerdict }>> = { strict: [], folded: [] };
  const goldMatcherTiers: Record<MatchMode, Array<{ gold: ReturnType<typeof tierOfVerdicts>; predicted: ReturnType<typeof tierOfVerdicts> }>> = { strict: [], folded: [] };

  let spent = 0;
  let outages = 0;
  let stopped: string | null = null;

  for (const cv of selected) {
    if (!oracle && priorSpend + spent + 0.05 > budget) {
      stopped = `the next request could take total spend past ${formatDollars(budget)}`;
      break;
    }

    const role = dataset.roles[cv.role];
    if (!role) throw new Error(`${cv.id}: unknown role ${cv.role}`);
    const text = loadCvText(cv);

    const ctx = await createTestContext({ idPrefix: cv.id });
    const { logger, entries } = createMemoryLogger(cv.id);
    const { job, requirements } = await createJob({ repos: ctx.repos }, { title: role.title, seniority: 'senior', description: role.description, requirements: role.requirements.map((entry) => ({ label: entry.label, criterion: entry.criterion, kind: entry.kind, weight: entry.weight })) });
    const ingested = await ingestResume({ repos: ctx.repos }, { reference: cv.id, displayName: null, text, source: 'manual' });
    const evaluation = await openEvaluation({ repos: ctx.repos }, { jobId: job.id, candidateId: ingested.candidate.id, resume: ingested.resume });
    const content = ingested.resume.contentText;

    // The stored requirement for each dataset requirement (matched on the label, unique within a role).
    const stored = new Map(role.requirements.map((entry) => [entry.id, requirements.find((requirement) => requirement.label === entry.label)]));
    for (const [id, requirement] of stored) if (!requirement) throw new Error(`${cv.id}: requirement ${id} was not stored`);

    // Gold passages and verdicts, located in the stored text.
    const gold = role.requirements.map((entry) => {
      const label = labelFor.get(`${cv.id}\u0000${entry.id}`);
      if (!label) throw new Error(`${cv.id} / ${entry.id}: no label`);
      const spans = label.passages.map((passage) => {
        const span = locatePassage(passage, content);
        if (!span) throw new Error(`${cv.id} / ${entry.id}: a gold passage cannot be found in the CV (run validate-labels.ts)`);
        return span;
      });
      return { entry, requirement: stored.get(entry.id)!, label, spans };
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
              findings: gold.flatMap(({ requirement, spans }) =>
                spans.map((span) => ({ requirementId: requirement.id, quote: content.slice(span.start, span.end), charStart: span.start, charEnd: span.end, reasoning: 'gold' })),
              ),
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
      await extractEvidence({ repos: ctx.repos, provider, logger }, evaluation.id);
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
    const verifiedEvent = events.find((event) => event.eventType === 'evidence_verified');
    const refusal = events.find((event) => event.eventType === 'unverifiable_evidence_rejected');
    const reasons = Array.isArray(refusal?.payload.reasons) ? (refusal?.payload.reasons as string[]) : [];
    const dropped = events.find((event) => event.eventType === 'malformed_findings_dropped');
    const droppedReasons = Array.isArray(dropped?.payload.reasons) ? (dropped?.payload.reasons as string[]) : [];

    if (showFabricated && extracted) {
      const all = await ctx.repos.evidence.listForEvaluation(evaluation.id);
      for (const entry of all.filter((item) => !item.verified)) line(`  refused quote: ${JSON.stringify(entry.quote.slice(0, 90))}`);
    }

    // Verdicts: from the verified passages, in each mode; and from the gold passages, for the ceiling.
    const requirementRows: RequirementRow[] = [];
    const verdictsByMode: Record<MatchMode, Map<string, LabelVerdict>> = { strict: new Map(), folded: new Map() };
    const goldVerdicts = new Map<string, LabelVerdict>();
    for (const { entry, requirement, label, spans } of gold) {
      const mine = verifiedRows.filter((row) => row.requirementId === requirement.id);
      const verdict = {} as Record<MatchMode, LabelVerdict>;
      for (const mode of MATCH_MODES) {
        verdict[mode] = verdictFromQuotes(requirement, mine.map((row) => row.quote), mode);
        verdictsByMode[mode].set(requirement.id, verdict[mode]);
        pairsByMode[mode].push({ gold: label.verdict, predicted: verdict[mode] });
      }
      goldVerdicts.set(requirement.id, label.verdict);
      const verifiedSpans = mine.map((row) => ({ start: row.charStart, end: row.charEnd }));
      pairRecords.push({ cvId: cv.id, requirementId: entry.id, goldVerdict: label.verdict, goldSpans: spans, verifiedSpans });
      requirementRows.push({ requirementId: entry.id, label: entry.label, goldVerdict: label.verdict, goldSpans: spans, verifiedSpans, verdict });
    }

    const requirementList = gold.map((item) => item.requirement);
    const goldTier = tierOfVerdicts(requirementList, goldVerdicts);
    const tier = { gold: goldTier } as CvRow['tier'];
    for (const mode of MATCH_MODES) {
      tier[mode] = tierOfVerdicts(requirementList, verdictsByMode[mode]);
      tiersByMode[mode].push({ gold: goldTier, predicted: tier[mode] as ReturnType<typeof tierOfVerdicts> });

      // The matcher alone: the labeller's passages as the evidence.
      const goldQuotes = new Map(gold.map(({ requirement, spans }) => [requirement.id, spans.map((span) => content.slice(span.start, span.end))]));
      const ceiling = verdictsFromGoldPassages(requirementList, goldQuotes, mode);
      for (const { requirement, label } of gold) goldMatcherPairs[mode].push({ gold: label.verdict, predicted: ceiling.get(requirement.id) as LabelVerdict });
      goldMatcherTiers[mode].push({ gold: goldTier, predicted: tierOfVerdicts(requirementList, ceiling) });
    }

    const row: CvRow = {
      id: cv.id,
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
      findingsReturned: record?.findingsReturned ?? null,
      proposedValidShape: extracted ? Number(verifiedEvent?.payload.verified ?? 0) + Number(verifiedEvent?.payload.rejected ?? 0) : null,
      verified: extracted ? verifiedRows.length : null,
      refusedNotInCv: extracted ? reasons.filter((reason) => reason === 'not_found_in_resume').length : null,
      refusedTooShort: extracted ? reasons.filter((reason) => reason === 'quote_too_short').length : null,
      refusedOverMask: extracted ? reasons.filter((reason) => reason === 'quotes_redacted_text').length : null,
      malformedDropped: extracted ? droppedReasons.length : null,
      requirements: requirementRows,
      tier,
    };
    rows.push(row);

    if (!oracle && JSON.stringify([entries, events, after, record]).includes(apiKey)) {
      line('STOPPED: the API key reached a log, the audit trail or a record.');
      return 1;
    }
    await ctx.close();

    const agree = (mode: MatchMode): string => `${requirementRows.filter((r) => r.verdict[mode] === r.goldVerdict).length}/${requirementRows.length}`;
    line(
      `${cv.id} (${role.title.split(' ')[0]}, ${content.length} chars): ${row.result}` +
        (row.failureLabel ? ` [${row.failureLabel}]` : '') +
        `  ${row.inputTokens ?? '-'} in / ${row.outputTokens ?? '-'} out, ${row.latencyMs ?? '-'} ms, ${cost === null ? '-' : formatDollars(cost)}` +
        `  quotes ${row.proposedValidShape ?? '-'} proposed, ${row.verified ?? '-'} verified, ${row.refusedNotInCv ?? '-'} not in CV` +
        `  verdicts strict ${agree('strict')} folded ${agree('folded')}  tier gold ${goldTier} / strict ${tier.strict} / folded ${tier.folded}`,
    );

    if (!oracle) {
      if (mustStopNow(row.result, row.failureLabel)) {
        stopped = `the service refused a request (${row.failureLabel ?? row.result}): a key, credit, rate-limit or configuration problem, not something to retry`;
        break;
      }
      outages = row.result === 'unavailable' ? outages + 1 : 0;
      if (outages >= 2) {
        stopped = 'two requests in a row did not get an answer';
        break;
      }
    }
  }

  // --- the numbers -------------------------------------------------------------------------------------------
  const totals = rows.reduce(
    (sum, row) => ({ requests: sum.requests + row.requests, inputTokens: sum.inputTokens + (row.inputTokens ?? 0), outputTokens: sum.outputTokens + (row.outputTokens ?? 0) }),
    { requests: 0, inputTokens: 0, outputTokens: 0 },
  );
  const totalCost = oracle ? 0 : costOf(config.anthropicModel, { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens });
  const succeeded = rows.filter((row) => row.result === 'succeeded');
  const proposed = succeeded.reduce((sum, row) => sum + (row.proposedValidShape ?? 0), 0);
  const notInCv = succeeded.reduce((sum, row) => sum + (row.refusedNotInCv ?? 0), 0);
  const tooShort = succeeded.reduce((sum, row) => sum + (row.refusedTooShort ?? 0), 0);
  const overMask = succeeded.reduce((sum, row) => sum + (row.refusedOverMask ?? 0), 0);
  const verifiedTotal = succeeded.reduce((sum, row) => sum + (row.verified ?? 0), 0);
  const fabricatedRate = proposed === 0 ? null : notInCv / proposed;
  const latency = summarise(rows.map((row) => row.latencyMs).filter((value): value is number => value !== null));
  const perCvCost = summarise(rows.map((row) => row.costDollars).filter((value): value is number => value !== null));

  const results = {} as Record<MatchMode, ModeResult>;
  const goldThroughMatcher = {} as Record<MatchMode, { verdictAgreement: ReturnType<typeof verdictAgreement>; tierAgreement: ReturnType<typeof tierAgreement> }>;
  for (const mode of MATCH_MODES) {
    results[mode] = {
      matchMode: mode,
      passage: { half: passageMetrics(pairRecords, 'half'), any: passageMetrics(pairRecords, 'any') },
      verdictAgreement: verdictAgreement(pairsByMode[mode]),
      tierAgreement: tierAgreement(tiersByMode[mode]),
    };
    goldThroughMatcher[mode] = { verdictAgreement: verdictAgreement(goldMatcherPairs[mode]), tierAgreement: tierAgreement(goldMatcherTiers[mode]) };
  }

  line();
  line(`== results: ${model}, ${rows.length} CVs, ${pairRecords.length} requirement rows ==`);
  if (stopped) line(`STOPPED EARLY: ${stopped}`);
  line(`requests ${totals.requests}; tokens ${totals.inputTokens.toLocaleString('en')} in / ${totals.outputTokens.toLocaleString('en')} out; cost ${totalCost === null ? 'unknown' : formatDollars(totalCost)}; latency mean ${latency.mean === null ? 'n/a' : Math.round(latency.mean)} ms, median ${latency.median ?? 'n/a'} ms, max ${latency.max ?? 'n/a'} ms`);
  line(`extractions: ${succeeded.length} of ${rows.length} succeeded` + (succeeded.length < rows.length ? `; failed: ${rows.filter((r) => r.result !== 'succeeded').map((r) => `${r.id} ${r.result}`).join(', ')}` : ''));
  line(`quotes: ${proposed} proposed in a valid shape, ${verifiedTotal} verified, refused ${notInCv} not in the CV / ${tooShort} too short / ${overMask} over a masked detail; fabricated-quote rate ${percent(fabricatedRate)} (${notInCv}/${proposed})`);
  for (const mode of MATCH_MODES) {
    const result = results[mode];
    const half = result.passage.half;
    const any = result.passage.any;
    line(`-- ${mode} --`);
    line(`passage recall    : ${percent(half.recall)} (${half.goldPassagesHit}/${half.goldPassages} gold passages; any-overlap ${percent(any.recall)})   requirements with gold hit: ${half.requirementsWithGoldHit}/${half.requirementsWithGold}`);
    line(`passage precision : ${percent(half.precision)} (${half.verifiedPassagesHit}/${half.verifiedPassages} verified passages; any-overlap ${percent(any.precision)})`);
    line(`verdict agreement : ${percent(result.verdictAgreement.rate)} (${result.verdictAgreement.agree}/${result.verdictAgreement.rows}); pipeline higher than gold ${result.verdictAgreement.higherThanGold}, lower ${result.verdictAgreement.lowerThanGold}`);
    line(`tier agreement    : ${percent(result.tierAgreement.rate)} (${result.tierAgreement.agree}/${result.tierAgreement.cvs})`);
    line(`  [matcher alone, gold passages as the evidence] verdicts ${percent(goldThroughMatcher[mode].verdictAgreement.rate)}, tiers ${percent(goldThroughMatcher[mode].tierAgreement.rate)}`);
  }

  if (outPath) {
    const file = path.resolve(outPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          kind: 'extraction and matching evaluation',
          date: new Date().toISOString().slice(0, 10),
          model: oracle ? 'oracle (the labeller\'s gold passages quoted exactly; not a model)' : config.anthropicModel,
          toolChoice: oracle ? 'n/a' : config.anthropicToolChoice,
          temperature: oracle ? 'n/a' : config.anthropicTemperature ?? 'unset (not sent: the model does not accept one)',
          promptVersion: EXTRACTION_PROMPT_VERSION,
          dataset: dataset.version,
          datasetDescription: `${dataset.cvs.length} invented CVs (${selected.length} run), 2 roles, ${pairRecords.length} requirement rows`,
          labelsFile: 'eval/labels_TODO.csv',
          labelsSha256: sha256(labelsText.replace(/\r\n/g, '\n')),
          // Who made the labels this run was scored against, in the exact words (see evalLabels.ts). Never omitted.
          labelsProvenance: provenanceFor(['main']),
          matchModes: [...MATCH_MODES],
          retries: 0,
          stoppedEarly: stopped,
          note: 'Counts, character ranges, verdicts, tokens, latency and cost only. No key, prompt, reply or quote is stored; passages can be rebuilt from the ranges and the CVs in eval/cvs/ (contentSha256 identifies the text the ranges index). Both match modes are scored from the same extraction.',
          definitions: {
            hit: 'A verified passage hits a gold passage of the same requirement in the same CV when their character ranges overlap by at least half of the shorter one ("half", the headline) or by at least one character ("any").',
            passageRecall: 'gold passages hit by at least one verified passage / gold passages',
            passagePrecision: 'verified passages that hit a gold passage / verified passages (a verified passage for a requirement with no gold passage is a miss)',
            fabricatedQuoteRate: 'quotes refused as not found in the CV / quotes proposed in a valid shape (refused-as-too-short and over-a-masked-detail are counted apart)',
            verdictAgreement: 'requirements where the pipeline\'s verdict equals the labeller\'s',
            tierAgreement: 'CVs where the tier from the pipeline\'s verdicts equals the tier from the labeller\'s verdicts, by the application\'s own rule',
            goldThroughMatcher: 'what the matching stage says when the labeller\'s own gold passages are the evidence: the matcher\'s disagreement with the labels before any model is involved',
          },
          prices: PRICES_SOURCE,
          run: { requests: totals.requests, inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, costDollars: totalCost, perCvCost, latencyMs: latency },
          extraction: { cvs: rows.length, succeeded: succeeded.length, quotesProposed: proposed, quotesVerified: verifiedTotal, refusedNotInCv: notInCv, refusedTooShort: tooShort, refusedOverMask: overMask, fabricatedQuoteRate: fabricatedRate },
          results,
          goldThroughMatcher,
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
