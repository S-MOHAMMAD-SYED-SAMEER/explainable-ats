import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';
import type { Health } from '../api/types.ts';

// Overview — the first screen after signing in, and in P3-A the only one.
//
// It reports live status from `GET /api/health`, which makes it the end-to-end
// proof that the foundation is wired together: browser → Express → handler →
// repository → migrated schema, with a real answer coming back.
//
// It states facts in sentences rather than printing the configuration object.
// Project 2 shipped a raw key/value dump here and it read as a diagnostics
// console to the one audience that matters. Every fact below is the same fact
// health reports; none of them is hidden to make the system look more finished
// than it is.

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; health: Health }
  | { status: 'error'; message: string };

type Fact = { label: string; value: string; detail: string; tone: 'good' | 'bad' | 'neutral' };

function facts(health: Health): Fact[] {
  const a = health.adapters;
  const connected = health.status === 'ok' && health.database.reachable;

  const out: Fact[] = [
    {
      label: 'System',
      value: connected ? 'Running' : 'Degraded',
      detail: connected
        ? 'The service is answering and its records are reachable.'
        : 'The service is answering but its records are not reachable.',
      tone: connected ? 'good' : 'bad',
    },
    {
      label: 'Sign-in',
      value: a.authConfigured === true ? 'Required' : 'Not configured',
      detail:
        a.authConfigured === true
          ? 'Every screen and every action requires a signed-in user.'
          : 'No password is set, so the API is open. Not suitable for real data.',
      tone: a.authConfigured === true ? 'good' : 'bad',
    },
    {
      label: 'Language model',
      value: a.llmProvider === 'mock' ? 'Demo mode' : a.llmProvider === 'anthropic' ? 'Claude' : String(a.llmProvider),
      detail:
        a.llmProvider === 'mock'
          ? 'Running on recorded responses, so a walkthrough behaves identically every time.'
          : 'Live model calls, with every reply checked before it can be used.',
      tone: 'neutral',
    },
  ];

  return out;
}

export function Overview(): ReactNode {
  // Every hook above every return — see the note in App.tsx.
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    api
      .health()
      .then((health) => {
        if (!cancelled) setState({ status: 'ready', health });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The client turns every failure — including a network drop, which has
        // no envelope — into one ApiError, so there is exactly one error shape
        // to render here.
        setState({ status: 'error', message: err instanceof ApiError ? err.message : 'Something went wrong.' });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      <section className="rounded-card border border-line bg-surface p-6 shadow-resting">
        <h3 className="text-subhead">System status</h3>

        {state.status === 'loading' ? <p className="mt-3 text-small text-ink-muted">Checking…</p> : null}

        {state.status === 'error' ? (
          <div className="mt-3 rounded-control border border-line bg-danger-tint p-4">
            <p className="text-small font-semibold text-danger">Not connected</p>
            <p className="mt-1 text-small text-ink-muted">{state.message}</p>
            <p className="mt-2 text-meta text-ink-muted">
              Start the API with <code className="font-mono">npm run dev</code> in{' '}
              <code className="font-mono">explainable-ats/server</code>.
            </p>
          </div>
        ) : null}

        {state.status === 'ready' ? (
          <>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              {facts(state.health).map((fact) => (
                <div key={fact.label} className="rounded-control border border-line p-3">
                  <dt className="text-meta uppercase tracking-wide text-ink-muted">{fact.label}</dt>
                  {/* Tone is carried by the words as well as the colour: status
                      is never communicated by colour alone. */}
                  <dd
                    className={`mt-1 text-body ${
                      fact.tone === 'good' ? 'text-success' : fact.tone === 'bad' ? 'text-danger' : 'text-ink'
                    }`}
                  >
                    {fact.value}
                  </dd>
                  <dd className="mt-1 text-meta text-ink-muted">{fact.detail}</dd>
                </div>
              ))}
            </dl>

            <p className="mt-4 text-meta text-ink-muted">
              Configuration is reported as configured or not — never the values themselves. No key, no fragment of a
              key, and no connection string reaches the browser.
            </p>
          </>
        ) : null}
      </section>
    </div>
  );
}
