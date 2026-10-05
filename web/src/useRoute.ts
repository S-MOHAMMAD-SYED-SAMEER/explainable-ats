import { useEffect, useState } from 'react';
import { parseRoute, type Route, type RouteName } from './router.ts';

/**
 * Subscribes to the location hash.
 *
 * A hook rather than a context: exactly one component per deployment needs the
 * current route, and threading it from a single owner is clearer than a provider
 * nobody else consumes.
 *
 * `allowed` and `fallback` are the running mode's routes and front page (see
 * `router.ts`). They are module constants at every call site, which is what keeps
 * them safe to use as effect dependencies.
 */
export function useRoute(allowed: readonly RouteName[], fallback: Route): Route {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === 'undefined' ? fallback : parseRoute(window.location.hash, { allowed, fallback }),
  );

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseRoute(window.location.hash, { allowed, fallback }));
    window.addEventListener('hashchange', onHashChange);
    // Re-read on mount too: the first render happens before this effect, and
    // the hash can already have changed by then — a deep link, or a reload.
    onHashChange();
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [allowed, fallback]);

  return route;
}
