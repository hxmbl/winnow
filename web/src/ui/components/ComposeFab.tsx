/**
 * The phone's compose button: a round pencil in the accent, beside the dock's pill.
 *
 * It used to float over the list at the bottom right, a fixed gap above the dock, where
 * it covered the end of whatever row was passing under it. Now it is part of the dock's
 * bottom row (`PhoneDock`), a circle as tall as the pill and aligned with it, after
 * Linear's Android app; the list's end padding keeps the last row clear of it.
 *
 * `App.tsx` decides *when* composing is offered (the list, with nothing over it); the
 * dock decides where.
 */

import { SquarePen } from "lucide-react";
import { shortcutHint } from "../../core/mail/keybinds";

export function ComposeButton({ onCompose }: { onCompose: () => void }) {
  return (
    <button
      type="button"
      data-compose-fab=""
      onClick={onCompose}
      aria-label="Compose"
      title={shortcutHint("Compose", "compose")}
      className="wn-raised pointer-events-auto flex h-[var(--wn-dock-h)] w-[var(--wn-dock-h)] shrink-0 items-center justify-center rounded-full border border-hairline bg-accent text-on-accent transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2"
    >
      <SquarePen size={22} strokeWidth={2} aria-hidden="true" />
    </button>
  );
}
