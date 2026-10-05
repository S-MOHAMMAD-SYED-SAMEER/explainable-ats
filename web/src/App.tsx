import type { ReactNode } from 'react';
import { RecruiterApp } from './RecruiterApp.tsx';
import { DemoApp } from './DemoApp.tsx';
import { useMode } from './useMode.ts';

// The page's one entry point: which product is this?
//
// THE SAME BUNDLE IS SERVED BY TWO DEPLOYMENTS
//
// The real application and the portfolio demo are one codebase, deployed twice
// (see `server/src/config/mode.ts`). This component asks the server which one it
// is talking to and hands the page to the matching half — `RecruiterApp` or
// `DemoApp` — each of which owns its own hooks, its own routes and its own gate.
// Nothing below here compares a mode to a string, so neither half can end up
// drawing the other's screens.
//
// IT DOES NOT GUESS. If the server's answer is missing or unrecognised, the page
// says so and offers a retry, rather than picking a side: a sign-in screen drawn
// against a server with no sign-in, or a recruiter's dashboard drawn against the
// demo, is exactly the confusion the split exists to remove.
//
// EVERY HOOK IS DECLARED HERE, ABOVE EVERY RETURN, AND MUST STAY THAT WAY.
//
// React counts hooks per render. A hook placed after one of the early returns
// below would run on some renders and not others, which is React error #310
// ("Rendered more hooks than during the previous render") — and with no error
// boundary that unmounts the tree and leaves a blank page. inbox-crm-agent shipped
// exactly that fault and it survived 800 passing tests, because nothing in a
// node:test suite renders a component. `test/hook-order.test.ts` is what
// guards it here.

export function App(): ReactNode {
  const mode = useMode();

  if (mode.state.status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-small text-ink-muted">Loading…</p>
      </main>
    );
  }

  if (mode.state.status === 'error') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
        <div className="w-full max-w-sm rounded-card border border-line bg-surface p-5 shadow-resting">
          <h1 className="text-subhead text-ink">Explainable ATS</h1>
          <p role="alert" className="mt-2 text-small text-ink-muted">
            {mode.state.message}
          </p>
          <button
            type="button"
            onClick={mode.retry}
            className="mt-4 h-control w-full rounded-control bg-brand px-4 text-small font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            Try again
          </button>
        </div>
      </main>
    );
  }

  return mode.state.mode === 'demo' ? <DemoApp /> : <RecruiterApp />;
}
