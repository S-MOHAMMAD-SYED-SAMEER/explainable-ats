import { createMockLlmProvider } from './mock.ts';
import { createAnthropicProvider } from './anthropic.ts';
import { LlmError, type LlmProvider } from './types.ts';
import type { AppConfig } from '../../config/env.ts';
import type { Logger } from '../../lib/logger.ts';

export { createMockLlmProvider, fixtureKey } from './mock.ts';
export { createAnthropicProvider, ANTHROPIC_PROVIDER, MAX_RETRIES_CEILING } from './anthropic.ts';
export type { AnthropicMessagesClient, AnthropicProviderOptions } from './anthropic.ts';
export { LlmError } from './types.ts';
export type { LlmProvider, LlmRequest, LlmResponse, LlmTool } from './types.ts';

/**
 * Builds the provider the configuration asks for.
 *
 * `mock` is the default, costs nothing and needs no key. `anthropic` is built
 * only when it is asked for by name, and only with a key: there is no fallback
 * between the two. A run that believed it called Claude but actually replayed a
 * fixture would invalidate every number taken from it — and that is exactly the
 * kind of result someone would put in a report.
 *
 * The public demo never comes through here. It builds its own mock provider, so
 * `LLM_PROVIDER=anthropic` cannot make an anonymous visitor's click spend money.
 */
export function createLlmProvider(config: AppConfig, options: { logger?: Logger } = {}): LlmProvider {
  switch (config.llmProvider) {
    case 'mock':
      return createMockLlmProvider();

    case 'anthropic': {
      if (config.anthropicApiKey === null) {
        throw new LlmError('anthropic', 'LLM_PROVIDER is "anthropic" but ANTHROPIC_API_KEY is not set.');
      }
      return createAnthropicProvider({
        apiKey: config.anthropicApiKey,
        model: config.anthropicModel,
        timeoutMs: config.anthropicTimeoutMs,
        maxRetries: config.anthropicMaxRetries,
        ...(options.logger ? { logger: options.logger } : {}),
      });
    }
  }
}
