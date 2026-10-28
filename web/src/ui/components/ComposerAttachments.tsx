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
 *
 * A file that would take the message past 25 MB is refused as before, and when the parent
 * passes `drive`, a "Send as a Drive link" button appears beside the reason: the file goes
 * to the user's Google Drive and the message carries a "File name (size) — link" line.
 * The asking (a plain-words dialog, then Google's consent) and the upload are the
 * parent's; this only holds the refused files until the button is pressed. The Drive
 * files already on the message show as link chips.
 */

import { useImperativeHandle, useRef, useState, type Ref } from "react";
import { Link2, Paperclip, X } from "lucide-react";
import type { DraftAttachment, DraftDriveFile } from "../../core/model/email";
import {
  GMAIL_ATTACHMENT_LIMIT,
  attachFiles,
  bytesToBase64,
  oversizedFiles,
  planAttachments,
  removeAttachment,
  totalAttachmentSize,
  type IncomingFile,
} from "../../core/mail/attachments";
import { formatBytes } from "../../core/gmail/mime";
import { buttonClass } from "../button";
import { Icon } from "./Icon";

export type AttachmentAdder = { add: (files: readonly File[]) => void };

/** The composer's Drive-link side, from the parent. Absent hides the offer. */
export type DriveLinkOffer = {
  /** The refused files, to go to Drive (the parent asks first when it must). */
  onSendAsLink: (files: File[]) => void;
  /** "Uploading report.mov…" while it runs. */
  busy: string | null;
  /** A failed step, with a link when there is a switch to flip ("Turn on the Drive API"). */
  problem: { message: string; url: string | null; label: string | null } | null;
  onOpenHelp: (url: string) => void;
};

let nextId = 0;
const makeId = () => `local-${Date.now().toString(36)}-${(nextId += 1)}`;

export function ComposerAttachments({
  attachments,
  onChange,
  adderRef,
  notice = null,
  phone = false,
  drive = null,
  driveFiles = [],
  onRemoveDriveFile,
}: {
  attachments: readonly DraftAttachment[];
  /** The whole new list; the parent merges it into the draft. */
  onChange: (next: DraftAttachment[]) => void;
  adderRef?: Ref<AttachmentAdder>;
  /** Said under the chips: files a restored draft could not bring back. */
  notice?: string | null;
  phone?: boolean;
  drive?: DriveLinkOffer | null;
  driveFiles?: readonly DraftDriveFile[];
  onRemoveDriveFile?: (id: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(0);
  /** Files refused for size, kept for "Send as a Drive link" until the next change. */
  const [tooBig, setTooBig] = useState<File[]>([]);
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
    setTooBig(
      oversizedFiles(
        latest.current,
        files.map((file) => ({ filename: file.name, size: file.size })),
      ).map((index) => files[index]!),
    );
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
          className={`flex items-center gap-1.5 rounded-ctl px-2 text-meta font-medium text-ink-body transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring ${chip}`}
        >
          <Icon icon={Paperclip} size={16} />
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
            className={`inline-flex max-w-full items-center gap-1.5 rounded-ctl border border-hairline bg-sheen py-0.5 pl-2.5 pr-1 text-meta ${chip}`}
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
                setTooBig([]);
                onChange(removeAttachment(latest.current, attachment.id));
              }}
              className={`flex shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring ${
                phone ? "h-9 w-9" : "h-6 w-6"
              }`}
            >
              <Icon icon={X} size={12} />
            </button>
          </span>
        ))}
        {driveFiles.map((file) => (
          <span
            key={file.id}
            data-drive-chip={file.name}
            className={`inline-flex max-w-full items-center gap-1.5 rounded-ctl border border-hairline bg-sheen py-0.5 pl-2.5 pr-1 text-meta ${chip}`}
          >
            <Icon icon={Link2} size={12} className="shrink-0 text-ink-icon" />
            <span className="min-w-0 truncate font-medium text-ink" title={`${file.name} — Google Drive link`}>
              {file.name}
            </span>
            <span className="shrink-0 tabular-nums text-ink-subtle">Drive · {formatBytes(file.size)}</span>
            {onRemoveDriveFile && (
              <button
                type="button"
                aria-label={`Remove the Drive link to ${file.name}`}
                data-drive-remove=""
                onClick={() => onRemoveDriveFile(file.id)}
                className={`flex shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring ${
                  phone ? "h-9 w-9" : "h-6 w-6"
                }`}
              >
                <Icon icon={X} size={12} />
              </button>
            )}
          </span>
        ))}
        {drive?.busy && (
          <span role="status" data-drive-busy="" className="text-meta text-ink-subtle">
            {drive.busy}
          </span>
        )}
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
      {drive && tooBig.length > 0 && !drive.busy && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-drive-offer=""
            onClick={() => {
              const files = tooBig;
              setTooBig([]);
              setError(null);
              drive.onSendAsLink(files);
            }}
            className={buttonClass("secondary", "sm", chip)}
          >
            <Icon icon={Link2} size={16} />
            Send as a Drive link
          </button>
          <span className="text-meta text-ink-subtle">
            {tooBig.length === 1 ? "Uploads it to your Google Drive and adds the link." : "Uploads them to your Google Drive and adds the links."}
          </span>
        </div>
      )}
      {drive?.problem && (
        <div data-drive-problem="" role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-meta font-medium text-danger">{drive.problem.message}</p>
          {drive.problem.url && (
            <button
              type="button"
              onClick={() => drive.onOpenHelp(drive.problem!.url!)}
              className="rounded-ctl border border-hairline px-3 py-1 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-active focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {drive.problem.label ?? "Open"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
