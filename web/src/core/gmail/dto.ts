/**
 * The Gmail wire types.
 *
 * These mirror the API's JSON and nothing else. They are *not* the app's
 * `Email` type: conversion happens in `mapper.ts`, so a Gmail API change lands
 * in one file rather than rippling through the classifier and the list.
 *
 * Fields are optional where the API omits them — e.g., a message with no
 * `payload` is a draft stub, and a header may be absent entirely.
 */

/** The base URL every Gmail request is built from. */
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

/** Google's token endpoint, shared by the installed-app and web flows. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Where the user is sent to approve access. */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * base64url, per RFC 4648 §5: `+` → `-`, `/` → `_`, padding stripped.
 *
 * Every base64url operation in the Gmail layer goes through these two, because
 * the alphabet is the wire format: `messages.send`'s `raw` field, message body
 * blobs and attachment payloads all arrive URL-safe, while a
 * `Content-Transfer-Encoding: base64` body inside a message must not be.
 */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode base64url back to bytes.
 *
 * Returns `null` rather than throwing for input `atob` rejects: a message body
 * becomes `""` and keeps its headers, a `Message-ID` encoded word is left alone
 * rather than deleted, and an attachment yields no bytes instead of an exception
 * inside a download.
 */
export function base64UrlDecode(text: string): Uint8Array | null {
  try {
    const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * One Gmail scope, deliberately.
 *
 * `gmail.modify` covers read, label changes and send — simpler consent than
 * requesting separate scopes for read, send and settings.
 */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

/** Gmail's own labels, which are how the sync engine buckets messages. */
export const LABEL = {
  inbox: "INBOX",
  spam: "SPAM",
  trash: "TRASH",
  sent: "SENT",
  draft: "DRAFT",
  important: "IMPORTANT",
  starred: "STARRED",
  unread: "UNREAD",
  promotions: "CATEGORY_PROMOTIONS",
  updates: "CATEGORY_UPDATES",
  social: "CATEGORY_SOCIAL",
  forums: "CATEGORY_FORUMS",
  receipts: "CATEGORY_RECEIPTS",
} as const;

export type GmailProfile = {
  emailAddress: string;
  historyId: string;
  messagesTotal?: number;
};

export type GmailListResponse = {
  messages?: { id: string; threadId: string }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

export type GmailHeader = {
  name: string;
  value: string;
};

/** One MIME part. Gmail nests these into a tree. */
export type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: {
    attachmentId?: string;
    /** base64url, possibly chunked. */
    data?: string;
    size?: number;
  };
  parts?: GmailPart[];
};

export type GmailMessage = {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  /** Estimated size in bytes, reported in every format. */
  sizeEstimate?: number;
  payload?: GmailPart;
};

export type GmailAttachmentResponse = {
  size: number;
  data?: string;
};

export type GmailSendResponse = {
  id: string;
  threadId: string;
  labelIds?: string[];
};

export type GmailHistoryRecord = {
  id: string;
  messages?: { id: string; threadId?: string }[];
  messagesAdded?: { message: { id: string; threadId?: string } }[];
  messagesDeleted?: { id: string; threadId?: string }[];
  labelsAdded?: { message: { id: string; threadId?: string }; labelIds: string[] }[];
  labelsRemoved?: { message: { id: string; threadId?: string }; labelIds: string[] }[];
};

export type GmailHistoryResponse = {
  history?: GmailHistoryRecord[];
  historyId?: string;
  nextPageToken?: string;
};

/** The token pair. `refresh_token` is absent on a re-authorisation. */
export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. Computed locally, never read from the response. */
  expiresAt: number;
  scope?: string;
};

/** Why an OAuth attempt failed, in terms the user can act on. */
export type AuthErrorKind =
  | "declined"
  | "state_mismatch"
  | "reauth_required"
  | "network"
  | "timeout"
  /** The build is missing something it needs — a client id, redirect URI or secret. */
  | "config"
  /**
   * Google accepted the request but refused the identity: a wrong secret, or a
   * client whose type forbids the flow it was asked to perform (e.g., a Desktop
   * client misconfigured with a web redirect URI, or vice versa).
   */
  | "invalid_client"
  | "unknown";

export class GmailError extends Error {
  readonly status: number;
  readonly kind: AuthErrorKind;

  constructor(message: string, status = 0, kind: AuthErrorKind = "unknown") {
    super(message);
    this.name = "GmailError";
    this.status = status;
    this.kind = kind;
  }

  /** True when re-authorising is the only way forward. */
  get needsReauth(): boolean {
    return this.kind === "reauth_required";
  }
}

/** A message that could not be fetched, with enough context to retry it. */
export class GmailHttpError extends GmailError {
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Gmail returned ${status}: ${body.slice(0, 200)}`, status, "unknown");
    this.name = "GmailHttpError";
    this.body = body;
  }
}
