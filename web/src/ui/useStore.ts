/**
 * Binding the store to React.
 *
 * One hook, and it is `useSyncExternalStore` over `WinnowStore`'s own
 * subscription. No context, no provider, no store library.
 *
 * The subtlety is snapshot identity. The store's `getSnapshot` recomputes the
 * whole derived view on every call — deliberately, because recomputing is what
 * guarantees the list and the rail agree — and returns a *new* object each time.
 * React compares snapshots with `Object.is`, so handing it a fresh object on
 * every render would report a change on every render and loop forever.
 *
 * So the snapshot is cached against the store's monotonic `key`, and the same
 * object is returned until the key actually moves. That is the whole trick, and
 * it is why the store exposes a key at all.
 *
 * The alternative — memoising inside the store and invalidating by hand — is
 * where the previous version's bugs came from: the list, the rail and the reader
 * each memoised independently, and briefly disagreed about which filters were
 * active.
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Snapshot, WinnowStore } from "../core/store/store";

/**
 * The store, and its current snapshot.
 *
 * `getSnapshot` is stable for the life of the store, so `subscribe` and
 * `getSnapshot` are both referentially stable and React never resubscribes.
 */
export function useStore(store: WinnowStore): Snapshot {
  // The last snapshot handed to React, plus the key it was built at.
  const cache = useRef<{ key: string; snapshot: Snapshot } | null>(null);

  const getSnapshot = useCallback((): Snapshot => {
    const next = store.getSnapshot();
    const previous = cache.current;
    if (previous && previous.key === next.key) return previous.snapshot;
    cache.current = { key: next.key, snapshot: next };
    return next;
  }, [store]);

  // The third argument is `getServerSnapshot`, for SSR. There is no server here
  // — Winnow is a client app that talks to Gmail directly — but the argument is
  // required, and passing the same function is honest rather than a stub.
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/**
 * Subscribe to one slice of the snapshot.
 *
 * Only worth using when a subtree is expensive enough that re-rendering it for
 * a slice that did not change costs more than recomputing the slice. The
 * comparison is by identity, so it is correct for the object references the
 * store hands out and *wrong* for primitives — a selector returning a number
 * would compare by value and work, but one returning a fresh object each call
 * would re-render on every store change, which is the bug this hook is meant to
 * avoid.
 */
export function useStoreSelector<T>(
  store: WinnowStore,
  select: (snapshot: Snapshot) => T,
): T {
  const getSnapshot = useCallback((): T => select(store.getSnapshot()), [store, select]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
