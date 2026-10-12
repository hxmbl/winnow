/**
 * Message vocabulary types.
 * Email = product view (normalised); RawEmail = wire view (gmail/dto.ts).
 * gmail/mapper.ts converts between them.
 */

/** Unix milliseconds (app-wide). */
export type Millis = number;

/** Gmail message ID. */
export type GmailId = string;

export type Mailbox = "inbox" | "archive" | "sent" | "trash" | "spam";

export const MAILBOXES: readonly Mailbox[] = ["inbox", "archive", "sent", "trash", "spam"];

export const MAILBOX_LABEL: Record<Mailbox, string> = {
  inbox: "Inbox",
  archive: "Archive",
  sent: "Sent",
  trash: "Trash",
  spam: "Spam",
};

/** Gmail categories. */
export type EmailCategory =
  | "primary"
  | "social"
  | "promotions"
  | "updates"
  | "forums"
  | "reservations"
  | "receipts"
  | "newsletter";

/** Maps Gmail category labels to internal union (fallback primary). */
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
 * One address on a message, with the name it was addressed by.
 *
 * The same shape for every field that holds one. `name` is optional because a header
 * frequently has no display name at all, and a contact with a name is worth more to a
 * recipient list than one without.
 */
export type Contact = {
  /** Bare address. */
  address: string;
  /** Header display name, if the message carried one. */
  name?: string;
};

/** Attachment metadata (bytes fetched on demand). */
export type Attachment = {
  /** Gmail attachmentId for download. */
  id: string;
  /** MIME part path, e.g. `1.2`. */
  partId: string;
  filename: string;
  mimeType: string;
  /** Bytes (reported by Gmail). */
  size: number;
  /** Inline images kept for "show remote content" escape hatch. */
  inline: boolean;
};

/** Reply/composer draft. */
export type Draft = {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  /** Gmail thread for `In-Reply-To`/`References`. */
  inReplyTo?: GmailId;
  threadId?: GmailId;
  /** Prefilled quote block (see `core/reply.ts`). */
  quoteBlock?: string;
  /** Prefilled body before user edits (comparison for discard confirmation). */
  prefilled?: string;
};

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

export function mimeTypeForFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return ATTACHMENT_MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

/**
 * Normalised message.
 * id = numeric hash of Gmail id (React/URL key). gmailId = authority.
 */
export type Email = {
  id: number;
  gmailId: GmailId;
  /** Absent for single-message threads. */
  threadId?: GmailId;
  /** RFC 822 Message-ID (may be absent in demo/cached older builds). */
  messageId?: string;
  /** Envelope sender (bare address). Join key for sender grouping. */
  sender: string;
  /** Original header address if different from sender. */
  address?: string;
  /** Header display name. */
  name?: string;
  /**
   * Who the message was addressed to.
   *
   * Optional and absent on most cached messages: the fields are new, and the offline
   * cache is full of rows written before they existed. Absence means "this message
   * predates them", so every reader treats them as empty rather than as an error.
   *
   * On received mail `to` and `cc` are what the sender chose to disclose; `bcc` is
   * normally empty, because a recipient is not told who else was copied. On sent mail
   * all three are complete, which is the point — sent mail is the only place the other
   * side of a conversation is visible.
   */
  to?: Contact[];
  cc?: Contact[];
  bcc?: Contact[];
  mailbox: Mailbox;
  receivedAt: Millis;
  subject: string;
  /** Plain text (always present). */
  body: string;
  /** Original HTML. */
  bodyHtml?: string;
  category: EmailCategory;
  starred: boolean;
  unread: boolean;
  attachments: Attachment[];
  /** Gmail spam score 0-100, if available. */
  spamScore?: number;
  /** Person/Gmail marked urgent (bypasses keyword test). */
  urgent: boolean;
};

export function displayName(email: Email): string {
  const name = email.name?.trim();
  if (name) return name;
  const local = email.sender.split("@")[0]?.trim();
  return local || email.sender;
}

export function displayAddress(email: Email): string {
  return email.address ?? email.sender;
}

/** Single-cap monogram for avatar (first char only). */
export function monogram(email: Email): string {
  const source = displayName(email).trim();
  return (source[0] ?? "?").toUpperCase();
}

export function isMailbox(value: unknown): value is Mailbox {
  return typeof value === "string" && (MAILBOXES as readonly string[]).includes(value);
}
