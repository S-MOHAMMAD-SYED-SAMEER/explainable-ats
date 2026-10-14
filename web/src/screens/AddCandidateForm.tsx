import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';
import { AssessmentProgress } from '../components/AssessmentProgress.tsx';
import {
  MAX_CV_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_REFERENCE_CHARS,
  emptyCandidateDraft,
  validateCandidateDraft,
  type CandidateDraft,
} from '../assess.ts';
import { routeToHash } from '../router.ts';
import type { AddedCandidate, EvaluationStatusView } from '../api/types.ts';

// Adding a CV: pasted plain text, a reference, and (optionally) the person's name.
//
// One press does two things the server keeps separate: it stores and redacts the
// CV, then asks for the assessment to start. The name is for the recruiter's own
// screen and is masked out of the text before a model reads it, which is why it is
// asked for.

const FIELD =
  'mt-1 w-full rounded-control border border-line bg-surface p-2 text-small text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand';
const LABEL = 'text-meta font-semibold uppercase tracking-wide text-ink-muted';

type Phase =
  | { name: 'idle' }
  | { name: 'sending' }
  | { name: 'running'; added: AddedCandidate }
  | { name: 'done'; added: AddedCandidate; status: EvaluationStatusView };

export function AddCandidateForm({ jobId, onChanged }: { jobId: string; onChanged: () => void }): ReactNode {
  // Every hook above every return — see the note in App.tsx.
  const [draft, setDraft] = useState<CandidateDraft>(emptyCandidateDraft);
  const [problems, setProblems] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ name: 'idle' });

  const busy = phase.name === 'sending' || phase.name === 'running';

  const submit = async (): Promise<void> => {
    if (busy) return;
    const checked = validateCandidateDraft(draft);
    if (!checked.ok) {
      setProblems(checked.problems);
      setServerError(null);
      return;
    }

    setProblems([]);
    setServerError(null);
    setPhase({ name: 'sending' });

    let added: AddedCandidate;
    try {
      added = await api.addCandidate(jobId, checked.input);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not add that CV.');
      setPhase({ name: 'idle' });
      return;
    }

    // The candidate now exists in the list as "not assessed yet".
    onChanged();
    try {
      await api.runEvaluation(added.evaluationId);
      setPhase({ name: 'running', added });
    } catch (err) {
      const why = err instanceof ApiError ? err.message : 'The server could not be reached.';
      setServerError(
        `The CV was added, but the assessment could not be started: ${why} Open the candidate from the list to start it again.`,
      );
      setPhase({ name: 'idle' });
    }
  };

  const finished = (added: AddedCandidate) => (status: EvaluationStatusView) => {
    setPhase({ name: 'done', added, status });
    setDraft(emptyCandidateDraft());
    onChanged();
  };

  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-resting">
      <h4 className="text-subhead">Add a CV</h4>
      <p className="mt-1 text-small text-ink-muted">
        Paste the CV as plain text. Names, contact details and other protected details are masked before anything
        reads it, and every passage quoted back is checked against the original.
      </p>

      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="cv-reference" className={LABEL}>
              Reference
            </label>
            <input
              id="cv-reference"
              value={draft.reference}
              maxLength={MAX_REFERENCE_CHARS}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, reference: event.target.value })}
              className={FIELD}
            />
          </div>
          <div>
            <label htmlFor="cv-name" className={LABEL}>
              Name (optional)
            </label>
            <input
              id="cv-name"
              value={draft.displayName}
              maxLength={MAX_DISPLAY_NAME_CHARS}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, displayName: event.target.value })}
              className={FIELD}
            />
          </div>
        </div>

        <div>
          <label htmlFor="cv-text" className={LABEL}>
            CV text
          </label>
          <textarea
            id="cv-text"
            rows={10}
            value={draft.text}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
            className={`${FIELD} font-mono`}
          />
          <p className="mt-1 text-meta text-ink-muted">
            {draft.text.length.toLocaleString('en')} of {MAX_CV_CHARS.toLocaleString('en')} characters.
          </p>
        </div>

        <div aria-live="polite">
          {problems.length > 0 ? (
            <ul className="list-disc space-y-1 rounded-control bg-danger-tint px-5 py-2 text-small text-danger">
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          ) : null}
          {serverError ? (
            <p className="rounded-control bg-danger-tint px-3 py-2 text-small text-danger">{serverError}</p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={busy}
          className="h-control rounded-control bg-brand px-5 text-small font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
        >
          {phase.name === 'sending' ? 'Adding…' : phase.name === 'running' ? 'Assessing…' : 'Add and assess'}
        </button>
      </form>

      {phase.name === 'running' ? (
        <div className="mt-4">
          <AssessmentProgress evaluationId={phase.added.evaluationId} onFinished={finished(phase.added)} />
        </div>
      ) : null}

      {phase.name === 'done' ? (
        <div className="mt-4 rounded-control border border-line bg-canvas px-3 py-2" aria-live="polite">
          {phase.status.status === 'scored' ? (
            <p className="text-small text-ink">
              {phase.added.candidate.displayName ?? phase.added.candidate.reference} has been assessed.{' '}
              <a
                href={routeToHash({ name: 'candidates', id: phase.added.evaluationId })}
                className="font-semibold text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Read the assessment
              </a>
            </p>
          ) : (
            <p className="text-small text-danger">
              {phase.status.failureReason ?? 'The assessment did not finish.'}{' '}
              <a
                href={routeToHash({ name: 'candidates', id: phase.added.evaluationId })}
                className="font-semibold text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Open it to try again
              </a>
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
