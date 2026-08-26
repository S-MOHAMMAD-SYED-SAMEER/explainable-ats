import { MASK_CHAR } from './redact.ts';
import type { JobRequirement } from '../domain/ats.ts';

// The extraction prompt, and the parser that reads it back.
//
// Both live here because they are one contract. The deterministic stand-in
// model (`mockExtractor.ts`) has to read the requirements and the resume out of
// the message it is handed, exactly as a real model would — and if the builder
// and the reader drifted apart, the stand-in would silently start extracting
// from nothing and every fixture would go quietly empty.
//
// The section markers are deliberately unusual strings rather than bare words.
// A resume containing a line that reads "RESUME" is entirely plausible; one
// containing "=== RESUME ===" is not.

export const REQUIREMENTS_MARKER = '=== REQUIREMENTS ===';
export const RESUME_MARKER = '=== RESUME ===';

export function buildSystemPrompt(): string {
  return [
    'You are helping a recruiter screen a resume against a job specification.',
    '',
    'For each requirement, find the passages in the resume that speak to it and quote them EXACTLY.',
    'Copy the text character for character. Do not paraphrase, summarise, correct, or tidy it.',
    'If a requirement is not addressed anywhere in the resume, omit it rather than guessing.',
    '',
    'You do not decide whether a requirement is met, and you do not produce a score.',
    'Your only job is to find and quote the evidence. Someone else weighs it.',
    '',
    `Some passages appear as runs of "${MASK_CHAR}". Personal details have been removed there.`,
    'Never quote those runs and never speculate about what they contained.',
  ].join('\n');
}

export function buildUserMessage(requirements: readonly JobRequirement[], redactedText: string): string {
  const list = requirements
    .map((requirement) => `- [${requirement.id}] ${requirement.label} :: ${requirement.criterion}`)
    .join('\n');

  return [REQUIREMENTS_MARKER, list, '', RESUME_MARKER, redactedText].join('\n');
}

export type PromptRequirement = { id: string; label: string; criterion: string };

export type ParsedExtractionPrompt = {
  requirements: PromptRequirement[];
  /** The resume as the model was shown it — that is, already redacted. */
  resumeText: string;
};

const REQUIREMENT_LINE = /^- \[([^\]]+)\] (.*?) :: (.*)$/;

/**
 * Reads a prompt built by `buildUserMessage` back into its parts.
 *
 * Throws rather than returning something empty. A stand-in model that received
 * a message it could not understand and answered "no evidence found" would look
 * exactly like a candidate who matched nothing, and that is a failure mode
 * worth being loud about.
 */
export function parseExtractionPrompt(userMessage: string): ParsedExtractionPrompt {
  const resumeAt = userMessage.indexOf(`\n${RESUME_MARKER}\n`);
  if (!userMessage.startsWith(REQUIREMENTS_MARKER) || resumeAt === -1) {
    throw new Error('This message was not built by buildUserMessage: its section markers are missing.');
  }

  const head = userMessage.slice(REQUIREMENTS_MARKER.length, resumeAt);
  const resumeText = userMessage.slice(resumeAt + RESUME_MARKER.length + 2);

  const requirements: PromptRequirement[] = [];
  for (const line of head.split('\n')) {
    const match = REQUIREMENT_LINE.exec(line);
    if (match) {
      requirements.push({
        id: match[1] as string,
        label: match[2] as string,
        criterion: match[3] as string,
      });
    }
  }

  return { requirements, resumeText };
}
