/**
 * Dev Options → Debug log's viewer: the in-memory lines (`core/debug/debugLog.ts`),
 * newest last, with Copy and Clear. Text only, already redacted.
 */

import { useState, useSyncExternalStore } from "react";
import { clearDebugLog, debugLogLines, debugLogText, subscribeDebugLog, DEBUG_LOG_CAP } from "../../core/debug/debugLog";
import { copyText } from "../clipboard";

const BUTTON =
  "rounded-ctl border border-control-border px-3 py-1.5 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50";

export function DebugLogPanel({ recording }: { recording: boolean }) {
  const lines = useSyncExternalStore(subscribeDebugLog, debugLogLines, debugLogLines);
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div data-debug-log="" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-meta text-ink-subtle" aria-live="polite">
          {lines.length} of {DEBUG_LOG_CAP.toLocaleString("en-GB")} lines{recording ? ", recording" : ", not recording"}
        </p>
        <button
          type="button"
          data-debug-log-copy=""
          disabled={lines.length === 0}
          onClick={() => void copyText(debugLogText()).then((ok) => setCopied(ok ? "copied" : "failed"))}
          className={BUTTON}
        >
          {copied === "copied" ? "Copied" : copied === "failed" ? "Couldn't copy" : "Copy"}
        </button>
        <button
          type="button"
          data-debug-log-clear=""
          disabled={lines.length === 0}
          onClick={() => {
            clearDebugLog();
            setCopied("idle");
          }}
          className={BUTTON}
        >
          Clear
        </button>
      </div>
      <pre
        data-debug-log-text=""
        tabIndex={0}
        aria-label="Debug log"
        className="selectable max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-pane border border-hairline bg-surface-sunken p-2 font-mono text-meta text-ink-body"
      >
        {lines.length > 0 ? lines.join("\n") : "Nothing recorded yet."}
      </pre>
    </div>
  );
}
