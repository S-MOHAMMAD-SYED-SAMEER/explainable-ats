// How many output tokens an extraction may use.
//
// The answer a model gives is two things that both count against `max_tokens`:
//
//   * its own thinking. Some models (Sonnet 5.5) always think and cannot be told
//     not to; on a three-requirement CV of a few hundred words it used about 1,400
//     tokens before writing anything. More text to read and more requirements to
//     weigh mean more thinking, so the allowance grows with the CV.
//   * the findings: one entry per quoted passage, each carrying a requirement id,
//     the quote, two offsets and a sentence of reasoning.
//
// A limit that is too small does not produce a smaller answer, it produces a cut-off
// one, which is refused outright (`extraction_truncated`). So the limit is sized from
// the size of the job, with room for several passages per requirement, rather than
// fixed at a number that happened to suit a demo.
//
// It is capped, because a bigger limit is a longer wait and a bigger bill and the
// request has a timeout. Inside the cap, the answer for any CV and role the API
// accepts fits when the model quotes up to `PASSAGES_PER_REQUIREMENT` passages for each
// requirement; past the cap, a run that really needs more fails as truncated and
// says so, which is the honest outcome. These are estimates, and the live check in
// `scripts/live-failure-check.ts` records the real usage to compare them with.

/** Passages per requirement the budget has room for. The prompt asks for no more than this. */
export const PASSAGES_PER_REQUIREMENT = 4;

/**
 * Tokens for one finding. A quote of a sentence or two (about 90), a requirement id
 * (a UUID is about 20), two offsets, one sentence of reasoning (about 40) and the
 * JSON around them, rounded up.
 */
export const TOKENS_PER_PASSAGE = 220;

/** Thinking allowance before any CV has been read. */
export const THINKING_BASE_TOKENS = 4096;

/** Extra thinking allowance: one token for every this-many characters of CV. */
export const RESUME_CHARS_PER_THINKING_TOKEN = 16;

export const MIN_MAX_TOKENS = 4096;
export const MAX_TOKENS_CEILING = 32_000;

export type TokenBudgetInput = { requirementCount: number; resumeChars: number };

export function maxTokensFor({ requirementCount, resumeChars }: TokenBudgetInput): number {
  const thinking = THINKING_BASE_TOKENS + Math.ceil(Math.max(0, resumeChars) / RESUME_CHARS_PER_THINKING_TOKEN);
  const findings = Math.max(0, requirementCount) * PASSAGES_PER_REQUIREMENT * TOKENS_PER_PASSAGE;
  return Math.min(MAX_TOKENS_CEILING, Math.max(MIN_MAX_TOKENS, thinking + findings));
}
