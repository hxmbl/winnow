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

/** The media upload endpoint, for a message too big to send as JSON. Same host. */
export const GMAIL_UPLOAD_API = "https://gmail.googleapis.com/upload/gmail/v1";

/** Google's token endpoint, shared by the installed-app and web flows. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Google's revocation endpoint: takes one token in a form body and ends its grant. */
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

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

/**
 * The narrowest scope that allows drafts (`users.drafts.*`): what the drafts opt-in asks
 * for when a grant lacks every scope in `DRAFT_SCOPES`.
 */
export const COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";

/**
 * Any one of these lets Winnow create, update, send and delete drafts. The sign-in grant
 * (`gmail.modify`) is one of them, so a normal session never needs to ask.
 */
export const DRAFT_SCOPES: readonly string[] = [
  COMPOSE_SCOPE,
  GMAIL_SCOPE,
  "https://mail.google.com/",
];

/**
 * Whether a token's `scope` string allows drafts.
 *
 * A token with no `scope` recorded counts as allowed: every Winnow sign-in asks for
 * `gmail.modify`, Google grants a single requested scope whole or not at all, and a
 * grant that turns out not to carry it is caught where it matters — the API answers 403
 * and the composer says "Drafts need permission" (see `DraftsScopeMissing`).
 */
export function hasDraftScopes(scope: string | undefined | null): boolean {
  if (scope === undefined || scope === null) return true;
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return DRAFT_SCOPES.some((wanted) => granted.has(wanted));
}

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

/** A `users.drafts` resource, as create, update and get return it. */
export type GmailDraft = {
  id: string;
  message?: { id?: string; threadId?: string; labelIds?: string[] };
};

/** `drafts.get?format=full`: the draft's id and its whole message. */
export type GmailFullDraft = {
  id: string;
  message?: GmailMessage;
};

/** `drafts.list`: ids only, the message id changing whenever the draft is saved. */
export type GmailDraftList = {
  drafts?: { id: string; message?: { id?: string; threadId?: string } }[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
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
  /** Gmail sends `{ message: {…} }`, like the other three; `id` is the pre-1.5.6 test shape. */
  messagesDeleted?: { message?: { id: string; threadId?: string }; id?: string }[];
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
  /**
   * The OAuth client the refresh token was issued to, when it is not the main client:
   * set by a native Android sign-in, whose code belongs to the Web application client
   * named as `serverClientId`. Google refreshes a token only for the client it was
   * issued to. Absent means the main client.
   */
  clientId?: string;
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

/**
 * A token request that never got an HTTP response: `fetch` itself rejected (offline,
 * DNS, or — on Android — the WebView was paused behind the browser when the request
 * went out). Distinct from every rejection Google *answers* with, because only this
 * one is safe to send again: an answered `invalid_grant` means the code is spent.
 */
export class GoogleUnreachable extends GmailError {
  constructor(message: string) {
    super(message, 0, "network");
    this.name = "GoogleUnreachable";
  }
}

/** A message that could not be fetched, with enough context to retry it. */
/**
 * The grant does not allow drafts: Google answered 403 with an insufficient-scope
 * reason, or the token's own scope list says so. The composer offers the opt-in.
 */
export class DraftsScopeMissing extends GmailError {
  constructor(message = "Drafts need permission.") {
    super(message, 403, "unknown");
    this.name = "DraftsScopeMissing";
  }
}

/** Whether an API refusal is about the grant's scopes rather than anything else. */
export function isInsufficientScope(status: number, body: string): boolean {
  return status === 403 && /insufficient(Permissions|_?scope)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(body);
}

export class GmailHttpError extends GmailError {
  readonly body: string;

  constructor(status: number, body: string) {
    super(`Gmail returned ${status}: ${body.slice(0, 200)}`, status, "unknown");
    this.name = "GmailHttpError";
    this.body = body;
  }
}
