import type { ReactNode } from 'react';
import { useAssessmentStatus } from '../useAssessmentStatus.ts';
import type { EvaluationStatusView } from '../api/types.ts';

// "The assessment is running", for as long as it is.
//
// The server works in the background; this asks how it is getting on and tells the
// parent once it has ended, one way or the other. What happens next (show the
// result, offer a re-run) is the parent's decision, so this component only reports.

export function AssessmentProgress({
  evaluationId,
  onFinished,
}: {
  evaluationId: string;
  onFinished: (status: EvaluationStatusView) => void;
}): ReactNode {
  const watch = useAssessmentStatus(evaluationId, onFinished);

  return (
    <div aria-live="polite" className="rounded-control border border-line bg-canvas px-3 py-2">
      {watch.phase === 'running' ? (
        <p className="text-small text-ink-muted">
          Assessing this CV. It has been redacted, and a model is now quoting the passages that speak to each
          requirement. This usually takes under a minute.
        </p>
      ) : null}
      {watch.phase === 'finished' ? (
        <p className="text-small text-ink">
          {watch.status.status === 'scored' ? 'The assessment is finished.' : 'The assessment did not finish.'}
        </p>
      ) : null}
      {watch.phase === 'unreachable' ? <p className="text-small text-danger">{watch.message}</p> : null}
    </div>
  );
}
