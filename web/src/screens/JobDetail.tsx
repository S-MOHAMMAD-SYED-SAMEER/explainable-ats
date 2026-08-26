import type { ReactNode } from 'react';
import { api } from '../api/client.ts';
import { useLoad } from '../useLoad.ts';
import { BackLink, Badge, Empty, Loading, Problem, Technical } from '../components/Bits.tsx';
import { kindLabel, tierWording } from '../copy.ts';
import { routeToHash } from '../router.ts';
import type { JobDetail as JobDetailData, RankedCandidate, Ranking } from '../api/types.ts';

// One role, and everyone assessed against it.
//
// THE ORDER ON THIS PAGE IS THE SERVER'S ORDER.
//
// `entries` arrives already sorted, already ranked, already explained. Nothing
// here sorts, compares scores, or decides who is held back — a ranking computed
// in the browser would be a second implementation able to disagree with the
// one the audit trail was written from, and the disagreement would surface as
// "the list said one thing and the candidate page said another".
//
// Ties are shown as ties. The final tie-break on the server is arbitrary but
// stable, so presenting #3 as having beaten #4 when they scored identically
// would be a claim nobody made.

function ScoreCell({ entry }: { entry: RankedCandidate }): ReactNode {
  // `scorePercent` arrives already rounded. Dividing the basis points here
  // would be the browser doing arithmetic on a score — the one thing this
  // layer must never do, because the answer could then differ from the one the
  // audit trail records.
  if (entry.scorePercent === null) {
    return <span className="text-small text-ink-muted">Not assessed</span>;
  }
  return <span className="text-body font-semibold text-ink">{entry.scorePercent}</span>;
}

function CandidateRow({ entry }: { entry: RankedCandidate }): ReactNode {
  const wording = tierWording(entry.tier);
  const name = entry.displayName ?? entry.reference;

  const body = (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <span className="w-10 shrink-0 text-meta font-semibold text-ink-muted">
            {entry.rank === null ? '—' : `#${entry.rank}`}
          </span>
          <span className="text-body font-semibold text-ink">{name}</span>
          <Badge wording={wording} />
        </div>
        <ScoreCell entry={entry} />
      </div>

      <p className="mt-2 pl-13 text-small text-ink-muted">{entry.rationale}</p>

      {entry.failedMustHaves.length > 0 ? (
        <p className="mt-1 pl-13 text-small text-danger">
          Does not meet: {entry.failedMustHaves.join(', ')}
        </p>
      ) : null}
      {entry.unclearMustHaves.length > 0 ? (
        <p className="mt-1 pl-13 text-small text-signal">
          Nothing found in the CV about: {entry.unclearMustHaves.join(', ')}
        </p>
      ) : null}
    </>
  );

  return (
    <li>
      {entry.evaluationId === null ? (
        <div className="rounded-card border border-dashed border-line-strong bg-surface p-4">{body}</div>
      ) : (
        <a
          href={routeToHash({ name: 'candidates', id: entry.evaluationId })}
          className="block rounded-card border border-line bg-surface p-4 shadow-resting focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
        >
          {body}
        </a>
      )}
    </li>
  );
}

function Requirements({ job }: { job: JobDetailData }): ReactNode {
  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <h4 className="text-subhead">What this role asks for</h4>
      <ul className="mt-3 space-y-2">
        {job.requirements.map((requirement) => (
          <li key={requirement.id} className="rounded-control border border-line p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-small font-semibold text-ink">{requirement.label}</span>
              <span
                className={`text-meta font-semibold uppercase tracking-wide ${
                  requirement.kind === 'must_have' ? 'text-ink' : 'text-ink-muted'
                }`}
              >
                {kindLabel(requirement.kind)}
              </span>
            </div>
            <p className="mt-1 text-small text-ink-muted">{requirement.criterion}</p>
          </li>
        ))}
      </ul>

      <Technical summary="How the weighting works">
        <p>
          Each requirement carries a weight, and the score is the weighted average of what the evidence showed for
          each one. Essential requirements are counted separately: missing one moves a candidate down the list without
          changing their score.
        </p>
        <ul className="mt-1 list-disc pl-4">
          {job.requirements.map((requirement) => (
            <li key={requirement.id}>
              {requirement.label} — weight {requirement.weight}, {kindLabel(requirement.kind).toLowerCase()}
            </li>
          ))}
        </ul>
      </Technical>
    </section>
  );
}

function RankedList({ ranking }: { ranking: Ranking }): ReactNode {
  if (ranking.entries.length === 0) {
    return <Empty>Nobody has been assessed against this role yet.</Empty>;
  }

  return (
    <>
      <ul className="space-y-3">
        {ranking.entries.map((entry) => (
          <CandidateRow key={entry.candidateId} entry={entry} />
        ))}
      </ul>

      {ranking.notEvaluatedCount > 0 ? (
        <p className="mt-3 text-meta text-ink-muted">
          {ranking.notEvaluatedCount} candidate{ranking.notEvaluatedCount === 1 ? ' is' : 's are'} listed but not
          ranked, because {ranking.notEvaluatedCount === 1 ? 'their assessment has' : 'their assessments have'} not
          finished. They are shown rather than hidden — a list that quietly leaves someone out looks complete and is
          not.
        </p>
      ) : null}
    </>
  );
}

export function JobDetail({ jobId }: { jobId: string }): ReactNode {
  // Every hook above every return — see the note in App.tsx.
  const job = useLoad(() => api.job(jobId), [jobId]);
  const ranking = useLoad(() => api.ranking(jobId), [jobId]);

  return (
    <div className="space-y-5">
      <BackLink href={routeToHash({ name: 'jobs', id: null })}>All roles</BackLink>

      {job.state.status === 'loading' ? <Loading what="the role" /> : null}
      {job.state.status === 'error' ? <Problem message={job.state.message} /> : null}

      {job.state.status === 'ready' ? (
        <>
          <section>
            <h3 className="text-section text-ink">{job.state.data.title}</h3>
            {job.state.data.description ? (
              <p className="mt-1 text-small text-ink-muted">{job.state.data.description}</p>
            ) : null}
          </section>

          <Requirements job={job.state.data} />
        </>
      ) : null}

      <section>
        <h4 className="text-subhead">Candidates</h4>
        <p className="mt-1 mb-3 text-small text-ink-muted">
          Ordered by the evidence found in each CV. Candidates missing an essential requirement sit below those who
          meet them all, whatever their score.
        </p>

        {ranking.state.status === 'loading' ? <Loading what="candidates" /> : null}
        {ranking.state.status === 'error' ? <Problem message={ranking.state.message} /> : null}
        {ranking.state.status === 'ready' ? <RankedList ranking={ranking.state.data} /> : null}
      </section>
    </div>
  );
}
