/**
 * A message's attachments, in the reader: a thumbnail for each picture, then one row per
 * file with its type icon, name and size, and what can be done with it — Open for a PDF
 * (the browser's viewer, or the system's on the desktop), Preview for a picture (the
 * `Lightbox`), Save for everything (the save dialog on the desktop and Android, a
 * download in the browser).
 *
 * Pictures are fetched for their thumbnail as the reader opens, raster types only
 * (`isPreviewableImage`: never SVG) and only up to `THUMBNAIL_MAX_BYTES`; anything else is
 * fetched when asked for. Object URLs are revoked when the reader moves on.
 */

import { useEffect, useMemo, useState } from "react";
import {
  CalendarDays,
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import {
  THUMBNAIL_MAX_BYTES,
  attachmentKind,
  isPdf,
  isPreviewableImage,
  previewMimeType,
  type AttachmentKind,
} from "../../core/mail/attachments";
import { formatBytes } from "../../core/gmail/mime";
import type { Attachment } from "../../core/model/email";
import { Lightbox, type LightboxImage } from "./Lightbox";
import { Icon } from "./Icon";

const KIND_ICON: Record<AttachmentKind, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  text: FileText,
  document: FileText,
  spreadsheet: FileSpreadsheet,
  slides: Presentation,
  archive: FileArchive,
  calendar: CalendarDays,
  audio: FileAudio,
  video: FileVideo,
  other: File,
};

/** How many pictures get a thumbnail without being asked. */
const MAX_THUMBNAILS = 8;

export type LoadedAttachment = { bytes: Uint8Array; filename: string; mimeType: string };

export function AttachmentList({
  attachments,
  load,
  onSave,
  onOpen,
}: {
  attachments: readonly Attachment[];
  /** The bytes of the attachment at `index`. Rejects with the reason it cannot. */
  load: (index: number) => Promise<LoadedAttachment>;
  onSave: (index: number) => void;
  /** Show a PDF in a viewer. */
  onOpen: (index: number) => void;
}) {
  /** Which attachments are pictures the reader may draw, by index. */
  const pictures = useMemo(
    () =>
      attachments
        .map((attachment, index) => ({ attachment, index }))
        .filter(({ attachment }) => isPreviewableImage(attachment.mimeType, attachment.filename)),
    [attachments],
  );
  const [urls, setUrls] = useState<ReadonlyMap<number, string>>(() => new Map());
  const [lightbox, setLightbox] = useState<number | null>(null);

  // Thumbnails: fetched once per message (the reader remounts per selection), revoked on
  // the way out. A failure leaves the row, which can still be saved, and no thumbnail.
  useEffect(() => {
    let live = true;
    const made: string[] = [];
    const wanted = pictures
      .filter(({ attachment }) => attachment.size <= THUMBNAIL_MAX_BYTES)
      .slice(0, MAX_THUMBNAILS);
    for (const { attachment, index } of wanted) {
      load(index).then(
        (loaded) => {
          if (!live) return;
          const url = URL.createObjectURL(
            new Blob([loaded.bytes as unknown as BlobPart], {
              type: previewMimeType(attachment.mimeType, attachment.filename),
            }),
          );
          made.push(url);
          setUrls((current) => new Map(current).set(index, url));
        },
        () => undefined,
      );
    }
    return () => {
      live = false;
      for (const url of made) URL.revokeObjectURL(url);
    };
    // `load` is a fresh closure every render; the pictures are what decide the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pictures]);

  if (attachments.length === 0) return null;

  const images: LightboxImage[] = pictures
    .filter(({ index }) => urls.has(index))
    .map(({ attachment, index }) => ({ index, url: urls.get(index)!, filename: attachment.filename }));

  const ACTION =
    "flex h-8 shrink-0 items-center gap-1.5 rounded-ctl px-2 text-meta font-medium text-ink-body transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:h-11 max-sm:px-3";

  return (
    <div data-attachments="" className="mt-6 max-w-[68ch]">
      <h3 className="text-meta font-semibold text-ink-muted">
        {attachments.length} {attachments.length === 1 ? "attachment" : "attachments"}
      </h3>

      {images.length > 0 && (
        <ul aria-label="Pictures" className="mt-2 flex flex-wrap gap-2">
          {images.map((image) => (
            <li key={image.index}>
              <button
                type="button"
                data-attachment-thumb={image.filename}
                aria-label={`Preview ${image.filename}`}
                onClick={() => setLightbox(image.index)}
                className="block h-24 w-24 overflow-hidden rounded-ctl border border-hairline bg-surface transition-opacity hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <img src={image.url} alt="" className="h-full w-full object-cover" draggable={false} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <ul className="mt-2 flex flex-col gap-1">
        {attachments.map((attachment, index) => {
          const kind = attachmentKind(attachment.mimeType, attachment.filename);
          const Glyph = KIND_ICON[kind];
          const pdf = isPdf(attachment.mimeType, attachment.filename);
          const previewable = urls.has(index);
          return (
            <li
              key={attachment.id}
              data-attachment={attachment.filename}
              data-attachment-kind={kind}
              className="flex items-center gap-2 rounded-ctl px-2 py-1 hover:bg-sheen"
            >
              <Icon icon={Glyph} size={16} className="shrink-0 text-ink-muted" />
              <span className="min-w-0 flex-1">
                <span className="selectable block truncate text-ui font-medium text-ink" title={attachment.filename}>
                  {attachment.filename}
                </span>
                <span className="block text-meta tabular-nums text-ink-subtle">{formatBytes(attachment.size)}</span>
              </span>
              {pdf && (
                <button
                  type="button"
                  data-attachment-open=""
                  onClick={() => onOpen(index)}
                  aria-label={`Open ${attachment.filename}`}
                  className={ACTION}
                >
                  <Icon icon={ExternalLink} size={16} />
                  <span className="max-sm:sr-only">Open</span>
                </button>
              )}
              {previewable && (
                <button
                  type="button"
                  data-attachment-preview=""
                  onClick={() => setLightbox(index)}
                  aria-label={`Preview ${attachment.filename}`}
                  className={ACTION}
                >
                  <Icon icon={FileImage} size={16} />
                  <span className="max-sm:sr-only">Preview</span>
                </button>
              )}
              <button
                type="button"
                data-attachment-save=""
                onClick={() => onSave(index)}
                aria-label={`Save ${attachment.filename}`}
                className={ACTION}
              >
                <Icon icon={Download} size={16} />
                <span className="max-sm:sr-only">Save</span>
              </button>
            </li>
          );
        })}
      </ul>

      {lightbox !== null && images.some((image) => image.index === lightbox) && (
        <Lightbox
          images={images}
          current={lightbox}
          onChange={setLightbox}
          onSave={onSave}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
