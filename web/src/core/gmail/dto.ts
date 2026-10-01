/**
 * The Gmail wire types.
 *
 * These mirror the API's JSON and nothing else. They are *not* the app's
 * `Email` type: a raw message has `labelIds`, an RFC 822 `payload` tree of
 * base64 blobs, and a header map. Converting one to the other is
 * `mapper.ts`'s job, and keeping the two apart means a Gmail API change lands
 * in one file rather than rippling through the classifier and the list.
 *
 * Every field is optional where the API omits it, because Gmail omits more than
 * its documentation admits — a message with no `payload` is a draft stub, and
 * a header may be absent entirely.
 */

/** The base URL every Gmail request is built from. */
export const GMAIL_API = "https://gmail.googleapis.com/gmail/v1";

/** Google's token endpoint, shared by the installed-app and web flows. */
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Where the user is sent to approve access. */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/**
 * One Gmail scope, deliberately.
 *
 * `gmail.modify` covers read, label changes and send. Asking for
 * `gmail.readonly` plus `gmail.send` plus `gmail.settings.basic` would produce
 * three consent screens' worth of warnings for the same access, and the user
 * would have no idea what they had agreed to.
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
  /** The build is missing something it needs — a client id, or a secret. */
  | "config"
  /**
   * Google accepted the request but refused the identity: a wrong secret, or a
   * client whose type forbids the flow it was asked to perform.
   *
   * Distinct from `config` because the fix is not the same. `config` means
   * "this was never built correctly"; this means "this was built for a different
   * client type", which for Winnow is usually a Desktop-app client configured
   * with a web redirect URI, or the reverse.
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
