import type { ReactNode } from 'react';
import { AppShell } from './components/AppShell.tsx';
import { Overview } from './screens/Overview.tsx';
import { Jobs } from './screens/Jobs.tsx';
import { JobDetail } from './screens/JobDetail.tsx';
import { CandidateDetail } from './screens/CandidateDetail.tsx';
import { Login } from './screens/Login.tsx';
import { useSession } from './auth/useSession.ts';
import { setApiScope } from './api/client.ts';
import { DEFAULT_ROUTE, RECRUITER_ROUTES } from './router.ts';
import { useRoute } from './useRoute.ts';

// The real application: sign in, then the recruiter's screens.
//
// Rendered only when the server says it is `APP_MODE=app`. There is nothing here
// about the demo — no demo session, no demo route, no link to one. A visitor who
// is not signed in sees the sign-in screen and nothing else.
//
// EVERY HOOK IS DECLARED ABOVE EVERY RETURN — see the note in App.tsx.

export function RecruiterApp(): ReactNode {
  const route = useRoute(RECRUITER_ROUTES, DEFAULT_ROUTE);
  const session = useSession();

  // The recruiter's half of the API. Set in render, because a child's
  // data-loading effect runs BEFORE any effect this component could register.
  // It is idempotent — the same input always sets the same value.
  setApiScope('recruiter');

  if (session.state.status === 'loading') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-canvas">
        <p className="text-small text-ink-muted">Loading…</p>
      </main>
    );
  }

  // This gate is the honest presentation of the server's boundary rather than
  // the boundary itself — the server refuses every protected endpoint on its own.
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
