import { useEffect, useRef, useState } from 'react';
import { api } from './api/client.ts';
import { POLL_INTERVAL_MS, POLL_MAX_CONSECUTIVE_ERRORS, isFinished } from './assess.ts';
import type { EvaluationStatusView } from './api/types.ts';

// Polls a running assessment until it ends.
//
// The server does the work in the background and answers 202; this is the other
// half. It asks the cheap status endpoint, waits, asks again, and stops the
// moment the status is `scored` or `failed` or the component leaves the screen.
// A few failed requests in a row (the server restarting, a dropped connection) do
// not end it, but they do not loop forever either.

export type AssessmentWatch =
  | { phase: 'running' }
  | { phase: 'finished'; status: EvaluationStatusView }
  | { phase: 'unreachable'; message: string };

export function useAssessmentStatus(
  evaluationId: string | null,
  onFinished: (status: EvaluationStatusView) => void,
): AssessmentWatch {
  const [watch, setWatch] = useState<AssessmentWatch>({ phase: 'running' });
  // The latest callback, without restarting the poll whenever the parent re-renders.
  const finished = useRef(onFinished);
  finished.current = onFinished;

  useEffect(() => {
    if (evaluationId === null) return undefined;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let errors = 0;
    setWatch({ phase: 'running' });

    const tick = async (): Promise<void> => {
      try {
        const status = await api.evaluationStatus(evaluationId);
        if (cancelled) return;
        errors = 0;
        if (isFinished(status.status)) {
          setWatch({ phase: 'finished', status });
          finished.current(status);
          return;
        }
      } catch {
        if (cancelled) return;
        errors += 1;
        if (errors >= POLL_MAX_CONSECUTIVE_ERRORS) {
          setWatch({
            phase: 'unreachable',
            message: 'Lost contact with the server while the assessment was running. It may still finish: reload to check.',
          });
          return;
        }
      }
      timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };

    timer = setTimeout(() => void tick(), 0);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [evaluationId]);

  return watch;
}
