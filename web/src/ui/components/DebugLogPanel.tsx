/**
 * Dev Options → Debug log's viewer: the in-memory lines (`core/debug/debugLog.ts`),
 * newest last, with Copy and Clear. Text only, already redacted.
 *
 * Only the newest `DEBUG_LOG_SHOWN` lines are drawn: the log holds up to ten thousand,
 * and laying out a megabyte of text in a `<pre>` on every new line is what froze the
 * screen on a phone. Copy still takes every line, after pulling in what the native
 * shell recorded since the last look.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import {
  clearDebugLog,
  debugLogLines,
  debugLogText,
  subscribeDebugLog,
  syncNativeDebugLog,
  visibleDebugText,
  DEBUG_LOG_CAP,
  DEBUG_LOG_SHOWN,
} from "../../core/debug/debugLog";
import { copyText } from "../clipboard";

const BUTTON =
  "rounded-ctl border border-control-border px-3 py-1.5 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50";

export function DebugLogPanel({ recording }: { recording: boolean }) {
  const lines = useSyncExternalStore(subscribeDebugLog, debugLogLines, debugLogLines);
  const [copied, setCopied] = useState<"idle" | "copying" | "copied" | "failed">("idle");

  // Opening the viewer pulls in the native lines waiting in the shell.
  useEffect(() => {
    void syncNativeDebugLog();
  }, []);

  const copy = async () => {
    setCopied("copying");
    await syncNativeDebugLog();
    // Let the "Copying…" label paint before the (up to a megabyte) string is built.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ok = await copyText(debugLogText());
    setCopied(ok ? "copied" : "failed");
  };

  const shown = Math.min(lines.length, DEBUG_LOG_SHOWN);
  return (
    <div data-debug-log="" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto text-meta text-ink-subtle" aria-live="polite">
          {lines.length.toLocaleString("en-GB")} of {DEBUG_LOG_CAP.toLocaleString("en-GB")} lines
          {recording ? ", recording" : ", not recording"}
          {lines.length > shown ? `. Showing the newest ${shown}; Copy takes them all.` : ""}
        </p>
        <button
          type="button"
          data-debug-log-copy=""
          disabled={lines.length === 0 || copied === "copying"}
          onClick={() => void copy()}
          className={BUTTON}
        >
          {copied === "copying" ? "Copying…" : copied === "copied" ? "Copied" : copied === "failed" ? "Couldn't copy" : "Copy"}
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
        {visibleDebugText(lines)}
      </pre>
    </div>
  );
}
