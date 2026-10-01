/**
 * The keyboard cheat sheet.
 *
 * Rendered from `BINDINGS`, the same array the router reads. That is the whole
 * point: the previous version maintained this list by hand and it had already
 * drifted from the code, which is how a shortcut sheet becomes a small lie.
 * Now a binding cannot exist without a row, and a test asserts it.
 *
 * `380px` wide, `pane` radius, monospaced key chips — it is an overlay, not a
 * page, and it should read as something summoned rather than navigated to.
 */

import { BINDINGS } from "../../core/mail/keybinds";

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(event) => event.stopPropagation()}
        className="animate-sheet w-full max-w-[380px] rounded-pane border border-hairline bg-chrome p-5 shadow-lift"
      >
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="shortcuts-title" className="text-[15px] font-semibold text-ink">
            Keyboard shortcuts
          </h2>
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
      </div>
    </div>
  );
}
