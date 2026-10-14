import type { ReactNode } from 'react';
import type { ExtractionView } from '../api/types.ts';

// What the model call cost and how long it took, for the details area.
//
// Its own file so the assessment screen, which carries the decision form, stays free
// of anything about the model's usage: that screen is checked for nothing but the
// decision going through its one call.

export function ModelCallFacts({ extraction }: { extraction: ExtractionView | null }): ReactNode {
  // The stand-in matcher reports no usage, and a number that was not reported is not shown.
  if (extraction === null || extraction.inputTokens === null || extraction.outputTokens === null) return null;

  return (
    <p>
      The model call used <strong>{extraction.inputTokens.toLocaleString('en')}</strong> input and{' '}
      <strong>{extraction.outputTokens.toLocaleString('en')}</strong> output tokens
      {extraction.maxTokens !== null ? ` (output limit ${extraction.maxTokens.toLocaleString('en')})` : ''}
      {extraction.latencyMs !== null ? ` and took ${extraction.latencyMs.toLocaleString('en')} ms` : ''}.
    </p>
  );
}
