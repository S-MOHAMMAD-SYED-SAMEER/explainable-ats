import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import {
  createAnthropicProvider,
  retryDelayMs,
  MAX_RETRIES_CEILING,
  type AnthropicMessagesClient,
  type AnthropicProviderOptions,
} from '../src/adapters/llm/anthropic.ts';
import { createLlmProvider, LlmError, type LlmRequest } from '../src/adapters/llm/index.ts';
import { createApp } from '../src/app.ts';
import { seedDemoData } from '../src/demo/seed.ts';
import { configSummary, loadConfig } from '../src/config/env.ts';
import { handleHealth } from '../src/handlers/health.ts';
import { extractEvidence } from '../src/agent/extract.ts';
import { matchAndScore } from '../src/agent/match.ts';
import { EXTRACTION_PROMPT_VERSION, EXTRACTION_TOOL } from '../src/agent/extractionSchema.ts';
import { buildSystemPrompt, buildUserMessage } from '../src/agent/extractionPrompt.ts';
import { createDeterministicExtractor } from '../src/agent/mockExtractor.ts';
import { MASK_CHAR } from '../src/agent/redact.ts';
import { AppError } from '../src/lib/errors.ts';
import { createMemoryLogger } from '../src/lib/logger.ts';
import { createTestContext, rejects } from './helpers.ts';
import { seedScenario, RESUME_TEXT, SENSITIVE_VALUES } from './fixtures.ts';
import type { JobRequirement } from '../src/domain/ats.ts';

// The Anthropic provider, without Anthropic.
//
// Nothing in this file contacts the Anthropic API, and none of it needs a key.
// There are two seams, and both are local:
//
//   * a FAKE CLIENT injected into the adapter, for every behaviour that is about
//     the adapter's own logic — request shape, tool handling, retries, errors;
//   * a LOOPBACK STUB SERVER (127.0.0.1, an ephemeral port) driven through the
//     REAL SDK, for the things a fake cannot prove — that the request is a valid
//     Messages API call on the wire, that the real SDK's error classes and
//     response parsing are what the adapter expects, and that the timeout really
//     fires. The SDK is pointed at the stub with an explicit `baseURL`, so there
//     is no path from here to api.anthropic.com.
//
// What this file cannot show is how the live service behaves. That is the point of
// the separate, opt-in smoke test planned for a later phase.

const API_KEY = 'test-api-key-not-real-0123456789';
const MODEL = 'model-named-by-config';

// --- scaffolding -------------------------------------------------------------

const REQUIREMENTS = [
  { id: 'req-1', label: 'Node.js', criterion: 'Has shipped production services in Node.js' },
  { id: 'req-2', label: 'PostgreSQL', criterion: 'Has run PostgreSQL at scale' },
] as unknown as JobRequirement[];

function extractionRequest(redactedText = 'A short resume.\nDesigned Node.js services.'): LlmRequest {
  return {
    purpose: 'extract_evidence',
    promptVersion: EXTRACTION_PROMPT_VERSION,
    systemPrompt: buildSystemPrompt(),
    messages: [{ role: 'user', content: buildUserMessage(REQUIREMENTS, redactedText) }],
    tool: EXTRACTION_TOOL,
    maxTokens: 2048,
  };
}

const FINDINGS = {
  findings: [
    { requirementId: 'req-1', quote: 'Designed Node.js services.', charStart: 16, charEnd: 42, reasoning: 'Direct match.' },
  ],
};

function toolUse(input: unknown, name = 'record_evidence', id = 'toolu_test') {
  return { type: 'tool_use', id, name, input, caller: { type: 'direct' } };
}

type MessageOverrides = {
  content?: unknown[];
  stop_reason?: string | null;
  usage?: unknown;
  model?: string;
  stop_details?: unknown;
};

/** A Messages API response, with only the fields the adapter reads spelled out. */
function reply(overrides: MessageOverrides = {}): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'served-model-id',
    content: [toolUse(FINDINGS)],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 85 },
    ...overrides,
  } as unknown as Anthropic.Message;
}

type CreateBody = Anthropic.MessageCreateParamsNonStreaming;
type Step = Anthropic.Message | Error | ((body: CreateBody) => Anthropic.Message);

/** A client that plays `steps` in order, repeating the last one, and records every call. */
function fakeClient(...steps: Step[]) {
  const calls: Array<{ body: CreateBody; options: { timeout?: number; maxRetries?: number } | undefined }> = [];
  const client: AnthropicMessagesClient = {
    messages: {
      async create(body, options) {
        calls.push({ body, options });
        const step = steps[Math.min(calls.length - 1, steps.length - 1)] as Step;
        if (step instanceof Error) throw step;
        return typeof step === 'function' ? step(body) : structuredClone(step);
      },
    },
  };
  return { client, calls };
}

function build(client: AnthropicMessagesClient, overrides: Partial<AnthropicProviderOptions> = {}) {
  const sleeps: number[] = [];
  let clock = 0;
  const provider = createAnthropicProvider({
    apiKey: API_KEY,
    model: MODEL,
    timeoutMs: 5_000,
    maxRetries: 2,
    client,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => (clock += 25),
    ...overrides,
  });
  return { provider, sleeps };
}

/** A typed API error, built the way the SDK builds one from an HTTP response. */
function apiError(status: number, message = 'provider said no', headers: Record<string, string> = {}): Error {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type: 'error_type', message } },
    undefined,
    new Headers(headers),
  );
}

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  const err = await rejects(() => promise);
  assert.ok(err instanceof LlmError, `expected an LlmError, got ${err.constructor.name}: ${err.message}`);
  assert.equal(err.provider, 'anthropic');
  return err;
}

// --- A, B: the forced tool call, and how its payload is mapped ----------------

test('a forced record_evidence call comes back as the extraction output', async () => {
  const { client, calls } = fakeClient(reply());
  const { provider } = build(client);

  const response = await provider.complete(extractionRequest());

  assert.deepEqual(response.output, FINDINGS);
  assert.equal(calls.length, 1);
  assert.equal(provider.name, 'anthropic');
  assert.equal(provider.configured, true);
});

test('the request forces the tool and carries exactly the extraction request', async () => {
  const { client, calls } = fakeClient(reply());
  const { provider } = build(client);
  const request = extractionRequest();

  await provider.complete(request);

  const { body, options } = calls[0] as (typeof calls)[number];
  assert.equal(body.model, MODEL, 'the model must come from configuration, verbatim');
  assert.equal(body.max_tokens, request.maxTokens);
  assert.equal(body.system, request.systemPrompt);
  assert.deepEqual(body.messages, request.messages);

  // One tool, forced, at most one call.
  assert.equal(body.tools?.length, 1);
  const tool = body.tools?.[0] as Anthropic.Tool;
  assert.equal(tool.name, 'record_evidence');
  assert.deepEqual(tool.input_schema, EXTRACTION_TOOL.inputSchema);
  assert.deepEqual(body.tool_choice, { type: 'tool', name: 'record_evidence', disable_parallel_tool_use: true });

  // Parameters that newer models reject, or that would make the output vary, are
  // simply not sent.
  for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'prefill']) {
    assert.ok(!(key in body), `${key} must not be sent`);
  }
  assert.ok(!body.messages.some((message) => message.role === 'assistant'), 'no assistant prefill');

  // The adapter owns the timeout and the retries; the SDK owns neither.
  assert.deepEqual(options, { timeout: 5_000, maxRetries: 0 });
});

test('the model reported by the response is what gets recorded, with the configured one as fallback', async () => {
  const served = await build(fakeClient(reply({ model: 'the-model-that-answered' })).client).provider.complete(
    extractionRequest(),
  );
  assert.equal(served.model, 'the-model-that-answered');

  const unnamed = await build(fakeClient(reply({ model: '' })).client).provider.complete(extractionRequest());
  assert.equal(unnamed.model, MODEL);
});

test('text and thinking blocks beside the tool call are ignored, and cannot become output', async () => {
  const { client } = fakeClient(
    reply({
      content: [
        { type: 'thinking', thinking: 'let me think', signature: 'sig' },
        { type: 'text', text: '{"findings":[{"requirementId":"req-1","quote":"smuggled"}]}' },
        toolUse(FINDINGS),
      ],
    }),
  );
  const response = await build(client).provider.complete(extractionRequest());

  assert.deepEqual(response.output, FINDINGS);
  assert.ok(!JSON.stringify(response.output).includes('smuggled'));
});

test('the output is a copy: a caller cannot reach back into the response', async () => {
  const message = reply();
  const { client } = fakeClient(() => message);
  const response = await build(client).provider.complete(extractionRequest());

  (response.output.findings as unknown[]).push('tampered');
  const stored = (message.content[0] as Anthropic.ToolUseBlock).input as { findings: unknown[] };
  assert.equal(stored.findings.length, 1);
});

// --- C, D, E: responses that are not one good tool call -----------------------

test('a malformed tool payload is a provider failure, not an empty result', async () => {
  for (const input of ['a string', 42, null, ['findings'], {}, { findings: 'not an array' }, { findings: null }]) {
    const { client, calls } = fakeClient(reply({ content: [toolUse(input)] }));
    const err = await failure(build(client).provider.complete(extractionRequest()));

    assert.match(err.message, /rejected/, `${JSON.stringify(input)} was accepted`);
    assert.equal(calls.length, 1, 'a malformed answer must not be retried');
  }
});

test('a reply with no tool call is a provider failure', async () => {
  const { client, calls } = fakeClient(
    reply({ content: [{ type: 'text', text: 'I could not find anything relevant.' }], stop_reason: 'end_turn' }),
  );
  const err = await failure(build(client).provider.complete(extractionRequest()));

  assert.match(err.message, /no "record_evidence" tool call/);
  assert.equal(calls.length, 1);
});

test('more than one tool call is refused, rather than one being picked', async () => {
  const two = reply({ content: [toolUse(FINDINGS, 'record_evidence', 'a'), toolUse(FINDINGS, 'record_evidence', 'b')] });
  const err = await failure(build(fakeClient(two).client).provider.complete(extractionRequest()));
  assert.match(err.message, /2 tool calls/);

  const stray = reply({ content: [toolUse(FINDINGS, 'record_evidence', 'a'), toolUse({}, 'something_else', 'b')] });
  await failure(build(fakeClient(stray).client).provider.complete(extractionRequest()));
});

test('a tool call under another name is refused', async () => {
  const { client } = fakeClient(reply({ content: [toolUse(FINDINGS, 'record_something_else')] }));
  const err = await failure(build(client).provider.complete(extractionRequest()));
  assert.match(err.message, /not "record_evidence"/);
});

test('a refusal, a truncated output and an unexpected stop reason are provider failures', async () => {
  const refused = reply({ stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' }, content: [] });
  assert.match((await failure(build(fakeClient(refused).client).provider.complete(extractionRequest()))).message, /declined.*cyber/);

  const truncated = reply({ stop_reason: 'max_tokens' });
  assert.match((await failure(build(fakeClient(truncated).client).provider.complete(extractionRequest()))).message, /cut off/);

  const odd = reply({ stop_reason: 'pause_turn' });
  assert.match((await failure(build(fakeClient(odd).client).provider.complete(extractionRequest()))).message, /stop_reason/);
});

test('a tool schema that is not an object schema fails before anything is sent', async () => {
  const { client, calls } = fakeClient(reply());
  const request = extractionRequest();
  request.tool = { ...request.tool, inputSchema: { type: 'string' } };

  await failure(build(client).provider.complete(request));
  assert.equal(calls.length, 0);
});

// --- F, G: API errors and authentication --------------------------------------

test('a client error is mapped to LlmError and never retried', async () => {
  for (const status of [400, 403, 404, 413, 422]) {
    const { client, calls } = fakeClient(apiError(status));
    const { provider, sleeps } = build(client);
    const err = await failure(provider.complete(extractionRequest()));

    assert.match(err.message, new RegExp(`HTTP ${status}`));
    assert.equal(calls.length, 1, `HTTP ${status} was retried`);
    assert.deepEqual(sleeps, []);
  }
});

test('a 400 carries the API\'s own explanation, so a rejected configuration is diagnosable', async () => {
  const { client } = fakeClient(apiError(400, 'tool_choice: type "tool" and "any" are not supported for this model.'));
  const err = await failure(build(client).provider.complete(extractionRequest()));
  assert.match(err.message, /tool_choice/);
});

test('an authentication failure is mapped, not retried, and never echoes the key', async () => {
  const { client, calls } = fakeClient(apiError(401, `invalid x-api-key: ${API_KEY}`));
  const { provider, sleeps } = build(client);
  const err = await failure(provider.complete(extractionRequest()));

  assert.match(err.message, /HTTP 401/);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
  assert.ok(!err.message.includes(API_KEY), 'the key reached an error message');
  assert.match(err.message, /\[redacted\]/);
});

test('provider error text is bounded', async () => {
  const { client } = fakeClient(apiError(400, 'x'.repeat(10_000)));
  const err = await failure(build(client).provider.complete(extractionRequest()));
  assert.ok(err.message.length < 700, `error message was ${err.message.length} characters`);
});

test('an error that is not from the SDK is a provider failure, not a retry', async () => {
  const { client, calls } = fakeClient(new TypeError('a bug'));
  const err = await failure(build(client).provider.complete(extractionRequest()));

  assert.match(err.message, /unexpected error/);
  assert.equal(calls.length, 1);
});

// --- H: transient failures, and bounded retries --------------------------------

test('a transient failure is retried and then succeeds', async () => {
  for (const transient of [apiError(429), apiError(500), apiError(529), apiError(408), new Anthropic.APIConnectionError({})]) {
    const { client, calls } = fakeClient(transient, reply());
    const { provider, sleeps } = build(client);
    const response = await provider.complete(extractionRequest());

    assert.deepEqual(response.output, FINDINGS);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [500]);
  }
});

test('retries are bounded: a failure that never clears stops after maxRetries', async () => {
  const { client, calls } = fakeClient(apiError(503));
  const { provider, sleeps } = build(client, { maxRetries: 2 });
  const err = await failure(provider.complete(extractionRequest()));

  assert.equal(calls.length, 3, 'one attempt plus two retries');
  assert.match(err.message, /after 3 attempts/);
  assert.deepEqual(sleeps, [500, 1000], 'a fixed exponential delay, no jitter');
});

test('maxRetries of zero means one attempt, and the ceiling is enforced', async () => {
  const { client, calls } = fakeClient(apiError(500));
  await failure(build(client, { maxRetries: 0 }).provider.complete(extractionRequest()));
  assert.equal(calls.length, 1);

  assert.throws(() => build(fakeClient(reply()).client, { maxRetries: MAX_RETRIES_CEILING + 1 }), LlmError);
  assert.throws(() => build(fakeClient(reply()).client, { maxRetries: -1 }), LlmError);
  assert.throws(() => build(fakeClient(reply()).client, { maxRetries: 1.5 }), LlmError);
});

test('retry delays are deterministic, capped, and honour Retry-After within the cap', async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => retryDelayMs(n)), [500, 1000, 2000, 4000, 8000, 8000]);
  assert.equal(retryDelayMs(1, 2), 2000, 'a longer Retry-After wins');
  assert.equal(retryDelayMs(3, 1), 2000, 'a shorter one does not shorten the backoff');
  assert.equal(retryDelayMs(1, 3600), 8000, 'and an hour-long one is capped');

  const { client } = fakeClient(apiError(429, 'slow down', { 'retry-after': '3' }), reply());
  const { provider, sleeps } = build(client);
  await provider.complete(extractionRequest());
  assert.deepEqual(sleeps, [3000]);
});

test('a retried request is the same request', async () => {
  const { client, calls } = fakeClient(apiError(500), apiError(500), reply());
  await build(client).provider.complete(extractionRequest());

  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1]?.body, calls[0]?.body);
  assert.deepEqual(calls[2]?.body, calls[0]?.body);
});

// --- I: timeouts ---------------------------------------------------------------

test('a timeout is bounded, retried, and then reported as a timeout', async () => {
  const { client, calls } = fakeClient(new Anthropic.APIConnectionTimeoutError());
  const { provider, sleeps } = build(client, { maxRetries: 1 });
  const err = await failure(provider.complete(extractionRequest()));

  assert.equal(calls.length, 2);
  assert.match(err.message, /timeout/);
  assert.deepEqual(sleeps, [500]);
  for (const call of calls) assert.equal(call.options?.timeout, 5_000, 'every attempt carries the timeout');
});

test('the timeout must be a positive number of milliseconds', () => {
  for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => build(fakeClient(reply()).client, { timeoutMs }), LlmError);
  }
});

// --- L: usage and latency ------------------------------------------------------

test('usage is mapped when the provider reports it, and absent when it does not', async () => {
  const reported = await build(fakeClient(reply({ usage: { input_tokens: 1200, output_tokens: 85 } })).client).provider.complete(
    extractionRequest(),
  );
  assert.deepEqual(reported.usage, { inputTokens: 1200, outputTokens: 85 });

  for (const usage of [undefined, null, {}, { input_tokens: 'many', output_tokens: 1 }, { input_tokens: -1, output_tokens: 1 }]) {
    const response = await build(fakeClient(reply({ usage })).client).provider.complete(extractionRequest());
    assert.equal(response.usage, undefined, `usage was invented from ${JSON.stringify(usage)}`);
  }
});

test('latency is the measured wall-clock time of the call, retries included', async () => {
  const { client } = fakeClient(reply());
  const { provider } = build(client);
  const response = await provider.complete(extractionRequest());

  assert.equal(response.latencyMs, 25, 'one clock reading at the start, one at the end');
  assert.ok(Number.isInteger(response.latencyMs) && response.latencyMs >= 0);
});

test('no cost is ever computed or returned', async () => {
  const response = await build(fakeClient(reply()).client).provider.complete(extractionRequest());
  assert.ok(!JSON.stringify(response).toLowerCase().includes('cost'));
});

// --- J: configuration ----------------------------------------------------------

test('selecting anthropic without a key fails clearly, and never falls back to the mock', () => {
  const { config, problems } = loadConfig({ LLM_PROVIDER: 'anthropic' });

  assert.ok(problems.some((problem) => /ANTHROPIC_API_KEY/.test(problem)), 'configuration did not flag the missing key');
  const err = (() => {
    try {
      createLlmProvider(config);
    } catch (caught) {
      return caught;
    }
    return null;
  })();
  assert.ok(err instanceof LlmError, 'a provider was built without a key');
  assert.equal(err.provider, 'anthropic');
  assert.match(err.message, /ANTHROPIC_API_KEY is not set/);
});

test('a blank key is no key', () => {
  assert.equal(loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: '   ' }).config.anthropicApiKey, null);
  assert.throws(() => build(fakeClient(reply()).client, { apiKey: '  ' }), /ANTHROPIC_API_KEY is not set/);
  assert.throws(() => build(fakeClient(reply()).client, { model: '' }), /ANTHROPIC_MODEL/);
});

test('with a key, selecting anthropic builds the Anthropic provider and makes no call', () => {
  const { config } = loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: API_KEY, ANTHROPIC_MODEL: MODEL });
  const provider = createLlmProvider(config);

  assert.equal(provider.name, 'anthropic');
  assert.equal(provider.configured, true);
});

test('the mock is still the default, and needs no key', () => {
  const { config, problems } = loadConfig({});

  assert.equal(config.llmProvider, 'mock');
  assert.equal(createLlmProvider(config).name, 'mock');
  assert.ok(!problems.some((problem) => /ANTHROPIC/.test(problem)), 'the default configuration complained about Anthropic');
});

test('the timeout and retry limits have defaults, are configurable, and are bounded', () => {
  const defaults = loadConfig({}).config;
  assert.equal(defaults.anthropicTimeoutMs, 60_000);
  assert.equal(defaults.anthropicMaxRetries, 2);

  const set = loadConfig({ ANTHROPIC_TIMEOUT_MS: '15000', ANTHROPIC_MAX_RETRIES: '0' });
  assert.equal(set.config.anthropicTimeoutMs, 15_000);
  assert.equal(set.config.anthropicMaxRetries, 0, 'zero retries is a legitimate choice');
  assert.deepEqual(set.problems.filter((p) => /ANTHROPIC_(TIMEOUT|MAX)/.test(p)), []);

  const wild = loadConfig({ ANTHROPIC_TIMEOUT_MS: '99999999', ANTHROPIC_MAX_RETRIES: '50' });
  assert.equal(wild.config.anthropicTimeoutMs, 300_000, 'a timeout cannot be made unbounded');
  assert.equal(wild.config.anthropicMaxRetries, MAX_RETRIES_CEILING, 'retries cannot be made unbounded');
  assert.equal(wild.problems.filter((p) => /above the maximum/.test(p)).length, 2);

  const junk = loadConfig({ ANTHROPIC_TIMEOUT_MS: 'soon', ANTHROPIC_MAX_RETRIES: '-3' });
  assert.equal(junk.config.anthropicTimeoutMs, 60_000);
  assert.equal(junk.config.anthropicMaxRetries, 2);
  assert.equal(junk.problems.filter((p) => /must be/.test(p)).length, 2);
});

test('the key is never exposed by health, the config summary, or an error', async () => {
  const { config } = loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: API_KEY });

  assert.ok(!JSON.stringify(configSummary(config)).includes(API_KEY));
  assert.ok(!JSON.stringify((await handleHealth({ config })).body).includes(API_KEY));
  assert.equal(configSummary(config).llmConfigured, true);

  const { client } = fakeClient(apiError(500, `boom ${API_KEY}`));
  const err = await failure(build(client, { maxRetries: 0 }).provider.complete(extractionRequest()));
  assert.ok(!err.message.includes(API_KEY));
});

// --- the wire: the real SDK against a loopback stub ---------------------------

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> };
type StubReply = { status: number; json: unknown } | 'hang';

async function stub(respond: (seen: Seen, n: number) => StubReply) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') };
      seen.push(entry);
      const answer = respond(entry, seen.length);
      if (answer === 'hang') return; // never answered: the client's timeout has to be what ends this
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    seen,
    baseURL: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The real SDK, pointed at a stub, with its own retries off exactly as the adapter builds it. */
function sdkAt(baseURL: string, timeout = 5_000): AnthropicMessagesClient {
  return new Anthropic({ apiKey: API_KEY, authToken: null, baseURL, timeout, maxRetries: 0 });
}

test('on the wire, the request is a valid Messages call and the reply parses', async (t) => {
  const server = await stub(() => ({ status: 200, json: reply() }));
  t.after(() => server.close());

  const { provider } = build(sdkAt(server.baseURL));
  const response = await provider.complete(extractionRequest());

  assert.deepEqual(response.output, FINDINGS);
  assert.deepEqual(response.usage, { inputTokens: 1200, outputTokens: 85 });

  assert.equal(server.seen.length, 1);
  const request = server.seen[0] as Seen;
  assert.equal(request.method, 'POST');
  assert.equal(request.url, '/v1/messages');
  assert.equal(request.headers['x-api-key'], API_KEY, 'the configured key is the credential sent');
  assert.ok(request.headers['anthropic-version'], 'the API version header is set');
  assert.equal(request.headers.authorization, undefined, 'no second credential is sent');
  assert.equal(request.body.model, MODEL);
  assert.deepEqual(request.body.tool_choice, { type: 'tool', name: 'record_evidence', disable_parallel_tool_use: true });
  assert.equal((request.body.tools as unknown[]).length, 1);
});

test('on the wire, the real SDK error classes are mapped the same way', async (t) => {
  const server = await stub((_seen, n) => {
    const status = n === 1 ? 401 : 400;
    return { status, json: { type: 'error', error: { type: 'x', message: `HTTP ${status} ${API_KEY}` } } };
  });
  t.after(() => server.close());

  // 401, then 400: each is one attempt and a mapped, key-free LlmError.
  for (const [status, label] of [[401, /HTTP 401/], [400, /HTTP 400/]] as const) {
    const before = server.seen.length;
    const err = await failure(build(sdkAt(server.baseURL), { maxRetries: 2 }).provider.complete(extractionRequest()));
    assert.match(err.message, label);
    assert.equal(server.seen.length - before, 1, `HTTP ${status} was retried over the wire`);
    assert.ok(!err.message.includes(API_KEY));
  }
});

test('on the wire, a transient server failure is retried by the adapter and then succeeds', async (t) => {
  const server = await stub((_seen, n) =>
    n < 3 ? { status: 529, json: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } } : { status: 200, json: reply() },
  );
  t.after(() => server.close());

  const { provider, sleeps } = build(sdkAt(server.baseURL), { maxRetries: 2 });
  const response = await provider.complete(extractionRequest());

  assert.deepEqual(response.output, FINDINGS);
  assert.equal(server.seen.length, 3, 'the SDK made one request per adapter attempt, not its own extra retries');
  assert.deepEqual(sleeps, [500, 1000]);
});

test('on the wire, a server that never answers is cut off by the timeout', async (t) => {
  const server = await stub(() => 'hang');
  t.after(() => server.close());

  const started = Date.now();
  const { provider } = build(sdkAt(server.baseURL, 150), { timeoutMs: 150, maxRetries: 1 });
  const err = await failure(provider.complete(extractionRequest()));

  assert.match(err.message, /timeout/);
  assert.equal(server.seen.length, 2, 'one attempt plus one bounded retry');
  assert.ok(Date.now() - started < 3_000, 'the call did not return in bounded time');
});

// --- K, M, N: inside the real pipeline -----------------------------------------

/** Answers like a well-behaved model: quotes real lines out of the prompt it was sent. */
function wellBehavedModel(sent: string[]) {
  return (body: CreateBody): Anthropic.Message => {
    const content = body.messages.at(-1)?.content as string;
    sent.push(JSON.stringify(body));
    const output = createDeterministicExtractor()({ messages: [{ role: 'user', content }] } as LlmRequest);
    return reply({ content: [toolUse(output)] });
  };
}

test('provider failure inside the pipeline is a recorded failure, never empty evidence or a score', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const scenario = await seedScenario(ctx.repos);
  const memory = createMemoryLogger();

  const { client } = fakeClient(apiError(401, `invalid x-api-key: ${API_KEY}`));
  const { provider } = build(client);

  const err = await rejects(() =>
    extractEvidence({ repos: ctx.repos, provider, logger: memory.logger }, scenario.evaluation.id),
  );

  // The rest of the application sees its own error, with a fixed, safe message.
  assert.ok(err instanceof AppError && err.code === 'PROVIDER_UNAVAILABLE', `got ${err.constructor.name}`);
  assert.ok(!/anthropic|401|api-key/i.test(err.message), `the error leaked provider detail: ${err.message}`);

  const evaluation = await ctx.repos.evaluations.getById(scenario.evaluation.id);
  assert.equal(evaluation?.status, 'failed');
  assert.equal(evaluation?.scoreBasisPoints, null, 'a failed extraction must not leave a score');
  assert.equal((await ctx.repos.evidence.listForEvaluation(scenario.evaluation.id)).length, 0);
  assert.equal((await ctx.repos.matches.listForEvaluation(scenario.evaluation.id)).length, 0);
  await rejects(() => matchAndScore({ repos: ctx.repos }, scenario.evaluation.id));

  const trail = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  const failed = trail.find((event) => event.eventType === 'extraction_failed');
  assert.ok(failed, 'the failure was not audited');
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(failed.payload, { provider: 'anthropic' });

  const everything = JSON.stringify([trail, memory.entries, evaluation]);
  assert.ok(!everything.includes(API_KEY), 'the key reached the audit trail, the log or the evaluation');
});

test('only the redacted resume is ever sent to Anthropic', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const scenario = await seedScenario(ctx.repos);

  const sent: string[] = [];
  const { client, calls } = fakeClient(wellBehavedModel(sent));
  await extractEvidence({ repos: ctx.repos, provider: build(client).provider }, scenario.evaluation.id);

  assert.equal(calls.length, 1, 'precondition: the provider was actually called');
  const everything = sent.join('\n');

  for (const value of SENSITIVE_VALUES) {
    assert.ok(RESUME_TEXT.includes(value), `precondition: the resume contains ${value}`);
    assert.ok(!everything.includes(value), `${value} was sent to Anthropic`);
  }
  assert.ok(everything.includes(MASK_CHAR), 'the model should see that something was removed');

  const userMessage = calls[0]?.body.messages.at(-1)?.content as string;
  assert.ok(userMessage.includes(scenario.resume.redactedText));
  assert.ok(!userMessage.includes(scenario.resume.contentText));
});

test('what the model returns is only a candidate: verification against the original is still authoritative', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const scenario = await seedScenario(ctx.repos);
  const [node, postgres, mentoring] = scenario.requirements;
  assert.ok(node && postgres && mentoring);

  const real = 'Designed and shipped a Node.js settlement service handling 40,000 transactions a day.';
  const realStart = RESUME_TEXT.indexOf(real);
  const nameStart = RESUME_TEXT.indexOf('Priya Raman');
  assert.ok(realStart >= 0 && nameStart >= 0, 'precondition: both passages are in the resume');

  // A hostile or hallucinating model: one real quote, one invented one, one lifted
  // out of the masked name — and it volunteers a verdict and a score nobody asked for.
  const hostile = {
    findings: [
      { requirementId: node.id, quote: real, charStart: realStart, charEnd: realStart + real.length, reasoning: 'ok', verdict: 'met', score: 10_000 },
      { requirementId: postgres.id, quote: 'Ran PostgreSQL at planetary scale for a decade.', charStart: 0, charEnd: 48, reasoning: 'invented' },
      { requirementId: mentoring.id, quote: 'Priya Raman', charStart: nameStart, charEnd: nameStart + 11, reasoning: 'masked' },
    ],
    score: 10_000,
    verdict: 'met',
    rank: 1,
  };
  const { client } = fakeClient(reply({ content: [toolUse(hostile)] }));

  const outcome = await extractEvidence({ repos: ctx.repos, provider: build(client).provider }, scenario.evaluation.id);
  assert.deepEqual([outcome.verified, outcome.rejected, outcome.malformed], [1, 2, 0]);

  // Every stored quote that counts is really in the document, where it says it is.
  for (const item of await ctx.repos.evidence.listVerifiedForEvaluation(scenario.evaluation.id)) {
    assert.equal(scenario.resume.contentText.slice(item.charStart, item.charEnd), item.quote);
  }
  assert.equal((await ctx.repos.evidence.listForEvaluation(scenario.evaluation.id)).length, 3, 'rejects stay visible');

  // The score comes from deterministic code over verified evidence alone.
  const { evaluation } = await matchAndScore({ repos: ctx.repos }, scenario.evaluation.id);
  const matches = await ctx.repos.matches.listForEvaluation(scenario.evaluation.id);
  const verdictOf = (id: string) => matches.find((match) => match.requirementId === id)?.verdict;

  assert.equal(verdictOf(postgres.id), 'unclear', 'an invented quote must not count for a requirement');
  assert.equal(verdictOf(mentoring.id), 'unclear', 'a quote of masked text must not count either');
  assert.ok((evaluation.scoreBasisPoints ?? 0) <= 5_000, 'the provider\'s own "score" must not have been used');
  assert.notEqual(evaluation.scoreBasisPoints, 10_000);
});

test('malformed findings from the provider are dropped and audited by the existing pipeline, and their neighbours survive', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const scenario = await seedScenario(ctx.repos);
  const [node] = scenario.requirements;
  assert.ok(node);

  const real = 'Mentored three junior engineers';
  const start = RESUME_TEXT.indexOf(real);
  const { client } = fakeClient(
    reply({
      content: [
        toolUse({
          findings: [
            { requirementId: node.id, quote: real, charStart: start, charEnd: start + real.length, reasoning: 'ok' },
            { requirementId: node.id, quote: 42, charStart: 0, charEnd: 1, reasoning: 'wrong type' },
            'not even an object',
            { requirementId: 'not-a-requirement-of-this-job', quote: real, charStart: start, charEnd: start + real.length, reasoning: 'x' },
          ],
        }),
      ],
    }),
  );

  const outcome = await extractEvidence({ repos: ctx.repos, provider: build(client).provider }, scenario.evaluation.id);
  assert.deepEqual([outcome.verified, outcome.malformed], [1, 3]);

  const trail = await ctx.repos.audit.listForCorrelation(scenario.evaluation.id);
  assert.ok(trail.some((event) => event.eventType === 'malformed_findings_dropped'));
});

test('provider usage is recorded in the audit trail as token counts, only when reported, and never as a cost', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());

  const withUsage = await seedScenario(ctx.repos);
  const sent: string[] = [];
  const reporting = fakeClient((body) => {
    const message = wellBehavedModel(sent)(body);
    message.usage = { ...message.usage, input_tokens: 1234, output_tokens: 56 };
    return message;
  });
  await extractEvidence({ repos: ctx.repos, provider: build(reporting.client).provider }, withUsage.evaluation.id);

  const recorded = (await ctx.repos.audit.listForCorrelation(withUsage.evaluation.id)).find(
    (event) => event.eventType === 'extraction_recorded',
  );
  assert.deepEqual(recorded?.payload.usage, { inputTokens: 1234, outputTokens: 56 });
  assert.equal(recorded?.actorId, 'served-model-id', 'the model that actually answered is what is recorded');
  assert.ok(!JSON.stringify(recorded?.payload).toLowerCase().includes('cost'));

  // The mock reports no usage, so its audit payload has no such key — unchanged.
  const ctx2 = await createTestContext();
  t.after(() => ctx2.close());
  const mocked = await seedScenario(ctx2.repos);
  await extractEvidence({ repos: ctx2.repos, provider: mocked.provider }, mocked.evaluation.id);
  const mockRecorded = (await ctx2.repos.audit.listForCorrelation(mocked.evaluation.id)).find(
    (event) => event.eventType === 'extraction_recorded',
  );
  assert.ok(mockRecorded && !('usage' in mockRecorded.payload));
});

// --- the provider is responsible for extraction and nothing else --------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER = fs.readFileSync(path.join(HERE, '../src/adapters/llm/anthropic.ts'), 'utf8');
const ADAPTER_CODE = ADAPTER.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('the adapter imports nothing that matches, scores, ranks or verifies', () => {
  const imports = [...ADAPTER_CODE.matchAll(/from '([^']+)'/g)].map((match) => match[1]);

  assert.deepEqual(imports.sort(), ['../../lib/logger.ts', './types.ts', '@anthropic-ai/sdk']);
  for (const forbidden of ['match', 'score', 'rank', 'verify', 'domain', 'db/', 'repositories']) {
    assert.ok(!imports.some((source) => source?.includes(forbidden)), `the adapter imports ${forbidden}`);
  }
});

test('the adapter names no model, reads no environment, and logs no content', () => {
  assert.ok(!/claude-/i.test(ADAPTER_CODE), 'a model name is hard-coded in the adapter');
  assert.ok(!/process\.env/.test(ADAPTER_CODE), 'the adapter reads the environment itself');
  assert.ok(!/console\./.test(ADAPTER_CODE), 'the adapter writes to the console');

  // The only thing it logs is a retry, and only its kind, count and delay.
  const logCalls = [...ADAPTER_CODE.matchAll(/logger\?\.(\w+)\(/g)].map((match) => match[1]);
  assert.deepEqual(logCalls, ['warn']);
  const retryLog = /logger\?\.warn\('Anthropic request failed; retrying', \{([^}]*)\}/.exec(ADAPTER_CODE)?.[1] ?? '';
  assert.match(retryLog, /attempt/);
  assert.ok(!/request|body|message|resume|content|err\b/.test(retryLog.replace(/maxRetries/, '')), `the retry log carries more than it should: ${retryLog}`);
});

test('the extraction tool the provider is forced to call carries no verdict, score or rank', () => {
  const properties = JSON.stringify(EXTRACTION_TOOL.inputSchema).toLowerCase();
  for (const word of ['score', 'verdict', 'rank', 'weight', 'met']) {
    assert.ok(!new RegExp(`"${word}"`).test(properties), `the tool schema offers a "${word}" field`);
  }
  assert.deepEqual(Object.keys((EXTRACTION_TOOL.inputSchema.properties as Record<string, unknown>)), ['findings']);
});

// --- selection at the application level ----------------------------------------

test('the server refuses to start with anthropic selected and no key, and starts with one', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const { logger } = createMemoryLogger();

  const keyless = loadConfig({ LLM_PROVIDER: 'anthropic' }).config;
  assert.throws(() => createApp({ db: ctx.db, config: keyless, logger }), LlmError);

  // With a key it starts, and building the client makes no request.
  const keyed = loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: API_KEY }).config;
  assert.doesNotThrow(() => createApp({ db: ctx.db, config: keyed, logger }));

  // The default needs neither.
  assert.doesNotThrow(() => createApp({ db: ctx.db, config: loadConfig({}).config, logger }));
});

test('the public demo keeps using the mock even when the server is configured for anthropic', async (t) => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  await seedDemoData({ repos: ctx.repos });

  const config = {
    ...loadConfig({ LLM_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: API_KEY }).config,
    demoPublicReadonly: true,
  };
  const app = createApp({ db: ctx.db, config, logger: createMemoryLogger().logger });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const run = await fetch(`${base}/api/demo/scenarios/demo-001/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(run.status, 201, 'the demo should run without touching the configured provider');
  const { evaluationId } = (await run.json()) as { evaluationId: string };

  const detail = (await (await fetch(`${base}/api/evaluations/${evaluationId}`)).json()) as { model: string | null; status: string };
  assert.equal(detail.status, 'scored');
  assert.equal(detail.model, 'mock', 'a public visitor\'s click was answered by something other than the mock');

  const audit = (await (await fetch(`${base}/api/evaluations/${evaluationId}/audit`)).json()) as {
    events: Array<{ eventType: string; actorId: string | null }>;
  };
  assert.equal(audit.events.find((event) => event.eventType === 'extraction_recorded')?.actorId, 'mock');
});
