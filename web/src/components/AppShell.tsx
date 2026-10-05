import type { ReactNode } from 'react';
import { routeToHash, type Route, type RouteName } from '../router.ts';
import { DemoGuide } from './DemoGuide.tsx';
import { CONTROL_HELP, DEMO_DISCLOSURE, DEMO_TITLE } from '../demo/copy.ts';

// The frame every screen sits in.
//
// Navigation is business language, not the shape of the code: a recruiter reads
// "Jobs" and "Review", never "evaluations" or "requirement_match". Those names
// belong in the schema and stay there.
//
// ONE FRAME, TWO DEPLOYMENTS
//
// The real application draws it with a signed-in operator; the demo draws it with
// a visitor's session. They are told apart by which group of props arrives, not by
// a mode flag, so there is no third combination to render: no operator in the demo,
// no demo controls in the application.

type NavItem = { route: RouteName; label: string; hint: string };

const NAV: NavItem[] = [
  { route: 'jobs', label: 'Roles', hint: 'Open roles and the candidates assessed against them' },
  { route: 'overview', label: 'Status', hint: 'System status' },
];

const BUTTON =
  'h-control rounded-control border border-line-strong px-3 text-meta font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand';

export type AppShellProps = {
  route: Route;
  /** The signed-in operator. Present in the real application only. */
  operator?: string;
  onSignOut?: () => void;
  /**
   * A visitor's own demo session. Present in the demo only: it replaces the
   * sign-out button with the two things a visitor can do to their copy, and
   * removes the navigation — the demo is one path, so a menu would only be a
   * second way to get lost on it.
   */
  demoSession?: { onReset: () => void; onExit: () => void; busy: boolean };
  notice: string | null;
  onDismissNotice: () => void;
  children: ReactNode;
};

export function AppShell({
  route,
  operator,
  onSignOut,
  demoSession,
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
            {demoSession ? (
              <>
                <span className="text-meta text-ink-muted">Public demo</span>
                <button
                  type="button"
                  onClick={demoSession.onReset}
                  disabled={demoSession.busy}
                  title={CONTROL_HELP.reset}
                  className={`${BUTTON} disabled:opacity-50`}
                >
                  {demoSession.busy ? 'Resetting…' : 'Reset demo'}
                </button>
                <button type="button" onClick={demoSession.onExit} title={CONTROL_HELP.exit} className={BUTTON}>
                  Exit demo
                </button>
              </>
            ) : (
              <>
                <span className="text-meta text-ink-muted">{operator}</span>
                <button type="button" onClick={onSignOut} className={BUTTON}>
                  Sign out
                </button>
              </>
            )}
          </div>
        </div>

        {demoSession ? null : (
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
        )}
      </header>

      {demoSession ? (
        <div className="mx-auto mt-4 max-w-6xl rounded-card border border-line bg-surface px-4 py-3">
          <p className="text-meta font-semibold uppercase tracking-wide text-ink-muted">
            {DEMO_TITLE} · your own private copy
          </p>
          <p className="mt-1 text-small text-ink">
            {DEMO_DISCLOSURE} The candidates are invented, and this copy belongs to this browser alone — it is discarded
            after a while without use.
          </p>
          <DemoGuide />
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
