/**
 * Whether the window is phone-sized, and how much of it the on-screen keyboard covers.
 *
 * The phone layout is a different *arrangement* of the same components rather than a
 * restyle, so it is chosen in JS: the top bar, the dock and the reader's action bar
 * replace the masthead outright, and rendering both and hiding one with CSS would put two
 * search inputs with the same id in the document — and `/` can only focus one of them.
 */

import { useEffect, useState } from "react";

/**
 * Below Tailwind's `sm` (640px). The width at which the masthead already had to wrap onto
 * two lines to fit, which is the honest definition of "a phone" for this layout: a narrow
 * desktop window gets the same thumb-first arrangement, and a tablet keeps the panes.
 */
const PHONE_QUERY = "(max-width: 639px)";

function matches(): boolean {
  return globalThis.matchMedia?.(PHONE_QUERY).matches ?? false;
}

export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(matches);

  useEffect(() => {
    const query = globalThis.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const onChange = () => setPhone(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return phone;
}

/**
 * Publish the height the on-screen keyboard takes as `--wn-keyboard` on `<html>`.
 *
 * `interactive-widget=resizes-content` in `index.html` makes Chromium on Android shrink
 * the layout viewport (and so `dvh`) when the keyboard opens, and then this reads 0. iOS
 * Safari ignores that hint and only shrinks the *visual* viewport, which is what this
 * measures — so a full-height composer subtracts it and keeps Send above the keyboard on
 * both.
 */
export function useKeyboardInset(enabled: boolean): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = globalThis.visualViewport;
    if (!enabled || !viewport) {
      root.style.removeProperty("--wn-keyboard");
      return;
    }
    const update = () => {
      const covered = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      root.style.setProperty("--wn-keyboard", `${Math.round(covered)}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      root.style.removeProperty("--wn-keyboard");
    };
  }, [enabled]);
}
