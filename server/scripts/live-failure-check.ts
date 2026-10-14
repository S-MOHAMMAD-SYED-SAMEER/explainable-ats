import { config } from '../src/config/env.ts';
import { createAnthropicProvider } from '../src/adapters/llm/anthropic.ts';
import type { LlmProvider } from '../src/adapters/llm/types.ts';
import { createJob, ingestResume } from '../src/agent/ingest.ts';
import { extractEvidence, openEvaluation } from '../src/agent/extract.ts';
import { matchAndScore } from '../src/agent/match.ts';
import { FAILURE_WORDING } from '../src/agent/failures.ts';
import { maxTokensFor } from '../src/agent/tokenBudget.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { createTestContext } from '../test/helpers.ts';

// OPT-IN LIVE CHECK OF THE FAILURE PATHS AND THE OUTPUT LIMIT — by hand, never in CI.
//
//   ANTHROPIC_LIVE_TEST=1 node scripts/live-failure-check.ts [--cases=truncated,timeout,long,empty]
//
// Not under `test/` and not named `*.test.ts`, so `node --test` never finds it. It runs
// only when ANTHROPIC_API_KEY is set and ANTHROPIC_LIVE_TEST is exactly "1".
//
// Four cases, ONE real request each, through the real adapter and the real pipeline:
//
//   truncated  the output limit is forced down to 200 tokens, so the answer is cut off.
//              Expected: a `truncated` failure with its own event and message.
//   timeout    the request timeout is 1 ms and there are no retries.
//              Expected: an `unavailable` failure (a timeout).
//   long       a CV of about 30,000 characters against eight requirements, with the
//              output limit the application itself computes. Expected: it completes, and
//              the output used sits inside the limit. This is the sizing check.
//   empty      a valid CV with nothing to do with the role. Reported, not asserted: the
//              model may quote nothing (flagged `extraction_empty`) or reach for something.
//
// IT PRINTS METADATA ONLY: kinds, counts, tokens, latency. Never the key, a CV, a prompt,
// a reply or a quote.

const ALL_CASES = ['truncated', 'timeout', 'long', 'empty'] as const;
type CaseName = (typeof ALL_CASES)[number];

const JOB = {
  title: 'Senior Backend Engineer',
  seniority: 'senior' as const,
  description: 'Owns a service end to end.',
  requirements: [
    { label: 'Node.js services', criterion: 'Has designed and shipped production Node.js services', kind: 'must_have' as const, weight: 3 },
    { label: 'PostgreSQL', criterion: 'Has run PostgreSQL migrations at scale', kind: 'must_have' as const, weight: 2 },
    { label: 'Mentoring', criterion: 'Has mentored junior engineers', kind: 'nice_to_have' as const, weight: 1 },
  ],
};

const LONG_JOB = {
  ...JOB,
  requirements: [
    ...JOB.requirements,
    { label: 'Kubernetes', criterion: 'Has operated services on Kubernetes in production', kind: 'nice_to_have' as const, weight: 1 },
    { label: 'Incident response', criterion: 'Has led the response to a production incident', kind: 'nice_to_have' as const, weight: 2 },
    { label: 'API design', criterion: 'Has designed public or internal HTTP APIs used by other teams', kind: 'must_have' as const, weight: 2 },
    { label: 'Testing', criterion: 'Has introduced or improved automated testing practices', kind: 'nice_to_have' as const, weight: 1 },
    { label: 'TypeScript', criterion: 'Has written substantial production code in TypeScript', kind: 'nice_to_have' as const, weight: 1 },
  ],
};

const SHORT_CV = [
  'Name: Quentin Ashgrove',
  'Email: quentin.ashgrove@example.invalid',
  'Phone: +1 555 010 0199',
  '',
  'SUMMARY',
  'Backend engineer with seven years building logistics software.',
  '',
  'EXPERIENCE',
  'Staff Engineer, Fabrikam Freight',
  'Designed and shipped a Node.js routing service that handles 90,000 shipment updates a day.',
  'Led the migration of the order database from a single PostgreSQL instance to a replicated cluster.',
  'Mentored four junior engineers through their first production releases.',
].join('\n');

// Invented, and unrelated to the role: a pastry chef.
const UNRELATED_CV = [
  'Name: Odette Marchbanks',
  'Email: odette.marchbanks@example.invalid',
  '',
  'SUMMARY',
  'Pastry chef with nine years in hotel kitchens.',
  '',
  'EXPERIENCE',
  'Head Pastry Chef, The Larkspur Hotel',
  'Ran a team of six producing laminated doughs, entremets and plated desserts for a 120-cover restaurant.',
  'Redesigned the dessert menu each season and cut ingredient waste by a fifth.',
  'Trained four apprentices through their first service.',
].join('\n');

/** About 30,000 characters of invented, plausible work history. Deterministic. */
function longCv(): string {
  const employers = ['Fabrikam Freight', 'Contoso Logistics', 'Northwind Traders', 'Adventure Works', 'Tailspin Systems', 'Litware Labs'];
  const themes = [
    'a Node.js service that tracks shipment updates and fans them out to partner systems',
    'a PostgreSQL migration from a single instance to a replicated cluster with no downtime',
    'an HTTP API used by six internal teams, versioned and documented',
    'a Kubernetes rollout that moved twelve services off virtual machines',
    'the response to a production incident that took the order system down for forty minutes',
    'a testing programme that took the suite from twenty minutes to six',
    'a TypeScript rewrite of a legacy JavaScript module of about forty thousand lines',
    'onboarding and mentoring junior engineers through their first production releases',
  ];
  const lines: string[] = ['Name: Quentin Ashgrove', 'Email: quentin.ashgrove@example.invalid', 'Phone: +1 555 010 0199', '', 'EXPERIENCE'];
  let year = 2024;
  for (let i = 0; lines.join('\n').length < 30_000; i += 1) {
    const employer = employers[i % employers.length] as string;
    lines.push('', `Engineer, ${employer} (${year - 1}-${year})`);
    for (let j = 0; j < 6; j += 1) {
      const theme = themes[(i + j) % themes.length] as string;
      lines.push(`Worked on ${theme}; contributed design notes, code review and a written post-mortem, project ${i}.${j}.`);
      lines.push(`Collaborated with product, support and operations on ${theme}, tracking progress weekly and reporting results to leadership.`);
    }
    year -= 1;
  }
  return lines.join('\n');
}

type Row = { name: string; pass: boolean };

function line(text: string): void {
  console.log(text);
}

function safeMessage(err: unknown, secret: string): string {
  const text = err instanceof Error ? err.message : 'unknown error';
  return text.split(secret).join('[redacted]').slice(0, 300);
}

async function runCase(name: CaseName, apiKey: string): Promise<Row[]> {
  const ctx = await createTestContext({ idPrefix: `live-${name}` });
  const { logger, entries } = createMemoryLogger(`live-${name}`);
  const rows: Row[] = [];

  const timeoutMs = name === 'timeout' ? 1 : Math.max(config.anthropicTimeoutMs, name === 'long' ? 180_000 : 0);
  const real = createAnthropicProvider({
    apiKey,
    model: config.anthropicModel,
    timeoutMs,
    maxRetries: 0,
    toolChoice: config.anthropicToolChoice,
    ...(config.anthropicTemperature === null ? {} : { temperature: config.anthropicTemperature }),
    logger,
  });

  let requests = 0;
  const provider: LlmProvider = {
    name: real.name,
    configured: real.configured,
    async complete(request) {
      requests += 1;
      if (requests > 1) throw new Error('Each case makes exactly one request.');
      return real.complete(request);
    },
  };

  const cv = name === 'empty' ? UNRELATED_CV : name === 'long' ? longCv() : SHORT_CV;
  const { job, requirements } = await createJob({ repos: ctx.repos }, name === 'long' ? LONG_JOB : JOB);
  const ingested = await ingestResume({ repos: ctx.repos }, { reference: `live-${name}`, displayName: null, text: cv, source: 'manual' });
  const evaluation = await openEvaluation({ repos: ctx.repos }, { jobId: job.id, candidateId: ingested.candidate.id, resume: ingested.resume });

  const sized = maxTokensFor({ requirementCount: requirements.length, resumeChars: ingested.resume.redactedText.length });
  const started = performance.now();
  let threw = false;
  try {
    await extractEvidence(
      { repos: ctx.repos, provider, logger, ...(name === 'truncated' ? { maxTokens: 200 } : {}) },
      evaluation.id,
    );
  } catch {
    threw = true;
  }
  const wallMs = Math.round(performance.now() - started);

  const after = await ctx.repos.evaluations.getById(evaluation.id);
  const record = await ctx.repos.evaluationRecords.getForEvaluation(evaluation.id);
  const events = (await ctx.repos.audit.listForCorrelation(evaluation.id)).map((event) => event.eventType);
  const usage = record && record.inputTokens !== null ? `${record.inputTokens} in / ${record.outputTokens} out` : 'not reported';

  line(`--- case: ${name} (${config.anthropicModel}) ---`);
  line(`requests made    : ${requests}`);
  line(`cv characters    : ${cv.length} (redacted copy ${ingested.resume.redactedText.length}), requirements ${requirements.length}`);
  line(`output limit     : ${record?.maxTokens ?? sized}${name === 'truncated' ? ' (forced)' : ` (computed; fixed 2048 before)`}`);
  line(`result           : ${record?.result ?? 'no record'}   evaluation: ${after?.status}`);
  line(`tokens           : ${usage}   latency ${record?.latencyMs ?? 'n/a'} ms (wall ${wallMs} ms)`);
  line(`audit events     : ${events.filter((type) => type.startsWith('extraction')).join(', ') || 'none'}`);

  if (name === 'truncated') {
    rows.push({ name: 'a cut-off answer is a truncated failure', pass: record?.result === 'truncated' && after?.status === 'failed' });
    rows.push({ name: 'its own event and message', pass: events.includes(FAILURE_WORDING.truncated.eventType) && after?.failureReason === FAILURE_WORDING.truncated.message });
    rows.push({ name: 'the usage of the cut-off reply was kept', pass: record?.outputTokens !== null && record?.outputTokens !== undefined && record.outputTokens > 0 });
    rows.push({ name: 'no evidence and no score exist', pass: (await ctx.repos.evidence.count()) === 0 && after?.scoreBasisPoints === null });
  } else if (name === 'timeout') {
    rows.push({ name: 'a timeout is an unavailable failure', pass: record?.result === 'unavailable' && after?.status === 'failed' });
    rows.push({ name: 'its own event and message', pass: events.includes(FAILURE_WORDING.unavailable.eventType) && after?.failureReason === FAILURE_WORDING.unavailable.message });
  } else if (name === 'long') {
    let scored = false;
    try {
      await matchAndScore({ repos: ctx.repos }, evaluation.id);
      scored = true;
    } catch {
      scored = false;
    }
    const used = record?.outputTokens ?? null;
    const limit = record?.maxTokens ?? sized;
    line(`headroom         : ${used === null ? 'n/a' : `${used} of ${limit} output tokens used (${Math.round((used / limit) * 100)}%)`}`);
    rows.push({ name: 'the long job completed (no cut-off, no failure)', pass: !threw && record?.result === 'succeeded' });
    rows.push({ name: 'the output used sits inside the limit', pass: used !== null && used < limit });
    rows.push({ name: 'match-and-score ran', pass: scored });
  } else {
    const flagged = events.includes('extraction_empty');
    line(`model quoted     : ${record?.findingsReturned ?? 'n/a'} passage(s); extraction_empty ${flagged ? 'raised' : 'not raised'}`);
    rows.push({ name: 'the run completed', pass: !threw && record?.result === 'succeeded' });
    rows.push({ name: 'the empty flag agrees with the record', pass: flagged === (record?.findingsReturned === 0) });
  }

  const leaked = JSON.stringify([entries, events, after, record]).includes(apiKey);
  rows.push({ name: 'API key absent from logs, audit trail and records', pass: !leaked });

  await ctx.close();
  return rows;
}

async function main(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '' || process.env.ANTHROPIC_LIVE_TEST !== '1') {
    line('SKIPPED: set ANTHROPIC_API_KEY and ANTHROPIC_LIVE_TEST=1 to run. No request was made.');
    return 0;
  }

  const arg = process.argv.find((value) => value.startsWith('--cases='));
  const wanted = arg ? arg.slice('--cases='.length).split(',') : [...ALL_CASES];
  const cases = ALL_CASES.filter((name) => wanted.includes(name));

  line(`model ${config.anthropicModel}, tool choice ${config.anthropicToolChoice}, temperature ${config.anthropicTemperature ?? 'not sent'}`);
  line(`cases: ${cases.join(', ')} (${cases.length} request${cases.length === 1 ? '' : 's'})`);

  let failed = 0;
  for (const name of cases) {
    let rows: Row[];
    try {
      rows = await runCase(name, apiKey);
    } catch (err) {
      line(`case ${name}: UNEXPECTED FAILURE: ${safeMessage(err, apiKey)}`);
      failed += 1;
      continue;
    }
    for (const row of rows) {
      line(`${row.pass ? 'PASS' : 'FAIL'}  ${row.name}`);
      if (!row.pass) failed += 1;
    }
  }
  return failed === 0 ? 0 : 1;
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
