import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';
import { AssessmentProgress } from './AssessmentProgress.tsx';
import { Technical } from './Bits.tsx';
import { navigate, routeToHash } from '../router.ts';
import type { EvaluationDetail } from '../api/types.ts';

// The state of an assessment that has not produced a result: still running, or
// failed. A scored assessment shows nothing here.
//
// A failed assessment keeps its place in the record with the reason it failed.
// Re-running it opens a NEW assessment that replaces it, so the history shows
// that a first attempt failed and why, rather than a result that appeared from
// nowhere.

const BUTTON =
  'h-control rounded-control bg-brand px-5 text-small font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50';

export function AssessmentPanel({
  detail,
  onChanged,
}: {
  detail: EvaluationDetail;
  /** Re-reads the assessment, once a running one has ended. */
  onChanged: () => void;
}): ReactNode {
  // Every hook above every return — see the note in App.tsx.
  const [rerunning, setRerunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rerun = async (): Promise<void> => {
    if (rerunning) return;
    setRerunning(true);
    setError(null);
    try {
      const started = await api.rerunEvaluation(detail.evaluationId);
      // The new assessment has its own page; go there and watch it run.
      navigate({ name: 'candidates', id: started.evaluationId });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the assessment again.');
    } finally {
      setRerunning(false);
    }
  };

  const rerunButton = (label: string): ReactNode => (
    <button type="button" disabled={rerunning} onClick={() => void rerun()} className={BUTTON}>
      {rerunning ? 'Starting…' : label}
    </button>
  );

  const errorLine = (
    <div aria-live="polite">
      {error ? <p className="mt-3 rounded-control bg-danger-tint px-3 py-2 text-small text-danger">{error}</p> : null}
    </div>
  );

  if (detail.status === 'scored') return null;

  if (detail.status === 'failed' && !detail.isCurrent) {
    return (
      <section className="rounded-card border border-dashed border-line-strong p-5">
        <p className="text-small text-ink-muted">
          This attempt failed and has been replaced by a newer assessment.{' '}
          {detail.supersededBy ? (
            <a
              href={routeToHash({ name: 'candidates', id: detail.supersededBy })}
              className="font-semibold text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              Open the current one
            </a>
          ) : null}
        </p>
        {detail.failureReason ? <p className="mt-2 text-meta text-ink-muted">It failed because: {detail.failureReason}</p> : null}
      </section>
    );
  }

  if (detail.status === 'failed') {
    return (
      <section className="rounded-card border border-line bg-danger-tint p-5">
        <h4 className="text-subhead text-danger">This assessment did not finish</h4>
        <p className="mt-1 text-small text-ink">{detail.failureReason ?? 'The assessment stopped before it could finish.'}</p>
        <p className="mt-1 text-small text-ink-muted">
          Nothing was scored and nothing was guessed. Running it again opens a new assessment; this attempt stays on
          the record.
        </p>
        <div className="mt-3">{rerunButton('Re-run the assessment')}</div>
        {errorLine}
      </section>
    );
  }

  // Pending or extracted: still on its way.
  if (!detail.isCurrent) {
    return (
      <section className="rounded-card border border-dashed border-line-strong p-5">
        <p className="text-small text-ink-muted">This assessment has been replaced by a newer one.</p>
      </section>
    );
  }

  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h4 className="text-subhead">Assessment in progress</h4>
      <div className="mt-3">
        <AssessmentProgress evaluationId={detail.evaluationId} onFinished={onChanged} />
      </div>
      <Technical summary="Has this been waiting a long time?">
        <p>
          If the server was restarted while this was running, the assessment will not finish by itself. Start it
          again: this one stays on the record and the new one replaces it.
        </p>
        <div className="mt-2">{rerunButton('Start it again')}</div>
        {errorLine}
      </Technical>
    </section>
  );
}
