import { hasBodyContent } from './demo.ts';
import { handleJobDetail, handleJobList, handleJobRanking } from './jobs.ts';
import { handleDecision, handleEvaluationAudit, handleEvaluationDetail } from './evaluations.ts';
import { isDemoScenarioId } from '../demo/runScenario.ts';
import { AppError, ValidationError } from '../lib/errors.ts';
import type { DemoSessionStore, VisitorSandbox } from '../demo/sessions.ts';
import type { Logger } from '../lib/logger.ts';
import type { HandlerResult } from './types.ts';

// The visitor-scoped demo session endpoints' handlers.
//
// THE RULE THAT SHAPES THIS FILE
//
// Nothing here is handed the canonical repositories. `DemoSessionDeps` has a
// store and a logger, and every read below runs against the repositories that
// belong to the one session the request's cookie names. So the question "could a
// demo request reach a recruiter's record?" has a structural answer, not a
// checked one: there is no reference to the canonical database in this module's
// reach to misuse.
//
// The reads are the recruiter reads — `handleJobList`, `handleEvaluationDetail`
// and the rest — pointed at a private database. Their output shapes are the
// same, which is what lets the dashboard draw a demo session without a second
// set of screens, and their logic is not restated.
//
// The writes here are the session's own lifecycle (start, reset, end) and one
// more: a visitor's decision on a demo candidate. That one is NOT the recruiter's
// decision route and does not share its credential. It reuses the recruiter's
// handler — so the outcomes, the reason rule, the one-decision-per-assessment
// rule and the audit event are the same code, not a copy — but hands it the
// visitor's own repositories and a fixed demo actor. The recruiter route
// (`POST /evaluations/:id/decision`) is untouched and still needs an operator
// session and a CSRF token.

export type DemoSessionDeps = {
  store: DemoSessionStore;
  logger?: Logger;
};

export type DemoSessionView = {
  /** The visitor's own copy of the demo job. */
  jobId: string;
  jobTitle: string;
  /** When the session lapses if it goes unused, ISO-8601. */
  expiresAt: string;
};

export type DemoSessionStatus = { active: false } | ({ active: true } & DemoSessionView);

export function viewOf(sandbox: VisitorSandbox): DemoSessionView {
  return { jobId: sandbox.jobId, jobTitle: sandbox.jobTitle, expiresAt: sandbox.expiresAt };
}

/**
 * The refusal for a request that needs a session and has none.
 *
 * One answer for "no cookie", "malformed cookie", "unknown session" and
 * "expired session" alike. Telling them apart would tell someone guessing
 * whether a token was well-formed, or once real.
 */
export function noDemoSession(): AppError {
  return new AppError('UNAUTHORIZED', 'There is no active demo session. Start the demo and try again.');
}

function refuseBody(body: unknown): void {
  if (hasBodyContent(body)) {
    throw new AppError('VALIDATION_ERROR', 'This endpoint does not accept a request body.');
  }
}

export function handleDemoSessionStatus(sandbox: VisitorSandbox | null): HandlerResult<DemoSessionStatus> {
  return {
    status: 200,
    body: sandbox ? { active: true, ...viewOf(sandbox) } : { active: false },
  };
}

/** Reads, against the visitor's own repositories. */

export function demoJobList(sandbox: VisitorSandbox) {
  return handleJobList({ repos: sandbox.repos });
}

export function demoJobDetail(sandbox: VisitorSandbox, jobId: string) {
  return handleJobDetail({ repos: sandbox.repos }, jobId);
}

export function demoJobRanking(sandbox: VisitorSandbox, jobId: string) {
  return handleJobRanking({ repos: sandbox.repos }, jobId);
}

export function demoEvaluationDetail(sandbox: VisitorSandbox, evaluationId: string) {
  return handleEvaluationDetail({ repos: sandbox.repos }, evaluationId);
}

export function demoEvaluationAudit(sandbox: VisitorSandbox, evaluationId: string) {
  return handleEvaluationAudit({ repos: sandbox.repos }, evaluationId);
}

export type DemoResumeView = {
  /** The redacted text, character for character as stored. Nothing else about the resume. */
  text: string;
};

/**
 * The resume an evaluation was made from, as the pipeline saw it: redacted.
 *
 * THIS IS THE ONE PLACE A RESUME'S TEXT LEAVES THE SERVER, AND IT IS NARROW ON
 * PURPOSE
 *
 * It reads `redactedText` and never `contentText`. The original is not selected,
 * not held in a variable and not named in the response, so there is no code path
 * on which it could be sent by mistake — a test asserts the original's personal
 * details are absent from every demo candidate's response, and another that this
 * file never mentions `contentText`. Redaction replaces every protected span with
 * a mask of the SAME length, so the stored evidence offsets index this text
 * exactly and the screen can highlight in it without any mapping.
 *
 * It is looked up in the visitor's own repositories only, like every other read
 * here, and is served by no canonical route: the recruiter API has no resume
 * endpoint, and none was added.
 */
export async function demoEvaluationResume(
  sandbox: VisitorSandbox,
  evaluationId: string,
): Promise<HandlerResult<DemoResumeView>> {
  const evaluation = await sandbox.repos.evaluations.getById(evaluationId);
  if (!evaluation) throw new AppError('NOT_FOUND', 'That evaluation does not exist.');

  const resume = await sandbox.repos.resumes.getById(evaluation.resumeId);
  if (!resume) throw new AppError('NOT_FOUND', 'That evaluation does not exist.');

  return { status: 200, body: { text: resume.redactedText } };
}

/**
 * "Run" a fixed scenario in this visitor's session.
 *
 * The session already holds every scenario, produced by the real pipeline when
 * it was built, so a run resolves to that evaluation rather than building a
 * second one: the same repeat-runs-are-the-same-run behaviour the shared sandbox
 * has. The scenario still comes from the path and nowhere else, checked against
 * the same literal allow-list, and a body is refused outright.
 */
export function handleDemoSessionRun(
  sandbox: VisitorSandbox,
  scenarioParam: unknown,
  body: unknown,
): HandlerResult<{ evaluationId: string }> {
  refuseBody(body);

  if (!isDemoScenarioId(scenarioParam)) {
    throw new AppError('NOT_FOUND', 'That demo scenario does not exist.');
  }

  return { status: 200, body: { evaluationId: sandbox.evaluationFor(scenarioParam) } };
}

export { refuseBody as refuseDemoBody };

/**
 * Who a demo decision is recorded as.
 *
 * Fixed, and never taken from the request: a decision made through this route is
 * attributed to the demo and to nobody else. It is also not a name the operator
 * can have, so a demo decision can never be mistaken for a recruiter's.
 */
export const DEMO_ACTOR = 'demo-visitor';

/**
 * Drops the "(received ...)" tail the shared validator appends to a bad enum.
 *
 * Behind a login, quoting the rejected value back is a convenience. On an
 * anonymous endpoint it reflects up to the whole request body into a response,
 * so the demo's validation errors say what was wrong and not what was sent.
 */
function withoutEcho(problem: string): string {
  return problem.replace(/ \(received [\s\S]*\)$/, '');
}

const ALREADY_DECIDED = 'You have already recorded a decision on this demo candidate. Use Reset demo to start over.';

/**
 * Records a visitor's decision on a demo candidate, in their own sandbox only.
 *
 * The evaluation id is resolved against `sandbox.repos` and nowhere else, so a
 * canonical id is simply "not found" here and an id from another visitor's
 * session is whatever this visitor's own session holds under that id — their own
 * record, never the other visitor's. The decision body is validated by the same
 * `parseDecision` the recruiter route uses.
 */
export async function handleDemoDecision(sandbox: VisitorSandbox, evaluationId: string, body: unknown) {
  try {
    return await handleDecision({ repos: sandbox.repos }, evaluationId, body, DEMO_ACTOR);
  } catch (err) {
    if (err instanceof ValidationError) throw new ValidationError(err.problems.map(withoutEcho));

    // The recruiter handler tells a second decision to "re-assess the candidate",
    // which a visitor cannot do. Say what they can.
    if (err instanceof AppError && err.code === 'CONFLICT') throw new AppError('CONFLICT', ALREADY_DECIDED);

    // Two requests racing past the "already decided?" check land on the
    // database's UNIQUE backstop. That is the same answer, not a server error.
    if (!(err instanceof AppError) && (await sandbox.repos.decisions.getForEvaluation(evaluationId))) {
      throw new AppError('CONFLICT', ALREADY_DECIDED);
    }
    throw err;
  }
}
