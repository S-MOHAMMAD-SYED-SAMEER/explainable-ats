import type { ReactNode } from 'react';
import type { TimelineItem } from '../demo/timeline.ts';

// The audit trail as a timeline.
//
// One entry per recorded event, oldest first, each with the time it was stored,
// a plain sentence, who did it where that means something, and — behind a native
// `<details>` — the arithmetic or provenance the event carries. The demo
// recruiter's decision, when there is one, is the last entry and says so in words.
//
// TWO THINGS A VISITOR WOULD OTHERWISE MISREAD, SAID UP FRONT
//
//   * Times. Every demo session starts byte-identical, so the pipeline's events
//     carry the demo's fixed clock; only a decision carries the time it was made.
//   * Order. The trail is in the order events were recorded. The pipeline writes
//     the extraction's summary after its evidence has been verified, so that
//     summary appears just after verification.
//
// Neither is hidden or smoothed over: the events are shown as stored.

function Entry({ item, last }: { item: TimelineItem; last: boolean }): ReactNode {
  const final = item.isDecision && last;

  return (
    <li
      className={`rounded-control border p-3 ${final ? 'border-brand bg-brand-tint' : 'border-line bg-surface'}`}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-meta font-semibold uppercase tracking-wide text-ink-muted">
          {item.stageLabel}
          {item.outcome ? ` · ${item.outcome}` : ''}
          {final ? ' · Final event' : ''}
        </span>
        <time dateTime={item.at} className="text-meta text-ink-muted">
          {new Date(item.at).toLocaleString()}
        </time>
      </div>

      <p className={`mt-1 text-small text-ink ${item.isDecision ? 'font-semibold' : ''}`}>{item.title}</p>
      {item.actor ? <p className="mt-1 text-meta text-ink-muted">By: {item.actor}</p> : null}
      {item.isDecision ? (
        <p className="mt-1 text-meta text-ink-muted">
          This is a demo recruiter decision. It affects only your private demo session.
        </p>
      ) : null}

      {item.details.length > 0 ? (
        <details className="mt-2 rounded-control border border-line bg-canvas p-2">
          <summary className="cursor-pointer text-meta font-semibold text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">
            Show details
          </summary>
          <dl className="mt-2 space-y-1 text-meta">
            {item.details.map((line, index) => (
              <div key={`${line.label}-${index}`} className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
                <dt className="font-semibold text-ink sm:w-56 sm:shrink-0">{line.label}</dt>
                <dd className="break-words text-ink-muted">{line.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}
    </li>
  );
}

export function AuditTimeline({ items }: { items: readonly TimelineItem[] }): ReactNode {
  return (
    <section aria-labelledby="timeline-heading" className="rounded-card border border-line bg-surface p-5">
      <h4 id="timeline-heading" className="text-subhead">
        Timeline
      </h4>
      <p className="mt-1 text-small text-ink-muted">
        Everything recorded about this candidate, oldest first, exactly as stored. Nothing here can be edited.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-meta text-ink-muted">
        <li>
          Pipeline events show the demo’s fixed clock, so every visitor’s copy starts identical. A decision shows the
          time you made it.
        </li>
        <li>Events appear in the order they were recorded: extraction’s summary is written after its evidence is verified.</li>
      </ul>

      <ol className="mt-3 space-y-2">
        {items.map((item, index) => (
          <Entry key={item.key} item={item} last={index === items.length - 1} />
        ))}
      </ol>
    </section>
  );
}
