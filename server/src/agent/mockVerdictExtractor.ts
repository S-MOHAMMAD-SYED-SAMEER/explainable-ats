import { createDeterministicExtractor, type MockExtractorOptions } from './mockExtractor.ts';
import { parseExtractionPrompt } from './extractionPrompt.ts';
import { DEFAULT_MATCH_MODE, decideMatch } from './matchRules.ts';
import { VERDICT_PURPOSE } from './verdictExtraction.ts';
import type { LlmRequest } from '../adapters/llm/types.ts';
import type { MockLlmProvider } from '../adapters/llm/mock.ts';

// A deterministic stand-in for the model in `model_checked` mode.
//
// It quotes exactly what the quotes-only stand-in quotes (the same lines, picked the same way), and its verdict for a requirement
// is what the matcher says about those quotes, in the matcher's mode. So with the same match mode the second opinion always
// agrees and an offline run gives the outcomes the matcher alone gives: it exercises the whole contract (the verdict shape, the
// verification, the enforcement, the second opinion) without pretending to be a model that can read.
//
// Anything a test wants to show about a model that DISAGREES with the matcher, or that lies, is registered explicitly on the
// provider by that test, so the test says what it means instead of depending on this misbehaving by luck.

export function createDeterministicVerdictExtractor(options: MockExtractorOptions = {}) {
  const quoteLines = createDeterministicExtractor(options);
  const matchMode = options.matchMode ?? DEFAULT_MATCH_MODE;

  return function respond(request: LlmRequest): Record<string, unknown> {
    const { findings } = quoteLines(request) as { findings: Array<{ requirementId: string; quote: string; reasoning: string }> };
    const message = request.messages[request.messages.length - 1];
    if (!message) throw new Error('The extraction request carried no message.');
    const { requirements } = parseExtractionPrompt(message.content);

    return {
      requirements: requirements.map((requirement) => {
        const mine = findings.filter((finding) => finding.requirementId === requirement.id);
        const decision = decideMatch(
          requirement,
          mine.map((finding) => ({ requirementId: requirement.id, quote: finding.quote, verified: true })),
          matchMode,
        );
        return {
          requirementId: requirement.id,
          verdict: decision.verdict,
          passages: mine.map((finding) => finding.quote),
          reason: mine.length === 0 ? 'No line of the resume speaks to this requirement.' : (mine[0] as { reasoning: string }).reasoning,
        };
      }),
    };
  };
}

/** Installs the verdict stand-in for the extraction call on a mock provider. */
export function installDeterministicVerdictExtractor(provider: MockLlmProvider, options: MockExtractorOptions = {}): void {
  provider.registerResponder(VERDICT_PURPOSE, createDeterministicVerdictExtractor(options));
}
