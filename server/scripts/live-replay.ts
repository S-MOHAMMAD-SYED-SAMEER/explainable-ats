import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../src/config/env.ts';
import { createDatabase } from '../src/db/index.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { createRepositories } from '../src/db/repositories/index.ts';
import { createAnthropicProvider } from '../src/adapters/llm/anthropic.ts';
import type { LlmProvider, LlmResponse } from '../src/adapters/llm/types.ts';
import { createJob, ingestResume } from '../src/agent/ingest.ts';
import { openEvaluation } from '../src/agent/extract.ts';
import { extractVerdicts } from '../src/agent/extractVerdicts.ts';
import { matchAndScore } from '../src/agent/match.ts';
import { parseExtractionPrompt } from '../src/agent/extractionPrompt.ts';
import { VERDICT_PROMPT_VERSION, VERDICT_PURPOSE } from '../src/agent/verdictExtraction.ts';
import { handleEvaluationDetail } from '../src/handlers/evaluations.ts';
import { loadCvText, loadDataset } from './evalLabels.ts';

// ONE LIVE REQUEST, RECORDED, AND A REPLAY OF IT THAT MAKES NONE.
//
//   ANTHROPIC_LIVE_TEST=1 env -u ANTHROPIC_API_KEY node --env-file=.env scripts/live-replay.ts --live --cv=cv-02 \
//       --save=../docs/results/replay-<date>-<cv>-<model>.json [--db=<file.sqlite>]
//   node scripts/live-replay.ts --replay=../docs/results/replay-....json [--db=<file.sqlite>]
//
// `--live` makes exactly ONE request to the model through the real adapter (retries off, no second attempt, stops on any error), runs
// the reply through the real pipeline in `model_checked` mode, and saves the reply (verdicts, reasons, quotes), the model, the settings
// and the date. `--replay` reads such a file and runs the same pipeline with a stand-in that answers with the saved reply: no key, no
// network, no cost. Both write into `--db` when it is given (a SQLite file the full application can then be started on, so a screenshot
// of the candidate page can be taken, and retaken, without another request) and into memory otherwise.
//
// The CV is an invented one from `eval/`. The saved reply therefore holds quotes from an invented CV and a model's one-line reasons:
// nothing about a real person. It holds no key and no prompt.

type Saved = {
  kind: 'recorded model reply';
  date: string;
  note: string;
  model: string;
  toolChoice: string;
  temperature: unknown;
  promptVersion: string;
  verdictMode: 'model_checked';
  matchMode: string;
  retries: 0;
  requestsMade: 1;
  cv: { id: string; role: string; chars: number; contentSha256: string };
  labelsProvenance: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  latencyMs: number;
  /** The reply by requirement label: what a replay answers with. */
  reply: { requirements: Array<{ label: string; verdict: unknown; passages: unknown; reason: unknown }> };
  /** The tool input exactly as the model returned it (its requirement ids are those of the run that made it). */
  rawOutput: Record<string, unknown>;
};

function line(text: string): void {
  console.log(text);
}

function argValue(name: string): string | undefined {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

async function main(): Promise<number> {
  const live = process.argv.includes('--live');
  const replayPath = argValue('--replay');
  const savePath = argValue('--save');
  const dbPath = argValue('--db') ?? ':memory:';
  const cvId = argValue('--cv') ?? 'cv-02';
  if (live === (replayPath !== undefined)) {
    line('Give exactly one of --live and --replay=<file>.');
    return 1;
  }

  const dataset = loadDataset();
  const entry = dataset.cvs.find((candidate) => candidate.id === cvId);
  if (!entry) {
    line(`${cvId} is not in the evaluation set.`);
    return 1;
  }
  const role = dataset.roles[entry.role]!;
  const cvText = loadCvText(entry);

  let saved: Saved | null = null;
  let provider: LlmProvider;
  const capture: { response: LlmResponse | null; requests: number } = { response: null, requests: 0 };

  if (live) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey === undefined || apiKey.trim() === '' || process.env.ANTHROPIC_LIVE_TEST !== '1') {
      line('SKIPPED: set ANTHROPIC_API_KEY and ANTHROPIC_LIVE_TEST=1 to run. No request was made.');
      return 0;
    }
    if (!savePath) {
      line('--live needs --save=<file>, so the reply is kept.');
      return 1;
    }
    const real = createAnthropicProvider({
      apiKey,
      model: config.anthropicModel,
      timeoutMs: Math.max(config.anthropicTimeoutMs, 120_000),
      maxRetries: 0,
      toolChoice: config.anthropicToolChoice,
      ...(config.anthropicTemperature === null ? {} : { temperature: config.anthropicTemperature }),
    });
    provider = {
      name: real.name,
      configured: real.configured,
      async complete(request) {
        capture.requests += 1;
        if (capture.requests > 1) throw new Error('Exactly one request is allowed.');
        const response = await real.complete(request);
        capture.response = response;
        return response;
      },
    };
    line(`model ${config.anthropicModel}, tool choice ${config.anthropicToolChoice}, temperature ${config.anthropicTemperature ?? 'not sent'}, prompt ${VERDICT_PROMPT_VERSION}, match mode ${config.matchMode}, retries 0`);
    line(`ONE request for ${cvId} (${cvText.length} characters). Nothing else will be sent.`);
  } else {
    saved = JSON.parse(fs.readFileSync(replayPath!, 'utf8')) as Saved;
    if (saved.cv.id !== cvId && argValue('--cv') !== undefined) throw new Error(`The saved reply is for ${saved.cv.id}, not ${cvId}.`);
    // Its own provider, with its own name, and a model id that says what it is: `replay:<model>:<date>`. It is NOT the mock, so the
    // app's history line says "Replayed from a saved <model> reply (<date>), no new request" and never "Deterministic demo extraction".
    const replayModel = `replay:${saved.model}:${saved.date}`;
    provider = {
      name: 'replay',
      configured: true,
      async complete(request) {
        if (request.purpose !== VERDICT_PURPOSE) throw new Error(`The replay holds only the ${VERDICT_PURPOSE} reply.`);
        const parsed = parseExtractionPrompt(request.messages[0]!.content);
        const byLabel = new Map(saved!.reply.requirements.map((item) => [item.label, item]));
        return {
          output: {
            requirements: parsed.requirements.flatMap((requirement) => {
              const item = byLabel.get(requirement.label);
              return item ? [{ requirementId: requirement.id, verdict: item.verdict, passages: item.passages, reason: item.reason }] : [];
            }),
          },
          model: replayModel,
          latencyMs: 0,
        };
      },
    };
    line(`REPLAY of ${path.basename(replayPath!)} (${saved.model}, ${saved.date}). No request is made.`);
  }

  // --- the pipeline, on a file database the full application can open --------------------------------------------------------
  if (dbPath !== ':memory:' && fs.existsSync(dbPath)) fs.rmSync(dbPath);
  const db = await createDatabase({ ...config, dbDriver: 'sqlite', databaseUrl: null, sqlitePath: dbPath });
  try {
    await runMigrations(db, config.migrationsDir);
    const repos = createRepositories(db);
    const { job, requirements } = await createJob({ repos }, { title: role.title, seniority: 'senior', description: role.description, requirements: role.requirements.map((r) => ({ label: r.label, criterion: r.criterion, kind: r.kind, weight: r.weight })) }, 'replay');
    const ingested = await ingestResume({ repos }, { reference: entry.id, displayName: entry.displayName, text: cvText, source: 'manual' });
    const evaluation = await openEvaluation({ repos }, { jobId: job.id, candidateId: ingested.candidate.id, resume: ingested.resume });

    let failed: string | null = null;
    try {
      await extractVerdicts({ repos, provider }, evaluation.id);
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err);
    }

    if (live) {
      const response = capture.response as LlmResponse | null;
      if (failed !== null || response === null) {
        line(`STOPPED: the request did not give a usable reply (${failed ?? 'no reply'}). It was not retried.`);
        return 1;
      }
      const labelOf = new Map(requirements.map((requirement) => [requirement.id, requirement.label]));
      const list = Array.isArray(response.output.requirements) ? (response.output.requirements as Array<Record<string, unknown>>) : [];
      saved = {
        kind: 'recorded model reply',
        date: new Date().toISOString().slice(0, 10),
        note: 'One live request on an invented CV from eval/. The reply is kept so a screenshot can be replayed with `scripts/live-replay.ts --replay=<this file>`, with no request. It holds the model\'s verdicts, one-line reasons and quotes from the invented CV; no key, no prompt.',
        model: response.model,
        toolChoice: config.anthropicToolChoice,
        temperature: config.anthropicTemperature ?? 'unset (not sent)',
        promptVersion: VERDICT_PROMPT_VERSION,
        verdictMode: 'model_checked',
        matchMode: config.matchMode,
        retries: 0,
        requestsMade: 1,
        cv: { id: entry.id, role: entry.role, chars: cvText.length, contentSha256: crypto.createHash('sha256').update(ingested.resume.contentText).digest('hex') },
        labelsProvenance: 'not applicable: this run is for a screenshot and was not scored against the evaluation labels',
        usage: response.usage ?? null,
        latencyMs: response.latencyMs,
        reply: {
          requirements: list.map((item) => ({ label: labelOf.get(String(item.requirementId)) ?? String(item.requirementId), verdict: item.verdict, passages: item.passages, reason: item.reason })),
        },
        rawOutput: response.output,
      };
      fs.mkdirSync(path.dirname(path.resolve(savePath!)), { recursive: true });
      fs.writeFileSync(savePath!, `${JSON.stringify(saved, null, 2)}\n`);
      line(`saved ${savePath}`);
      line(`tokens ${response.usage?.inputTokens ?? 'n/a'} in / ${response.usage?.outputTokens ?? 'n/a'} out, ${response.latencyMs} ms`);
    } else if (failed !== null) {
      line(`The replay failed: ${failed}`);
      return 1;
    }

    const scored = await matchAndScore({ repos, matchMode: config.matchMode, verdictMode: 'model_checked' }, evaluation.id);
    const detail = (await handleEvaluationDetail({ repos }, evaluation.id)).body;
    line(`score ${detail.scorePercent} (${scored.breakdown.scoreBasisPoints}), tier ${detail.tier}, routed to review: ${detail.needsReview}, evaluation ${evaluation.id}`);
    line(`extraction recorded as: ${detail.model ?? 'n/a'}`);
    for (const requirement of detail.requirements) {
      const check = requirement.check;
      line(`- ${requirement.label} [${requirement.kind}]: ${requirement.verdict}  (model: ${check?.modelVerdict ?? 'n/a'}; matcher: ${check?.matcherVerdict ?? 'n/a'}; disagreement: ${check?.disagreement ?? 'n/a'}; quote shares no words: ${check?.quoteNoOverlap ?? 'n/a'})`);
      line(`    reason: ${check?.modelReason ?? '(none)'}`);
      for (const quote of requirement.evidence) line(`    quote: ${JSON.stringify(quote.quote.slice(0, 110))}`);
    }
    if (dbPath !== ':memory:') line(`database: ${dbPath}`);
    return 0;
  } finally {
    await db.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    line(`FAILED: ${(err instanceof Error ? err.message : String(err)).split(process.env.ANTHROPIC_API_KEY ?? '\u0000').join('[redacted]').slice(0, 300)}`);
    process.exitCode = 1;
  },
);
