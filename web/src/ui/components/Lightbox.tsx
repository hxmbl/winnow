/**
 * A picture attachment, large: the reader's lightbox. One picture at a time over a scrim,
 * with the previous and next picture of the same message (buttons, and the arrow keys),
 * Save, and close (the X, Escape, or a click on the backdrop — a viewer is obviously
 * dismissable by clicking away).
 *
 * Built on `Sheet`, so focus moves in, is trapped, and goes back where it came from. Every
 * key but Escape and Tab stops here: the app's shortcuts (archive, next message) must not
 * act on the message behind a picture someone is looking at.
 */

import { useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, Download, X } from "lucide-react";
import { Sheet } from "./Overlay";

export type LightboxImage = { index: number; url: string; filename: string };

export function Lightbox({
  images,
  current,
  onChange,
  onSave,
  onClose,
}: {
  images: readonly LightboxImage[];
  /** The attachment index on show. */
  current: number;
  onChange: (index: number) => void;
  onSave: (index: number) => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const at = Math.max(0, images.findIndex((image) => image.index === current));
  const image = images[at]!;
  const step = (by: number) => {
    if (images.length < 2) return;
    onChange(images[(at + by + images.length) % images.length]!.index);
  };
  const BUTTON =
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring max-sm:h-11 max-sm:w-11";

  // Portalled to the body: the reader pane animates in with a transform, and a fixed
  // overlay inside a transformed ancestor is positioned against that ancestor, not the
  // window.
  return createPortal(
    <Sheet
      label={`Picture: ${image.filename}`}
      onClose={onClose}
      dismissOnBackdrop
      initialFocus={closeRef}
      className="flex max-h-full max-w-[min(94vw,1200px)] flex-col"
    >
      <div
        data-lightbox=""
        className="flex min-w-[min(90vw,420px)] flex-col items-center gap-3 rounded-pane border border-hairline bg-chrome p-3 shadow-lift"
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            step(event.key === "ArrowLeft" ? -1 : 1);
          }
          if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
        }}
      >
        <div className="flex w-full items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-ui font-medium text-ink" data-lightbox-name="">
            {image.filename}
            {images.length > 1 && (
              <span className="ml-2 text-meta tabular-nums text-ink-subtle">
                {at + 1} of {images.length}
              </span>
            )}
          </p>
          <button type="button" onClick={() => onSave(image.index)} aria-label={`Save ${image.filename}`} className={BUTTON}>
            <Download size={17} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close picture" data-lightbox-close="" className={BUTTON}>
            <X size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
        <div className="flex w-full items-center justify-center gap-2">
          {images.length > 1 && (
            <button type="button" onClick={() => step(-1)} aria-label="Previous picture" className={BUTTON}>
              <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
          <img
            src={image.url}
            alt={image.filename}
            data-lightbox-image=""
            draggable={false}
            className="max-h-[78vh] min-w-0 max-w-full rounded-inset border border-hairline bg-surface object-contain"
          />
          {images.length > 1 && (
            <button type="button" onClick={() => step(1)} aria-label="Next picture" className={BUTTON}>
              <ChevronRight size={18} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </Sheet>,
    document.body,
  );
}
