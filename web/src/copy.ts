// Recruiter language, in one place.
//
// Everything a recruiter reads is written here; the schema's vocabulary stays
// in the schema. `shortlist`, `not_met` and `needs_review` are good column
// values and terrible things to put in front of a person making a decision
// about someone's career.
//
// Kept as a pure module with no JSX so it can be unit-tested without rendering
// anything — the test asserts these maps are total over the server's enums, so
// a new verdict cannot reach a screen as a raw identifier.

export const TIERS = ['qualified', 'needs_review', 'gated', 'not_evaluated'] as const;
export type Tier = (typeof TIERS)[number];

export const VERDICTS = ['met', 'partial', 'not_met', 'unclear'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const OUTCOMES = ['shortlist', 'reject', 'hold'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export type Wording = { label: string; detail: string; tone: 'good' | 'warn' | 'bad' | 'neutral' };

export const TIER_WORDING: Readonly<Record<Tier, Wording>> = Object.freeze({
  qualified: {
    label: 'Meets every must-have',
    detail: 'Every essential requirement is backed by a passage quoted from the CV.',
    tone: 'good',
  },
  needs_review: {
    label: 'Worth a look',
    detail: 'The CV says nothing either way about an essential requirement. That is a gap in the CV, not a mark against the candidate.',
    tone: 'warn',
  },
  gated: {
    label: 'Missing an essential',
    detail: 'We found relevant text for an essential requirement and it does not show what the role needs.',
    tone: 'bad',
  },
  not_evaluated: {
    label: 'Not assessed yet',
    detail: 'This candidate has not been assessed against this role, so there is nothing to rank.',
    tone: 'neutral',
  },
});

/**
 * The distinction the whole product turns on.
 *
 * `not_met` means we looked, found something relevant, and it fell short.
 * `unclear` means the CV is silent. Those are different facts about a person,
 * and a screen that showed both as "no" would be quietly unfair to the second.
 */
export const VERDICT_WORDING: Readonly<Record<Verdict, Wording>> = Object.freeze({
  met: {
    label: 'Met',
    detail: 'Backed by a passage quoted from the CV.',
    tone: 'good',
  },
  partial: {
    label: 'Partly met',
    detail: 'The quoted passage covers some of what this asks for, not all of it.',
    tone: 'warn',
  },
  not_met: {
    label: 'Does not meet',
    detail: 'We found relevant text in the CV and it does not show this.',
    tone: 'bad',
  },
  unclear: {
    label: 'Not demonstrated',
    detail: 'Nothing in the CV speaks to this either way. Worth asking about rather than assuming.',
    tone: 'warn',
  },
});

export const OUTCOME_WORDING: Readonly<Record<Outcome, Wording>> = Object.freeze({
  shortlist: { label: 'Shortlist', detail: 'Move this candidate forward.', tone: 'good' },
  hold: { label: 'Hold', detail: 'Park this one for a closer look or a conversation.', tone: 'warn' },
  reject: { label: 'Reject', detail: 'Do not take this candidate further.', tone: 'bad' },
});

/** The minimum the server accepts. Shown in the form so it is never a surprise. */
export const MIN_REASON_CHARS = 10;

export function tierWording(tier: string): Wording {
  return TIER_WORDING[tier as Tier] ?? { label: tier, detail: '', tone: 'neutral' };
}

export function verdictWording(verdict: string | null): Wording {
  if (verdict === null) return { label: 'Not assessed', detail: '', tone: 'neutral' };
  return VERDICT_WORDING[verdict as Verdict] ?? { label: verdict, detail: '', tone: 'neutral' };
}

export function outcomeWording(outcome: string): Wording {
  return OUTCOME_WORDING[outcome as Outcome] ?? { label: outcome, detail: '', tone: 'neutral' };
}

export function toneClass(tone: Wording['tone']): string {
  switch (tone) {
    case 'good':
      return 'text-success';
    case 'bad':
      return 'text-danger';
    case 'warn':
      return 'text-signal';
    default:
      return 'text-ink';
  }
}

/** Essential or desirable — the words a job advert would use. */
export function kindLabel(kind: string): string {
  return kind === 'must_have' ? 'Essential' : 'Desirable';
}

// --- the model's verdict and the second opinion ----------------------------------------------------------------------------------

/** What a recruiter reads about a requirement's second opinion. Every difference is shown and none changes the score; a credited quote that shares no word with the requirement is flagged, and on a must-have it routes the candidate to review. */
export const SECOND_OPINION = {
  banner:
    'Quote shares no words with the requirement; a person should check. On at least one must-have the model credited the candidate on a passage that has no word in common with it. The score is the model\'s verified verdict and has not been changed.',
  quoteNoOverlap: 'Quote shares no words with the requirement; a person should check.',
  shownOnly: 'The two differ by two steps or more. Shown, not acted on: the model\'s verified verdict is what is scored.',
  oneStep: 'The two differ by one step. Shown, not acted on.',
  lowered: (verdictLabel: string): string => `Lowered to ${verdictLabel.toLowerCase()} by the code: no passage the model quoted for this was found in the CV.`,
} as const;

/**
 * A replay of a saved real reply (`server/scripts/live-replay.ts`) records itself as `replay:<model>:<date>`. It is not the stand-in
 * extractor and it is not a live call, and the history says exactly that.
 */
const MODEL_NAMES: Readonly<Record<string, string>> = {
  'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
};

export function isReplay(actorId: string | null): actorId is string {
  return actorId !== null && actorId.startsWith('replay:');
}

export function replayDescription(actorId: string): string {
  const [, model = '', date = ''] = actorId.split(':');
  return `Replayed from a saved ${MODEL_NAMES[model] ?? (model || 'model')} reply${date ? ` (${date})` : ''}, no new request`;
}
