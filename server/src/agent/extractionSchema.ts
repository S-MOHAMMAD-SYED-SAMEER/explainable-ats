import type { LlmTool } from '../adapters/llm/types.ts';

// What the model is allowed to return, and how it is checked.
//
// THE MODEL CITES. IT DOES NOT JUDGE, AND IT DOES NOT SCORE.
//
// A finding is a quote and where it came from. There is no verdict field and no
// number, because a verdict is a judgement about whether evidence satisfies a
// criterion — that is P3-D's stage, working from evidence that has already been
// verified. Letting the model return a score here would make the number
// unexplainable and unreproducible, which is the exact failure this product
// exists to avoid.
//
// VALIDATION IS STRICT AND FAILS CLOSED
//
// Every field is checked. Anything malformed is dropped with a reason rather
// than coerced, because a coerced field is a fabricated one: a missing quote
// turned into an empty string would become evidence that says nothing and
// cites nothing.

export const EXTRACTION_PROMPT_VERSION = 'extract-v1';

export const EXTRACTION_TOOL: LlmTool = {
  name: 'record_evidence',
  description:
    'Record, for each requirement, the passages in the resume that speak to it. ' +
    'Quote the resume exactly. Never paraphrase, never summarise, and never write a quote ' +
    'that is not present in the text you were given. If a requirement is not addressed, omit it.',
  inputSchema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            requirementId: { type: 'string', description: 'The requirement this passage speaks to.' },
            quote: { type: 'string', description: 'Exact text from the resume. Copied, never rewritten.' },
            charStart: { type: 'integer', description: 'Where the quote begins in the resume text.' },
            charEnd: { type: 'integer', description: 'Where the quote ends (exclusive).' },
            reasoning: { type: 'string', description: 'One sentence: why this passage is relevant.' },
          },
          required: ['requirementId', 'quote', 'charStart', 'charEnd', 'reasoning'],
        },
      },
    },
    required: ['findings'],
  },
};

export type RawFinding = {
  requirementId: string;
  quote: string;
  charStart: number;
  charEnd: number;
  reasoning: string;
};

export type RejectedFinding = {
  /** Why it was dropped. Recorded in the audit trail, never shown as evidence. */
  reason:
    | 'not_an_object'
    | 'missing_field'
    | 'wrong_type'
    | 'empty_quote'
    | 'unknown_requirement'
    | 'invalid_offsets';
  detail: string;
};

export type ValidationResult = {
  accepted: RawFinding[];
  rejected: RejectedFinding[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Checks the model's output against the contract.
 *
 * Structural only — whether a quote is *true* is the verifier's job, and it is
 * a separate step on purpose: this one can be reasoned about without a resume
 * in hand.
 *
 * `knownRequirementIds` is required rather than optional. A finding against a
 * requirement that does not belong to this job is not a small mistake to be
 * tidied away; it means the model answered a question nobody asked, and
 * attaching it to some other requirement would invent a claim.
 */
export function validateExtraction(output: unknown, knownRequirementIds: ReadonlySet<string>): ValidationResult {
  const accepted: RawFinding[] = [];
  const rejected: RejectedFinding[] = [];

  if (!isRecord(output)) {
    return { accepted, rejected: [{ reason: 'not_an_object', detail: `output was ${typeof output}` }] };
  }

  const findings = output.findings;
  if (!Array.isArray(findings)) {
    return {
      accepted,
      rejected: [{ reason: 'missing_field', detail: `"findings" was ${findings === undefined ? 'absent' : typeof findings}` }],
    };
  }

  findings.forEach((raw, index) => {
    if (!isRecord(raw)) {
      rejected.push({ reason: 'not_an_object', detail: `findings[${index}] was ${typeof raw}` });
      return;
    }

    for (const field of ['requirementId', 'quote', 'reasoning'] as const) {
      if (typeof raw[field] !== 'string') {
        rejected.push({
          reason: raw[field] === undefined ? 'missing_field' : 'wrong_type',
          detail: `findings[${index}].${field}`,
        });
        return;
      }
    }
    for (const field of ['charStart', 'charEnd'] as const) {
      if (typeof raw[field] !== 'number' || !Number.isInteger(raw[field])) {
        rejected.push({
          reason: raw[field] === undefined ? 'missing_field' : 'wrong_type',
          detail: `findings[${index}].${field}`,
        });
        return;
      }
    }

    const finding: RawFinding = {
      requirementId: raw.requirementId as string,
      quote: raw.quote as string,
      charStart: raw.charStart as number,
      charEnd: raw.charEnd as number,
      reasoning: raw.reasoning as string,
    };

    if (finding.quote.trim().length === 0) {
      rejected.push({ reason: 'empty_quote', detail: `findings[${index}]` });
      return;
    }
    if (!knownRequirementIds.has(finding.requirementId)) {
      rejected.push({ reason: 'unknown_requirement', detail: `findings[${index}] cites a requirement not on this job` });
      return;
    }
    if (finding.charStart < 0 || finding.charEnd <= finding.charStart) {
      rejected.push({ reason: 'invalid_offsets', detail: `findings[${index}] spans ${finding.charStart}-${finding.charEnd}` });
      return;
    }

    accepted.push(finding);
  });

  return { accepted, rejected };
}
