import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';
import { useLoad } from '../useLoad.ts';
import { BackLink, Badge, Loading, Problem, Technical } from '../components/Bits.tsx';
import {
  MIN_REASON_CHARS,
  OUTCOMES,
  kindLabel,
  outcomeWording,
  tierWording,
  toneClass,
  verdictWording,
} from '../copy.ts';
import { routeToHash } from '../router.ts';
import type { EvaluationDetail, RequirementOutcome } from '../api/types.ts';

// One candidate, against one role — the screen a hiring decision is made on.
//
// EVERY QUOTE HERE WAS CHECKED AGAINST THE ORIGINAL CV BEFORE IT WAS STORED.
//
// The server sends verified passages and nothing else. That is not a detail of
// the API; it is the reason a recruiter can read a quote on this page and
// repeat it to the candidate. A quote the verifier rejected exists in the audit
// trail and never reaches this component.
//
// The primary reading path is plain language. Model names, prompt versions,
// weights and basis points live inside `<details>` — a recruiter deciding about
// a person should not have to read the word "basis points" to do it, and an
// engineer checking the arithmetic should not have to ask.

function Headline({ detail }: { detail: EvaluationDetail }): ReactNode {
  const wording = tierWording(detail.tier);
  const name = detail.candidate.displayName ?? detail.candidate.reference;

  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-resting">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 className="text-section text-ink">{name}</h3>
          <p className="mt-1 text-small text-ink-muted">Assessed against {detail.job.title}</p>
        </div>
        <div className="text-right">
          <p className="text-display leading-none text-ink">{detail.scorePercent ?? '—'}</p>
          <p className="mt-1 text-meta uppercase tracking-wide text-ink-muted">Evidence score</p>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Badge wording={wording} />
        {detail.mustHavesTotal !== null ? (
          <span className="text-small text-ink-muted">
            Meets {detail.mustHavesMet} of {detail.mustHavesTotal} essential requirement
            {detail.mustHavesTotal === 1 ? '' : 's'}.
          </span>
        ) : null}
      </div>

      <p className={`mt-2 text-small ${toneClass(wording.tone)}`}>{wording.detail}</p>

      {detail.isCurrent ? null : (
        <p className="mt-3 rounded-control bg-signal-tint px-3 py-2 text-small text-signal">
          This is an earlier assessment. It has been replaced by a newer one, and no decision can be recorded against
          it. It is kept so a decision made at the time can still be explained.
        </p>
      )}

      <Technical summary="How this score was reached">
        <p>
          The score is the weighted average of what the evidence showed for each requirement, as an integer out of
          10,000 basis points: <strong>{detail.scoreBasisPoints ?? '—'}</strong>. Each requirement below shows its own
          contribution, and those contributions add up to exactly this total.
        </p>
        <p>
          Evidence was read by <strong>{detail.model ?? 'no model yet'}</strong> under prompt version{' '}
          <strong>{detail.promptVersion ?? '—'}</strong>. The model quotes passages; it does not decide whether a
          requirement is met and it does not produce a score. Those are computed here, in ordinary arithmetic, from
          quotes that were checked against the CV first.
        </p>
        {detail.evidenceRejectedCount > 0 ? (
          <p>
            <strong>{detail.evidenceRejectedCount}</strong> quoted passage
            {detail.evidenceRejectedCount === 1 ? ' was' : 's were'} not found in the CV and{' '}
            {detail.evidenceRejectedCount === 1 ? 'was' : 'were'} rejected. Rejected passages take no part in the score
            and are not shown on this page.
          </p>
        ) : (
          <p>Every quoted passage was found in the CV exactly as quoted.</p>
        )}
      </Technical>
    </section>
  );
}

function Fairness({ detail }: { detail: EvaluationDetail }): ReactNode {
  if (detail.protectedAttributes.count === 0) return null;

  return (
    <section className="rounded-card border border-line bg-brand-tint p-4">
      <h4 className="text-small font-semibold text-ink">
        {detail.protectedAttributes.count} personal detail
        {detail.protectedAttributes.count === 1 ? ' was' : 's were'} hidden before this CV was read
      </h4>
      <p className="mt-1 text-small text-ink-muted">
        Removed from the copy the assessment ran on, so they could not influence it:{' '}
        {detail.protectedAttributes.categories.join(', ').replace(/_/g, ' ')}.
      </p>
      <p className="mt-1 text-meta text-ink-muted">
        Only the category and the position were recorded. The values themselves were never stored, so there is nothing
        to show here and nothing to leak.
      </p>
    </section>
  );
}

/**
 * One requirement, its verdict, and the passages behind it.
 *
 * The contribution is shown in points rather than as a rounded percentage, and
 * that is deliberate. The scorer distributes the total so the parts sum to it
 * exactly; rounding each part to a whole percent independently breaks that sum
 * back open — three requirements reading 43%, 0% and 29% against a headline of
 * 71%. The one thing a reader checks is whether it adds up, so the number shown
 * here is the one that does.
 */
function RequirementCard({
  requirement,
  totalBasisPoints,
}: {
  requirement: RequirementOutcome;
  totalBasisPoints: number | null;
}): ReactNode {
  const wording = verdictWording(requirement.verdict);

  return (
    <li className="rounded-card border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-body font-semibold text-ink">{requirement.label}</span>
          <span className="text-meta uppercase tracking-wide text-ink-muted">{kindLabel(requirement.kind)}</span>
        </div>
        <Badge wording={wording} />
      </div>

      <p className="mt-1 text-small text-ink-muted">{requirement.criterion}</p>
      <p className={`mt-2 text-small ${toneClass(wording.tone)}`}>{wording.detail}</p>

      {requirement.evidence.length > 0 ? (
        <div className="mt-3">
          <p className="text-meta font-semibold uppercase tracking-wide text-ink-muted">From the CV</p>
          <ul className="mt-1 space-y-2">
            {requirement.evidence.map((item) => (
              <li key={item.id} className="border-l-2 border-brand pl-3">
                <blockquote className="text-small italic text-ink">“{item.quote}”</blockquote>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 text-small text-ink-muted">
          No passage in the CV was quoted for this requirement.
        </p>
      )}

      <Technical summary="How this requirement was judged">
        <p>{requirement.rationale ?? 'This requirement was not judged, because the assessment did not finish.'}</p>
        <p>
          Weight {requirement.weight}
          {requirement.contributionBasisPoints === null
            ? '.'
            : `, contributing ${requirement.contributionBasisPoints.toLocaleString()} points of this candidate's ${(totalBasisPoints ?? 0).toLocaleString()}.`}
          {requirement.confidence === null ? '' : ` Confidence: ${requirement.confidence}.`}
        </p>
      </Technical>
    </li>
  );
}

function DecisionRecorded({ detail }: { detail: EvaluationDetail }): ReactNode {
  const decision = detail.decision;
  if (!decision) return null;

  const wording = outcomeWording(decision.outcome);

  return (
    <section className="rounded-card border border-line-strong bg-surface p-5">
      <h4 className="text-subhead">Decision recorded</h4>
      <p className={`mt-2 text-body font-semibold ${toneClass(wording.tone)}`}>{wording.label}</p>
      <p className="mt-2 text-small text-ink">“{decision.reason}”</p>
      <p className="mt-2 text-meta text-ink-muted">
        Recorded by {decision.decidedBy} on {new Date(decision.decidedAt).toLocaleString()}.
      </p>
      <p className="mt-3 text-meta text-ink-muted">
        A decision cannot be edited or removed. To decide differently, assess the candidate again — the new assessment
        replaces this one, and both stay on the record.
      </p>
    </section>
  );
}

function DecisionForm({
  detail,
  onDecided,
}: {
  detail: EvaluationDetail;
  onDecided: (updated: EvaluationDetail) => void;
}): ReactNode {
  // Every hook above every return — see the note in App.tsx. The guards that
  // hide this form live in the parent for exactly that reason.
  const [outcome, setOutcome] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = reason.trim();
  const ready = outcome !== null && trimmed.length >= MIN_REASON_CHARS && !submitting;

  const submit = async (): Promise<void> => {
    if (!ready || outcome === null) return;
    setSubmitting(true);
    setError(null);

    try {
      const result = await api.decide(detail.evaluationId, outcome, trimmed);
      // The server returns the resulting state, so the screen renders what it
      // actually holds rather than what this component assumed would happen.
      onDecided(result.evaluation);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not record that decision.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="rounded-card border border-line bg-surface p-5 shadow-resting">
      <h4 className="text-subhead">Your decision</h4>
      <p className="mt-1 text-small text-ink-muted">
        Every decision needs a reason. It is kept on the record permanently, and it is what makes this decision
        explainable to the candidate later.
      </p>

      <form
        className="mt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset>
          <legend className="text-meta font-semibold uppercase tracking-wide text-ink-muted">Outcome</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {OUTCOMES.map((option) => {
              const wording = outcomeWording(option);
              const selected = outcome === option;
              return (
                <label
                  key={option}
                  className={`cursor-pointer rounded-control border px-4 py-2 text-small font-semibold focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-brand ${
                    selected ? 'border-brand bg-brand text-white' : 'border-line-strong text-ink'
                  }`}
                >
                  <input
                    type="radio"
                    name="outcome"
                    value={option}
                    checked={selected}
                    onChange={() => setOutcome(option)}
                    className="sr-only"
                  />
                  {wording.label}
                </label>
              );
            })}
          </div>
          {outcome === null ? null : (
            <p className="mt-2 text-small text-ink-muted">{outcomeWording(outcome).detail}</p>
          )}
        </fieldset>

        <div className="mt-4">
          <label htmlFor="decision-reason" className="text-meta font-semibold uppercase tracking-wide text-ink-muted">
            Reason (required)
          </label>
          <textarea
            id="decision-reason"
            value={reason}
            rows={3}
            required
            minLength={MIN_REASON_CHARS}
            aria-describedby="decision-reason-hint"
            onChange={(event) => setReason(event.target.value)}
            className="mt-1 w-full rounded-control border border-line bg-surface p-2 text-small text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          />
          <p id="decision-reason-hint" className="mt-1 text-meta text-ink-muted">
            At least {MIN_REASON_CHARS} characters.{' '}
            {trimmed.length > 0 && trimmed.length < MIN_REASON_CHARS
              ? `${MIN_REASON_CHARS - trimmed.length} more to go.`
              : 'Write what you would say if the candidate asked.'}
          </p>
        </div>

        <div aria-live="polite">
          {error ? (
            <p className="mt-3 rounded-control bg-danger-tint px-3 py-2 text-small text-danger">{error}</p>
          ) : null}
        </div>

        <button
          type="submit"
          disabled={!ready}
          className="mt-4 h-control rounded-control bg-brand px-5 text-small font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
        >
          {submitting ? 'Recording…' : 'Record decision'}
        </button>
      </form>
    </section>
  );
}

function History({ evaluationId }: { evaluationId: string }): ReactNode {
  // Every hook above every return — see the note in App.tsx.
  const { state } = useLoad(() => api.evaluationAudit(evaluationId), [evaluationId]);

  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h4 className="text-subhead">Full history</h4>
      <p className="mt-1 text-small text-ink-muted">
        Everything that happened to this CV, in order, from the moment personal details were removed. Nothing in this
        record can be edited or deleted.
      </p>

      <div className="mt-3">
        {state.status === 'loading' ? <Loading what="the history" /> : null}
        {state.status === 'error' ? <Problem message={state.message} /> : null}

        {state.status === 'ready' ? (
          <ol className="space-y-2">
            {state.data.events.map((event) => (
              <li key={event.id} className="rounded-control border border-line p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-small text-ink">{event.summary}</span>
                  <span className="text-meta text-ink-muted">{new Date(event.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-1 text-meta text-ink-muted">
                  {event.actor === 'ai' ? 'By the model' : event.actor === 'human' ? 'By a person' : 'Automatic'}
                  {event.actorId ? ` (${event.actorId})` : ''}
                  {event.outcome === 'ok' ? '' : ` — ${event.outcome}`}
                </p>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </section>
  );
}

export function CandidateDetail({
  evaluationId,
  demo = false,
}: {
  evaluationId: string;
  /**
   * Viewing without a session. The form is not drawn, because a control that
   * looked usable and then failed with a 401 would teach a visitor that the
   * product is broken rather than that they are not signed in. The server
   * refuses the write regardless of this prop.
   */
  demo?: boolean;
}): ReactNode {
  // Every hook above every return — see the note in App.tsx.
  const { state, set } = useLoad(() => api.evaluation(evaluationId), [evaluationId]);

  if (state.status === 'loading') return <Loading what="the candidate" />;
  if (state.status === 'error') return <Problem message={state.message} />;

  const detail = state.data;
  // Both conditions are enforced by the server, which answers 409 either way.
  // Hiding the form is the honest presentation of that rule, not the rule.
  const decidable =
    !demo && detail.decision === null && detail.isCurrent && detail.status === 'scored';

  return (
    <div className="space-y-5">
      <BackLink href={routeToHash({ name: 'jobs', id: detail.job.id })}>Back to {detail.job.title}</BackLink>

      <Headline detail={detail} />
      <Fairness detail={detail} />

      <section>
        <h4 className="text-subhead">Requirement by requirement</h4>
        <p className="mt-1 mb-3 text-small text-ink-muted">
          Every requirement is shown, including the ones the CV said nothing about.
        </p>
        <ul className="space-y-3">
          {detail.requirements.map((requirement) => (
            <RequirementCard
              key={requirement.requirementId}
              requirement={requirement}
              totalBasisPoints={detail.scoreBasisPoints}
            />
          ))}
        </ul>
      </section>

      <DecisionRecorded detail={detail} />

      {decidable ? <DecisionForm detail={detail} onDecided={set} /> : null}

      {demo && detail.decision === null ? (
        <section className="rounded-card border border-dashed border-line-strong p-5">
          <p className="text-small text-ink-muted">
            Recording a decision is where this stops being read-only, so it needs an operator
            sign-in. Everything that produced the ranking above — the quoted evidence, the
            verification and the scoring — is on this page already.
          </p>
        </section>
      ) : null}

      {!decidable && detail.decision === null ? (
        <section className="rounded-card border border-dashed border-line-strong p-5">
          <p className="text-small text-ink-muted">
            {detail.isCurrent
              ? 'This candidate has not finished being assessed, so there is nothing to decide on yet.'
              : 'This assessment has been replaced. Open the current one to record a decision.'}
          </p>
        </section>
      ) : null}

      <History evaluationId={evaluationId} />
    </div>
  );
}
