/**
 * Asked before a send whose Google Drive links Winnow uploaded, when Winnow may not use
 * Drive (signed out and back in, or the permission removed at Google): without it the
 * links can't be shared, and the recipients get a link they can't open. Three answers:
 * allow Drive again (the same incremental consent as the first upload), send anyway with
 * that warning spelled out, or keep editing. Never sent silently.
 *
 * The words are `DRIVE_GRANT_NEEDED` in `core/gmail/drive`.
 */

import { useRef } from "react";
import { DRIVE_GRANT_NEEDED } from "../../core/gmail/drive";
import { Sheet } from "./Overlay";

export function DriveGrantNeeded({
  web,
  onAllow,
  onSendAnyway,
  onCancel,
}: {
  /** On the web the page leaves for Google and comes back; Send again then. */
  web: boolean;
  onAllow: () => void;
  onSendAnyway: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Sheet
      label={DRIVE_GRANT_NEEDED.title}
      onClose={onCancel}
      onEscape={onCancel}
      dismissOnBackdrop={false}
      initialFocus={cancelRef}
      className="w-full max-w-[420px] rounded-pane border border-hairline bg-chrome p-5 shadow-lift"
    >
      <div data-drive-grant-needed="">
        <h2 className="text-read font-semibold text-ink">{DRIVE_GRANT_NEEDED.title}</h2>
        <p className="mt-1.5 text-ui leading-relaxed text-ink-muted">{DRIVE_GRANT_NEEDED.body}</p>
        <p className="mt-2 text-ui leading-relaxed text-ink-body" data-drive-grant-warning="">
          {DRIVE_GRANT_NEEDED.sendAnywayWarning}
        </p>
        {web && (
          <p className="mt-2 text-meta leading-relaxed text-ink-subtle">
            Allowing goes to Google and comes back. Your draft is kept; press Send again afterwards.
          </p>
        )}
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-ctl border border-control-border px-4 py-1.5 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Keep editing
          </button>
          <button
            type="button"
            data-drive-grant-send-anyway=""
            onClick={onSendAnyway}
            className="rounded-ctl border border-control-border px-4 py-1.5 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Send anyway
          </button>
          <button
            type="button"
            data-drive-grant-allow=""
            onClick={onAllow}
            className="rounded-ctl bg-accent px-4 py-1.5 text-ui font-semibold text-on-accent transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Allow Google Drive
          </button>
        </div>
      </div>
    </Sheet>
  );
}
