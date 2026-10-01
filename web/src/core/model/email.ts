/**
 * The vocabulary of a message.
 *
 * Every other module in `core/` speaks these types, so this file is the one
 * place a field gets added. The split is deliberate:
 *
 *   - `Email` is the *product* view: normalised, denormalised into the exact
 *     fields the classifier and the reader need, and safe to persist as-is.
 *   - `RawEmail` (in `gmail/dto.ts`) is the *wire* view: whatever Gmail
 *     returned. `gmail/mapper.ts` is the only thing that converts one to the
 *     other.
 *
 * That boundary is what lets a demo seed, a Gmail sync and a future IMAP
 * account all feed the same store.
 */

/** Unix milliseconds. The single time unit in the whole app. */
export type Millis = number;

/** Gmail's own message id. Stable across syncs; the cache keys on it. */
export type GmailId = string;

/** Which mailbox a message is filed in. Mirrors the Swift `EmailMailbox`. */
export type Mailbox = "inbox" | "archive" | "trash" | "spam";

export const MAILBOXES: readonly Mailbox[] = ["inbox", "archive", "trash", "spam"];

export const MAILBOX_LABEL: Record<Mailbox, string> = {
  inbox: "Inbox",
  archive: "Archive",
  trash: "Trash",
  spam: "Spam",
};

/** Message categories Gmail supplies. Only some affect classification. */
export type EmailCategory =
  | "primary"
  | "social"
  | "promotions"
  | "updates"
  | "forums"
  | "reservations"
  | "receipts"
  | "newsletter";

/**
 * Gmail's own category, mapped onto the coarser union the classifier reads.
 * Anything unrecognised falls back to `primary` rather than being dropped.
 */
export const CATEGORY_MAP: Record<string, EmailCategory> = {
  CATEGORY_PRIMARY: "primary",
  CATEGORY_SOCIAL: "social",
  CATEGORY_PROMOTIONS: "promotions",
  CATEGORY_UPDATES: "updates",
  CATEGORY_FORUMS: "forums",
  CATEGORY_RESERVATIONS: "reservations",
  CATEGORY_RECEIPTS: "receipts",
  CATEGORY_NEWSLETTERS: "newsletter",
};

/**
 * An attachment's metadata. The bytes are fetched on demand — an inbox view
 * that preloaded every PDF would be unusable.
 */
export type Attachment = {
  /** Gmail attachmentId; the handle used to download. */
  id: string;
  /** MIME part path within the message, e.g. `1.2`. */
  partId: string;
  filename: string;
  mimeType: string;
  /** Bytes, as reported by Gmail. */
  size: number;
  /**
   * True for images the message inlines. Winnow strips them along with all
   * other remote content by default, so they are kept for the "show remote
   * content" escape hatch.
   */
  inline: boolean;
};

/** A reply, as composed in the composer. */
export type Draft = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** Gmail thread being replied to, for `In-Reply-To`/`References`. */
  inReplyTo?: GmailId;
  threadId?: GmailId;
  /**
   * The quote block Winnow pre-filled, kept so it can be stripped from the end
   * of the body if the user leaves it alone. See `core/reply.ts`.
   */
  quoteBlock?: string;
};

/** File names the composer should offer as an attachment picker. */
export const ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ics: "text/calendar",
};

/** Guess an attachment's type from its name, defaulting to opaque bytes. */
export function mimeTypeForFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return ATTACHMENT_MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/** True when the browser/Tauri can preview this without downloading it. */
export function isPreviewable(mimeType: string): boolean {
  // SVG is excluded explicitly: it is an image that can carry script, and a mail
  // client that previews one is a mail client that runs a stranger's JavaScript.
  if (mimeType.includes("svg")) return false;
  return (
    mimeType.startsWith("image/") ||
    mimeType === "application/pdf" ||
    mimeType.startsWith("text/")
  );
}

/**
 * A message, normalised.
 *
 * `id` is a numeric hash of the Gmail id — a stable, compact key for React and
 * for URL deep links. `gmailId` is the authority; `id` is derived from it, so
 * the two can never disagree.
 */
export type Email = {
  id: number;
  gmailId: GmailId;
  /** Absent for a single message with no thread. */
  threadId?: GmailId;
  /**
   * The envelope sender: the bare address from `From:`. This is the join key
   * for sender pills, trash bias and engagement ranking, so it is deliberately
   * the *address* and not the display name — two people at one company, or one
   * person across an alias, must not split into two senders.
   */
  sender: string;
  /**
   * The address as it appeared in the header, when that differs from
   * `sender`. Almost always the same value; kept separate so a message that
   * arrived via a forwarding service keeps its original `From:` for display
   * while still being attributed to the envelope sender for ranking.
   */
  address?: string;
  /** Display name from the header, if the sender supplied a usable one. */
  name?: string;
  /** Where the message was filed. */
  mailbox: Mailbox;
  receivedAt: Millis;
  subject: string;
  /** Plain text. Always present, even when the message was HTML-only. */
  body: string;
  /** Original HTML, kept for the reader's rich view. */
  bodyHtml?: string;
  category: EmailCategory;
  starred: boolean;
  unread: boolean;
  attachments: Attachment[];
  /** Gmail's per-message spam score, 0–100, when available. */
  spamScore?: number;
  /**
   * True when the sender or Gmail marked the message urgent. Bypasses the
   * keyword test for urgency — a person flagged it, so trust them.
   */
  urgent: boolean;
};

/** What a sender looks like to the user. The reader and list must agree. */
export function displayName(email: Email): string {
  const name = email.name?.trim();
  if (name) return name;
  const local = email.sender.split("@")[0]?.trim();
  return local || email.sender;
}

/** The full address, for the reader's byline. */
export function displayAddress(email: Email): string {
  return email.address ?? email.sender;
}

/**
 * A single-cap monogram for the avatar.
 *
 * Deliberately the *first* character rather than two initials: with a 40px
 * circle, "Ada Lovelace" as "AL" competes with the name next to it, while "A"
 * reads as an avatar at a glance.
 */
export function monogram(email: Email): string {
  const source = displayName(email).trim();
  return (source[0] ?? "?").toUpperCase();
}

/** Everything the type layer needs to narrow an untrusted value. */
export function isMailbox(value: unknown): value is Mailbox {
  return typeof value === "string" && (MAILBOXES as readonly string[]).includes(value);
}
