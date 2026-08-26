import { createMockLlmProvider } from './mock.ts';
import { LlmError, type LlmProvider } from './types.ts';
import type { AppConfig } from '../../config/env.ts';

export { createMockLlmProvider, fixtureKey } from './mock.ts';
export { LlmError } from './types.ts';
export type { LlmProvider, LlmRequest, LlmResponse, LlmTool } from './types.ts';

/**
 * Builds the provider the configuration asks for.
 *
 * Asking for a provider that is not implemented fails loudly rather than
 * quietly falling back to the mock. A run that believed it called Sonnet 5 but
 * actually replayed a fixture would invalidate every number taken from it —
 * and that is exactly the kind of result someone would put in a report.
 *
 * The Anthropic provider is not wired yet. Extraction runs against the
 * deterministic stand-in, which is what keeps the demo offline, free and
 * reproducible; pointing it at a real model is a later, deliberate step, and
 * this function is where that switch will be made.
 */
export function createLlmProvider(config: AppConfig): LlmProvider {
  if (config.llmProvider === 'mock') return createMockLlmProvider();

  throw new LlmError(
    config.llmProvider,
    `The "${config.llmProvider}" provider is not implemented yet (it arrives with extraction in P3-C). Set LLM_PROVIDER=mock.`,
  );
}
