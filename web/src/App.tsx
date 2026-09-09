import { useEffect, useState, type ReactNode } from 'react';
import { AppShell } from './components/AppShell.tsx';
import { Overview } from './screens/Overview.tsx';
import { Jobs } from './screens/Jobs.tsx';
import { JobDetail } from './screens/JobDetail.tsx';
import { CandidateDetail } from './screens/CandidateDetail.tsx';
import { Login } from './screens/Login.tsx';
import { useSession } from './auth/useSession.ts';
import { DEFAULT_ROUTE, parseRoute, type Route } from './router.ts';

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
  // boundary that unmounts the tree and leaves a blank page. Project 2 shipped
  // exactly that fault and it survived 800 passing tests, because nothing in a
  // node:test suite renders a component. `test/hook-order.test.ts` is what
  // guards it here.
  const route = useRoute();
  const session = useSession();
  // Viewing the dashboard without a session. A local view preference, not an
  // authentication state — see the note on `SessionState`. It buys this browser
  // nothing the server would not already give an anonymous caller.
  const [browsingDemo, setBrowsingDemo] = useState(false);

  if (session.state.status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-small text-ink-muted">Loading…</p>
      </main>
    );
  }

  // This gate is the honest presentation of the server's boundary rather than
  // the boundary itself — the server refuses every protected endpoint on its
  // own. The demo branch below relies on exactly that: it draws the dashboard
  // for a visitor with no session, and every write behind it still fails.
  if (session.state.status === 'anonymous' && !browsingDemo) {
    return (
      <Login
        onSignedIn={() => void session.refresh()}
        demoAvailable={session.state.demoAvailable}
        onBrowseDemo={() => setBrowsingDemo(true)}
      />
    );
  }

  // Anonymous past that return means the visitor chose to browse the demo.
  const demo = session.state.status === 'anonymous';

  return (
    <AppShell
      route={route}
      operator={session.state.status === 'authenticated' ? session.state.operator : null}
      onSignOut={() => void session.signOut()}
      demo={demo}
      onExitDemo={() => setBrowsingDemo(false)}
      notice={session.notice}
      onDismissNotice={session.dismissNotice}
    >
      {/* A screen switch rather than a route table: three branches read more
          plainly than a registry, and each screen owns its own loading. A
          detail route with no id is a stale or mistyped link, so it falls back
          to the list it belongs to rather than to an error. */}
      {route.name === 'overview' ? <Overview /> : null}
      {route.name === 'jobs' ? route.id === null ? <Jobs /> : <JobDetail jobId={route.id} /> : null}
      {route.name === 'candidates' ? route.id === null ? <Jobs /> : <CandidateDetail evaluationId={route.id} demo={demo} /> : null}
    </AppShell>
  );
}
