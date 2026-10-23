/** Whether Censor email addresses is on, as a React value (see `censorDom.ts`). */
import { useSyncExternalStore } from "react";
import { censorActive, subscribeCensor } from "./censorDom";

export function useCensorActive(): boolean {
  return useSyncExternalStore(subscribeCensor, censorActive, censorActive);
}
