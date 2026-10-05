import { Fragment, type ReactNode } from 'react';
import { AppShell } from './components/AppShell.tsx';
import { Jobs } from './screens/Jobs.tsx';
import { JobDetail } from './screens/JobDetail.tsx';
import { CandidateDetail } from './screens/CandidateDetail.tsx';
import { DemoEntry } from './screens/DemoEntry.tsx';
import { useDemoSession } from './demo/useDemoSession.ts';
import { setApiScope } from './api/client.ts';
import { DEMO_DEFAULT_ROUTE, DEMO_ROUTES, navigate } from './router.ts';
import { useRoute } from './useRoute.ts';

// The portfolio demo: a project explanation, then the interactive demo.
//
// Rendered only when the server says it is `APP_MODE=demo`. There is no sign-in
// here and no operator: the server has no sign-in to offer, so the page does not
// draw one.
//
//   Page 1  the project explanation (`DemoEntry`, at `#/demo`, and wherever a
//           visitor with no session lands). One call to action starts — or
//           resumes — the visitor's private session.
//   Page 2  the interactive demo: the same dashboard screens the recruiter would
//           use, drawn from the visitor's own in-memory copy of the synthetic
//           dataset.
//
// A DEMO SESSION IS NOT A SIGN-IN. It is named by an HttpOnly cookie this code
// cannot read, and everything it reaches is invented.
//
// EVERY HOOK IS DECLARED ABOVE EVERY RETURN — see the note in App.tsx.

export function DemoApp(): ReactNode {
  const route = useRoute(DEMO_ROUTES, DEMO_DEFAULT_ROUTE);
  const demoSession = useDemoSession();

  // Every screen below reads the visitor's own session, never a canonical API.
  setApiScope('demo');

  if (demoSession.state.status === 'checking') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-small text-ink-muted">Loading…</p>
      </main>
    );
  }

  // Page 1 is the front door: it is what `#/demo` is, what an unrecognised hash
  // falls back to, and where a visitor with no live session is sent from anywhere
  // else — a stale deep link, or a session that expired mid-visit. Starting again
  // from it puts the dashboard back under them.
  const inSession = demoSession.state.status === 'active' && route.name !== 'demo';
  if (!inSession) {
    return <DemoEntry demo={demoSession} redirect={route.name === 'demo'} />;
  }

  return (
    <AppShell
      route={route}
      demoSession={{
        busy: demoSession.busy,
        onReset: () => {
          void demoSession.reset().then((view) => {
            if (view) navigate({ name: 'jobs', id: view.jobId });
          });
        },
        // Leaving returns to Page 1, not to the dashboard's list.
        onExit: () => {
          void demoSession.end().then(() => navigate(DEMO_DEFAULT_ROUTE));
        },
      }}
      notice={null}
      onDismissNotice={() => undefined}
    >
      {/* Keyed on the reset count, so a reset remounts the screens and re-reads the
          fresh copy instead of showing the last one's data. */}
      <Fragment key={demoSession.generation}>
        {route.name === 'jobs' ? route.id === null ? <Jobs /> : <JobDetail jobId={route.id} demoSession /> : null}
        {route.name === 'candidates' ? route.id === null ? <Jobs /> : <CandidateDetail evaluationId={route.id} demoSession /> : null}
      </Fragment>
    </AppShell>
  );
}
