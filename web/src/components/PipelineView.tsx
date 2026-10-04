import type { ReactNode } from 'react';
import type { PipelineStage } from '../demo/pipeline.ts';

// The pipeline a candidate went through, one expandable card per stage.
//
// Built entirely from `buildPipeline`'s output, which is built from the audit
// events that were actually recorded. The status is a word beside the stage — not
// a colour — and a stage that did not run says "Not run" rather than being drawn
// as done. A native `<details>` per stage, as everywhere else in the front end:
// keyboard accessible and announced by screen readers with no state of its own.

function when(stage: PipelineStage): string {
  if (stage.at !== null) return `Recorded at ${new Date(stage.at).toLocaleString()}`;
  if (stage.status === 'derived') return 'Not an audit event, so it has no timestamp';
  if (stage.status === 'unavailable') return 'No timestamp is available';
  return 'Nothing was recorded for this stage, so there is no timestamp';
}

export function PipelineView({ stages }: { stages: readonly PipelineStage[] }): ReactNode {
  return (
    <section aria-labelledby="pipeline-heading">
      <h4 id="pipeline-heading" className="text-subhead">
        How this result was reached
      </h4>
      <p className="mt-1 mb-3 text-small text-ink-muted">
        The stages this candidate went through, as recorded. Open one to see what happened.
      </p>

      <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {stages.map((stage, index) => (
          <li key={stage.id}>
            <details className="h-full rounded-card border border-line bg-surface p-3">
              <summary className="cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border border-line-strong text-meta font-semibold text-ink"
                  >
                    {index + 1}
                  </span>
                  <span className="text-small font-semibold text-ink">
                    <span className="sr-only">Stage {index + 1}: </span>
                    {stage.label}
                  </span>
                </span>
                {/* The status is text, always. */}
                <span className="mt-1 block pl-8 text-meta font-semibold text-ink-muted">{stage.statusLabel}</span>
              </summary>

              <div className="mt-2 space-y-2 border-t border-line pt-2">
                <p className="text-small text-ink">{stage.explanation}</p>
                {stage.facts.length > 0 ? (
                  <ul className="list-disc space-y-1 pl-5 text-meta text-ink-muted">
                    {stage.facts.map((fact) => (
                      <li key={fact}>{fact}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="text-meta text-ink-muted">{when(stage)}</p>
              </div>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}
