// The model boundary.
//
// One interface, so the pipeline never knows which provider it is talking to
// and a test can substitute a deterministic one without a network.
//
// WHAT THE MODEL IS ALLOWED TO DO, STATED AS A TYPE
//
// The response carries structured `output` and nothing else that matters. The
// extraction stage uses this to return evidence — a quote, and where in the
// resume it came from — and it never returns a score. Scores are computed by
// deterministic code from verified evidence, because a number a model invented
// cannot be explained, reproduced, or defended to a candidate.
//
// `tool` is not optional by accident. A forced tool call is what makes the
// reply a structure to validate rather than prose to parse.

export type LlmTool = {
  name: string;
  description: string;
  /** JSON Schema. The provider forces the model to answer in this shape. */
  inputSchema: Record<string, unknown>;
};

export type LlmMessage = { role: 'user' | 'assistant'; content: string };

export type LlmRequest = {
  /** What this call is for. Also the fixture key the mock replays. */
  purpose: string;
  promptVersion: string;
  systemPrompt: string;
  messages: LlmMessage[];
  tool: LlmTool;
  maxTokens: number;
};

export type LlmResponse = {
  /** The tool input the model produced. Always validated before use. */
  output: Record<string, unknown>;
  model: string;
  latencyMs: number;
  /** Present only when the provider reports it. Never invented. */
  usage?: { inputTokens: number; outputTokens: number };
};

export type LlmProvider = {
  name: string;
  /** Whether this provider could actually be called. Never a promise that it will work. */
  configured: boolean;
  complete(request: LlmRequest): Promise<LlmResponse>;
};

/** Raised when a provider cannot answer. Never swallowed into a fabricated result. */
export class LlmError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = 'LlmError';
    this.provider = provider;
  }
}
