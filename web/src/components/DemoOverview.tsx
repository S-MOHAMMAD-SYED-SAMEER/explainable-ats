import type { ReactNode } from 'react';
import { Badge } from './Bits.tsx';
import { TIERS, TIER_WORDING, kindLabel } from '../copy.ts';
import type { JobDetail, Ranking } from '../api/types.ts';

// The first thing a visitor sees after "Start Demo": what the role is, what it
// asks for, how many people were assessed, and what the labels on them mean.
//
// IT DRAWS FROM THE SERVER'S ANSWERS AND ADDS NO DATA OF ITS OWN
//
// The job and the ranking arrive from the visitor's own session, exactly as the
// recruiter's screens receive theirs; this component only arranges them. There is
// no second, frontend-only copy of the dataset to drift from the real one, and
// nothing here sorts, scores or ranks — the order and every number are the
// server's. The tier legend is `copy.ts`'s own wording, the same words the badges
// beside each candidate use, so the explanation and the thing explained cannot
// disagree.
//
// It replaces the `Requirements` card in a visitor's session rather than adding
// to it, so the requirements are not shown twice; the recruiter's screen still
// draws that card.

function Fact({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="rounded-control border border-line p-3">
      <dt className="text-meta uppercase tracking-wide text-ink-muted">{label}</dt>
      <dd className="mt-1 text-body font-semibold text-ink">{children}</dd>
    </div>
  );
}

export function DemoOverview({ job, ranking }: { job: JobDetail; ranking: Ranking | null }): ReactNode {
  const essential = job.requirements.filter((requirement) => requirement.kind === 'must_have').length;

  return (
    <section aria-labelledby="demo-overview-heading" className="rounded-card border border-line bg-surface p-4">
      <h4 id="demo-overview-heading" className="text-subhead">
        Demo overview
      </h4>
      <p className="mt-1 text-small text-ink-muted">
        This is a synthetic role with invented candidates. Open any candidate below to see why they were placed where
        they were.
      </p>

      <dl className="mt-4 grid gap-3 sm:grid-cols-3">
        <Fact label="Seniority">
          <span className="capitalize">{job.seniority}</span>
        </Fact>
        <Fact label="Requirements">
          {job.requirements.length} ({essential} essential)
        </Fact>
        <Fact label="Candidates">{ranking === null ? '—' : ranking.entries.length}</Fact>
      </dl>

      <h5 className="mt-5 text-small font-semibold text-ink">What this role asks for</h5>
      <ul className="mt-2 space-y-2">
        {job.requirements.map((requirement) => (
          <li key={requirement.id} className="rounded-control border border-line p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-small font-semibold text-ink">{requirement.label}</span>
              {/* Kind and weight are words, not colours or icons. */}
              <span className="text-meta font-semibold uppercase tracking-wide text-ink-muted">
                {kindLabel(requirement.kind)} · Weight {requirement.weight}
              </span>
            </div>
            <p className="mt-1 text-small text-ink-muted">{requirement.criterion}</p>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-meta text-ink-muted">
        Weight is how much a requirement counts towards the score. Essential requirements also gate the ranking: missing
        one moves a candidate down the list without changing their score.
      </p>

      <h5 className="mt-5 text-small font-semibold text-ink">What the labels on a candidate mean</h5>
      <dl className="mt-2 grid gap-2 sm:grid-cols-2">
        {TIERS.map((tier) => (
          <div key={tier} className="rounded-control border border-line p-3">
            <dt>
              <Badge wording={TIER_WORDING[tier]} />
            </dt>
            <dd className="mt-2 text-small text-ink-muted">{TIER_WORDING[tier].detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
