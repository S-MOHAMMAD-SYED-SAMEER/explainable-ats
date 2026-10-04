import type { ReactNode } from 'react';
import { navigate } from '../router.ts';
import { landingView } from '../demo/session.ts';
import {
  CONTROL_HELP,
  DEMO_DISCLOSURE,
  DEMO_FACTS,
  DEMO_LEAD,
  DEMO_TITLE,
  EXPLORE_ITEMS,
  WHAT_IT_DOES,
  WORKFLOW_STAGES,
} from '../demo/copy.ts';
import type { DemoSessionHandle } from '../demo/useDemoSession.ts';

// The public demo's front door (`/#/demo`).
//
// A visitor arrives with no account and no password. This screen tells them what
// they are about to use — what the product does, what they can explore, that
// every person in it is invented, that nothing they do touches a real record and
// that no key or AI service is involved — and then waits for them to press
// "Start Demo". It never starts anything by itself: a session is built because a
// person asked for one.
//
// A VISITOR WITH A LIVE SESSION IS OFFERED IT BACK
//
// The same call sits behind every button here: starting resumes the session the
// browser already holds, and builds a new one only if there is none. So a reload,
// a second tab or a return visit lands here and gets "Resume demo", and the
// visitor who wants a clean slate says so explicitly with "Start over".
//
// IT IS NOT A SIGN-IN. It never calls `api.login`, holds no credential and sets
// no operator state. Nothing on it shows an identifier: the job and the session
// are named by the server and never by this screen.

export function DemoEntry({ demo, redirect }: { demo: DemoSessionHandle; redirect: boolean }): ReactNode {
  const { state, entered, busy, start, reset } = demo;
  const view = landingView(state, entered);
  const disabled = view.busy || busy;

  // Reached by the `/#/demo` address: move on to the job. When this screen
  // appears because a session ended mid-visit, the visitor is already where they
  // were, and starting again simply puts the dashboard back under them.
  const begin = async (): Promise<void> => {
    const session = await start();
    if (session && redirect) navigate({ name: 'jobs', id: session.jobId });
  };

  const startOver = async (): Promise<void> => {
    if ((await reset()) !== null) await begin();
  };

  return (
    <main className="min-h-screen bg-canvas text-ink">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-12">
        <header>
          <p className="text-eyebrow uppercase tracking-wide text-ink-muted">AI Recruitment Intelligence</p>
          <h1 className="mt-1 text-section text-ink">{DEMO_TITLE}</h1>
          <p className="mt-3 text-body text-ink">{DEMO_LEAD}</p>
          <p className="mt-2 inline-block rounded-control border border-line-strong bg-brand-tint px-3 py-2 text-small font-semibold text-ink">
            {DEMO_DISCLOSURE}
          </p>
        </header>

        <section
          aria-labelledby="demo-start-heading"
          className="mt-6 rounded-card border border-line bg-surface p-5 shadow-resting"
        >
          <h2 id="demo-start-heading" className="text-subhead">
            {state.status === 'active' ? 'Pick up where you left off' : 'Ready when you are'}
          </h2>
          <p className="mt-1 text-small text-ink-muted">
            {state.status === 'active'
              ? 'You already have a private demo session in this browser.'
              : 'No sign-in. Starting builds your own private copy of the demo in a moment.'}
          </p>

          <div aria-live="polite">
            {view.notice ? (
              <p className="mt-3 rounded-control bg-signal-tint px-3 py-2 text-small text-ink">{view.notice}</p>
            ) : null}
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <button
              type="button"
              onClick={() => void begin()}
              disabled={disabled}
              className="h-control w-full rounded-control bg-brand px-6 text-small font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 sm:w-auto"
            >
              {view.primary}
            </button>
            {view.canStartOver ? (
              <button
                type="button"
                onClick={() => void startOver()}
                disabled={disabled}
                className="h-control w-full rounded-control border border-line-strong px-4 text-small font-semibold text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 sm:w-auto"
              >
                Start over with a fresh copy
              </button>
            ) : null}
          </div>

          <p className="mt-3 text-meta text-ink-muted">
            Inside, the header has two controls. {CONTROL_HELP.reset} {CONTROL_HELP.exit}
          </p>
        </section>

        <section aria-labelledby="demo-about-heading" className="mt-10">
          <h2 id="demo-about-heading" className="text-subhead">
            What this ATS does
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-small text-ink">
            {WHAT_IT_DOES.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="demo-explore-heading" className="mt-8">
          <h2 id="demo-explore-heading" className="text-subhead">
            What you can explore
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-small text-ink">
            {EXPLORE_ITEMS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="demo-facts-heading" className="mt-8">
          <h2 id="demo-facts-heading" className="text-subhead">
            About this demo
          </h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            {DEMO_FACTS.map((fact) => (
              <div key={fact.heading} className="rounded-card border border-line bg-surface p-4">
                <dt className="text-small font-semibold text-ink">{fact.heading}</dt>
                <dd className="mt-1 text-small text-ink-muted">{fact.body}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="demo-workflow-heading" className="mt-10">
          <h2 id="demo-workflow-heading" className="text-subhead">
            How a CV becomes a ranking
          </h2>
          <p className="mt-1 text-small text-ink-muted">
            Seven stages, in order. Each one is recorded, so every placement can be explained afterwards.
          </p>
          <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {WORKFLOW_STAGES.map((stage, index) => (
              <li key={stage.id} className="rounded-card border border-line bg-surface p-4">
                <div className="flex items-center gap-2">
                  {/* The number is text, so the order does not depend on seeing a colour. */}
                  <span
                    aria-hidden="true"
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border border-line-strong text-meta font-semibold text-ink"
                  >
                    {index + 1}
                  </span>
                  <h3 className="text-small font-semibold text-ink">
                    <span className="sr-only">Stage {index + 1}: </span>
                    {stage.label}
                  </h3>
                </div>
                <p className="mt-2 text-meta text-ink-muted">{stage.summary}</p>
              </li>
            ))}
          </ol>
        </section>

        <div className="mt-10 border-t border-line pt-6">
          <button
            type="button"
            onClick={() => void begin()}
            disabled={disabled}
            className="h-control w-full rounded-control bg-brand px-6 text-small font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50 sm:w-auto"
          >
            {view.primary}
          </button>
        </div>
      </div>
    </main>
  );
}
