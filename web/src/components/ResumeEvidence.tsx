import type { ReactNode } from 'react';
import { Badge } from './Bits.tsx';
import { HighlightedText } from './EvidenceText.ts';
import { highlightEvidence, spansFromRequirements } from '../demo/evidence.ts';
import { verdictWording } from '../copy.ts';
import type { EvaluationDetail } from '../api/types.ts';

// The redacted resume, with the evidence that was verified against it.
//
// WHAT IS SHOWN, AND WHAT IS NOT
//
// The text is the REDACTED resume — what the pipeline read, with every protected
// detail already replaced by a run of block characters. The original is not on
// this page and not in the response that fed it. Highlights are the evaluation's
// own verified evidence and nothing else: a rejected passage is stored for the
// audit trail and never sent here, and a verified one is still refused if the text
// at its offsets is not its quote (see `demo/evidence.ts`). Anything refused is
// said so, in words, rather than dropped.
//
// It adds no matching of its own. The requirements, their verdicts and the
// evidence all come from the evaluation; this only puts the evidence where it was
// found.

export function ResumeEvidence({ text, detail }: { text: string; detail: EvaluationDetail }): ReactNode {
  const spans = spansFromRequirements(detail.requirements);
  const { segments, used, skipped } = highlightEvidence(text, spans);
  const names = detail.requirements.map((requirement) => requirement.label);

  return (
    <section aria-labelledby="resume-heading" className="rounded-card border border-line bg-surface p-5">
      <h4 id="resume-heading" className="text-subhead">
        Redacted resume
      </h4>
      <p className="mt-1 text-small text-ink-muted">
        This is the text the pipeline worked from. Personal details were masked (shown as ████) before anything read it.
        Highlighted passages are evidence verified against the resume; the number after each says which requirement it
        supports.
      </p>

      <ul className="mt-3 space-y-1" aria-label="Which number is which requirement">
        {detail.requirements.map((requirement, index) => {
          const count = used.filter((span) => span.requirement === index + 1).length;
          return (
            <li key={requirement.requirementId} className="flex flex-wrap items-center gap-2 text-small">
              <span className="font-semibold text-brand">{index + 1}</span>
              <span className="font-semibold text-ink">{requirement.label}</span>
              <Badge wording={verdictWording(requirement.verdict)} />
              <span className="text-meta text-ink-muted">
                {count === 0 ? 'no highlighted passage' : `${count} highlighted passage${count === 1 ? '' : 's'}`}
              </span>
            </li>
          );
        })}
      </ul>

      {/* A scrollable region must be reachable from the keyboard, or its overflow is unreadable without a mouse.
          The height cap applies from the small breakpoint up only. On a phone the masked header wraps onto
          many lines and fills any cap, which pushed the highlighted evidence out of sight inside a scroll box
          within a scrolling page — found by looking at it at 375px. There the page scrolls instead. */}
      <div
        role="region"
        aria-label="Redacted resume text"
        tabIndex={0}
        className="mt-4 whitespace-pre-wrap break-words sm:max-h-96 sm:overflow-y-auto rounded-control border border-line bg-canvas p-3 text-small leading-relaxed text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <HighlightedText segments={segments} requirementNames={names} />
      </div>

      {skipped.length > 0 ? (
        <p className="mt-2 rounded-control bg-signal-tint px-3 py-2 text-meta text-ink">
          {skipped.length} verified passage{skipped.length === 1 ? ' was' : 's were'} not highlighted because the text at
          {skipped.length === 1 ? ' its' : ' their'} recorded position did not match the quote. It is not shown as
          verified here.
        </p>
      ) : null}
      {detail.evidenceRejectedCount > 0 ? (
        <p className="mt-2 text-meta text-ink-muted">
          {detail.evidenceRejectedCount} quoted passage{detail.evidenceRejectedCount === 1 ? ' was' : 's were'} rejected
          during verification and {detail.evidenceRejectedCount === 1 ? 'is' : 'are'} never highlighted.
        </p>
      ) : null}
      <p className="mt-2 text-meta text-ink-muted">Evidence verified against the resume. The text above is shown exactly as stored.</p>
    </section>
  );
}
