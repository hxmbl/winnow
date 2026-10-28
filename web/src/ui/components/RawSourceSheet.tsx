/**
 * Dev Options → View Original: a message's raw source, as text.
 *
 * Headers and the MIME tree first, then every byte of the source (`core/mail/rawSource`).
 * A `<pre>` text node, never markup and never a frame: nothing in the source can run,
 * style itself or load. Copy copies the whole source, even past the display limit.
 */

import { useState } from "react";
import { Sheet, SheetHeader } from "./Overlay";
import { copyText } from "../clipboard";
import { rawSourceText } from "../../core/mail/rawSource";
import { buttonClass } from "../button";

export type RawSourceState =
  | { status: "loading"; subject: string }
  | { status: "ready"; subject: string; raw: string; demo: boolean }
  | { status: "error"; subject: string };

export function RawSourceSheet({ state, phone, onClose }: { state: RawSourceState; phone: boolean; onClose: () => void }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const view = state.status === "ready" ? rawSourceText(state.raw) : null;
  return (
    <Sheet
      label="View Original"
      onClose={onClose}
      dismissOnBackdrop
      placement={phone ? "fill" : "center"}
      className={phone ? "" : "max-w-sheet-wide"}
    >
      <div data-raw-source="" data-raw-status={state.status} className="flex max-h-(--wn-sheet-max-h) min-h-0 flex-col">
        <SheetHeader title="View Original" onClose={onClose} touch={phone}>
          {state.status === "ready" && (
            <button
              type="button"
              data-raw-copy=""
              onClick={() => {
                void copyText(state.raw).then((ok) => setCopied(ok ? "copied" : "failed"));
              }}
              className={buttonClass("secondary", "sm", "ml-auto")}
            >
              {copied === "copied" ? "Copied" : copied === "failed" ? "Couldn't copy" : "Copy"}
            </button>
          )}
        </SheetHeader>
        <p className="px-5 pt-3 text-meta text-ink-subtle">
          {state.subject || "(no subject)"}
          {state.status === "ready" && state.demo && " · Demo: built on this device, as the demo has no server."}
        </p>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5 pt-2">
          {state.status === "loading" && (
            <p role="status" aria-live="polite" className="text-meta text-ink-subtle">
              Asking Gmail for the original…
            </p>
          )}
          {state.status === "error" && (
            <p role="alert" className="text-meta text-danger">
              Couldn&rsquo;t get the original from Gmail. Check the connection and try again.
            </p>
          )}
          {view && (
            <pre
              data-raw-text=""
              tabIndex={0}
              aria-label="Raw message source"
              className="selectable whitespace-pre-wrap break-all font-mono text-meta text-ink-body"
            >
              {view.text}
            </pre>
          )}
        </div>
      </div>
    </Sheet>
  );
}
