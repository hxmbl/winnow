/**
 * The composer's attachments: an Attach button (the system file picker, several at once),
 * a chip per file with its size and a remove button, the running total against Gmail's
 * 25 MB, and the reason in place when a file is refused. On the desktop the composer is
 * also a drop target (`Composer`'s `onFiles`), which hands its files to `add` here through
 * `adderRef`, so the cap and the reading live in one place.
 *
 * The files ride on the draft (`Draft.attachments`, base64), so the autosave writes them
 * into the Gmail draft and Send builds them into the MIME message. The rules are in
 * `core/mail/attachments`, where they are tested.
 */

import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { Paperclip, X } from "lucide-react";
import type { DraftAttachment } from "../../core/model/email";
import {
  GMAIL_ATTACHMENT_LIMIT,
  attachFiles,
  bytesToBase64,
  planAttachments,
  removeAttachment,
  totalAttachmentSize,
  type IncomingFile,
} from "../../core/mail/attachments";
import { formatBytes } from "../../core/gmail/mime";

export type AttachmentAdder = { add: (files: readonly File[]) => void };

let nextId = 0;
const makeId = () => `local-${Date.now().toString(36)}-${(nextId += 1)}`;

export function ComposerAttachments({
  attachments,
  onChange,
  adderRef,
  notice = null,
  phone = false,
}: {
  attachments: readonly DraftAttachment[];
  /** The whole new list; the parent merges it into the draft. */
  onChange: (next: DraftAttachment[]) => void;
  adderRef?: Ref<AttachmentAdder>;
  /** Said under the chips: files a restored draft could not bring back. */
  notice?: string | null;
  phone?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(0);
  /** The list as of this render, for a read that finishes after another change. */
  const latest = useRef(attachments);
  latest.current = attachments;

  const add = (files: readonly File[]) => {
    if (files.length === 0) return;
    const { accepted, error: refusal } = planAttachments(
      latest.current,
      files.map((file) => ({ filename: file.name, size: file.size })),
    );
    setError(refusal);
    if (accepted.length === 0) return;
    setReading((count) => count + 1);
    void Promise.all(
      accepted.map(async (index): Promise<IncomingFile> => {
        const file = files[index]!;
        return {
          filename: file.name,
          mimeType: file.type,
          size: file.size,
          data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
        };
      }),
    )
      .then((read) => {
        // Checked again against the list as it is now: another drop may have landed
        // while these were being read.
        const again = planAttachments(latest.current, read);
        if (again.error) setError(again.error);
        onChange(attachFiles(latest.current, again.accepted.map((index) => read[index]!), makeId));
      })
      .catch(() => setError("That file could not be read."))
      .finally(() => setReading((count) => count - 1));
  };

  useImperativeHandle(adderRef, () => ({ add }));

  const total = totalAttachmentSize(attachments);
  const chip = phone ? "min-h-11" : "min-h-8";

  return (
    <div data-composer-attachments="" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-attach=""
          onClick={() => inputRef.current?.click()}
          title="Attach files"
          className={`flex items-center gap-1.5 rounded-ctl px-2 text-meta font-medium text-ink-body transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${chip}`}
        >
          <Paperclip size={15} strokeWidth={1.9} aria-hidden="true" />
          Attach
        </button>
        <input
          ref={inputRef}
          type="file"
          multiple
          tabIndex={-1}
          aria-hidden="true"
          data-attach-input=""
          className="hidden"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            // Cleared so picking the same file again (after removing it) fires a change.
            event.target.value = "";
            add(files);
          }}
        />
        {attachments.map((attachment) => (
          <span
            key={attachment.id}
            data-attachment-chip={attachment.filename}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-full border border-hairline bg-sheen py-0.5 pl-2.5 pr-1 text-meta ${chip}`}
          >
            <span className="min-w-0 truncate font-medium text-ink" title={attachment.filename}>
              {attachment.filename}
            </span>
            <span className="shrink-0 tabular-nums text-ink-subtle">{formatBytes(attachment.size)}</span>
            <button
              type="button"
              aria-label={`Remove ${attachment.filename}`}
              data-attachment-remove=""
              onClick={() => {
                setError(null);
                onChange(removeAttachment(latest.current, attachment.id));
              }}
              className={`flex shrink-0 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
                phone ? "h-9 w-9" : "h-6 w-6"
              }`}
            >
              <X size={13} strokeWidth={2.2} aria-hidden="true" />
            </button>
          </span>
        ))}
        {reading > 0 && (
          <span role="status" className="text-meta text-ink-subtle">
            Attaching…
          </span>
        )}
        {attachments.length > 0 && (
          <span data-attachment-total="" className="ml-auto text-meta tabular-nums text-ink-subtle">
            {formatBytes(total)} of {formatBytes(GMAIL_ATTACHMENT_LIMIT)}
          </span>
        )}
      </div>
      {(error ?? notice) && (
        <p role="alert" data-attach-error="" className="text-meta font-medium text-danger">
          {[error, notice].filter(Boolean).join(" ")}
        </p>
      )}
    </div>
  );
}
