/**
 * One-time codes, one click from the clipboard.
 *
 * `CodeChip` is the list row's "Copy 418 902", shown only while the message is under
 * five minutes old (`codeChipVisible`); `CodeBar` is the reader's strip at the very top,
 * shown for a message with a code at any age. Both copy without opening anything and
 * swap to "Copied" for a moment; `App` owns which message was just copied, so the `c`
 * shortcut lights up the same confirmation.
 */

import { Check, Copy } from "lucide-react";
import { formatCode } from "../../core/mail/otp";
import { Icon } from "./Icon";

/** Every event a row listens to for drag-select, long-press and its context menu. */
const stop = (event: React.SyntheticEvent) => event.stopPropagation();

/** The chip's label, so the row can reserve exactly its width on the preview line. */
const codeChipLabel = (code: string): string => `Copy ${formatCode(code)}`;

/**
 * The room the chip takes on the row's preview line: an invisible copy of the chip's
 * contents, so the preview truncates before it and the chip (drawn over it, outside the
 * row's button) never pushes the time column. Inside the row button, so not a control.
 */
export function CodeChipRoom({ code }: { code: string }) {
  return (
    <span
      aria-hidden="true"
      data-code-room=""
      className="invisible ml-2 flex shrink-0 items-center gap-1 border border-transparent px-2 text-meta font-medium tabular-nums"
    >
      <span className="size-3" />
      {codeChipLabel(code)}
    </span>
  );
}

/**
 * The row's Copy chip. It sits on the preview line, right-aligned to the row button's
 * edge, so the time above keeps its fixed column like every other row (`MessageList`).
 * `right-11` is the star's 24px plus the row's 8px gap and 12px padding; a draft has no
 * star, so its chip sits at the padding.
 */
export function CodeChip({
  code,
  copied,
  onCopy,
  draft = false,
}: {
  code: string;
  copied: boolean;
  onCopy: () => void;
  draft?: boolean;
}) {
  return (
    <button
      type="button"
      data-row-control="code"
      data-code-chip={code}
      aria-label={copied ? `Copied code ${code}` : `Copy code ${code}`}
      title="Copy the code"
      onPointerDown={stop}
      onMouseDown={stop}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onCopy();
      }}
      className={`absolute bottom-1 ${draft ? "right-3" : "right-11"} flex h-6 items-center gap-1 rounded-ctl border border-control-border bg-surface px-2 text-meta font-medium tabular-nums text-ink-body transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring [@media(hover:none)]:bottom-0 [@media(hover:none)]:h-8`}
    >
      {copied ? (
        <Icon icon={Check} size={12} className="text-success" />
      ) : (
        <Icon icon={Copy} size={12} />
      )}
      <span aria-hidden="true">{copied ? "Copied" : codeChipLabel(code)}</span>
    </button>
  );
}

export function CodeBar({
  code,
  copied,
  onCopy,
  phone = false,
}: {
  code: string;
  copied: boolean;
  onCopy: () => void;
  phone?: boolean;
}) {
  // Copy on the left, where the cursor already is coming from the list (and the thumb's
  // side of the bar on a phone), and the code on the right, read after pressing it.
  return (
    <div
      data-code-bar={code}
      className={`flex items-center gap-3 border-b border-hairline-soft bg-surface px-5 pb-3 ${
        phone ? "pt-[max(0.75rem,env(safe-area-inset-top))]" : "pt-3"
      }`}
    >
      <button
        type="button"
        data-code-copy=""
        onClick={onCopy}
        aria-label={copied ? `Copied code ${code}` : `Copy code ${code}`}
        title="Copy the code (c)"
        className={`flex min-w-22 shrink-0 items-center justify-center gap-1.5 rounded-ctl px-3 py-1.5 text-ui font-semibold transition-[background-color,opacity] duration-150 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:min-h-11 ${
          copied ? "bg-surface-active text-ink" : "bg-accent text-on-accent hover:opacity-90"
        }`}
      >
        {copied ? <Icon icon={Check} size={16} /> : <Icon icon={Copy} size={16} />}
        <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
      </button>
      <div data-code-value="" className="ml-auto min-w-0 text-right">
        <p className="text-meta text-ink-subtle">Verification code</p>
        <p className="selectable text-title font-semibold tabular-nums text-ink">{formatCode(code)}</p>
      </div>
    </div>
  );
}
