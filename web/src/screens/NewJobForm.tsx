import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';
import {
  MAX_CRITERION_CHARS,
  MAX_LABEL_CHARS,
  MAX_REQUIREMENTS,
  MAX_WEIGHT,
  MIN_WEIGHT,
  SENIORITY_OPTIONS,
  emptyJobDraft,
  emptyRequirement,
  validateJobDraft,
  type JobDraft,
  type RequirementDraft,
} from '../assess.ts';

// Creating a role: a title, a seniority, and the requirements a CV will be read
// against, each with a weight and an essential-or-desirable flag.
//
// The form checks what it can before sending, so a person is told what is wrong
// in plain words; the server checks everything again and is the one that decides.

const FIELD =
  'mt-1 w-full rounded-control border border-line bg-surface p-2 text-small text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand';
const LABEL = 'text-meta font-semibold uppercase tracking-wide text-ink-muted';

export function NewJobForm({ onCreated }: { onCreated: (jobId: string) => void }): ReactNode {
  // Every hook above every return — see the note in App.tsx.
  const [draft, setDraft] = useState<JobDraft>(emptyJobDraft);
  const [problems, setProblems] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setRequirement = (index: number, patch: Partial<RequirementDraft>): void => {
    setDraft((current) => ({
      ...current,
      requirements: current.requirements.map((entry, at) => (at === index ? { ...entry, ...patch } : entry)),
    }));
  };

  const submit = async (): Promise<void> => {
    if (submitting) return;
    const checked = validateJobDraft(draft);
    if (!checked.ok) {
      setProblems(checked.problems);
      setServerError(null);
      return;
    }

    setProblems([]);
    setServerError(null);
    setSubmitting(true);
    try {
      const job = await api.createJob(checked.input);
      onCreated(job.id);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Could not create the role.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="space-y-4 rounded-card border border-line bg-surface p-5 shadow-resting"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h4 className="text-subhead">New role</h4>

      <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
        <div>
          <label htmlFor="job-title" className={LABEL}>
            Title
          </label>
          <input
            id="job-title"
            value={draft.title}
            onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            className={FIELD}
          />
        </div>
        <div>
          <label htmlFor="job-seniority" className={LABEL}>
            Seniority
          </label>
          <select
            id="job-seniority"
            value={draft.seniority}
            onChange={(event) => setDraft({ ...draft, seniority: event.target.value })}
            className={FIELD}
          >
            {SENIORITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label htmlFor="job-description" className={LABEL}>
          Description (optional)
        </label>
        <textarea
          id="job-description"
          rows={2}
          value={draft.description}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
          className={FIELD}
        />
      </div>

      <fieldset className="space-y-3">
        <legend className={LABEL}>What a CV is read against</legend>
        <p className="text-small text-ink-muted">
          Describe each requirement as something a CV could show. Weight says how much it counts ({MIN_WEIGHT} to{' '}
          {MAX_WEIGHT}). Essential means a candidate who does not meet it is listed below those who do.
        </p>

        {draft.requirements.map((entry, index) => (
          <div key={index} className="space-y-2 rounded-control border border-line p-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_9rem_5rem]">
              <div>
                <label htmlFor={`req-label-${index}`} className={LABEL}>
                  Name
                </label>
                <input
                  id={`req-label-${index}`}
                  value={entry.label}
                  maxLength={MAX_LABEL_CHARS}
                  onChange={(event) => setRequirement(index, { label: event.target.value })}
                  className={FIELD}
                />
              </div>
              <div>
                <label htmlFor={`req-kind-${index}`} className={LABEL}>
                  Kind
                </label>
                <select
                  id={`req-kind-${index}`}
                  value={entry.kind}
                  onChange={(event) =>
                    setRequirement(index, { kind: event.target.value === 'nice_to_have' ? 'nice_to_have' : 'must_have' })
                  }
                  className={FIELD}
                >
                  <option value="must_have">Essential</option>
                  <option value="nice_to_have">Desirable</option>
                </select>
              </div>
              <div>
                <label htmlFor={`req-weight-${index}`} className={LABEL}>
                  Weight
                </label>
                <input
                  id={`req-weight-${index}`}
                  type="number"
                  min={MIN_WEIGHT}
                  max={MAX_WEIGHT}
                  step={1}
                  value={entry.weight}
                  onChange={(event) => setRequirement(index, { weight: event.target.value })}
                  className={FIELD}
                />
              </div>
            </div>
            <div>
              <label htmlFor={`req-criterion-${index}`} className={LABEL}>
                What to look for
              </label>
              <textarea
                id={`req-criterion-${index}`}
                rows={2}
                maxLength={MAX_CRITERION_CHARS}
                value={entry.criterion}
                onChange={(event) => setRequirement(index, { criterion: event.target.value })}
                className={FIELD}
              />
            </div>
            {draft.requirements.length > 1 ? (
              <button
                type="button"
                onClick={() =>
                  setDraft({ ...draft, requirements: draft.requirements.filter((_, at) => at !== index) })
                }
                className="text-small font-semibold text-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
              >
                Remove this requirement
              </button>
            ) : null}
          </div>
        ))}

        {draft.requirements.length < MAX_REQUIREMENTS ? (
          <button
            type="button"
            onClick={() => setDraft({ ...draft, requirements: [...draft.requirements, emptyRequirement()] })}
            className="text-small font-semibold text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            + Add a requirement
          </button>
        ) : null}
      </fieldset>

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
        disabled={submitting}
        className="h-control rounded-control bg-brand px-5 text-small font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
      >
        {submitting ? 'Creating…' : 'Create role'}
      </button>
    </form>
  );
}
