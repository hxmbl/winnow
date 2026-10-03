/**
 * The keyboard cheat sheet.
 *
 * Rendered from `BINDINGS`, the same array the router reads. That is the whole point:
 * the previous version maintained this list by hand and it had already drifted from the
 * code, which is how a shortcut sheet becomes a small lie — and when the router became
 * table-driven, `,` and `⇧U` had been working in the app for weeks without appearing
 * here. A binding cannot exist without a row now, and a test asserts both directions:
 * every row resolves, and every command is documented by some row or is one of Escape's
 * targets.
 *
 * The modal behaviour — focus in, focus trapped, focus restored, Escape closes — comes
 * from `Overlay`, which is shared with the settings panel and the composer. Each of
 * those had its own incomplete version.
 *
 * `380px` wide, `pane` radius, monospaced key chips — it is an overlay, not a page, and
 * it should read as something summoned rather than navigated to.
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
        <h2 className="text-[15px] font-semibold text-ink">Keyboard shortcuts</h2>
        <span className="text-[11.5px] text-ink-subtle">Esc to close</span>
      </div>

      <dl className="mt-4 flex flex-col gap-1.5">
        {BINDINGS.map((binding) => (
          <div
            key={binding.keys}
            className="flex items-baseline justify-between gap-4"
          >
            <dt>
              <kbd className="rounded border border-hairline bg-surface-sunken px-1.5 py-0.5 font-mono text-[11.5px] font-semibold text-ink-body">
                {binding.keys}
              </kbd>
            </dt>
            <dd className="flex-1 text-right text-[12.5px] text-ink-muted">
              {binding.help}
            </dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}
