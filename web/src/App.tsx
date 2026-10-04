import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { AppShell } from './components/AppShell.tsx';
import { Overview } from './screens/Overview.tsx';
import { Jobs } from './screens/Jobs.tsx';
import { JobDetail } from './screens/JobDetail.tsx';
import { CandidateDetail } from './screens/CandidateDetail.tsx';
import { Login } from './screens/Login.tsx';
import { DemoEntry } from './screens/DemoEntry.tsx';
import { useSession } from './auth/useSession.ts';
import { useDemoSession } from './demo/useDemoSession.ts';
import { demoSessionInUse } from './demo/session.ts';
import { setApiScope } from './api/client.ts';
import { DEFAULT_ROUTE, navigate, parseRoute, type Route } from './router.ts';

/**
 * Subscribes to the location hash.
 *
 * A hook rather than a context: exactly one component needs the current route,
 * and threading it from a single owner is clearer than a provider nobody else
 * consumes.
 */
function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? DEFAULT_ROUTE : parseRoute(window.location.hash),
  );

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    // Re-read on mount too: the first render happens before this effect, and
    // the hash can already have changed by then — a deep link, or a reload.
    onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}

export function App(): ReactNode {
  // EVERY HOOK IS DECLARED HERE, ABOVE EVERY RETURN, AND MUST STAY THAT WAY.
  //
  // React counts hooks per render. A hook placed after one of the early returns
  // below would run on some renders and not others, which is React error #310
  // ("Rendered more hooks than during the previous render") — and with no error
  // boundary that unmounts the tree and leaves a blank page. inbox-crm-agent shipped
  // exactly that fault and it survived 800 passing tests, because nothing in a
  // node:test suite renders a component. `test/hook-order.test.ts` is what
  // guards it here.
  const route = useRoute();
  const session = useSession();
  // The visitor-scoped public demo. Entirely separate from `session`: a demo
  // session is not a sign-in, and nothing below lets one stand in for the other.
  const demoSession = useDemoSession();

  // Whether the dashboard is drawn from the visitor's own sandbox. Derived from
  // the server's two answers, never stored — see `demoSessionInUse`.
  const inDemoSession = demoSessionInUse({
    sessionActive: demoSession.state.status === 'active',
    authenticated: session.state.status === 'authenticated',
    entered: demoSession.entered,
  });

  // Which half of the API every screen below reads. Set here, in render, because
  // a child's data-loading effect runs BEFORE any effect this component could
  // register, and would otherwise read the previous scope. It is idempotent —
  // the same inputs always set the same value — which is what makes it safe.
  setApiScope(inDemoSession ? 'demo' : 'recruiter');

  if (session.state.status === 'loading' || demoSession.state.status === 'checking') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-small text-ink-muted">Loading…</p>
      </main>
    );
  }

  // The public demo's front door, and the recovery path when a demo session
  // ends mid-visit. It sits ABOVE the sign-in gate on purpose: a visitor who
  // asked for the demo must not meet a password box first. It grants nothing —
  // everything a demo session can reach is synthetic, and the server refuses the
  // recruiter's routes to it regardless of what this screen believes.
  if (route.name === 'demo' || (demoSession.entered && !inDemoSession)) {
    return <DemoEntry demo={demoSession} redirect={route.name === 'demo'} />;
  }

  // This gate is the honest presentation of the server's boundary rather than
  // the boundary itself — the server refuses every protected endpoint on its
  // own. The demo branch below relies on exactly that: it draws the dashboard
  // for a visitor with no session, and every write behind it still fails.
  if (session.state.status === 'anonymous' && !inDemoSession) {
    return <Login onSignedIn={() => void session.refresh()} />;
  }

  // Anonymous past that return means the visitor is in their own demo session. A
  // signed-in operator who chose the visitor demo is in it too.
  const demo = session.state.status === 'anonymous' || inDemoSession;

  return (
    <AppShell
      route={route}
      operator={session.state.status === 'authenticated' && !inDemoSession ? session.state.operator : null}
      onSignOut={() => void session.signOut()}
      demo={demo}
      demoSession={
        inDemoSession
          ? {
              busy: demoSession.busy,
              onReset: () => {
                void demoSession.reset().then((view) => {
                  if (view) navigate({ name: 'jobs', id: view.jobId });
                });
              },
              onExit: () => {
                void demoSession.end().then(() => navigate({ name: 'jobs', id: null }));
              },
            }
          : undefined
      }
      notice={session.notice}
      onDismissNotice={session.dismissNotice}
    >
      {/* A screen switch rather than a route table: three branches read more
          plainly than a registry, and each screen owns its own loading. A
          detail route with no id is a stale or mistyped link, so it falls back
          to the list it belongs to rather than to an error. */}
      {/* Keyed on which half of the API is being read and on the reset count, so
          entering the demo, leaving it, or resetting it remounts the screens and
          re-reads from the right place instead of showing the last place's data. */}
      <Fragment key={`${inDemoSession ? 'demo' : 'recruiter'}-${demoSession.generation}`}>
        {route.name === 'overview' ? <Overview /> : null}
        {route.name === 'jobs' ? route.id === null ? <Jobs /> : <JobDetail jobId={route.id} demo={demo} demoSession={inDemoSession} /> : null}
        {route.name === 'candidates' ? route.id === null ? <Jobs /> : <CandidateDetail evaluationId={route.id} demo={demo} demoSession={inDemoSession} /> : null}
      </Fragment>
    </AppShell>
  );
}
