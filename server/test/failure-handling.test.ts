import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createAnthropicProvider, type AnthropicMessagesClient } from '../src/adapters/llm/anthropic.ts';
import { LLM_FAILURE_KINDS, LlmFailure, failureKindOf } from '../src/adapters/llm/failures.ts';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from '../src/adapters/llm/types.ts';
import { extractEvidence } from '../src/agent/extract.ts';
import { matchAndScore } from '../src/agent/match.ts';
import { EXTRACTION_EMPTY_EVENT, EXTRACTION_FAILURE_EVENTS, FAILURE_WORDING } from '../src/agent/failures.ts';
import { EXTRACTION_PROMPT_VERSION, EXTRACTION_TOOL } from '../src/agent/extractionSchema.ts';
import { buildSystemPrompt, buildUserMessage } from '../src/agent/extractionPrompt.ts';
import {
  MAX_TOKENS_CEILING,
  MIN_MAX_TOKENS,
  PASSAGES_PER_REQUIREMENT,
  THINKING_BASE_TOKENS,
  TOKENS_PER_PASSAGE,
  maxTokensFor,
} from '../src/agent/tokenBudget.ts';
import { MAX_RAW_OUTPUT_CHARS, RECORD_RESULTS } from '../src/db/repositories/records.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { AppError } from '../src/lib/errors.ts';
import { createTestContext, rejects, MIGRATIONS_DIR } from './helpers.ts';
import { seedScenario, SENSITIVE_VALUES } from './fixtures.ts';
import type { JobRequirement } from '../src/domain/ats.ts';

// How an extraction fails, and what is kept about every one.
//
// No model is called and no key is needed. The adapter is driven through a fake
// client (the same seam its own tests use); the pipeline is driven by providers
// that throw exactly what the adapter throws. Together they show that each way a
// model call can go wrong arrives as its own fact, leaves its own audit event and
// its own message, and never becomes either a score or an empty result.

const API_KEY = 'test-api-key-not-real-0123456789';

// --- the adapter names what went wrong -----------------------------------------

const REQUIREMENTS = [{ id: 'req-1', label: 'Node.js', criterion: 'Has shipped Node.js services' }] as unknown as JobRequirement[];

function request(): LlmRequest {
  return {
    purpose: 'extract_evidence',
    promptVersion: EXTRACTION_PROMPT_VERSION,
    systemPrompt: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserMessage(REQUIREMENTS, 'Designed Node.js services.') }],
    tool: EXTRACTION_TOOL,
    maxTokens: 4096,
  };
}

const GOOD = {
  findings: [{ requirementId: 'req-1', quote: 'Designed Node.js services.', charStart: 0, charEnd: 26, reasoning: 'Direct.' }],
};

function toolUse(input: unknown, name = 'record_evidence') {
  return { type: 'tool_use', id: 'toolu_x', name, input, caller: { type: 'direct' } };
}

function reply(overrides: Record<string, unknown> = {}): Anthropic.Message {
  return {
    id: 'msg_x',
    type: 'message',
    role: 'assistant',
    model: 'served-model',
    content: [toolUse(GOOD)],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 70 },
    ...overrides,
  } as unknown as Anthropic.Message;
}

function adapterFor(step: Anthropic.Message | Error, maxRetries = 0) {
  const client: AnthropicMessagesClient = {
    messages: {
      async create() {
        if (step instanceof Error) throw step;
        return structuredClone(step);
      },
    },
  };
  let clock = 0;
  return createAnthropicProvider({
    apiKey: API_KEY,
    model: 'configured-model',
    timeoutMs: 5000,
    maxRetries,
    client,
    sleep: async () => {},
    now: () => (clock += 10),
  });
}

async function failureOf(provider: LlmProvider): Promise<LlmFailure> {
  const err = await rejects(() => provider.complete(request()));
  assert.ok(err instanceof LlmFailure, `expected an LlmFailure, got ${err.constructor.name}: ${err.message}`);
  return err;
}

function apiError(status: number): Error {
  return Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: 'no' } }, undefined, new Headers());
}

test('a refusal is a refusal, and keeps what the reply cost', async () => {
  const failure = await failureOf(adapterFor(reply({ stop_reason: 'refusal', content: [], stop_details: { category: 'cyber' } })));
  assert.equal(failure.kind, 'refusal');
  assert.deepEqual(failure.details.usage, { inputTokens: 900, outputTokens: 70 });
  assert.equal(failure.details.model, 'served-model');
});

test('a cut-off answer is truncated, and keeps the partial tool input and the usage', async () => {
  const partial = { findings: [{ requirementId: 'req-1', quote: 'Designed No' }] };
  const failure = await failureOf(
    adapterFor(reply({ stop_reason: 'max_tokens', content: [toolUse(partial)], usage: { input_tokens: 900, output_tokens: 4096 } })),
  );
  assert.equal(failure.kind, 'truncated');
  assert.deepEqual(failure.details.raw, partial);
  assert.deepEqual(failure.details.usage, { inputTokens: 900, outputTokens: 4096 });
});

test('a cut-off answer with no tool call at all (all of it was thinking) is still truncated', async () => {
  const failure = await failureOf(adapterFor(reply({ stop_reason: 'max_tokens', content: [{ type: 'thinking', thinking: '...' }] })));
  assert.equal(failure.kind, 'truncated');
  assert.equal(failure.details.raw, undefined);
});

test('answers in the wrong shape are malformed, each keeping what arrived', async () => {
  const cases: Array<[string, Anthropic.Message, unknown]> = [
    ['no tool call', reply({ content: [{ type: 'text', text: 'I think they are strong.' }], stop_reason: 'end_turn' }), undefined],
    ['two calls', reply({ content: [toolUse(GOOD), toolUse(GOOD)] }), GOOD],
    ['the wrong tool', reply({ content: [toolUse(GOOD, 'something_else')] }), GOOD],
    ['no findings list', reply({ content: [toolUse({ results: [] })] }), { results: [] }],
    ['findings that is not a list', reply({ content: [toolUse({ findings: 'many' })] }), { findings: 'many' }],
    ['an unknown stop reason', reply({ stop_reason: 'pause_turn' }), GOOD],
  ];
  for (const [label, message, raw] of cases) {
    const failure = await failureOf(adapterFor(message));
    assert.equal(failure.kind, 'malformed', label);
    assert.deepEqual(failure.details.raw, raw, `${label}: the raw input is kept`);
    assert.deepEqual(failure.details.usage, { inputTokens: 900, outputTokens: 70 }, label);
  }
});

test('an outage that outlasts the retries is unavailable, whatever form it takes', async () => {
  const timeout = await failureOf(adapterFor(new Anthropic.APIConnectionTimeoutError(), 2));
  assert.equal(timeout.kind, 'unavailable');
  assert.equal(timeout.details.label, 'timeout');
  assert.equal(timeout.details.attempts, 3, 'one attempt and two retries');
  assert.equal(timeout.details.model, 'configured-model');

  for (const status of [429, 500, 529]) {
    const failure = await failureOf(adapterFor(apiError(status), 1));
    assert.equal(failure.kind, 'unavailable', `HTTP ${status}`);
    assert.equal(failure.details.label, `HTTP ${status}`);
    assert.equal(failure.details.attempts, 2);
  }

  const dropped = await failureOf(adapterFor(new Anthropic.APIConnectionError({ message: 'socket hang up' }), 0));
  assert.equal(dropped.kind, 'unavailable');
  assert.equal(dropped.details.label, 'connection error');
});

test('a request the service refuses is rejected (a configuration problem), and is not retried', async () => {
  for (const status of [400, 401, 403, 404]) {
    const failure = await failureOf(adapterFor(apiError(status), 3));
    assert.equal(failure.kind, 'rejected', `HTTP ${status}`);
    assert.equal(failure.details.attempts, 1, `HTTP ${status} must not be retried`);
  }
});

test('anything that is not an SDK error is unexpected', async () => {
  const failure = await failureOf(adapterFor(new TypeError('x is not a function'), 2));
  assert.equal(failure.kind, 'unexpected');
  assert.equal(failure.details.attempts, 1);
});

test('no failure message or detail carries the key', async () => {
  const failure = await failureOf(adapterFor(apiError(401), 0));
  assert.ok(!JSON.stringify([failure.message, failure.details]).includes(API_KEY));
});

test('a provider that throws a plain LlmError is treated as unavailable, anything else as unexpected', () => {
  assert.equal(failureKindOf(new LlmError('mock', 'down')), 'unavailable');
  assert.equal(failureKindOf(new LlmFailure('x', 'refusal', 'no')), 'refusal');
  assert.equal(failureKindOf(new Error('bug')), 'unexpected');
  assert.equal(failureKindOf('a string'), 'unexpected');
});

// --- the pipeline gives each its own message and event --------------------------

/** A provider that fails the way it is told to. */
function failing(error: unknown): LlmProvider {
  return {
    name: 'scripted',
    configured: true,
    async complete(): Promise<LlmResponse> {
      throw error;
    },
  };
}

test('every kind of failure has its own message and its own audit event', () => {
  const messages = LLM_FAILURE_KINDS.map((kind) => FAILURE_WORDING[kind].message);
  const events = LLM_FAILURE_KINDS.map((kind) => FAILURE_WORDING[kind].eventType);
  assert.equal(new Set(messages).size, LLM_FAILURE_KINDS.length, 'two kinds share a message');
  assert.equal(new Set(events).size, LLM_FAILURE_KINDS.length, 'two kinds share an event');
  assert.deepEqual([...EXTRACTION_FAILURE_EVENTS], events);
  assert.ok(!events.includes(EXTRACTION_EMPTY_EVENT), '"found nothing" is not a failure event');

  for (const kind of LLM_FAILURE_KINDS) {
    const wording = FAILURE_WORDING[kind];
    assert.match(wording.message, /nothing was scored/i, `${kind}: says nothing was scored`);
    assert.ok(!/anthropic|claude|api[ -]?key|http|token|sonnet|haiku/i.test(wording.message), `${kind}: names a provider or a setting`);
  }
  // The message that is "could not be reached" belongs to one kind only.
  assert.equal(messages.filter((message) => /could not be reached/.test(message)).length, 1);
});

for (const kind of LLM_FAILURE_KINDS) {
  test(`${kind}: the evaluation fails with that kind's message, event and record, and nothing is scored`, async (t) => {
    const ctx = await createTestContext();
    t.after(() => ctx.close());
    const scenario = await seedScenario(ctx.repos);
    const memory = createMemoryLogger();

    const detail = {
      label: 'a-label',
      attempts: 2,
      model: 'served-model',
      latencyMs: 1234,
      usage: kind === 'unavailable' || kind === 'rejected' || kind === 'unexpected' ? undefined : { inputTokens: 900, outputTokens: 70 },
      raw: kind === 'truncated' || kind === 'malformed' ? { findings: [{ quote: 'Desig' }] } : undefined,
    };
    const thrown = kind === 'unexpected' ? new Error('internal-secret-detail') : new LlmFailure('scripted', kind, 'internal-secret-detail', detail);
    const provider = failing(thrown);

    const err = await rejects(() =>
      extractEvidence({ repos: ctx.repos, provider, logger: memory.logger }, scenario.evaluation.id),
    );
    assert.ok(err instanceof AppError && err.code === 'PROVIDER_UNAVAILABLE');
    assert.equal(err.message, FAILURE_WORDING[kind].message);

    const evaluation = await ctx.repos.evaluations.getById(scenario.evaluation.id);
    assert.equal(evaluation?.status, 'failed');
    assert.equal(evaluation?.failureReason, FAILURE_WORDING[kind].message);
    assert.equal(evaluation?.scoreBasisPoints, null);
    assert.equal(await ctx.repos.evidence.count(), 0);
    await rejects(() => matchAndScore({ repos: ctx.repos }, scenario.evaluation.id));

    const trail = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
    const event = trail.find((entry) => entry.eventType === FAILURE_WORDING[kind].eventType);
    assert.ok(event, `no ${FAILURE_WORDING[kind].eventType} event`);
    assert.equal(event.outcome, 'failed');
    assert.equal(event.payload.kind, kind);
    for (const other of LLM_FAILURE_KINDS) {
      if (other !== kind) assert.ok(!trail.some((entry) => entry.eventType === FAILURE_WORDING[other].eventType));
    }

    // The record keeps what is known: the model, the cost, the time, the partial answer.
    const record = await ctx.repos.evaluationRecords.getForEvaluation(scenario.evaluation.id);
    assert.equal(record?.result, kind);
    if (kind !== 'unexpected') {
      assert.equal(record?.model, 'served-model');
      assert.equal(record?.latencyMs, 1234);
      assert.deepEqual(
        record?.inputTokens === null ? null : { inputTokens: record?.inputTokens, outputTokens: record?.outputTokens },
        detail.usage ?? null,
      );
      assert.equal(record?.rawOutput, detail.raw === undefined ? null : JSON.stringify(detail.raw));
    }
    assert.ok((record?.maxTokens ?? 0) >= MIN_MAX_TOKENS);

    // The provider's own text is for the log and nowhere else.
    assert.ok(!JSON.stringify([trail, evaluation, record, err.message]).includes('internal-secret-detail'));
    assert.ok(JSON.stringify(memory.entries).includes('internal-secret-detail'), 'the operator log has the real detail');
  });
}

// --- the model found nothing ------------------------------------------------------

test('an empty findings list is a real result: flagged, verdicts unclear, and not a failure', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const scenario = await seedScenario(ctx.repos, { deterministicExtractor: false });
  scenario.provider.register('extract_evidence', { findings: [] });

  const outcome = await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);
  assert.equal(outcome.verified, 0);
  assert.equal(outcome.evaluation.status, 'extracted');

  const events = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  const empty = events.find((event) => event.eventType === EXTRACTION_EMPTY_EVENT);
  assert.ok(empty, 'the audit trail says the model found nothing');
  assert.equal(empty.outcome, 'ok');
  assert.ok(!events.some((event) => EXTRACTION_FAILURE_EVENTS.includes(event.eventType)), 'it is not recorded as a failure');
  assert.ok(events.some((event) => event.eventType === 'extraction_recorded'), 'extraction still completed');

  const record = await ctx.repos.evaluationRecords.getForEvaluation(scenario.evaluation.id);
  assert.equal(record?.result, 'succeeded');
  assert.equal(record?.findingsReturned, 0);
  assert.equal(record?.rawOutput, '{"findings":[]}');

  // Scoring goes ahead and every requirement is "unclear", never "not met".
  const scored = await matchAndScore({ repos: ctx.repos }, scenario.evaluation.id);
  assert.deepEqual([...new Set(scored.breakdown.rows.map((row) => row.decision.verdict))], ['unclear']);
  assert.equal(scored.breakdown.scoreBasisPoints, 0);
});

test('a normal answer is not flagged as empty', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const scenario = await seedScenario(ctx.repos);

  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  const events = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  assert.ok(!events.some((event) => event.eventType === EXTRACTION_EMPTY_EVENT));
  const record = await ctx.repos.evaluationRecords.getForEvaluation(scenario.evaluation.id);
  assert.ok((record?.findingsReturned ?? 0) > 0);
});

test('findings that are all malformed are dropped but are not "found nothing"', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const scenario = await seedScenario(ctx.repos, { deterministicExtractor: false });
  scenario.provider.register('extract_evidence', { findings: ['junk', 42] });

  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  const events = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  assert.ok(events.some((event) => event.eventType === 'malformed_findings_dropped'));
  assert.ok(!events.some((event) => event.eventType === EXTRACTION_EMPTY_EVENT), 'the model did return findings');
  assert.equal((await ctx.repos.evaluationRecords.getForEvaluation(scenario.evaluation.id))?.findingsReturned, 2);
});

// --- what is kept for every extraction ------------------------------------------------

test('a successful extraction keeps the model, usage, latency, limit and the raw answer', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const scenario = await seedScenario(ctx.repos, { deterministicExtractor: false });
  const answer = {
    findings: [
      { requirementId: scenario.requirements[0]?.id, quote: 'x', charStart: 0, charEnd: 1, reasoning: 'r' },
      { requirementId: 'not-a-requirement', quote: 'y', charStart: 0, charEnd: 1, reasoning: 'r' },
    ],
  };
  const provider: LlmProvider = {
    name: 'scripted',
    configured: true,
    async complete(): Promise<LlmResponse> {
      return { output: answer, model: 'served-model', latencyMs: 321, usage: { inputTokens: 1500, outputTokens: 222 } };
    },
  };

  await extractEvidence({ repos: ctx.repos, provider }, scenario.evaluation.id);

  const record = await ctx.repos.evaluationRecords.getForEvaluation(scenario.evaluation.id);
  assert.ok(record);
  assert.equal(record.result, 'succeeded');
  assert.equal(record.model, 'served-model');
  assert.equal(record.inputTokens, 1500);
  assert.equal(record.outputTokens, 222);
  assert.equal(record.latencyMs, 321);
  assert.equal(record.findingsReturned, 2, 'counted before validation, so the dropped one is in it');
  assert.deepEqual(JSON.parse(record.rawOutput ?? 'null'), answer, 'kept as the model returned it, bad entries included');
  assert.equal(record.maxTokens, maxTokensFor({ requirementCount: 3, resumeChars: scenario.resume.redactedText.length }));
});

test('the raw answer holds redacted text only, never a protected value', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const scenario = await seedScenario(ctx.repos);

  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);

  const raw = (await ctx.repos.evaluationRecords.getForEvaluation(scenario.evaluation.id))?.rawOutput ?? '';
  assert.ok(raw.length > 20, 'precondition: there is a raw answer to inspect');
  for (const value of SENSITIVE_VALUES) assert.ok(!raw.includes(value), `the raw answer holds "${value}"`);
});

test('a record is replaced rather than duplicated, and an oversized answer is cut with a note', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const scenario = await seedScenario(ctx.repos);

  await ctx.repos.evaluationRecords.record({ evaluationId: scenario.evaluation.id, result: 'malformed', raw: { a: 1 } });
  await ctx.repos.evaluationRecords.record({
    evaluationId: scenario.evaluation.id,
    result: 'succeeded',
    raw: { text: 'z'.repeat(MAX_RAW_OUTPUT_CHARS + 50) },
  });

  assert.equal(await ctx.repos.evaluationRecords.count(), 1);
  const stored = await ctx.repos.evaluationRecords.getForEvaluation(scenario.evaluation.id);
  assert.equal(stored?.result, 'succeeded');
  assert.ok(stored?.rawOutput?.includes('[cut: the stored copy was longer than the limit]'));
  assert.ok((stored?.rawOutput?.length ?? 0) < MAX_RAW_OUTPUT_CHARS + 100);
});

test('the record kinds match the failure kinds and the schema constraint', () => {
  assert.deepEqual([...RECORD_RESULTS], ['succeeded', ...LLM_FAILURE_KINDS]);

  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, '003_evaluation_records.sql'), 'utf8').replace(/--[^\n]*/g, '');
  const check = /result\s+TEXT NOT NULL CHECK \(result IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? '';
  const inSchema = [...check.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);
  assert.deepEqual(inSchema, [...RECORD_RESULTS], 'the CHECK constraint and the code list differ');
  assert.ok(!/\b(api_key|apikey|authorization|password)\b/i.test(sql), 'the record schema has no place for a credential');
});

test('the old migrations are untouched, because their checksums are checked', () => {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
  assert.deepEqual(files, ['001_foundation.sql', '002_domain.sql', '003_evaluation_records.sql']);
});

// --- the output limit is sized from the job -----------------------------------------------

test('the output limit grows with the CV and with the requirement list, within a floor and a ceiling', () => {
  const small = maxTokensFor({ requirementCount: 1, resumeChars: 0 });
  assert.equal(small, THINKING_BASE_TOKENS + PASSAGES_PER_REQUIREMENT * TOKENS_PER_PASSAGE);
  assert.ok(small >= MIN_MAX_TOKENS);

  assert.ok(maxTokensFor({ requirementCount: 3, resumeChars: 20_000 }) > maxTokensFor({ requirementCount: 3, resumeChars: 2_000 }));
  assert.ok(maxTokensFor({ requirementCount: 12, resumeChars: 2_000 }) > maxTokensFor({ requirementCount: 3, resumeChars: 2_000 }));
  assert.ok(maxTokensFor({ requirementCount: 25, resumeChars: 200_000 }) <= MAX_TOKENS_CEILING);
  assert.equal(maxTokensFor({ requirementCount: 25, resumeChars: 200_000 }), MAX_TOKENS_CEILING, 'the largest job the API accepts is capped');
  assert.ok(maxTokensFor({ requirementCount: -3, resumeChars: -10 }) >= MIN_MAX_TOKENS, 'nonsense input still gives a usable limit');
});

test('the limit leaves room for the answer the largest uncapped job could produce', () => {
  // An answer written out in full: every requirement quoted the most the budget allows,
  // each quote a long sentence, each reason a full sentence, each id a UUID. Counted
  // pessimistically at 3 characters per token (ordinary English runs nearer 4; ids and
  // JSON punctuation run lower), so this is a deliberately harsh estimate.
  const uuid = '3f2b8c1e-5d4a-4e7b-9c10-a1b2c3d4e5f6';
  const quote = 'Led the migration of the settlement service from a single PostgreSQL instance to a replicated cluster, cutting p99 latency by forty percent.';
  const reasoning = 'Directly shows ownership of a production database migration at meaningful scale for this role.';

  for (const requirementCount of [1, 3, 8, 12]) {
    const findings = Array.from({ length: requirementCount * PASSAGES_PER_REQUIREMENT }, () => ({
      requirementId: uuid,
      quote,
      charStart: 12345,
      charEnd: 12345 + quote.length,
      reasoning,
    }));
    const answerTokens = Math.ceil(JSON.stringify({ findings }).length / 3);
    const thinkingAllowance = THINKING_BASE_TOKENS; // before any extra for CV length, which only adds room
    const limit = maxTokensFor({ requirementCount, resumeChars: 0 });

    assert.ok(limit < MAX_TOKENS_CEILING, `${requirementCount} requirements should not hit the ceiling`);
    assert.ok(
      limit >= answerTokens + thinkingAllowance,
      `${requirementCount} requirements: limit ${limit} < the largest full answer (${answerTokens}) plus thinking (${thinkingAllowance})`,
    );
  }
});

test('extraction asks the provider for the sized limit, and an override wins', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const scenario = await seedScenario(ctx.repos);

  await extractEvidence({ repos: ctx.repos, provider: scenario.provider }, scenario.evaluation.id);
  assert.equal(
    scenario.provider.calls[0]?.maxTokens,
    maxTokensFor({ requirementCount: scenario.requirements.length, resumeChars: scenario.resume.redactedText.length }),
  );
  assert.ok((scenario.provider.calls[0]?.maxTokens ?? 0) > 2048, 'the old fixed 2048 would have been too small for a thinking model');

  const second = await seedScenario(ctx.repos);
  await extractEvidence({ repos: ctx.repos, provider: second.provider, maxTokens: 321 }, second.evaluation.id);
  assert.equal(second.provider.calls[0]?.maxTokens, 321);
});
