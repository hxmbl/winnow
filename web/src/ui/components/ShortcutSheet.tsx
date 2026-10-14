/**
 * The keyboard cheat sheet.
 *
 * Rendered from `BINDINGS`, the same array the router reads, so it cannot become the
 * small lie a hand-maintained list does; a test asserts every row resolves and every
 * command is documented. Modal behaviour comes from `Overlay`.
 */

import { BINDINGS } from "../../core/mail/keybinds";
import { Sheet } from "./Overlay";

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet
      label="Keyboard shortcuts"
      onClose={onClose}
      className="thin-scroll max-h-[85vh] w-full max-w-[380px] overflow-y-auto rounded-pane border border-hairline bg-chrome p-5 shadow-lift"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-read font-semibold text-ink">Keyboard shortcuts</h2>
        <span className="text-meta text-ink-subtle">Esc to close</span>
      </div>

      <dl className="mt-4 flex flex-col gap-1.5">
        {BINDINGS.map((binding) => (
          <div
            key={binding.keys}
            className="flex items-baseline justify-between gap-4"
          >
            <dt>
              <kbd className="rounded-ctl border border-hairline bg-surface-sunken px-1.5 py-0.5 font-mono text-meta font-semibold text-ink-body">
                {binding.keys}
              </kbd>
            </dt>
            <dd className="flex-1 text-right text-meta text-ink-muted">
              {binding.help}
            </dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}
