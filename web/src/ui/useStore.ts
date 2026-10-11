/**
 * Binding the store to React.
 *
 * One hook: `useSyncExternalStore` over `WinnowStore`'s own subscription. No context,
 * no provider, no store library.
 *
 * The subtlety is snapshot identity. The store's `getSnapshot` recomputes the whole
 * derived view on every call — deliberately, because recomputing is what guarantees the
 * list and the rail agree — and returns a *new* object each time. React compares
 * snapshots with `Object.is`, so handing it a fresh object every render would report a
 * change on every render and loop forever.
 *
 * So the snapshot is cached against the store's monotonic `key`, and the same object is
 * returned until the key actually moves. That is the whole trick, and it is why the
 * store exposes a key at all.
 *
 * There is deliberately no `useStoreSelector` alongside it: a selector returning a fresh
 * object or a freshly-computed array would report a change on every render and loop,
 * which is exactly the bug the caching above exists to prevent.
 */

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { Snapshot, WinnowStore } from "../core/store/store";

/**
 * The store, and its current snapshot.
 *
 * `subscribe` and `getSnapshot` are referentially stable for the life of the store, so
 * React never resubscribes.
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

  // The third argument is `getServerSnapshot`, for SSR. There is no server here, but
  // the argument is required, and passing the same function is honest rather than a
  // stub.
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}
