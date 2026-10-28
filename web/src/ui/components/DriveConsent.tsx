/**
 * What Winnow says before it asks Google for Drive: in plain words, what `drive.file`
 * lets it do and what it does not. Shown the first time the user presses "Send as a
 * Drive link", before any request reaches Google, and never at sign-in. Continue leads to
 * Google's own consent screen (on the web the page leaves for it and comes back).
 *
 * The words are `DRIVE_CONSENT` in `core/gmail/drive`, where they are tested.
 */

import { useRef } from "react";
import { Check, X } from "lucide-react";
import { DRIVE_CONSENT } from "../../core/gmail/drive";
import { Sheet } from "./Overlay";
import { buttonClass } from "../button";

export function DriveConsent({
  files,
  web,
  onContinue,
  onCancel,
}: {
  /** The files waiting to go, named so the user knows what this is for. */
  files: readonly { name: string }[];
  /** On the web the page leaves for Google, and the file has to be attached again. */
  web: boolean;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const names = files.map((file) => file.name).join(", ");
  return (
    <Sheet
      label={DRIVE_CONSENT.title}
      onClose={onCancel}
      onEscape={onCancel}
      dismissOnBackdrop={false}
      initialFocus={cancelRef}
      className="w-full max-w-[420px] rounded-pane border border-hairline bg-chrome p-5 shadow-lift"
    >
      <div data-drive-consent="">
        <h2 className="text-read font-semibold text-ink">{DRIVE_CONSENT.title}</h2>
        {names && (
          <p className="mt-1.5 text-ui leading-relaxed text-ink-muted">
            {names} {files.length === 1 ? "is" : "are"} over Gmail's 25 MB, so it can go as a link to a copy in your Google
            Drive instead.
          </p>
        )}
        <p className="mt-3 text-meta font-semibold text-ink">Winnow will be able to</p>
        <ul className="mt-1 flex flex-col gap-1">
          {DRIVE_CONSENT.allows.map((line) => (
            <li key={line} className="flex items-start gap-2 text-ui text-ink-body">
              <Check size={15} strokeWidth={2.2} aria-hidden="true" className="mt-0.5 shrink-0 text-accent" />
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-meta font-semibold text-ink">Winnow won't be able to</p>
        <ul className="mt-1 flex flex-col gap-1">
          {DRIVE_CONSENT.doesNot.map((line) => (
            <li key={line} className="flex items-start gap-2 text-ui text-ink-body">
              <X size={15} strokeWidth={2.2} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-icon" />
              {line}
            </li>
          ))}
        </ul>
        <p className="mt-3 text-meta leading-relaxed text-ink-subtle">{DRIVE_CONSENT.footnote}</p>
        {web && (
          <p className="mt-2 text-meta leading-relaxed text-ink-subtle">
            This page goes to Google and comes back; attach the file again afterwards. Your draft is kept.
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className={buttonClass("secondary")}
          >
            Not now
          </button>
          <button
            type="button"
            data-drive-consent-continue=""
            onClick={onContinue}
            className={buttonClass("primary")}
          >
            Continue to Google
          </button>
        </div>
      </div>
    </Sheet>
  );
}
