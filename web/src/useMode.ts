import { useCallback, useEffect, useState } from 'react';
import { api } from './api/client.ts';
import { MODE_UNKNOWN_MESSAGE, MODE_UNREACHABLE_MESSAGE, modeFromHealth, type ModeState } from './mode.ts';

// The deployment mode, as the page learns it.
//
// Asked once, at startup, from `GET /api/health` — see `mode.ts` for why it is
// the server's answer and never the bundle's. It is held in memory only: nothing
// is written to localStorage, sessionStorage or the URL, so a page that was
// loaded from one deployment can never carry a stale answer to another.

export type ModeHandle = {
  state: ModeState;
  /** Asks again. Offered when the first answer was missing or unrecognised. */
  retry(): void;
};

export function useMode(): ModeHandle {
  const [state, setState] = useState<ModeState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;

    api
      .health()
      .then((body) => {
        if (cancelled) return;
        const mode = modeFromHealth(body);
        setState(mode === null ? { status: 'error', message: MODE_UNKNOWN_MESSAGE } : { status: 'ready', mode });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error', message: MODE_UNREACHABLE_MESSAGE });
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = useCallback((): void => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
  }, []);

  return { state, retry };
}
