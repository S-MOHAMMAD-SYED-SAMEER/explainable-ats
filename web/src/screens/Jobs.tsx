import type { ReactNode } from 'react';
import { api } from '../api/client.ts';
import { useLoad } from '../useLoad.ts';
import { Empty, Loading, Problem } from '../components/Bits.tsx';
import { routeToHash } from '../router.ts';
import type { JobSummary } from '../api/types.ts';

// Roles — the first screen of the recruiter workflow.
//
// Counts come from the server, in two batch queries for the whole list. A
// screen that asked "how many candidates?" per row would be N+1 before it had
// ten rows on it, and this is the screen someone opens first every morning.

function JobRow({ job }: { job: JobSummary }): ReactNode {
  return (
    <li>
      <a
        href={routeToHash({ name: 'jobs', id: job.id })}
        className="block rounded-card border border-line bg-surface p-4 shadow-resting focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h4 className="text-subhead text-ink">{job.title}</h4>
          <span className="text-meta uppercase tracking-wide text-ink-muted">{job.seniority}</span>
        </div>

        <p className="mt-2 text-small text-ink-muted">
          {job.candidateCount === 0
            ? 'No candidates assessed yet.'
            : `${job.candidateCount} candidate${job.candidateCount === 1 ? '' : 's'} assessed.`}{' '}
          {job.mustHaveCount} essential requirement{job.mustHaveCount === 1 ? '' : 's'}, {job.requirementCount} in
          total.
        </p>
      </a>
    </li>
  );
}

export function Jobs(): ReactNode {
  // Every hook above every return — see the note in App.tsx.
  const { state } = useLoad(() => api.jobs(), []);

  return (
    <div className="space-y-4">
      <section>
        <h3 className="text-subhead">Open roles</h3>
        <p className="mt-1 text-small text-ink-muted">
          Pick a role to see who has been assessed against it, and why each of them sits where they do.
        </p>
      </section>

      {state.status === 'loading' ? <Loading what="roles" /> : null}
      {state.status === 'error' ? <Problem message={state.message} /> : null}

      {state.status === 'ready' ? (
        state.data.jobs.length === 0 ? (
          <Empty>No roles yet. Once a role is created, candidates assessed against it appear here.</Empty>
        ) : (
          <ul className="space-y-3">
            {state.data.jobs.map((job) => (
              <JobRow key={job.id} job={job} />
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
