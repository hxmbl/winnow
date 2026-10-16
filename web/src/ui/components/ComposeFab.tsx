/**
 * The phone's compose button: a round pencil at the bottom right, just above the dock.
 *
 * Its own component, rendered from `App.tsx`, rather than part of the phone chrome: the
 * dock and top bar are a different concern, and a floating button does not belong to
 * either. It finds the dock by `data-phone-dock` and sits a fixed gap above its top
 * edge, whatever the dock's height (one row of chips or two, the safe area or none), so
 * it never covers a tab. With no dock on screen it keeps clear of the safe area alone.
 *
 * `App.tsx` decides *when* it is shown (the list, with nothing over it); this decides
 * only where.
 */

import { useLayoutEffect, useState } from "react";
import { SquarePen } from "lucide-react";
import { shortcutHint } from "../../core/mail/keybinds";

/** The gap between the button and the dock's top edge, in px. */
const GAP = 16;

export function ComposeFab({ onCompose }: { onCompose: () => void }) {
  /** Distance from the viewport's bottom edge to the dock's top edge, or `null` with no dock. */
  const [dockTop, setDockTop] = useState<number | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const dock = document.querySelector<HTMLElement>("[data-phone-dock]");
      if (!dock) {
        setDockTop(null);
        return;
      }
      setDockTop(Math.max(0, window.innerHeight - dock.getBoundingClientRect().top));
    };
    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    const dock = document.querySelector<HTMLElement>("[data-phone-dock]");
    if (dock) resize?.observe(dock);
    resize?.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      resize?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  const bottom =
    dockTop === null ? `calc(${GAP}px + env(safe-area-inset-bottom))` : `${dockTop + GAP}px`;

  return (
    <button
      type="button"
      data-compose-fab=""
      onClick={onCompose}
      aria-label="Compose"
      title={shortcutHint("Compose", "compose")}
      style={{ bottom, right: `calc(${GAP}px + env(safe-area-inset-right))` }}
      className="fixed z-30 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-on-accent shadow-lift transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
    >
      <SquarePen size={22} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
