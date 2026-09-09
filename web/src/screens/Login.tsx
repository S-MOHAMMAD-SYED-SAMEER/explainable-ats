import { useState, type ReactNode } from 'react';
import { api, ApiError } from '../api/client.ts';

// The sign-in screen (M6-A).
//
// THERE IS NO USERNAME FIELD, AND THAT IS THE DESIGN.
//
// This build authenticates one operator against one password (M5-A decision 2).
// A username box would be a field the browser fills in and the server ignores —
// worse, it would look like the thing that establishes identity, when identity
// comes from the session the server issues. The operator name shown once signed
// in is read back from the server, never typed here.
//
// WHAT THIS COMPONENT DOES NOT DO
//
//   * store the password anywhere but the controlled input it is typed into,
//     which is cleared the moment submission succeeds or fails;
//   * write to localStorage, sessionStorage, or any other persistence;
//   * put anything in the URL;
//   * keep a "logged in" flag of its own — it reports success upward and the
//     app re-asks the server.
//
// A failed sign-in says one thing regardless of why, because the server answers
// the same way regardless of why (M5-A): distinguishing "wrong password" from
// "server has no password configured" would tell someone guessing which half of
// the problem to work on.

// THE DEMO BUTTON IS NOT A SECOND WAY IN
//
// It does not sign anybody in. There is no demo password, no demo account and
// no demo token — nothing this component could leak even if it wanted to. The
// button only tells the app to render the dashboard for a visitor who has no
// session, which works because the server independently serves a short
// allow-list of GET routes over invented data. Every write is still refused,
// by the server, whatever this browser thinks.
//
// It is offered only when the server said the window is open. A build talking
// to a fully-gated server shows the password box alone, exactly as before.

export function Login({
  onSignedIn,
  demoAvailable = false,
  onBrowseDemo,
}: {
  onSignedIn(): void;
  demoAvailable?: boolean;
  onBrowseDemo?(): void;
}): ReactNode {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (submitting || password === '') return;

    setSubmitting(true);
    setError(null);

    try {
      await api.login(password);
      // Cleared before anything else happens, so the value does not sit in a
      // component that might survive the transition.
      setPassword('');
      onSignedIn();
    } catch (err) {
      setPassword('');
      setError(
        err instanceof ApiError && err.status === 401
          ? 'That did not match. Check the password and try again.'
          : 'Could not sign in. Check your connection and try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <p className="text-eyebrow uppercase tracking-wide text-ink-muted">AI Recruitment Intelligence</p>
          <h1 className="mt-1 text-section text-ink">Explainable ATS</h1>
          <p className="mt-2 text-small text-ink-muted">
            Every candidate is ranked from evidence quoted out of their CV, and every placement can be explained
            to the person it is about.
          </p>
        </div>

        <form
          className="rounded-card border border-line bg-surface p-5 shadow-resting"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor="operator-password" className="text-meta font-semibold uppercase tracking-wide text-ink-muted">
            Operator password
          </label>
          <input
            id="operator-password"
            type="password"
            value={password}
            autoComplete="current-password"
            autoFocus
            required
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'signin-error' : undefined}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1 w-full rounded-control border border-line bg-surface p-2 text-small text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          />

          <div aria-live="polite">
            {error ? (
              <p id="signin-error" className="mt-3 rounded-control bg-danger-tint px-3 py-2 text-small text-danger">
                {error}
              </p>
            ) : null}
          </div>

          <button
            type="submit"
            disabled={submitting || password === ''}
            className="mt-4 h-control w-full rounded-control bg-brand px-4 text-small font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:opacity-50"
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {demoAvailable && onBrowseDemo ? (
          <div className="mt-5 rounded-card border border-line bg-surface p-5">
            <p className="text-meta font-semibold uppercase tracking-wide text-ink-muted">
              No account?
            </p>
            <p className="mt-1 text-small text-ink">
              Look around the real application without signing in. You will see the ranking, the
              evidence behind every placement and the audit trail, over five invented candidates.
            </p>
            <button
              type="button"
              onClick={onBrowseDemo}
              className="mt-4 h-control w-full rounded-control border border-line-strong px-4 text-small font-semibold text-ink hover:border-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
            >
              Browse the read-only demo
            </button>
            <p className="mt-3 text-meta text-ink-muted">
              Read-only: recording a decision needs an operator sign-in.
            </p>
          </div>
        ) : null}

        <p className="mt-4 text-meta text-ink-muted">
          The password is checked on the server and never stored in this browser.
        </p>
      </div>
    </main>
  );
}
