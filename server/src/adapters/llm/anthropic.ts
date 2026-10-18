import Anthropic from '@anthropic-ai/sdk';
import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './types.ts';
import { LlmFailure, type LlmFailureKind } from './failures.ts';
import type { Logger } from '../../lib/logger.ts';

// The Anthropic provider.
//
// IT IS AN ADAPTER, AND NOTHING ELSE
//
// It implements `LlmProvider` — the same interface the mock implements — so the
// pipeline cannot tell which one it is talking to. Its whole job is to carry one
// extraction request to Claude and to hand back what Claude cited, in the shape
// the extraction stage already validates. It never scores, matches, ranks or
// explains: this file imports none of those modules, and a test pins that.
//
// WHAT IT SENDS
//
// Exactly the request the extraction stage built, which holds `redactedText` and
// never the original: the redaction boundary is enforced upstream, in
// `extract.ts`, and this adapter has no way to reach the unredacted resume.
// Nothing about the request is logged here — not the prompt, not the resume,
// not the response.
//
// WHAT IT TRUSTS
//
// Nothing. The tool call is forced, so free-form text can never become output;
// anything other than exactly one well-formed `record_evidence` call is a
// provider failure, not an empty result. Even a well-formed call is only
// evidence *candidates*: `validateExtraction` checks every finding's shape and
// `verifyEvidence` checks every quote against the real document, and those, not
// this file, decide what counts.
//
// TIMEOUT AND RETRIES
//
// The SDK's own retries are switched off, so there is one retry policy and it is
// this one. A request has a hard timeout. A failure is retried only if it is
// plausibly transient — timeout, dropped connection, 408, 429, 5xx — and at most
// `maxRetries` times, with a fixed exponential delay (no jitter, so behaviour is
// reproducible). Bad requests, authentication failures, and malformed or refused
// responses are never retried: asking again would give the same answer, and a
// model that answered badly is a provider failure to be recorded, not a coin to
// be flipped again.
//
// WHAT THE LIVE SERVICE ACCEPTS (checked against the real API on 2026-10-14)
//
//   claude-sonnet-5-5          forced tool choice REJECTED (400 "tool_choice: type
//                              \"tool\" and \"any\" are not supported for this model");
//                              `tool_choice: auto` accepted; `temperature` REJECTED
//                              (400 "deprecated for this model"). It always thinks
//                              (adaptive thinking cannot be turned off), so its
//                              thinking counts against max_tokens.
//   claude-haiku-4-5-20251001  forced tool choice accepted; `temperature: 0` accepted.
//   claude-haiku-5-5           forced tool choice accepted; `temperature` REJECTED.
//
// So two behaviours are configuration, not code: `toolChoice` ("forced" makes the
// tool call mandatory, "auto" lets the model decide and treats a reply with no tool
// call as the failure it is) and `temperature` (sent only when set). The adapter
// still hard-codes no model: the model is whatever `ANTHROPIC_MODEL` names, and a
// model that refuses a setting fails with a non-retried `LlmError` carrying the
// API's own message.

export const ANTHROPIC_PROVIDER = 'anthropic';

export const TOOL_CHOICE_MODES = ['auto', 'forced'] as const;
export type ToolChoiceMode = (typeof TOOL_CHOICE_MODES)[number];

/** Delay before the first retry; it doubles each time, up to the ceiling. */
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8_000;

/** Longest provider error text kept for the operator log. */
const MAX_ERROR_TEXT = 400;

/** The most retries any configuration may ask for. */
export const MAX_RETRIES_CEILING = 5;

/**
 * The slice of the SDK client this adapter uses.
 *
 * A seam rather than a mock: the real `Anthropic` client satisfies it, and so
 * does a three-line fake, which is what lets every behaviour here be tested
 * without a network.
 */
export type AnthropicMessagesClient = {
  messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
      options?: { timeout?: number; maxRetries?: number },
    ): Promise<Anthropic.Message>;
  };
};

export type AnthropicProviderOptions = {
  apiKey: string;
  /** Passed through verbatim. Never defaulted or rewritten here. */
  model: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /** Retries after the first attempt, for transient failures only. */
  maxRetries: number;
  /**
   * "forced": the model must call the tool. "auto": the model may answer in text
   * instead, and a reply with no tool call is rejected. Some models (Sonnet 5.5)
   * refuse "forced". Default "auto", which every model accepts.
   */
  toolChoice?: ToolChoiceMode;
  /** Sampling temperature. Sent only when set: several current models reject it. */
  temperature?: number;
  logger?: Logger;
  /** Injectable for tests. Defaults to the real SDK client. */
  client?: AnthropicMessagesClient;
  /** Injectable so tests need not wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable monotonic millisecond clock. */
  now?: () => number;
};

type Failure = {
  /** What the pipeline is told, once the retries (if any) are used up. */
  kind: LlmFailureKind;
  /** Plausibly gone on a second attempt. */
  transient: boolean;
  /** A short, key-free description of what kind of failure it was. */
  label: string;
  status?: number;
  /** Seconds the provider asked us to wait, if it said. */
  retryAfterSeconds?: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Removes the key from provider text and bounds its length. */
function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length > 0) out = out.split(secret).join('[redacted]');
  }
  return out.length > MAX_ERROR_TEXT ? `${out.slice(0, MAX_ERROR_TEXT)}…` : out;
}

function classify(err: unknown): Failure {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return { kind: 'unavailable', transient: true, label: 'timeout' };
  }
  if (err instanceof Anthropic.APIUserAbortError) {
    return { kind: 'unexpected', transient: false, label: 'aborted' };
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return { kind: 'unavailable', transient: true, label: 'connection error' };
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const retryAfter = Number(err.headers?.get?.('retry-after'));
    const transient = status !== undefined && (status === 408 || status === 429 || status >= 500);
    const failure: Failure = {
      // A 4xx the service will not change its mind about means the request itself
      // was refused (key, setting, model): a configuration problem, not an outage.
      kind: transient ? 'unavailable' : 'rejected',
      transient,
      label: status === undefined ? 'API error' : `HTTP ${status}`,
    };
    if (status !== undefined) failure.status = status;
    if (Number.isFinite(retryAfter) && retryAfter > 0) failure.retryAfterSeconds = retryAfter;
    return failure;
  }
  // Not an SDK error at all. Never retried: it is a bug, and repeating a bug
  // does not fix it.
  return { kind: 'unexpected', transient: false, label: 'unexpected error' };
}

/** The wait before retry number `attempt` (1-based). Deterministic. */
export function retryDelayMs(attempt: number, retryAfterSeconds?: number): number {
  const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  const asked = retryAfterSeconds === undefined ? 0 : retryAfterSeconds * 1000;
  return Math.min(MAX_DELAY_MS, Math.max(backoff, asked));
}

function buildBody(
  request: LlmRequest,
  model: string,
  toolChoice: ToolChoiceMode,
  temperature: number | undefined,
): Anthropic.MessageCreateParamsNonStreaming {
  const schema = request.tool.inputSchema;
  if (schema.type !== 'object') {
    throw new LlmError(ANTHROPIC_PROVIDER, `The "${request.tool.name}" tool schema must be an object schema.`);
  }

  return {
    model,
    max_tokens: request.maxTokens,
    system: request.systemPrompt,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    tools: [
      {
        name: request.tool.name,
        description: request.tool.description,
        input_schema: schema as Anthropic.Tool.InputSchema,
      },
    ],
    // Forced where the model allows it, so the reply is a structure to validate
    // rather than prose to parse. Where it does not ("auto"), a reply without the
    // tool call is refused in `readResponse`. At most one call either way: two
    // would be ambiguous, and are refused there too.
    tool_choice:
      toolChoice === 'forced'
        ? { type: 'tool', name: request.tool.name, disable_parallel_tool_use: true }
        : { type: 'auto', disable_parallel_tool_use: true },
    ...(temperature === undefined ? {} : { temperature }),
  };
}

/**
 * Reads the provider's reply, or refuses it.
 *
 * Every refusal is an `LlmError`. None of them becomes an empty result: "the
 * model found nothing" and "the model did not answer properly" are different
 * facts, and only the first says anything about the candidate.
 */
/** Token counts, only when the provider reported them. Never estimated, never priced. */
function usageOf(message: Anthropic.Message): { inputTokens: number; outputTokens: number } | undefined {
  const usage = message.usage;
  if (
    usage &&
    Number.isFinite(usage.input_tokens) &&
    Number.isFinite(usage.output_tokens) &&
    usage.input_tokens >= 0 &&
    usage.output_tokens >= 0
  ) {
    return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  }
  return undefined;
}

function readResponse(
  message: Anthropic.Message,
  toolName: string,
  configuredModel: string,
  latencyMs: number,
): LlmResponse {
  const model = typeof message.model === 'string' && message.model !== '' ? message.model : configuredModel;
  const usage = usageOf(message);

  // A reply that is refused still cost what it cost and said what it said, so the
  // refusal carries both: the pipeline records them rather than losing them.
  function fail(kind: LlmFailureKind, reason: string, raw?: unknown): never {
    throw new LlmFailure(ANTHROPIC_PROVIDER, kind, `The Anthropic response was rejected: ${reason}.`, {
      model,
      latencyMs,
      ...(usage ? { usage } : {}),
      ...(raw === undefined ? {} : { raw }),
    });
  }

  // The tool input, if the reply made a call at all. It may be partial.
  const firstCall = message.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
  const partial = firstCall?.input;

  const stop = message.stop_reason;
  if (stop === 'refusal') {
    const category = (message as { stop_details?: { category?: string | null } }).stop_details?.category;
    fail('refusal', `the model declined the request${category ? ` (${category})` : ''}`);
  }
  if (stop === 'max_tokens') {
    fail('truncated', 'the output was cut off at max_tokens, so the tool call may be incomplete', partial);
  }
  if (stop !== 'tool_use' && stop !== 'end_turn') fail('malformed', `unexpected stop_reason "${String(stop)}"`, partial);

  // Text, thinking and every other block type are ignored on purpose: only a
  // tool call can become output, and exactly one is acceptable.
  const calls = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
  if (calls.length === 0) fail('malformed', `no "${toolName}" tool call was made`);
  if (calls.length > 1) {
    fail(
      'malformed',
      `${calls.length} tool calls were made where exactly one was expected (${calls.map((c) => c.name).join(', ')})`,
      partial,
    );
  }

  const call = calls[0] as Anthropic.ToolUseBlock;
  if (call.name !== toolName) fail('malformed', `the tool call was "${call.name}", not "${toolName}"`, partial);

  const input = call.input;
  if (!isPlainObject(input)) fail('malformed', 'the tool input was not an object', input);
  // The list the reply must carry is named by the tool: `findings` for the quotes-only tool, `requirements` for the verdict tool.
  const listKey = toolName === 'record_verdicts' ? 'requirements' : 'findings';
  if (!Array.isArray((input as Record<string, unknown>)[listKey])) {
    fail('malformed', `the tool input has no "${listKey}" array`, input);
  }

  const response: LlmResponse = {
    // A copy, so nothing downstream can mutate the SDK's parsed object.
    output: structuredClone(input) as Record<string, unknown>,
    model,
    latencyMs,
  };
  if (usage) response.usage = usage;

  return response;
}

export function createAnthropicProvider(options: AnthropicProviderOptions): LlmProvider {
  const { apiKey, model, timeoutMs, maxRetries, logger } = options;
  const toolChoice: ToolChoiceMode = options.toolChoice ?? 'auto';
  const { temperature } = options;

  if (apiKey.trim() === '') {
    throw new LlmError(ANTHROPIC_PROVIDER, 'ANTHROPIC_API_KEY is not set.');
  }
  if (model.trim() === '') {
    throw new LlmError(ANTHROPIC_PROVIDER, 'ANTHROPIC_MODEL is empty.');
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new LlmError(ANTHROPIC_PROVIDER, 'The Anthropic timeout must be a positive number of milliseconds.');
  }
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MAX_RETRIES_CEILING) {
    throw new LlmError(ANTHROPIC_PROVIDER, `The Anthropic retry count must be between 0 and ${MAX_RETRIES_CEILING}.`);
  }
  if (!(TOOL_CHOICE_MODES as readonly string[]).includes(toolChoice)) {
    throw new LlmError(ANTHROPIC_PROVIDER, `The Anthropic tool choice must be one of: ${TOOL_CHOICE_MODES.join(', ')}.`);
  }
  if (temperature !== undefined && !(Number.isFinite(temperature) && temperature >= 0 && temperature <= 1)) {
    throw new LlmError(ANTHROPIC_PROVIDER, 'The Anthropic temperature must be a number from 0 to 1.');
  }

  // The configured key is the only credential. `authToken: null` stops an
  // ambient ANTHROPIC_AUTH_TOKEN from being sent alongside it, and the SDK's own
  // retries are off so this file's policy is the only one.
  const client: AnthropicMessagesClient =
    options.client ?? new Anthropic({ apiKey, authToken: null, timeout: timeoutMs, maxRetries: 0 });
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => performance.now());

  return {
    name: ANTHROPIC_PROVIDER,
    configured: true,

    async complete(request: LlmRequest): Promise<LlmResponse> {
      const started = now();
      const body = buildBody(request, model, toolChoice, temperature);

      let message: Anthropic.Message | undefined;
      for (let attempt = 1; message === undefined; attempt++) {
        try {
          message = await client.messages.create(body, { timeout: timeoutMs, maxRetries: 0 });
        } catch (err) {
          const failure = classify(err);

          if (failure.transient && attempt <= maxRetries) {
            const delayMs = retryDelayMs(attempt, failure.retryAfterSeconds);
            // Kind and status only. Neither the request nor the provider's own
            // message is logged here.
            logger?.warn('Anthropic request failed; retrying', {
              attempt,
              maxRetries,
              failure: failure.label,
              delayMs,
            });
            await sleep(delayMs);
            continue;
          }

          const detail = err instanceof Error ? scrub(err.message, [apiKey]) : 'no detail';
          throw new LlmFailure(
            ANTHROPIC_PROVIDER,
            failure.kind,
            `The Anthropic request failed (${failure.label}) after ${attempt} attempt${attempt === 1 ? '' : 's'}: ${detail}`,
            {
              label: failure.label,
              attempts: attempt,
              model,
              latencyMs: Math.max(0, Math.round(now() - started)),
            },
          );
        }
      }

      return readResponse(message, request.tool.name, model, Math.max(0, Math.round(now() - started)));
    },
  };
}
