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

  if (session.state.status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-small text-ink-muted">Loading…</p>
      </main>
    );
  }

  // Nothing below can be reached by a browser the server has not confirmed a
  // session for — and the server refuses every protected endpoint anyway, so
  // this gate is the honest presentation of that boundary rather than the
  // boundary itself.
  if (session.state.status === 'anonymous') {
    return <Login onSignedIn={() => void session.refresh()} />;
  }

  return (
    <AppShell
      route={route}
      operator={session.state.operator}
      onSignOut={() => void session.signOut()}
      notice={session.notice}
      onDismissNotice={session.dismissNotice}
    >
      {/* A screen switch rather than a route table: three branches read more
          plainly than a registry, and each screen owns its own loading. A
          detail route with no id is a stale or mistyped link, so it falls back
          to the list it belongs to rather than to an error. */}
      {route.name === 'overview' ? <Overview /> : null}
      {route.name === 'jobs' ? route.id === null ? <Jobs /> : <JobDetail jobId={route.id} /> : null}
      {route.name === 'candidates' ? route.id === null ? <Jobs /> : <CandidateDetail evaluationId={route.id} /> : null}
    </AppShell>
  );
}
