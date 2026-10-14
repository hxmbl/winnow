import { useSyncExternalStore } from "react";

/** `navigator.onLine`, kept current by the `online`/`offline` events. */
function subscribe(onChange: () => void): () => void {
  globalThis.addEventListener?.("online", onChange);
  globalThis.addEventListener?.("offline", onChange);
  return () => {
    globalThis.removeEventListener?.("online", onChange);
    globalThis.removeEventListener?.("offline", onChange);
  };
}

const read = (): boolean => globalThis.navigator?.onLine ?? true;

/** True unless the browser says the network is gone. */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, read, () => true);
}
