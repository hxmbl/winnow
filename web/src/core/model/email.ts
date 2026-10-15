/**
 * Message vocabulary types.
 * Email = product view (normalised); RawEmail = wire view (gmail/dto.ts).
 * gmail/mapper.ts converts between them.
 */

import type { Unsubscribe } from "../mail/unsubscribe";
import { detectCode } from "../mail/otp";

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
  /**
   * Whether `body`, `bodyHtml` and `attachments` are the real thing.
   *
   * `false` means the message was synced as metadata only: `body` is Gmail's snippet,
   * `bodyHtml` is absent and `attachments` is empty until the reader (or the
   * background prefetch) loads it. Absent means loaded — the demo seed and every cache
   * written before metadata-first sync carry whole messages. Read it through
   * `isBodyLoaded` so the two "loaded" spellings cannot drift apart.
   */
  bodyLoaded?: boolean;
  /** Gmail's size estimate, in bytes. Present on synced mail. */
  sizeEstimate?: number;
  /**
   * The message carried `List-Unsubscribe` or `List-Id` — bulk mail by its own
   * declaration. Read by the classifier, which otherwise finds "unsubscribe" in the
   * footer of a body a metadata sync does not have.
   */
  bulk?: boolean;
  /**
   * A metadata-only message whose top-level MIME type is `multipart/mixed`, which is
   * how mail with attachments is built. A hint for the Attachments bucket until the
   * body (and the real attachment list) arrives.
   */
  attachmentHint?: boolean;
  /**
   * How to leave the mailing list, from `List-Unsubscribe`. Absent when the message
   * carried no usable header — and then the app offers no unsubscribe at all, rather
   * than guessing from a link in the body.
   */
  unsubscribe?: Unsubscribe;
  /**
   * The one-time code the message carries ("418902"), found locally at map time from
   * the subject and the text (`core/mail/otp.ts`). `null` means "looked, none";
   * absent means "not looked yet" (a cache row from before codes existed), which
   * `withCode` fills in on the way into the store.
   */
  code?: string | null;
};

/** The message with `code` settled: kept if already looked for, detected otherwise. */
export function withCode(email: Email): Email {
  if (email.code !== undefined) return email;
  return { ...email, code: detectCode(email.subject, email.body) };
}

/** True when `body`/`bodyHtml`/`attachments` hold the whole message, not a metadata stand-in. */
export function isBodyLoaded(email: Pick<Email, "bodyLoaded">): boolean {
  return email.bodyLoaded !== false;
}

/**
 * What loading a body adds to a metadata-only message. The reader's lazy load and the
 * background prefetch both produce one; the store and the cache both apply it.
 */
export type LoadedBody = {
  body: string;
  bodyHtml?: string;
  attachments: Attachment[];
};

/**
 * A freshly synced copy, keeping the body the cached copy already had.
 *
 * Gmail never changes a message's content after delivery — only its labels — so a
 * body loaded once is good forever, and a metadata re-fetch (a label change, a full
 * rebuild) must not throw it away. That is what keeps opened mail readable offline.
 */
export function keepLoadedBody(fresh: Email, cached: Email | undefined): Email {
  if (!cached || isBodyLoaded(fresh) || !isBodyLoaded(cached)) return fresh;
  return {
    ...fresh,
    body: cached.body,
    bodyHtml: cached.bodyHtml,
    attachments: cached.attachments,
    bodyLoaded: true,
    attachmentHint: undefined,
    code: cached.code ?? fresh.code,
  };
}

/** A metadata-only message with its body applied. */
export function withLoadedBody(email: Email, loaded: LoadedBody): Email {
  return {
    ...email,
    body: loaded.body,
    bodyHtml: loaded.bodyHtml,
    attachments: loaded.attachments,
    bodyLoaded: true,
    attachmentHint: undefined,
    // The snippet may have cut the code off; the whole body is the better witness.
    code: email.code || detectCode(email.subject, loaded.body),
  };
}

export function displayName(email: Email): string {
  const name = email.name?.trim();
  if (name) return name;
  const local = email.sender.split("@")[0]?.trim();
  return local || email.sender;
}

export function displayAddress(email: Email): string {
  return email.address ?? email.sender;
}

/** One recipient as a header would print it: `Name <address>`, or the bare address. */
export function formatContact(contact: Contact): string {
  const name = contact.name?.trim();
  return name && name !== contact.address ? `${name} <${contact.address}>` : contact.address;
}

/**
 * Who the message went to, one line per field that has anyone in it — `to …`, `cc …`,
 * `bcc …` — for the reader header, where it is selectable text the user can copy.
 * Empty for a message that predates the recipient fields (see `Email.to`).
 */
export function recipientLines(email: Email): { field: "to" | "cc" | "bcc"; text: string }[] {
  const lines: { field: "to" | "cc" | "bcc"; text: string }[] = [];
  for (const field of ["to", "cc", "bcc"] as const) {
    const contacts = email[field] ?? [];
    if (contacts.length > 0) lines.push({ field, text: contacts.map(formatContact).join(", ") });
  }
  return lines;
}

/** Single-cap monogram for avatar (first char only). */
export function monogram(email: Email): string {
  const source = displayName(email).trim();
  return (source[0] ?? "?").toUpperCase();
}

export function isMailbox(value: unknown): value is Mailbox {
  return typeof value === "string" && (MAILBOXES as readonly string[]).includes(value);
}
