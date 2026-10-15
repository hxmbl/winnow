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

/** Every event a row listens to for drag-select, long-press and its context menu. */
const stop = (event: React.SyntheticEvent) => event.stopPropagation();

export function CodeChip({
  code,
  copied,
  onCopy,
}: {
  code: string;
  copied: boolean;
  onCopy: () => void;
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
      className="-mt-[0.5px] flex h-6 shrink-0 items-center gap-1 rounded-ctl border border-control-border bg-surface px-2 text-meta font-medium tabular-nums text-ink-body transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring [@media(hover:none)]:-mt-[4.5px] [@media(hover:none)]:h-8"
    >
      {copied ? (
        <Check size={12} strokeWidth={2.4} aria-hidden="true" className="text-success" />
      ) : (
        <Copy size={12} strokeWidth={2} aria-hidden="true" />
      )}
      <span aria-hidden="true">{copied ? "Copied" : `Copy ${formatCode(code)}`}</span>
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
  return (
    <div
      data-code-bar={code}
      className={`flex items-center justify-between gap-3 border-b border-hairline-soft bg-surface px-5 pb-3 ${
        phone ? "pt-[max(0.75rem,env(safe-area-inset-top))]" : "pt-3"
      }`}
    >
      <div className="min-w-0">
        <p className="text-meta text-ink-subtle">Verification code</p>
        <p className="selectable text-title font-semibold tabular-nums text-ink">{formatCode(code)}</p>
      </div>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? `Copied code ${code}` : `Copy code ${code}`}
        title="Copy the code (c)"
        className={`flex shrink-0 items-center gap-1.5 rounded-ctl px-3 py-1.5 text-ui font-semibold transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:min-h-11 ${
          copied ? "bg-surface-active text-ink" : "bg-accent text-on-accent hover:opacity-90"
        }`}
      >
        {copied ? <Check size={14} strokeWidth={2.4} aria-hidden="true" /> : <Copy size={14} strokeWidth={2} aria-hidden="true" />}
        <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
