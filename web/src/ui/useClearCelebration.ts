/**
 * When the inbox-clear motion plays: once, right after the last row of a view goes.
 *
 * Remembers the previous render's view and row count; `justCleared` decides. The flag
 * stays up for `CELEBRATION_MS` and then drops, so a re-render later in the same empty
 * view (a sync tick, a theme change) does not replay it, and neither does coming back
 * to an empty Inbox. It fires the haptic itself, on a phone only, once per moment.
 */

import { useEffect, useRef, useState } from "react";
import { CELEBRATION_MS, CLEAR_HAPTIC, justCleared } from "./inboxClear";

export function useClearCelebration(key: string, count: number, haptic: boolean): boolean {
  const previous = useRef<{ key: string; count: number } | null>(null);
  const [celebrating, setCelebrating] = useState(false);

  useEffect(() => {
    const current = { key, count };
    const before = previous.current;
    const cleared = justCleared(before, current);
    previous.current = current;
    if (cleared) {
      setCelebrating(true);
      if (haptic) globalThis.navigator?.vibrate?.([...CLEAR_HAPTIC]);
    } else if (count > 0 || before?.key !== key) {
      setCelebrating(false);
    }
  }, [key, count, haptic]);

  useEffect(() => {
    if (!celebrating) return;
    const timer = setTimeout(() => setCelebrating(false), CELEBRATION_MS);
    return () => clearTimeout(timer);
  }, [celebrating]);

  return celebrating;
}
