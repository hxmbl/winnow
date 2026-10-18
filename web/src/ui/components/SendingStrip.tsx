/**
 * "Sending… Undo": the strip a message waits under during its undo window.
 *
 * Built like the undo strip below the notices — same row, same Undo button — because it
 * is the same promise: what you just did can still be taken back. It counts down so the
 * window is never a guess, and offers "Send now" for the user who is sure. It is a
 * status region, so a screen reader hears that the message is waiting.
 */

import { useEffect, useState } from "react";

export function SendingStrip({
  deadline,
  onUndo,
  onSendNow,
}: {
  /** When the message goes, in ms since the epoch. */
  deadline: number;
  onUndo: () => void;
  onSendNow: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.ceil((deadline - now) / 1000));

  return (
    <div
      role="status"
      data-send-pending=""
      className="flex animate-appear items-center justify-center gap-3 px-4 py-1.5 text-meta"
    >
      <span className="min-w-0 truncate text-ink-muted">
        Sending<span className="tabular-nums">{left > 0 ? ` in ${left}s` : ""}</span>…
      </span>
      <button
        type="button"
        data-send-undo=""
        onClick={onUndo}
        className="shrink-0 rounded-ctl bg-sheen px-2.5 py-0.5 font-medium text-ink-body transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        Undo
      </button>
      <button
        type="button"
        data-send-now=""
        onClick={onSendNow}
        className="shrink-0 rounded-ctl px-2 py-0.5 font-medium text-ink-subtle transition-colors hover:bg-sheen hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        Send now
      </button>
    </div>
  );
}
