import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api/client.ts';

// One loader, so every screen has the same three states and the same error
// shape.
//
// The `cancelled` flag matters more than it looks: without it, navigating away
// mid-request sets state on an unmounted component, and the stale response of a
// slow request can overwrite the fresh one of a fast request. On a candidate
// screen that means reading one person's evidence under another person's name.

export type Loaded<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string };

export type LoadResult<T> = {
  state: Loaded<T>;
  /** Re-runs the fetch. Used after a write, to render what the server now holds. */
  reload: () => void;
  /** Replaces the data without a round trip, when the server already returned it. */
  set: (data: T) => void;
};

export function useLoad<T>(load: () => Promise<T>, deps: readonly unknown[]): LoadResult<T> {
  const [state, setState] = useState<Loaded<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- the caller states its own dependencies
  const run = useCallback(load, deps);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    run()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: err instanceof ApiError ? err.message : 'Something went wrong.',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [run, nonce]);

  return {
    state,
    reload: useCallback(() => setNonce((value) => value + 1), []),
    set: useCallback((data: T) => setState({ status: 'ready', data }), []),
  };
}
