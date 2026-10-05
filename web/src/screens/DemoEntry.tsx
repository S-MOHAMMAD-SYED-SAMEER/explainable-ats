import type { ReactNode } from 'react';
import { navigate } from '../router.ts';
import { landingView } from '../demo/session.ts';
import {
  CONTROL_HELP,
  DEMO_DISCLOSURE,
  EXPLORE_ITEMS,
  PROJECT_LEAD,
  PROJECT_LIMITS,
  PROJECT_SECTIONS,
  WORKFLOW_STAGES,
  type ProjectSection,
} from '../demo/copy.ts';
import type { DemoSessionHandle } from '../demo/useDemoSession.ts';

// The demo deployment's first page: what this project is.
//
// A visitor arrives with no account and no password, and most arrive wanting to
// know what they are looking at before they click anything. This page tells them —
// the problem, the workflow, how evidence is verified, what is deterministic, where
// the boundaries are and what is not here — in a few short sections, and then
// offers ONE way in: the call to action that starts (or resumes) their private
// demo session. It never starts anything by itself: a session is built because a
// person asked for one.
//
// A VISITOR WITH A LIVE SESSION IS OFFERED IT BACK
//
// The same call sits behind the button either way: starting resumes the session the
// browser already holds, and builds a new one only if there is none. So a reload, a
// second tab or a return visit lands here and the button picks up where they were;
// a visitor who wants a clean slate says so explicitly with "Start over".
//
// IT IS NOT A SIGN-IN. It never calls `api.login`, holds no credential and sets no
// operator state — this deployment has none. Nothing on it shows an identifier: the
// job and the session are named by the server and never by this page.

function Section({ section }: { section: ProjectSection }): ReactNode {
  const headingId = `project-${section.id}`;
  return (
    <section aria-labelledby={headingId} className="rounded-card border border-line bg-surface p-5">
      <h2 id={headingId} className="text-subhead text-ink">
        {section.heading}
      </h2>
      {section.body.map((paragraph) => (
        <p key={paragraph} className="mt-2 text-small text-ink">
          {paragraph}
        </p>
      ))}
      {section.points ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-small text-ink">
          {section.points.map((point) => (
            <li key={point}>{point}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function DemoEntry({ demo, redirect }: { demo: DemoSessionHandle; redirect: boolean }): ReactNode {
  const { state, entered, busy, start, reset } = demo;
  const view = landingView(state, entered);
  const disabled = view.busy || busy;

  // Reached by the front-page address: move on to the job. When this page
  // appears because a session ended mid-visit, the visitor is already where they
  // were, and starting again simply puts the dashboard back under them.
  const begin = async (): Promise<void> => {
    const session = await start();
    if (session && redirect) navigate({ name: 'jobs', id: session.jobId });
  };

  const startOver = async (): Promise<void> => {
    if ((await reset()) !== null) await begin();
  };

  const workflow = PROJECT_SECTIONS.find((section) => section.id === 'workflow');
  const others = PROJECT_SECTIONS.filter((section) => section.id !== 'workflow');

  return (
    <main className="min-h-screen bg-canvas text-ink">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
        <header>
          <p className="text-eyebrow uppercase tracking-wide text-ink-muted">AI Recruitment Intelligence</p>
          <h1 className="mt-1 text-section text-ink">Explainable ATS</h1>
          <p className="mt-3 max-w-3xl text-body text-ink">{PROJECT_LEAD}</p>
          <p className="mt-3 inline-block rounded-control border border-line-strong bg-brand-tint px-3 py-2 text-small font-semibold text-ink">
            {DEMO_DISCLOSURE}
          </p>

          {/* THE call to action. There is one, here, above everything a visitor might
              scroll past: the page is short enough to read first and offers the way in
              first. */}
          <div className="mt-6 rounded-card border border-line bg-surface p-5 shadow-resting">
            <div aria-live="polite">
              {view.notice ? (
                <p className="mb-3 rounded-control bg-signal-tint px-3 py-2 text-small text-ink">{view.notice}</p>
              ) : null}
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
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

            <p className="mt-3 text-small text-ink-muted">
              {state.status === 'active'
                ? 'You already have a private demo session in this browser; the button picks it up where you left it.'
                : 'No sign-in. Starting builds your own private copy of the demo in a moment.'}
            </p>
            <p className="mt-1 text-meta text-ink-muted">
              Inside, the header has two controls. {CONTROL_HELP.reset} {CONTROL_HELP.exit}
            </p>
          </div>
        </header>

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {others.slice(0, 2).map((section) => (
            <Section key={section.id} section={section} />
          ))}
        </div>

        {workflow ? (
          <section aria-labelledby="project-workflow" className="mt-4 rounded-card border border-line bg-surface p-5">
            <h2 id="project-workflow" className="text-subhead text-ink">
              {workflow.heading}
            </h2>
            {workflow.body.map((paragraph) => (
              <p key={paragraph} className="mt-2 text-small text-ink-muted">
                {paragraph}
              </p>
            ))}
            <ol className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {WORKFLOW_STAGES.map((stage, index) => (
                <li key={stage.id} className="rounded-control border border-line p-4">
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
        ) : null}

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          {others.slice(2).map((section) => (
            <Section key={section.id} section={section} />
          ))}
        </div>

        <section aria-labelledby="project-limits" className="mt-4 rounded-card border border-dashed border-line-strong p-5">
          <h2 id="project-limits" className="text-subhead text-ink">
            What this demo is not
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-small text-ink">
            {PROJECT_LIMITS.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="project-inside" className="mt-4 rounded-card border border-line bg-surface p-5">
          <h2 id="project-inside" className="text-subhead text-ink">
            What you can explore
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-small text-ink">
            {EXPLORE_ITEMS.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
