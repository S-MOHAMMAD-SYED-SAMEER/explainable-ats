import type { ReactNode } from 'react';
import { routeToHash, type Route, type RouteName } from '../router.ts';

// The frame every screen sits in.
//
// Navigation is business language, not the shape of the code: a recruiter reads
// "Jobs" and "Review", never "evaluations" or "requirement_match". Those names
// belong in the schema and stay there.

type NavItem = { route: RouteName; label: string; hint: string };

const NAV: NavItem[] = [
  { route: 'jobs', label: 'Roles', hint: 'Open roles and the candidates assessed against them' },
  { route: 'overview', label: 'Status', hint: 'System status' },
];

export type AppShellProps = {
  route: Route;
  /** The signed-in operator, or null when this is the read-only demo. */
  operator: string | null;
  onSignOut: () => void;
  /**
   * Viewing without a session. The banner below says so in the visitor's
   * words; the server is what actually refuses the writes.
   */
  demo?: boolean;
  /** Leaves the demo and returns to the sign-in screen. */
  onExitDemo?: () => void;
  notice: string | null;
  onDismissNotice: () => void;
  children: ReactNode;
};

export function AppShell({
  route,
  operator,
  onSignOut,
  demo = false,
  onExitDemo,
  notice,
  onDismissNotice,
  children,
}: AppShellProps): ReactNode {
  // A candidate sits under Roles: the nav marks the section someone is in,
  // not the exact page, or the highlight vanishes as soon as they drill in.
  const section: RouteName = route.name === 'candidates' ? 'jobs' : route.name;
  const current = NAV.find((item) => item.route === section);

  return (
    <div className="min-h-screen bg-canvas text-ink">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div>
            <p className="text-eyebrow uppercase tracking-wide text-ink-muted">AI Recruitment Intelligence</p>
            <h1 className="text-subhead">Explainable ATS</h1>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-meta text-ink-muted">{demo ? 'Read-only demo' : operator}</span>
            <button
              type="button"
              onClick={demo ? onExitDemo : onSignOut}
              className="h-control rounded-control border border-line-strong px-3 text-meta font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              {demo ? 'Sign in' : 'Sign out'}
            </button>
          </div>
        </div>

        <nav aria-label="Sections" className="mx-auto max-w-6xl px-6 pb-3">
          <ul className="flex flex-wrap gap-2">
            {NAV.map((item) => {
              const active = item.route === section;
              return (
                <li key={item.route}>
                  <a
                    href={routeToHash({ name: item.route, id: null })}
                    aria-current={active ? 'page' : undefined}
                    title={item.hint}
                    className={`inline-flex h-control items-center rounded-control px-3 text-small font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
                      active ? 'bg-brand text-white' : 'border border-line-strong text-ink-muted'
                    }`}
                  >
                    {item.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>

      {demo ? (
        <div className="mx-auto mt-4 max-w-6xl rounded-card border border-line bg-surface px-4 py-3">
          <p className="text-meta font-semibold uppercase tracking-wide text-ink-muted">
            Read-only demo · not signed in
          </p>
          <p className="mt-1 text-small text-ink">
            This is the real application, running on five invented candidates. Everything here can be
            read. Recording a decision needs an operator sign-in, and the server refuses it either
            way — nothing you do here can change anything.
          </p>
        </div>
      ) : null}

      {notice ? (
        <div className="mx-auto mt-4 flex max-w-6xl items-start justify-between gap-4 rounded-card border border-signal bg-signal-tint px-4 py-3">
          <p className="text-small text-ink">{notice}</p>
          <button
            type="button"
            onClick={onDismissNotice}
            className="text-meta font-semibold text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <main className="mx-auto max-w-6xl px-6 py-6">
        <h2 className="sr-only">{current?.label ?? 'Explainable ATS'}</h2>
        {children}
      </main>
    </div>
  );
}
