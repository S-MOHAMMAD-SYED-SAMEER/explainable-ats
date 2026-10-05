import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, setDemoSessionLostHandler } from '../api/client.ts';
import { demoSessionFromResponse, type DemoSessionView, type DemoState } from './session.ts';

// The visitor's demo session, as the app sees it.
//
// One hook owns the answer to "is there a demo session?", and — like
// `useSession` — it takes that answer from the server every time: at startup, and
// after start, reset and end. There is no local "inDemo" flag that can disagree
// with the cookie, and nothing is written to localStorage, sessionStorage or the
// URL: the session is the server's, named by an HttpOnly cookie this code cannot
// see, which is exactly why a reload keeps it.
//
// A DEMO SESSION IS NOT A SIGN-IN
//
// Nothing here touches `useSession`, `SessionState` or an operator. The demo
// deployment has no sign-in, and the real application has no demo session: each is
// drawn by its own half of the client (`DemoApp`, `RecruiterApp`).

export type { DemoState };

export type DemoSessionHandle = {
  state: DemoState;
  /**
   * Whether the visitor started the demo during THIS page load, as opposed to a
   * live session simply being found. It only changes what the front page says: a
   * session that ended after the visitor was inside is reported as having ended.
   */
  entered: boolean;
  /** Bumped by a reset, so the app can remount its screens and re-read the fresh copy. */
  generation: number;
  /** A reset is in flight. */
  busy: boolean;
  /** Starts a session, or resumes the one the browser already has. Resolves to its view, or null on failure. */
  start(): Promise<DemoSessionView | null>;
  /** Restores this visitor's copy. Resolves to the new view, or null on failure. */
  reset(): Promise<DemoSessionView | null>;
  /** Ends this visitor's session. */
  end(): Promise<void>;
};

function messageOf(err: unknown, fallback: string): string {
  // The server's own safe message, or one fixed sentence — never a raw network
  // error or anything provider- or database-shaped.
  return err instanceof ApiError ? err.message : fallback;
}

export function useDemoSession(): DemoSessionHandle {
  const [state, setState] = useState<DemoState>({ status: 'checking' });
  const [entered, setEntered] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);

  // Ask once at startup. This is what makes the session survive a reload: the
  // cookie is still there, so the server still answers "active".
  useEffect(() => {
    let cancelled = false;

    api
      .demoSession()
      .then((body) => {
        if (cancelled) return;
        const status = demoSessionFromResponse(body);
        setState(status.active ? { status: 'active', session: status.session } : { status: 'inactive' });
      })
      .catch(() => {
        // An unreachable server or a malformed answer means no session. Failing
        // toward the sign-in screen is the only safe direction.
        if (!cancelled) setState({ status: 'inactive' });
      });

    return () => {
      cancelled = true;
    };
  }, []);

  // The session expired or was evicted while the visitor was reading. Not an
  // error and not a sign-out: back to "no session", which the app answers by
  // starting another.
  useEffect(() => {
    setDemoSessionLostHandler(() => setState({ status: 'inactive' }));
    return () => setDemoSessionLostHandler(null);
  }, []);

  const start = useCallback(async (): Promise<DemoSessionView | null> => {
    setState({ status: 'starting' });
    try {
      const status = demoSessionFromResponse(await api.startDemoSession());
      if (!status.active) throw new Error('The server did not return a session.');
      setEntered(true);
      setState({ status: 'active', session: status.session });
      return status.session;
    } catch (err) {
      setState({ status: 'error', message: messageOf(err, 'Could not start the demo. Try again.') });
      return null;
    }
  }, []);

  const reset = useCallback(async (): Promise<DemoSessionView | null> => {
    setBusy(true);
    try {
      const status = demoSessionFromResponse(await api.resetDemoSession());
      if (!status.active) throw new Error('The server did not return a session.');
      setState({ status: 'active', session: status.session });
      setGeneration((value) => value + 1);
      return status.session;
    } catch (err) {
      // A 401 already moved the state to `inactive` through the lost handler,
      // and the app will start a fresh session on its own. Anything else is
      // reported on the entry screen, where the visitor can try again.
      if (!(err instanceof ApiError && err.status === 401)) {
        setState({ status: 'error', message: messageOf(err, 'Could not reset the demo. Try again.') });
      }
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const end = useCallback(async (): Promise<void> => {
    try {
      await api.endDemoSession();
    } catch {
      // The cookie is HttpOnly and cannot be cleared from here. A failed end
      // still leaves the demo: the honest move is to stop showing it.
    }
    setEntered(false);
    setState({ status: 'inactive' });
  }, []);

  return { state, entered, generation, busy, start, reset, end };
}
