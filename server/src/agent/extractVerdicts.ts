import { maxTokensFor } from './tokenBudget.ts';
import { buildUserMessage } from './extractionPrompt.ts';
import { EXTRACTION_EMPTY_EVENT } from './failures.ts';
import { recordExtractionFailure, type ExtractDeps } from './extract.ts';
import { verifyEvidence } from './verifyEvidence.ts';
import { enforceVerdicts, type ModelAnswer } from './verdictEnforcement.ts';
import {
  VERDICT_PROMPT_VERSION,
  VERDICT_PURPOSE,
  VERDICT_TOOL,
  buildVerdictSystemPrompt,
  validateVerdictOutput,
} from './verdictExtraction.ts';
import { AppError } from '../lib/errors.ts';
import { LlmFailure } from '../adapters/llm/failures.ts';
import type { Evaluation } from '../domain/ats.ts';
import type { RawFinding } from './extractionSchema.ts';
import type { RedactionSpan } from './redact.ts';

// EXTRACT, in `model_checked` mode: the model proposes a verdict per requirement with the passages it relies on, and the code
// proves each passage and enforces the rules before any verdict can count.
//
// Same stage, same safeguards as `extractEvidence`:
//   1. the model is shown the redacted text and never the original;
//   2. every passage is checked against the REAL document (`content_text`), word for word, 15 characters or more, and
//      a passage that fails is kept as `verified = false` so a fabrication stays visible, and counts for nothing;
//   3. a verdict of met or partial with no surviving passage is lowered to `unclear` (audit `verdict_downgraded_no_evidence`).
//
// What this stage writes for the match stage: the verified evidence (as before), and one `verdict_checks` row per requirement
// holding the model's verdict and what the code made of it. The matcher's second opinion and the score come after, in
// `matchAndScore`, which needs only those rows and the verified evidence.

export type VerdictExtractionOutcome = {
  evaluation: Evaluation;
  verified: number;
  rejected: number;
  malformed: number;
  /** Verdicts the code lowered because no passage stood behind them. */
  downgraded: number;
};

export async function extractVerdicts(deps: ExtractDeps, evaluationId: string): Promise<VerdictExtractionOutcome> {
  const { repos, provider, logger } = deps;

  const evaluation = await repos.evaluations.getById(evaluationId);
  if (!evaluation) throw new AppError('NOT_FOUND', 'That evaluation does not exist.');
  if (evaluation.status !== 'pending') throw new AppError('INVALID_STATE', `This evaluation has already been ${evaluation.status}.`);

  const resume = await repos.resumes.getById(evaluation.resumeId);
  if (!resume) throw new AppError('INVALID_STATE', 'The resume for this evaluation is missing.');

  const requirements = await repos.requirements.listForJob(evaluation.jobId);
  if (requirements.length === 0) throw new AppError('INVALID_STATE', 'This job has no requirements, so there is nothing to look for.');

  const sensitive = await repos.sensitiveFindings.listForResume(resume.id);
  const redactionSpans: RedactionSpan[] = sensitive.map((finding) => ({ category: finding.category, charStart: finding.charStart, charEnd: finding.charEnd }));

  const maxTokens = deps.maxTokens ?? maxTokensFor({ requirementCount: requirements.length, resumeChars: resume.redactedText.length });
  const fail = (err: unknown): Promise<never> => recordExtractionFailure(deps, evaluation, maxTokens, err);

  // --- the model call: the redacted text, nothing else ------------------------------------------------------
  let output: Record<string, unknown>;
  let model: string;
  let latencyMs: number;
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  try {
    const response = await provider.complete({
      purpose: VERDICT_PURPOSE,
      promptVersion: VERDICT_PROMPT_VERSION,
      systemPrompt: buildVerdictSystemPrompt(),
      messages: [{ role: 'user', content: buildUserMessage(requirements, resume.redactedText) }],
      tool: VERDICT_TOOL,
      maxTokens,
    });
    output = response.output;
    model = response.model;
    latencyMs = response.latencyMs;
    usage = response.usage;
  } catch (err) {
    return fail(err);
  }

  if (!Array.isArray(output.requirements)) {
    return fail(
      new LlmFailure(provider.name, 'malformed', 'The reply had no "requirements" list.', { model, latencyMs, ...(usage ? { usage } : {}), raw: output }),
    );
  }

  // The answer is kept exactly as it came, before anything is validated or dropped.
  const passagesReturned = output.requirements.reduce<number>((sum, entry) => {
    const passages = (entry as { passages?: unknown } | null)?.passages;
    return sum + (Array.isArray(passages) ? passages.length : 0);
  }, 0);
  await repos.evaluationRecords.record({
    evaluationId,
    result: 'succeeded',
    model,
    maxTokens,
    usage: usage ?? null,
    latencyMs,
    findingsReturned: passagesReturned,
    raw: output,
  });

  // --- the shape ---------------------------------------------------------------------------------------------
  const known = new Set(requirements.map((requirement) => requirement.id));
  const validation = validateVerdictOutput(output, known);

  if (validation.rejected.length > 0 || validation.passagesOverLimit > 0 || validation.passagesNotText > 0) {
    await repos.audit.append({
      correlationId: evaluation.id,
      stage: 'extract',
      eventType: 'malformed_findings_dropped',
      actor: 'system',
      outcome: 'blocked',
      summary: `${validation.rejected.length} verdict(s) and ${validation.passagesOverLimit + validation.passagesNotText} passage(s) did not match the required shape and were dropped.`,
      payload: {
        reasons: validation.rejected.map((entry) => entry.reason),
        details: validation.rejected.map((entry) => entry.detail),
        passagesOverLimit: validation.passagesOverLimit,
        passagesNotText: validation.passagesNotText,
      },
      entityType: 'evaluation',
      entityId: evaluation.id,
    });
  }

  const answers = new Map<string, ModelAnswer>(validation.accepted.map((entry) => [entry.requirementId, { verdict: entry.verdict, reason: entry.reason }]));

  // The model answered properly and quoted nothing, and called every requirement unclear (or skipped it). That is a real
  // result, and also what an empty or garbled paste looks like, so it is flagged rather than left to pass as ordinary.
  const quotedNothing = validation.accepted.every((entry) => entry.passages.length === 0);
  const claimedAnything = validation.accepted.some((entry) => entry.verdict === 'met' || entry.verdict === 'partial' || entry.verdict === 'not_met');
  if (passagesReturned === 0 && quotedNothing && !claimedAnything) {
    await repos.audit.append({
      correlationId: evaluation.id,
      stage: 'extract',
      eventType: EXTRACTION_EMPTY_EVENT,
      actor: 'ai',
      actorId: model,
      outcome: 'ok',
      summary: 'The model read the resume and found nothing for any requirement. Every requirement will read as not demonstrated.',
      payload: { model, requirements: requirements.length, resumeChars: resume.redactedText.length },
      entityType: 'evaluation',
      entityId: evaluation.id,
    });
  }

  // --- every passage against the REAL resume -----------------------------------------------------------------
  const findings: RawFinding[] = [];
  for (const entry of validation.accepted) {
    for (const passage of entry.passages) {
      // The offsets are a hint the verifier is free to ignore: a passage is located by its words.
      findings.push({ requirementId: entry.requirementId, quote: passage, charStart: 0, charEnd: passage.length, reasoning: entry.reason });
    }
  }
  const { verified, rejected } = verifyEvidence(findings, { contentText: resume.contentText, redactionSpans });

  for (const entry of verified) {
    await repos.evidence.record({
      evaluationId: evaluation.id,
      resumeId: resume.id,
      requirementId: entry.finding.requirementId,
      quote: entry.finding.quote,
      charStart: entry.charStart,
      charEnd: entry.charEnd,
      verified: true,
    });
  }
  // Stored but never verified, so a fabrication is visible and counts for nothing.
  for (const entry of rejected) {
    await repos.evidence.record({
      evaluationId: evaluation.id,
      resumeId: resume.id,
      requirementId: entry.finding.requirementId,
      quote: entry.finding.quote,
      charStart: Math.max(0, entry.finding.charStart),
      charEnd: Math.max(1, entry.finding.charEnd),
      verified: false,
    });
  }
  if (rejected.length > 0) {
    await repos.audit.append({
      correlationId: evaluation.id,
      stage: 'verify',
      eventType: 'unverifiable_evidence_rejected',
      actor: 'system',
      outcome: 'blocked',
      summary:
        `${rejected.length} quoted passage(s) were rejected: not found in the resume, over a masked detail, or too short to count. ` +
        'Nothing that cannot be found in the document is shown or counted.',
      payload: { reasons: rejected.map((entry) => entry.reason) },
      entityType: 'evaluation',
      entityId: evaluation.id,
    });
  }
  await repos.audit.append({
    correlationId: evaluation.id,
    stage: 'verify',
    eventType: 'evidence_verified',
    actor: 'system',
    outcome: 'ok',
    summary: `${verified.length} passage(s) were found in the resume exactly as quoted.`,
    payload: {
      verified: verified.length,
      rejected: rejected.length,
      malformed: validation.rejected.length,
      offsetsCorrected: verified.filter((entry) => !entry.offsetsWereCorrect).length,
    },
    entityType: 'evaluation',
    entityId: evaluation.id,
  });

  // --- the code's rules for a verdict --------------------------------------------------------------------------
  const verifiedByRequirement = new Map<string, string[]>();
  for (const entry of verified) {
    const list = verifiedByRequirement.get(entry.finding.requirementId) ?? [];
    list.push(entry.finding.quote);
    verifiedByRequirement.set(entry.finding.requirementId, list);
  }
  const enforced = enforceVerdicts({ requirements, answers, verifiedPassages: verifiedByRequirement, contentText: resume.contentText });

  for (const entry of enforced) {
    await repos.verdictChecks.record({
      evaluationId: evaluation.id,
      requirementId: entry.requirementId,
      verdictMode: 'model_checked',
      modelVerdict: entry.modelVerdict,
      modelReason: entry.modelReason,
      enforcedVerdict: entry.enforcedVerdict,
      downgradeReason: entry.downgrade,
      // The second opinion is the match stage's: nothing is claimed about it yet.
      matcherVerdict: null,
      matcherMode: null,
      disagreement: 'none',
      scoredVerdict: entry.enforcedVerdict,
    });
  }

  const downgraded = enforced.filter((entry) => entry.downgrade === 'no_verified_passage');
  if (downgraded.length > 0) {
    await repos.audit.append({
      correlationId: evaluation.id,
      stage: 'verify',
      eventType: 'verdict_downgraded_no_evidence',
      actor: 'system',
      outcome: 'blocked',
      summary:
        `${downgraded.length} verdict(s) were lowered to unclear: the model claimed a verdict but no passage it quoted was found in the resume. ` +
        'A verdict needs evidence that is really in the document.',
      payload: {
        verdicts: downgraded.map((entry) => ({
          requirementId: entry.requirementId,
          label: requirements.find((requirement) => requirement.id === entry.requirementId)?.label ?? null,
          modelVerdict: entry.modelVerdict,
          enforcedVerdict: entry.enforcedVerdict,
        })),
      },
      entityType: 'evaluation',
      entityId: evaluation.id,
    });
  }

  const updated = await repos.evaluations.recordExtraction(evaluation.id, { model, promptVersion: VERDICT_PROMPT_VERSION, latencyMs });
  if (!updated) throw new AppError('INVALID_STATE', 'This evaluation moved on while extraction was running.');

  await repos.audit.append({
    correlationId: evaluation.id,
    stage: 'extract',
    eventType: 'extraction_recorded',
    actor: 'ai',
    actorId: model,
    outcome: 'ok',
    summary: `Read the resume against ${requirements.length} requirement(s) and proposed a verdict for each.`,
    payload: { model, promptVersion: VERDICT_PROMPT_VERSION, requirements: requirements.length, verdictMode: 'model_checked', ...(usage ? { usage } : {}) },
    entityType: 'evaluation',
    entityId: evaluation.id,
  });

  logger?.info('Verdict extraction complete', {
    evaluationId,
    verified: verified.length,
    rejected: rejected.length,
    downgraded: downgraded.length,
    ...(usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens } : {}),
  });

  return { evaluation: updated, verified: verified.length, rejected: rejected.length, malformed: validation.rejected.length, downgraded: downgraded.length };
}
