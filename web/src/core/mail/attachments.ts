/**
 * Attachments: the rules for files going out with a draft, and for describing files
 * that came in.
 *
 * Out: Gmail refuses a message whose attachments add up to more than 25 MB, so the
 * composer refuses first and says which file would cross the line, rather than letting
 * Send fail after an upload. The files ride on the `Draft` as base64 so the draft stays
 * plain JSON; the device copy (`LocalDrafts`) keeps the bytes only while they fit a small
 * budget, because `localStorage` is ~5 MB for the whole origin and a write that overflows
 * it throws away the *text* too. Anything over the budget lives in the Gmail draft, which
 * the autosave writes with its files.
 *
 * In: what kind of file a part is (for its icon), and whether the reader may show it as
 * a picture. SVG never is: it can carry script, and a preview is not worth that.
 *
 * Pure: no DOM, no Gmail.
 */

import type { DraftAttachment } from "../model/email";
import { mimeTypeForFilename } from "../model/email";
import { formatBytes } from "../gmail/mime";

/** Gmail's limit on a message's attachments, in bytes (25 MB). */
export const GMAIL_ATTACHMENT_LIMIT = 25 * 1024 * 1024;

/**
 * How much base64 the device copy keeps, in characters (~1.5 MB of files). Past it the
 * Gmail draft is where the files are kept.
 */
export const DEVICE_COPY_BUDGET = 2_000_000;

/** The bytes a draft's files add up to. */
export function totalAttachmentSize(attachments: readonly Pick<DraftAttachment, "size">[] | undefined): number {
  return (attachments ?? []).reduce((sum, attachment) => sum + attachment.size, 0);
}

/** A file the composer was handed, read. */
export type IncomingFile = { filename: string; mimeType?: string; size: number; data: string };

/**
 * Which of these files fit, in order, under Gmail's cap on top of what is attached: a file
 * that would cross it is refused, and a smaller one after it can still go in. An empty
 * file (a folder dropped from a file manager arrives as one) is refused too. Decided on
 * sizes alone, so a file that cannot go is never read.
 */
export function planAttachments(
  existing: readonly Pick<DraftAttachment, "size">[] | undefined,
  files: readonly { filename: string; size: number }[],
): { accepted: number[]; error: string | null } {
  let total = totalAttachmentSize(existing);
  const accepted: number[] = [];
  const big: { filename: string; size: number }[] = [];
  const empty: string[] = [];
  files.forEach((file, index) => {
    if (file.size <= 0) {
      empty.push(cleanFilename(file.filename));
    } else if (total + file.size > GMAIL_ATTACHMENT_LIMIT) {
      big.push(file);
    } else {
      total += file.size;
      accepted.push(index);
    }
  });
  const parts: string[] = [];
  if (big.length > 0) {
    const names = big.map((file) => `${cleanFilename(file.filename)} (${formatBytes(file.size)})`).join(", ");
    const left = Math.max(0, GMAIL_ATTACHMENT_LIMIT - total);
    parts.push(
      `${names} ${big.length === 1 ? "is" : "are"} too big to attach: Gmail allows 25 MB of attachments per message` +
        (left > 0 ? `, and ${formatBytes(left)} is left.` : ", and this message is full."),
    );
  }
  if (empty.length > 0) {
    parts.push(`${empty.join(", ")} ${empty.length === 1 ? "is" : "are"} empty or a folder, so not attached.`);
  }
  return { accepted, error: parts.length > 0 ? parts.join(" ") : null };
}

/** Files that were read, as draft attachments after `existing`. */
export function attachFiles(
  existing: readonly DraftAttachment[] | undefined,
  files: readonly IncomingFile[],
  makeId: () => string,
): DraftAttachment[] {
  return [
    ...(existing ?? []),
    ...files.map((file) => ({
      id: makeId(),
      filename: cleanFilename(file.filename),
      mimeType: file.mimeType && file.mimeType.trim() !== "" ? file.mimeType : mimeTypeForFilename(file.filename),
      size: file.size,
      data: file.data,
    })),
  ];
}

/** `planAttachments` then `attachFiles`, for files already read. */
export function addAttachments(
  existing: readonly DraftAttachment[] | undefined,
  incoming: readonly IncomingFile[],
  makeId: () => string,
): { attachments: DraftAttachment[]; error: string | null } {
  const { accepted, error } = planAttachments(existing, incoming);
  return { attachments: attachFiles(existing, accepted.map((index) => incoming[index]!), makeId), error };
}

/** Remove one attachment by id. */
export function removeAttachment(attachments: readonly DraftAttachment[] | undefined, id: string): DraftAttachment[] {
  return (attachments ?? []).filter((attachment) => attachment.id !== id);
}

/**
 * A filename as it may go into a header: no path, no control characters, no quotes, and
 * never blank. A browser hands over a bare name, but a drop from some file managers and
 * a reopened draft carry whatever the sender wrote.
 */
export function cleanFilename(name: string): string {
  let cleaned = "";
  for (const char of name.split(/[/\\]/).pop() ?? "") {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || char === '"') continue;
    cleaned += char;
  }
  cleaned = cleaned.trim();
  return cleaned === "" || /^\.+$/.test(cleaned) ? "attachment" : cleaned;
}

/**
 * The attachments as the device copy keeps them: bytes while the running total fits
 * `DEVICE_COPY_BUDGET`, and past it only the name, size and (if any) Gmail source.
 */
export function forDeviceCopy(
  attachments: readonly DraftAttachment[] | undefined,
  budget = DEVICE_COPY_BUDGET,
): DraftAttachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  let used = 0;
  return attachments.map((attachment) => {
    const length = attachment.data?.length ?? 0;
    if (attachment.data !== undefined && used + length <= budget) {
      used += length;
      return attachment;
    }
    const { data: _data, ...rest } = attachment;
    void _data;
    return rest;
  });
}

/**
 * Split a restored draft's attachments into those that can still be sent (bytes, or a
 * Gmail source) and the names of those that cannot, which were too big for the device
 * copy and have to be attached again.
 */
export function restorableAttachments(attachments: readonly DraftAttachment[] | undefined): {
  kept: DraftAttachment[];
  lost: string[];
} {
  const kept: DraftAttachment[] = [];
  const lost: string[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.data !== undefined || attachment.source) kept.push(attachment);
    else lost.push(attachment.filename);
  }
  return { kept, lost };
}

// ── Kinds ───────────────────────────────────────────────────────────────────

export type AttachmentKind =
  | "image"
  | "pdf"
  | "text"
  | "document"
  | "spreadsheet"
  | "slides"
  | "archive"
  | "calendar"
  | "audio"
  | "video"
  | "other";

const BY_EXTENSION: Record<string, AttachmentKind> = {
  pdf: "pdf",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  heic: "image",
  bmp: "image",
  svg: "image",
  txt: "text",
  md: "text",
  csv: "spreadsheet",
  tsv: "spreadsheet",
  xls: "spreadsheet",
  xlsx: "spreadsheet",
  ods: "spreadsheet",
  numbers: "spreadsheet",
  doc: "document",
  docx: "document",
  odt: "document",
  rtf: "document",
  pages: "document",
  ppt: "slides",
  pptx: "slides",
  odp: "slides",
  key: "slides",
  zip: "archive",
  rar: "archive",
  "7z": "archive",
  gz: "archive",
  tar: "archive",
  ics: "calendar",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  ogg: "audio",
  mp4: "video",
  mov: "video",
  webm: "video",
};

/** What kind of file this is, from its type and, failing that, its extension. */
export function attachmentKind(mimeType: string, filename: string): AttachmentKind {
  const type = mimeType.toLowerCase().split(";")[0]!.trim();
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type === "text/calendar") return "calendar";
  if (type === "text/csv" || type.includes("spreadsheet") || type.includes("excel")) return "spreadsheet";
  if (type.includes("presentation") || type.includes("powerpoint")) return "slides";
  if (type.includes("wordprocessing") || type === "application/msword" || type === "application/rtf") return "document";
  if (type.includes("zip") || type.includes("compressed") || type === "application/x-tar" || type === "application/gzip") {
    return "archive";
  }
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const byName = filename.includes(".") ? BY_EXTENSION[extension] : undefined;
  if (byName) return byName;
  if (type.startsWith("text/")) return "text";
  return "other";
}

/** Image types the reader draws as a thumbnail. Raster only: an SVG can carry script. */
const PREVIEWABLE_IMAGES = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp"];

/** The largest image the reader fetches for a thumbnail without being asked, in bytes. */
export const THUMBNAIL_MAX_BYTES = 8 * 1024 * 1024;

/** Whether the reader may show this attachment as a picture. */
export function isPreviewableImage(mimeType: string, filename: string): boolean {
  const type = mimeType.toLowerCase().split(";")[0]!.trim();
  if (PREVIEWABLE_IMAGES.includes(type)) return true;
  if (type !== "application/octet-stream" && type !== "") return false;
  // A generic type on a file whose name says what it is (some senders do this).
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(filename);
}

/** The type a previewable image is drawn as, so a mislabelled one still decodes. */
export function previewMimeType(mimeType: string, filename: string): string {
  const type = mimeType.toLowerCase().split(";")[0]!.trim();
  if (PREVIEWABLE_IMAGES.includes(type)) return type === "image/jpg" ? "image/jpeg" : type;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return ext === "jpg" ? "image/jpeg" : `image/${ext}`;
}

/** Whether this is a PDF, which opens in a viewer rather than only saving. */
export function isPdf(mimeType: string, filename: string): boolean {
  return attachmentKind(mimeType, filename) === "pdf";
}

// ── Bytes ───────────────────────────────────────────────────────────────────

/** Standard base64 of bytes, built in chunks so a 25 MB file does not blow the stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = "";
  for (let start = 0; start < bytes.length; start += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(start, start + CHUNK));
  }
  return btoa(binary);
}

/** Bytes from standard base64. Whitespace is ignored; anything else invalid throws. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64.replace(/\s+/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
