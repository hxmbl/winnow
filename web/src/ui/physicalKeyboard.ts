/**
 * Whether this device has a real keyboard, for the one place that asks: Settings →
 * Keyboard shortcuts, which a touch screen with only the on-screen keyboard has no use for.
 *
 * - A device with a fine pointer that can hover (a desktop or a laptop) is assumed to
 *   have one, as before: nothing changes there.
 * - A touch-only device (`(hover: none) and (pointer: coarse)`, a phone or a tablet) has
 *   one only once a key press proves it, and the proof is kept for the session
 *   (`sessionStorage`), so the category does not flicker away again.
 *
 * What counts as proof (`isHardwareKey`): the on-screen keyboard (Gboard, iOS) only types
 * into a focused text field and reports most keys as `Unidentified`/`Process`, keyCode
 * 229, or while composing. So a key counts when it is a real, named key and either
 * nothing editable has focus (nothing a soft keyboard could be typing into), or it is a
 * key soft keyboards do not send: Tab, Escape, the arrows, function keys, a bare
 * modifier, or a Ctrl/⌘/Alt chord.
 */

import { useEffect, useState } from "react";

export const PHYSICAL_KEYBOARD_KEY = "winnow.session.physicalKeyboard";

/** What `isHardwareKey` needs from a `KeyboardEvent`, so the tests need no DOM. */
export type KeySample = {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  /** The event's target is a text field, a textarea or contenteditable. */
  editable: boolean;
};

/** Keys an on-screen keyboard does not send, even into a focused field. */
const HARDWARE_ONLY = new Set([
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
]);

export function isHardwareKey(sample: KeySample): boolean {
  const { key } = sample;
  if (!key || key === "Unidentified" || key === "Process" || key === "Dead") return false;
  if (sample.isComposing || sample.keyCode === 229) return false;
  if (!sample.editable) return true;
  if (HARDWARE_ONLY.has(key) || /^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return true;
  return Boolean(sample.ctrlKey || sample.metaKey || sample.altKey);
}

/** Whether Keyboard shortcuts belongs in Settings. */
export function shortcutsAvailable({ touchOnly, keyboardSeen }: { touchOnly: boolean; keyboardSeen: boolean }): boolean {
  return !touchOnly || keyboardSeen;
}

const TOUCH_ONLY_QUERY = "(hover: none) and (pointer: coarse)";

function touchOnlyNow(): boolean {
  return globalThis.matchMedia?.(TOUCH_ONLY_QUERY).matches ?? false;
}

function seenThisSession(): boolean {
  try {
    return globalThis.sessionStorage?.getItem(PHYSICAL_KEYBOARD_KEY) === "1";
  } catch {
    return false;
  }
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(target.type);
  }
  return false;
}

let seen = false;
const listeners = new Set<() => void>();
let installed = false;

/** Listen once per page for the first hardware key press. Idempotent. */
export function watchPhysicalKeyboard(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  seen = seenThisSession();
  if (seen) return;
  const onKey = (event: KeyboardEvent) => {
    if (
      !isHardwareKey({
        key: event.key,
        keyCode: event.keyCode,
        isComposing: event.isComposing,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        editable: isEditable(event.target),
      })
    ) {
      return;
    }
    seen = true;
    try {
      globalThis.sessionStorage?.setItem(PHYSICAL_KEYBOARD_KEY, "1");
    } catch {
      // Private mode: kept in memory for this page instead.
    }
    window.removeEventListener("keydown", onKey, true);
    for (const listener of listeners) listener();
  };
  window.addEventListener("keydown", onKey, true);
}

/** Whether Keyboard shortcuts should show, live: true at once on a desktop. */
export function useShortcutsAvailable(): boolean {
  const [state, setState] = useState(() => ({ touchOnly: touchOnlyNow(), keyboardSeen: seen || seenThisSession() }));
  useEffect(() => {
    watchPhysicalKeyboard();
    const update = () => setState({ touchOnly: touchOnlyNow(), keyboardSeen: seen || seenThisSession() });
    update();
    listeners.add(update);
    const query = globalThis.matchMedia?.(TOUCH_ONLY_QUERY);
    query?.addEventListener("change", update);
    return () => {
      listeners.delete(update);
      query?.removeEventListener("change", update);
    };
  }, []);
  return shortcutsAvailable(state);
}
