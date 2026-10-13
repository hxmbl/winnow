/**
 * The People API client: the two listings Gmail itself suggests recipients from.
 *
 *   - **Saved contacts** — `people.connections.list`, under `contacts.readonly`. The
 *     people the user deliberately put in their address book.
 *   - **Other contacts** — `otherContacts.list`, under `contacts.other.readonly`. The
 *     addresses Google remembers because the user wrote to them, which is most of what
 *     Gmail's own To field offers.
 *
 * Neither scope is asked for at sign-in. They are added later, through incremental
 * consent (`GmailSession.grantContacts`), and every call here assumes nothing about
 * whether that has happened: a missing grant comes back as `PeopleScopeMissing`, which
 * the caller turns into "offer the opt-in again" rather than an error banner.
 *
 * Same wire rules as `client.ts`, deliberately sharing its helpers: a 429 or a quota 403
 * is retried with the same bounded backoff, a 401 gets one forced refresh, and every
 * request waits on a token bucket. The bucket is *not* the Gmail one — the People API
 * has its own per-user quota, counted in requests rather than Gmail units, so pacing it
 * against Gmail's 4,800 units a minute would be measuring with the wrong ruler.
 */

import { GmailError, GmailHttpError } from "./dto";
import {
  MAX_RETRIES,
  QuotaBucket,
  backoffMs,
  isRateLimited,
  type FetchLike,
  type Sleep,
  type TokenProvider,
} from "./client";

/** The People API's base URL. Covered by the desktop CSP's `*.googleapis.com`. */
export const PEOPLE_API = "https://people.googleapis.com/v1";

/** Saved contacts: `people.connections.list`. */
export const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.readonly";

/** "Other contacts" — people the user has written to: `otherContacts.list`. */
export const OTHER_CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts.other.readonly";

/** Both, in the order they are requested. Neither is part of the sign-in grant. */
export const CONTACT_SCOPES: readonly string[] = [CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE];

/**
 * Whether a token's `scope` string carries every contact scope.
 *
 * Both or nothing: Google's consent screen lets the user untick one of the two, and a
 * grant with saved contacts but not other contacts would make half the feature silently
 * fail with a 403 on every refresh. Treated as "not granted" so the opt-in is offered
 * again rather than a partial grant being used.
 */
export function hasContactScopes(scope: string | undefined | null): boolean {
  if (!scope) return false;
  const granted = new Set(scope.split(/\s+/).filter(Boolean));
  return CONTACT_SCOPES.every((wanted) => granted.has(wanted));
}

/** The People API's maximum page size for both listings. */
export const PEOPLE_PAGE_SIZE = 1000;

/**
 * Read requests a minute, per user, and the burst allowed.
 *
 * Google's default per-user read quota is 90 a minute; 60 leaves room for another tab
 * or device. A large address book is one or two requests a listing anyway — the pacing
 * matters for the retry loop, not the happy path.
 */
const PEOPLE_REQUESTS_PER_MINUTE = 60;
const PEOPLE_BURST = 20;

// ── Wire types ──────────────────────────────────────────────────────────────

type FieldMetadata = { primary?: boolean };

export type PeoplePerson = {
  /** `people/c123` for a saved contact, `otherContacts/c456` for an other contact. */
  resourceName: string;
  /** On an incremental listing, `deleted: true` is how a removal is reported. */
  metadata?: { deleted?: boolean };
  names?: { displayName?: string; metadata?: FieldMetadata }[];
  emailAddresses?: { value?: string; metadata?: FieldMetadata }[];
};

/** Which listing, by the name the rest of the app uses for it. */
export type PeopleSource = "saved" | "other";

/** One page of either listing, normalised so the sync engine has one shape to fold. */
export type PeoplePage = {
  people: PeoplePerson[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

type ListOptions = { pageToken?: string; syncToken?: string };

type ListResponse = {
  connections?: PeoplePerson[];
  otherContacts?: PeoplePerson[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

/**
 * Where each listing lives. The two differ only in path, in what the field list is
 * called, and in the key the page's people arrive under.
 */
const LISTINGS: Record<PeopleSource, { path: string; fieldsParam: string; key: "connections" | "otherContacts" }> = {
  saved: { path: "/people/me/connections", fieldsParam: "personFields", key: "connections" },
  other: { path: "/otherContacts", fieldsParam: "readMask", key: "otherContacts" },
};

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * The sync token is too old (Google keeps them for about a week) or otherwise refused.
 *
 * Its own class because the remedy is mechanical — forget the token and list everything
 * again — and the sync engine has to tell it apart from every other failure without
 * reading prose.
 */
export class ExpiredSyncToken extends GmailError {
  constructor(message = "The contacts sync token has expired.") {
    super(message, 410, "unknown");
    this.name = "ExpiredSyncToken";
  }
}

/**
 * The token does not carry the scope this listing needs.
 *
 * The user revoked access at myaccount.google.com, or unticked a box on the consent
 * screen. Not an error worth a banner: the opt-in is simply offered again.
 */
export class PeopleScopeMissing extends GmailError {
  constructor(message = "Winnow does not have access to your Google contacts.") {
    super(message, 403, "unknown");
    this.name = "PeopleScopeMissing";
  }
}

/**
 * Whether a response is Google refusing a sync token.
 *
 * Google documents the refusal as an error carrying `EXPIRED_SYNC_TOKEN` in its
 * `ErrorInfo.reason`, and it has been seen both as a 400 FAILED_PRECONDITION and as a
 * 410 GONE. The reason is the reliable half, so it is matched in the body whatever the
 * status; a bare 410 is also read as expiry, because GONE on a listing has no other
 * meaning.
 */
export function isExpiredSyncToken(status: number, body: string): boolean {
  if (body.includes("EXPIRED_SYNC_TOKEN")) return true;
  if (status === 410) return true;
  // The older wording, before ErrorInfo reasons were attached.
  return status === 400 && /sync token is expired/i.test(body);
}

/** Whether a 403 is a missing scope rather than a quota or a policy refusal. */
export function isScopeMissing(status: number, body: string): boolean {
  if (status !== 403) return false;
  return /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient(?:Permissions| authentication scopes)/i.test(body);
}

// ── The client ──────────────────────────────────────────────────────────────

type PeopleClientOptions = {
  fetchImpl?: FetchLike;
  /** One forced refresh after a 401, exactly as `GmailClient` does. */
  onUnauthorized?: () => Promise<string | null>;
  bucket?: QuotaBucket;
  now?: () => number;
  sleep?: Sleep;
};

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PeopleClient {
  private readonly fetchImpl: FetchLike;
  private readonly onUnauthorized: (() => Promise<string | null>) | undefined;
  private readonly sleep: Sleep;
  private readonly bucket: QuotaBucket;

  constructor(
    private readonly tokenProvider: TokenProvider,
    options: PeopleClientOptions = {},
  ) {
    const globalFetch = globalThis.fetch?.bind(globalThis) as FetchLike | undefined;
    const impl = options.fetchImpl ?? globalFetch;
    if (!impl) throw new Error("no fetch implementation available");
    this.fetchImpl = impl;
    this.onUnauthorized = options.onUnauthorized;
    this.sleep = options.sleep ?? realSleep;
    this.bucket =
      options.bucket ??
      new QuotaBucket(PEOPLE_REQUESTS_PER_MINUTE, options.now, this.sleep, PEOPLE_BURST);
  }

  /**
   * One GET: paced, retried on rate limits, refreshed once on a 401.
   *
   * Every request costs one unit of the People bucket. The expired-token and
   * missing-scope cases are classified here, at the wire, so the engine above sees a
   * typed error rather than a status code.
   */
  private async get<T>(pathAndQuery: string): Promise<T> {
    const token = await this.tokenProvider();
    if (!token) throw new GmailError("Not signed in to Google.", 401, "reauth_required");

    const url = `${PEOPLE_API}${pathAndQuery}`;
    const send = async (bearer: string) => {
      for (let attempt = 0; ; attempt += 1) {
        await this.bucket.take(1);
        const response = await this.fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${bearer}` },
        });
        const text = await response.text();
        if (!isRateLimited(response.status, text) || attempt >= MAX_RETRIES) {
          return { response, text };
        }
        this.bucket.drain();
        await this.sleep(backoffMs(attempt));
      }
    };

    let { response, text } = await send(token);

    if (response.status === 401 && this.onUnauthorized) {
      const refreshed = await this.onUnauthorized();
      if (!refreshed) {
        throw new GmailError("Your Google session has expired. Sign in again.", 401, "reauth_required");
      }
      ({ response, text } = await send(refreshed));
    }

    if (!response.ok) {
      if (isExpiredSyncToken(response.status, text)) throw new ExpiredSyncToken();
      if (isScopeMissing(response.status, text)) throw new PeopleScopeMissing();
      throw new GmailHttpError(response.status, text);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * One page of either listing.
   *
   * `requestSyncToken` on every page, because Google only hands the token back on the
   * last one. A paged incremental listing repeats the same `syncToken` on every page,
   * which is what the API requires.
   */
  async list(source: PeopleSource, options: ListOptions = {}): Promise<PeoplePage> {
    const listing = LISTINGS[source];
    const params = new URLSearchParams({
      [listing.fieldsParam]: "names,emailAddresses",
      pageSize: String(PEOPLE_PAGE_SIZE),
      requestSyncToken: "true",
    });
    if (options.pageToken) params.set("pageToken", options.pageToken);
    if (options.syncToken) params.set("syncToken", options.syncToken);
    const body = await this.get<ListResponse>(`${listing.path}?${params}`);
    return {
      people: body[listing.key] ?? [],
      nextPageToken: body.nextPageToken,
      nextSyncToken: body.nextSyncToken,
    };
  }
}
