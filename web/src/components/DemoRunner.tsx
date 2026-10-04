import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';
import { routeToHash } from '../router.ts';

// The public demo's scenario runner (Frontend Option B).
//
// This component has exactly one job: let a visitor pick one of the five
// fixed demo candidates and send that selection, and nothing else, to the
// server's controlled endpoint. It never computes, guesses, or falls back to
// a result of its own — every number a visitor eventually sees comes from
// `CandidateDetail`, reading the evaluation the server just ran.
//
// THAT EVALUATION IS TEMPORARY. The server runs it in an isolated, in-memory
// sandbox, so it is not one of the recruiter's saved evaluations, never appears
// in the ranking, and can disappear when the server restarts. The copy below
// says so, because a result that looks like any other assessment invites the
// belief that it was recorded.
//
// THE SCENARIO LIST IS DISPLAY METADATA, NOT AUTHORITY
//
// `SCENARIOS` below exists so this component has something to render before
// the request is even made — a label and a name. It is not what makes the
// five ids safe to run: `server/src/demo/runScenario.ts::DEMO_SCENARIO_IDS`
// is the actual, independently-enforced allow-list. If this list and the
// server's ever disagreed, the server would still refuse anything outside
// its own five — this list only decides what a visitor is offered to click.
//
// Names are `DemoCandidate.displayName` from `server/src/demo/dataset.ts`,
// copied here because the server has no route that lists scenario metadata —
// only entry points and a request/response has already the id it needs. The
// dataset's own `expected.demonstrates` prose is internal, test-facing
// commentary (it names other candidates by score for a developer's benefit)
// and is deliberately not reproduced here; the description below says only
// what is true of every scenario alike.

const SCENARIOS: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'demo-001', name: 'Rowan Ashfield' },
  { id: 'demo-002', name: 'Devi Narayanan' },
  { id: 'demo-003', name: 'Marcus Oyelaran' },
  { id: 'demo-004', name: 'Ines Fabre' },
  { id: 'demo-005', name: 'Toby Kestrel' },
];

export function DemoRunner(): ReactNode {
  // Every hook above every return — see the note in App.tsx. There is no
  // early return in this component, so this is the only rule to keep intact.
  const [selected, setSelected] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = selected !== null && !submitting;

  const run = async (): Promise<void> => {
    if (!ready || selected === null) return;
    setSubmitting(true);
    setError(null);

    try {
      const result = await api.runDemoScenario(selected);
      // The server's own answer decides where this goes. `routeToHash` is the
      // same helper every existing candidate link in this app builds its href
      // from — nothing here constructs a URL by hand, and nothing here renders
      // a result of its own. CandidateDetail, reached through the existing
      // router, does that.
      window.location.hash = routeToHash({ name: 'candidates', id: result.evaluationId });
    } catch (err) {
      // Same convention as CandidateDetail's DecisionForm: a safe message from
      // the server's own envelope, or one generic fallback — never a raw
      // network error, a stack trace, or anything provider- or database-shaped.
      setError(err instanceof ApiError ? err.message : 'Could not run the demo. Try again.');
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-resting">
      <h4 className="text-subhead">Try it yourself</h4>
      <p className="mt-1 text-small text-ink-muted">
        Pick one of the fixed demo candidates below. Running it sends that candidate's CV through the
        real screening pipeline — the same ingestion, redaction, evidence extraction and scoring
        every assessment on this page went through — and opens the result.
      </p>
      <p className="mt-2 text-small text-ink-muted">
        Demo results are temporary and do not change the recruiter's saved evaluations or the ranking on
        this page.
      </p>

      <fieldset className="mt-4">
        <legend className="text-meta font-semibold uppercase tracking-wide text-ink-muted">
          Demo candidate
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {SCENARIOS.map((scenario) => {
            const isSelected = selected === scenario.id;
            return (
              <label
                key={scenario.id}
                className={`cursor-pointer rounded-control border px-4 py-2 text-small font-semibold focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand ${
                  isSelected ? 'border-brand bg-brand text-white' : 'border-line-strong text-ink'
                }`}
              >
                <input
                  type="radio"
                  name="demo-scenario"
                  value={scenario.id}
                  checked={isSelected}
                  disabled={submitting}
                  onChange={() => setSelected(scenario.id)}
                  className="sr-only"
                />
                {scenario.name}
              </label>
            );
          })}
        </div>
      </fieldset>

      <div aria-live="polite">
        {error ? (
          <p className="mt-3 rounded-control bg-danger-tint px-3 py-2 text-small text-danger">{error}</p>
        ) : null}
      </div>

      <button
        type="button"
        onClick={() => void run()}
        disabled={!ready}
        aria-label="Run the selected demo candidate through the ATS pipeline"
        className="mt-4 h-control rounded-control bg-brand px-5 text-small font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
      >
        {submitting ? 'Running…' : 'Run demo'}
      </button>
    </section>
  );
}
