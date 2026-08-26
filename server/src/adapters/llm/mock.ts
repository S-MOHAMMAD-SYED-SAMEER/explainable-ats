import { LlmError, type LlmProvider, type LlmRequest, type LlmResponse } from './types.ts';

// The deterministic provider.
//
// It replays registered fixtures and nothing else. That is what lets the demo
// run identically every time, offline, at no cost — and it is what keeps the
// evaluation harness honest, because a run that varies between executions
// cannot tell you whether a change helped.
//
// IT FAILS LOUDLY WHEN IT HAS NOTHING
//
// An unregistered key raises rather than returning an empty structure. A mock
// that invents a plausible-looking answer is worse than no mock: the pipeline
// would carry on, the evidence verifier would see a quote that is not in the
// resume, and the fault would surface three stages away from its cause.

export type MockLlmProvider = LlmProvider & {
  /** Registers the reply for one `purpose`, or for one key within it. */
  register(key: string, output: Record<string, unknown>): void;
  /** Registers a failure, so error handling can be exercised deterministically. */
  registerFailure(key: string, message: string): void;
  /**
   * Registers a deterministic function to stand in for the model.
   *
   * A fixed fixture has to be written against one specific resume. A responder
   * reads the prompt it was actually given, which is what lets the demo ingest
   * a new resume and still produce quotes that exist in it. It must be a pure
   * function of the request: the same request has to give the same reply
   * forever, or the evaluation harness stops meaning anything.
   */
  registerResponder(key: string, respond: (request: LlmRequest) => Record<string, unknown>): void;
  /** Every call made, in order — what a test asserts against. */
  readonly calls: readonly LlmRequest[];
  reset(): void;
};

/**
 * The fixture key for a request.
 *
 * `purpose` alone is enough: one call shape exists per purpose, and a fixture
 * that has to vary with the resume is registered as a responder rather than as
 * a key. Keeping the derivation in one function means a future discriminator
 * lands in one place.
 */
export function fixtureKey(request: LlmRequest): string {
  return request.purpose;
}

export function createMockLlmProvider(): MockLlmProvider {
  const outputs = new Map<string, Record<string, unknown>>();
  const failures = new Map<string, string>();
  const responders = new Map<string, (request: LlmRequest) => Record<string, unknown>>();
  const calls: LlmRequest[] = [];

  return {
    name: 'mock',
    configured: true,
    calls,

    register(key, output) {
      outputs.set(key, output);
    },

    registerFailure(key, message) {
      failures.set(key, message);
    },

    registerResponder(key, respond) {
      responders.set(key, respond);
    },

    reset() {
      outputs.clear();
      failures.clear();
      responders.clear();
      calls.length = 0;
    },

    async complete(request: LlmRequest): Promise<LlmResponse> {
      calls.push(request);
      const key = fixtureKey(request);

      const failure = failures.get(key);
      if (failure !== undefined) throw new LlmError('mock', failure);

      // An explicit fixture wins over a responder: a test that pinned one exact
      // reply is making a point about that reply, and a generic stand-in
      // quietly overriding it would make the test assert something else.
      const responder = responders.get(key);
      const output = outputs.get(key) ?? (responder ? responder(request) : undefined);
      if (output === undefined) {
        throw new LlmError(
          'mock',
          `No fixture registered for "${key}". The mock never invents a reply — register one, or expect this to fail.`,
        );
      }

      // Returned by value, so a caller that mutates what it got cannot corrupt
      // the fixture for the next call. Determinism has to survive its callers.
      return {
        output: structuredClone(output),
        model: 'mock',
        latencyMs: 0,
      };
    },
  };
}
