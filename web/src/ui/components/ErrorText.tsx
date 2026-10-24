/**
 * Failure copy the user can select, copy — and, when long, expand.
 *
 * The chrome disables text selection, but an error is the one text a user most needs to
 * copy (to search it, or paste it into a bug report), so this opts back in and adds a
 * Copy button beside it. The button copies the *whole* string, which matters when the
 * text is clamped: a drag across a clamped line cannot reach what is hidden.
 *
 * A long text is clamped, and a separate disclosure button unclamps the *same* string.
 * It used to sit in a `<summary>`, which made every click on the text — including the
 * click that starts a selection, or a double-click to select a word — toggle the
 * disclosure. The text is now plain selectable copy and only the chevron toggles.
 * A short text gets no disclosure, since a "Details" toggle around one sentence is
 * ceremony.
 */

import { useEffect, useState, type ReactElement } from "react";
import { Check, ChevronDown, Copy } from "lucide-react";
import { copyText } from "../clipboard";
import { isLongError } from "../textSelection";

type Props = {
  text: string;
  /** Extra classes to match the caller's surface (colour, size…). */
  className?: string;
  /** Offer a Copy button. On by default: an error is what people paste elsewhere. */
  copyable?: boolean;
};

export function ErrorText({ text, className = "", copyable = true }: Props): ReactElement {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = isLongError(text);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  // A new error is a new text: it starts clamped, and "Copied" belonged to the old one.
  useEffect(() => {
    setOpen(false);
    setCopied(false);
  }, [text]);

  return (
    <span data-error-text="" className={`inline-flex min-w-0 max-w-full items-start gap-1 ${className}`}>
      {long && (
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Show less" : "Show the whole message"}
          title={open ? "Show less" : "Show the whole message"}
          onClick={() => setOpen((value) => !value)}
          className="mt-px shrink-0 rounded-ctl text-ink-subtle hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          <ChevronDown
            size={12}
            strokeWidth={2}
            className={`transition-transform ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      )}
      <span
        data-error-copy=""
        className={`selectable min-w-0 wrap-break-word ${long && !open ? "line-clamp-2" : ""}`}
      >
        {text}
      </span>
      {copyable && (
        <button
          type="button"
          data-error-copy-button=""
          aria-label={copied ? "Copied the error" : "Copy the error"}
          title={copied ? "Copied" : "Copy"}
          onClick={() => {
            void copyText(text).then((ok) => setCopied(ok));
          }}
          className="mt-px shrink-0 rounded-ctl p-0.5 text-ink-subtle transition-colors hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {copied ? (
            <Check size={12} strokeWidth={2.2} aria-hidden="true" />
          ) : (
            <Copy size={12} strokeWidth={2} aria-hidden="true" />
          )}
        </button>
      )}
    </span>
  );
}
