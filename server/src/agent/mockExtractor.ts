import { parseExtractionPrompt, type PromptRequirement } from './extractionPrompt.ts';
import { significantTerms } from './matchRules.ts';
import { MASK_CHAR } from './redact.ts';
import type { LlmRequest } from '../adapters/llm/types.ts';
import type { MockLlmProvider } from '../adapters/llm/mock.ts';

// A deterministic stand-in for the extraction model.
//
// It exists so the whole pipeline can run offline, for free, and identically
// every time — during the demo, in CI, and in the evaluation harness. A run
// whose result changes between executions cannot tell you whether a change
// helped, so determinism here is not a testing convenience; it is what makes
// the numbers mean anything.
//
// WHAT IT DELIBERATELY IS AND IS NOT
//
// It is a keyword matcher that quotes whole lines. That is far cruder than a
// real model, and it is meant to be: its job is to exercise the contract, not
// to be good at screening. What matters is that it behaves like a WELL-BEHAVED
// model — every quote it returns is genuinely present, character for character,
// at the offsets it reports. So when a test wants to prove the verifier catches
// a fabrication, it has to register a fabrication explicitly, and that test then
// says what it means rather than depending on this thing misbehaving by luck.
//
// It never quotes a line containing a mask. That is stricter than the verifier
// requires — a partly-masked line has usable text on either side — but a
// stand-in that produced quotes the verifier had to reject would make every
// fixture read as if redaction were breaking extraction.

function keywordsOf(requirement: PromptRequirement): string[] {
  // The same notion of "what this criterion asks for" the matcher uses. One
  // definition, so the two cannot drift — and note what that means for tests:
  // the stand-in picks the line that maximises exactly the overlap the matcher
  // then measures, so a test of a SCORING rule has to supply its own evidence
  // rather than let the stand-in supply it.
  return significantTerms(`${requirement.label} ${requirement.criterion}`);
}

type Line = { text: string; start: number };

/** Splits into lines, keeping each line's offset in the ORIGINAL string. */
function linesWithOffsets(text: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  for (const raw of text.split('\n')) {
    lines.push({ text: raw, start: offset });
    offset += raw.length + 1;
  }
  return lines;
}

export type MockExtractorOptions = {
  /** How many passages to quote per requirement. One keeps fixtures readable. */
  maxPerRequirement?: number;
};

/**
 * Builds the responder function.
 *
 * Pure: the same prompt yields byte-identical findings, in a fixed order, on
 * every call and in every process.
 */
export function createDeterministicExtractor(options: MockExtractorOptions = {}) {
  const maxPerRequirement = options.maxPerRequirement ?? 1;

  return function respond(request: LlmRequest): Record<string, unknown> {
    const message = request.messages[request.messages.length - 1];
    if (!message) throw new Error('The extraction request carried no message.');

    const { requirements, resumeText } = parseExtractionPrompt(message.content);
    const lines = linesWithOffsets(resumeText);

    const findings: Array<Record<string, unknown>> = [];

    for (const requirement of requirements) {
      const keywords = keywordsOf(requirement);
      if (keywords.length === 0) continue;

      const scored: Array<{ line: Line; hits: number }> = [];
      for (const line of lines) {
        const trimmed = line.text.trim();
        if (trimmed.length < 8) continue;
        if (trimmed.includes(MASK_CHAR)) continue;

        const haystack = trimmed.toLowerCase();
        const hits = keywords.filter((keyword) => haystack.includes(keyword)).length;
        if (hits > 0) scored.push({ line, hits });
      }

      // Most keywords first; earliest line breaks a tie. Both halves are
      // total orders over the input, so the result cannot depend on the sort
      // implementation.
      scored.sort((a, b) => b.hits - a.hits || a.line.start - b.line.start);

      for (const { line, hits } of scored.slice(0, maxPerRequirement)) {
        const leading = line.text.length - line.text.trimStart().length;
        const quote = line.text.trim();
        const charStart = line.start + leading;

        findings.push({
          requirementId: requirement.id,
          quote,
          charStart,
          charEnd: charStart + quote.length,
          reasoning: `This line matches ${hits} term(s) from "${requirement.label}".`,
        });
      }
    }

    return { findings };
  };
}

/** Installs the stand-in for the extraction call on a mock provider. */
export function installDeterministicExtractor(
  provider: MockLlmProvider,
  options: MockExtractorOptions = {},
): void {
  provider.registerResponder('extract_evidence', createDeterministicExtractor(options));
}
