/**
 * Whether Blur sensitive info is on, as a React value (see `censorDom.ts`): "" when off,
 * otherwise a key that changes with what it hides.
 */
import { useSyncExternalStore } from "react";
import { censorActive, subscribeCensor } from "./censorDom";

export function useCensorActive(): string {
  return useSyncExternalStore(subscribeCensor, censorActive, censorActive);
}
