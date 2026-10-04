import { config } from '../src/config/env.ts';
import { createAnthropicProvider } from '../src/adapters/llm/anthropic.ts';
import type { LlmProvider, LlmResponse } from '../src/adapters/llm/types.ts';
import { createJob, ingestResume } from '../src/agent/ingest.ts';
import { extractEvidence, openEvaluation } from '../src/agent/extract.ts';
import { matchAndScore } from '../src/agent/match.ts';
import { MASK_CHAR } from '../src/agent/redact.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { createTestContext } from '../test/helpers.ts';

// OPT-IN LIVE SMOKE TEST — one real Anthropic request, by hand, never in CI.
//
//   ANTHROPIC_LIVE_TEST=1 node scripts/live-smoke-anthropic.ts
//
// This file is deliberately NOT under `test/` and NOT named `*.test.ts`, so
// `node --test` (and therefore `npm test` and CI) never discovers it. It runs only
// when BOTH ANTHROPIC_API_KEY is set and ANTHROPIC_LIVE_TEST is exactly "1";
// otherwise it exits 0 having contacted nothing.
//
// It drives the real pipeline — the real Anthropic provider (retries off), the real
// extraction stage with its validator and quote verifier, then the deterministic
// match-and-score stage — over one invented CV embedded below. No file is read.
//
// IT PRINTS METADATA ONLY: model, counts, tokens, latency, pass/fail. Never the key,
// the CV, the prompt, the model's reply, a quote, or a request header.

const SYNTHETIC_NAME = 'Quentin Ashgrove';
const SYNTHETIC_EMAIL = 'quentin.ashgrove@example.invalid';
const SYNTHETIC_PHONE = '+1 555 010 0199';

// Invented. Not a real person; the contact details are reserved/fictional values.
const SYNTHETIC_CV = [
  `Name: ${SYNTHETIC_NAME}`,
  `Email: ${SYNTHETIC_EMAIL}`,
  `Phone: ${SYNTHETIC_PHONE}`,
  'Date of birth: 12 June 1990',
  'Gender: Male',
  '',
  'SUMMARY',
  'Backend engineer with seven years building logistics software.',
  '',
  'EXPERIENCE',
  'Staff Engineer, Fabrikam Freight',
  'Designed and shipped a Node.js routing service that handles 90,000 shipment updates a day.',
  'Led the migration of the order database from a single PostgreSQL instance to a replicated cluster.',
  'Mentored four junior engineers through their first production releases.',
  '',
  'SKILLS',
  'TypeScript, Node.js, PostgreSQL, Docker',
].join('\n');

const JOB = {
  title: 'Senior Backend Engineer',
  seniority: 'senior' as const,
  description: 'Owns a logistics service end to end.',
  requirements: [
    {
      label: 'Node.js services',
      criterion: 'Has designed and shipped production Node.js services',
      kind: 'must_have' as const,
      weight: 3,
    },
    {
      label: 'PostgreSQL',
      criterion: 'Has run PostgreSQL migrations at scale',
      kind: 'must_have' as const,
      weight: 2,
    },
    {
      label: 'Mentoring',
      criterion: 'Has mentored junior engineers',
      kind: 'nice_to_have' as const,
      weight: 1,
    },
  ],
};

type Check = { name: string; pass: boolean };

function line(text: string): void {
  console.log(text);
}

/** Provider error text with the key removed and its length bounded. */
function safeMessage(err: unknown, secret: string): string {
  const text = err instanceof Error ? err.message : 'unknown error';
  return text.split(secret).join('[redacted]').slice(0, 500);
}

async function main(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey.trim() === '' || process.env.ANTHROPIC_LIVE_TEST !== '1') {
    line('SKIPPED: set ANTHROPIC_API_KEY and ANTHROPIC_LIVE_TEST=1 to run. No request was made.');
    return 0;
  }

  const ctx = await createTestContext({ idPrefix: 'live' });
  const { logger, entries } = createMemoryLogger('live-smoke');

  // Wrap the real provider to count requests and keep reply metadata. The reply
  // itself is held in memory for the pipeline and is never printed.
  const real = createAnthropicProvider({
    apiKey,
    model: config.anthropicModel,
    timeoutMs: config.anthropicTimeoutMs,
    maxRetries: 0,
    logger,
  });
  let requests = 0;
  let meta: Pick<LlmResponse, 'model' | 'latencyMs' | 'usage'> | undefined;
  let providerError: string | undefined;
  const provider: LlmProvider = {
    name: real.name,
    configured: real.configured,
    async complete(request) {
      requests += 1;
      if (requests > 1) throw new Error('The live smoke test makes exactly one request.');
      try {
        const response = await real.complete(request);
        meta = { model: response.model, latencyMs: response.latencyMs, usage: response.usage };
        return response;
      } catch (err) {
        providerError = safeMessage(err, apiKey);
        throw err;
      }
    },
  };

  const { job, requirements } = await createJob({ repos: ctx.repos }, JOB);
  const ingested = await ingestResume(
    { repos: ctx.repos },
    { reference: 'synthetic-001', displayName: SYNTHETIC_NAME, text: SYNTHETIC_CV, source: 'upload' },
  );
  const evaluation = await openEvaluation(
    { repos: ctx.repos },
    { jobId: job.id, candidateId: ingested.candidate.id, resume: ingested.resume },
  );

  const wallStart = performance.now();
  let outcome: Awaited<ReturnType<typeof extractEvidence>> | undefined;
  try {
    outcome = await extractEvidence({ repos: ctx.repos, provider, logger }, evaluation.id);
  } catch {
    // Details are in `providerError`; the pipeline's own error is deliberately generic.
  }
  const wallMs = Math.round(performance.now() - wallStart);

  line('--- Anthropic live smoke test (synthetic CV) ---');
  line(`configured model : ${config.anthropicModel}`);
  line(`requests made    : ${requests}`);
  line(`input type       : synthetic CV`);

  if (outcome === undefined || meta === undefined) {
    line('request result   : FAILED');
    line(`safe error       : ${providerError ?? 'the pipeline failed before the provider was called'}`);
    await ctx.close();
    return 1;
  }

  // --- verify what came back, using the real validator/verifier results ----
  const verifiedRows = await ctx.repos.evidence.listVerifiedForEvaluation(evaluation.id);
  const sensitive = [SYNTHETIC_NAME, SYNTHETIC_EMAIL, SYNTHETIC_PHONE, '12 June 1990'];
  const maskedOrSensitive = verifiedRows.some(
    (row) => row.quote.includes(MASK_CHAR) || sensitive.some((value) => row.quote.includes(value)),
  );

  let scored = false;
  let scoreBasisPoints: number | undefined;
  let mustHaves: string | undefined;
  try {
    const result = await matchAndScore({ repos: ctx.repos }, evaluation.id);
    scored = true;
    scoreBasisPoints = result.breakdown.scoreBasisPoints;
    mustHaves = `${result.breakdown.mustHavesMet}/${result.breakdown.mustHavesTotal}`;
  } catch {
    scored = false;
  }

  const audit = await ctx.repos.audit.list({ limit: 500 });
  const leaked =
    JSON.stringify(entries).includes(apiKey) ||
    JSON.stringify(audit).includes(apiKey) ||
    (providerError ?? '').includes(apiKey);

  const usage = meta.usage;
  const checks: Check[] = [
    { name: 'request succeeded; forced record_evidence call accepted', pass: true },
    { name: 'expected extraction structure; validateExtraction: zero malformed', pass: outcome.malformed === 0 },
    { name: 'at least one evidence quote returned', pass: outcome.verified + outcome.rejected > 0 },
    { name: 'at least one quote passed deterministic verification', pass: outcome.verified > 0 },
    { name: 'no verified quote contains masked/redacted content', pass: !maskedOrSensitive },
    { name: 'match-and-score ran without error', pass: scored },
    {
      name: 'positive token usage reported',
      pass: usage !== undefined && usage.inputTokens > 0 && usage.outputTokens > 0,
    },
    { name: 'latency recorded', pass: meta.latencyMs > 0 },
    { name: 'API key absent from logs, audit trail and errors', pass: !leaked },
  ];

  line('request result   : SUCCESS');
  line(`response model   : ${meta.model}`);
  line(`input tokens     : ${usage?.inputTokens ?? 'not reported'}`);
  line(`output tokens    : ${usage?.outputTokens ?? 'not reported'}`);
  line(`provider latency : ${meta.latencyMs} ms (wall ${wallMs} ms)`);
  line(`requirements     : ${requirements.length}`);
  line(`quotes verified  : ${outcome.verified}`);
  line(`quotes rejected  : ${outcome.rejected}`);
  line(`malformed        : ${outcome.malformed}`);
  line(`scoring          : ${scored ? `ok (score ${scoreBasisPoints}/10000, must-haves ${mustHaves})` : 'FAILED'}`);
  for (const check of checks) line(`${check.pass ? 'PASS' : 'FAIL'}  ${check.name}`);

  await ctx.close();
  return checks.every((check) => check.pass) ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // Never print the error object: only its class and a key-scrubbed message.
    const secret = process.env.ANTHROPIC_API_KEY ?? '';
    console.log(`UNEXPECTED FAILURE: ${safeMessage(err, secret)}`);
    process.exitCode = 1;
  },
);
