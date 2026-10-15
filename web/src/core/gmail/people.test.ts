/**
 * The People API wire layer.
 *
 * What the sync engine above relies on: the exact listings and fields asked for, the
 * sync token carried on every page, the expired-token and missing-scope refusals turned
 * into typed errors, and the same retry rules the Gmail client follows — paced by a
 * bucket of its own. Every request runs against a stub fetch and a sleep that records
 * instead of waiting.
 */

import { describe, expect, it } from "vitest";
import { QuotaBucket, type FetchLike } from "./client";
import { GmailError, GmailHttpError } from "./dto";
import {
  CONTACTS_SCOPE,
  CONTACT_SCOPES,
  ExpiredSyncToken,
  OTHER_CONTACTS_SCOPE,
  PEOPLE_API,
  PEOPLE_PAGE_SIZE,
  PeopleClient,
  PEOPLE_API_LIBRARY_URL,
  PeopleApiDisabled,
  PeopleScopeMissing,
  apiActivationUrl,
  contactsFailureNotice,
  hasContactScopes,
  isApiDisabled,
  isExpiredSyncToken,
  isScopeMissing,
} from "./people";

type Call = { url: string; headers?: Record<string, string> };

function stubFetch(responses: { status: number; body?: string }[]): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers });
    const next = queue.shift() ?? { status: 200, body: "{}" };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body ?? "",
    };
  };
  return { fetchImpl, calls };
}

/**
 * A bucket that never waits for real: its clock moves a minute every time it is read,
 * so even a drained bucket is full again by the next request.
 */
const freeBucket = () => {
  let clock = 0;
  return new QuotaBucket(1_000_000, () => (clock += 60_000), async () => {}, 1_000_000);
};

function client(fetchImpl: FetchLike, extra: { onUnauthorized?: () => Promise<string | null>; sleeps?: number[] } = {}) {
  return new PeopleClient(async () => "token-1", {
    fetchImpl,
    bucket: freeBucket(),
    onUnauthorized: extra.onUnauthorized,
    sleep: async (ms) => {
      extra.sleeps?.push(ms);
    },
  });
}

const params = (url: string) => new URL(url).searchParams;

describe("hasContactScopes — both or nothing", () => {
  it("is true only when both contact scopes are on the token", () => {
    const gmail = "https://www.googleapis.com/auth/gmail.modify";
    expect(hasContactScopes(`${gmail} ${CONTACTS_SCOPE} ${OTHER_CONTACTS_SCOPE}`)).toBe(true);
    expect(hasContactScopes(`${OTHER_CONTACTS_SCOPE}  ${CONTACTS_SCOPE}`)).toBe(true);
  });

  it("treats a half grant as no grant, so the opt-in is offered again", () => {
    expect(hasContactScopes(`https://www.googleapis.com/auth/gmail.modify ${CONTACTS_SCOPE}`)).toBe(false);
    expect(hasContactScopes(OTHER_CONTACTS_SCOPE)).toBe(false);
  });

  it("is false for a missing scope string", () => {
    expect(hasContactScopes(undefined)).toBe(false);
    expect(hasContactScopes(null)).toBe(false);
    expect(hasContactScopes("")).toBe(false);
  });

  it("asks for exactly the two read-only scopes", () => {
    expect(CONTACT_SCOPES).toEqual([
      "https://www.googleapis.com/auth/contacts.readonly",
      "https://www.googleapis.com/auth/contacts.other.readonly",
    ]);
  });
});

describe("PeopleClient — the listings", () => {
  it("lists saved contacts with names and addresses, asking for a sync token", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        status: 200,
        body: JSON.stringify({
          connections: [{ resourceName: "people/c1" }],
          nextPageToken: "p2",
        }),
      },
    ]);
    const page = await client(fetchImpl).list("saved");
    expect(calls[0].url.startsWith(`${PEOPLE_API}/people/me/connections?`)).toBe(true);
    const query = params(calls[0].url);
    expect(query.get("personFields")).toBe("names,emailAddresses,photos");
    expect(query.get("pageSize")).toBe(String(PEOPLE_PAGE_SIZE));
    expect(query.get("requestSyncToken")).toBe("true");
    expect(query.has("syncToken")).toBe(false);
    expect(calls[0].headers?.Authorization).toBe("Bearer token-1");
    expect(page).toEqual({ people: [{ resourceName: "people/c1" }], nextPageToken: "p2", nextSyncToken: undefined });
  });

  it("lists other contacts with a read mask, not person fields", async () => {
    const { fetchImpl, calls } = stubFetch([
      {
        status: 200,
        body: JSON.stringify({ otherContacts: [{ resourceName: "otherContacts/c9" }], nextSyncToken: "s1" }),
      },
    ]);
    const page = await client(fetchImpl).list("other");
    expect(calls[0].url.startsWith(`${PEOPLE_API}/otherContacts?`)).toBe(true);
    const query = params(calls[0].url);
    expect(query.get("readMask")).toBe("names,emailAddresses,photos");
    expect(query.has("personFields")).toBe(false);
    expect(query.get("requestSyncToken")).toBe("true");
    expect(page.people).toHaveLength(1);
    expect(page.nextSyncToken).toBe("s1");
  });

  it("carries the sync token and the page token together on a paged incremental listing", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: "{}" }, { status: 200, body: "{}" }]);
    const people = client(fetchImpl);
    await people.list("saved", { syncToken: "tok", pageToken: "p3" });
    await people.list("other", { syncToken: "tok2" });
    expect(params(calls[0].url).get("syncToken")).toBe("tok");
    expect(params(calls[0].url).get("pageToken")).toBe("p3");
    expect(calls[0].url).toContain("/people/me/connections");
    expect(params(calls[1].url).get("syncToken")).toBe("tok2");
    expect(calls[1].url).toContain("/otherContacts");
  });

  it("returns an empty page for an empty body rather than undefined", async () => {
    const { fetchImpl } = stubFetch([{ status: 200, body: "{}" }]);
    expect(await client(fetchImpl).list("saved")).toEqual({
      people: [],
      nextPageToken: undefined,
      nextSyncToken: undefined,
    });
  });
});

describe("PeopleClient — refusals", () => {
  it("turns EXPIRED_SYNC_TOKEN into ExpiredSyncToken, whatever the status", async () => {
    const body = JSON.stringify({
      error: {
        code: 400,
        status: "FAILED_PRECONDITION",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "EXPIRED_SYNC_TOKEN" }],
      },
    });
    const { fetchImpl } = stubFetch([{ status: 400, body }]);
    await expect(client(fetchImpl).list("saved", { syncToken: "old" })).rejects.toBeInstanceOf(ExpiredSyncToken);
  });

  it("reads a bare 410 GONE as an expired token too", async () => {
    const { fetchImpl } = stubFetch([{ status: 410, body: "" }]);
    await expect(client(fetchImpl).list("other", { syncToken: "old" })).rejects.toBeInstanceOf(ExpiredSyncToken);
  });

  it("turns an insufficient-scope 403 into PeopleScopeMissing", async () => {
    const body = JSON.stringify({
      error: { code: 403, status: "PERMISSION_DENIED", details: [{ reason: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }] },
    });
    const { fetchImpl } = stubFetch([{ status: 403, body }]);
    await expect(client(fetchImpl).list("saved")).rejects.toBeInstanceOf(PeopleScopeMissing);
  });

  it("passes any other failure through as an HTTP error", async () => {
    const { fetchImpl } = stubFetch([{ status: 500, body: "boom" }]);
    await expect(client(fetchImpl).list("saved")).rejects.toBeInstanceOf(GmailHttpError);
  });

  it("refuses to call out with no session", async () => {
    const { fetchImpl, calls } = stubFetch([]);
    const anonymous = new PeopleClient(async () => null, { fetchImpl, bucket: freeBucket() });
    await expect(anonymous.list("saved")).rejects.toBeInstanceOf(GmailError);
    expect(calls).toHaveLength(0);
  });

  it("classifies the bodies it is handed", () => {
    expect(isExpiredSyncToken(400, '{"error":{"message":"Sync token is expired. Clear local cache and retry call without the sync token."}}')).toBe(true);
    expect(isExpiredSyncToken(400, '{"error":{"message":"Invalid personFields"}}')).toBe(false);
    expect(isScopeMissing(403, "Request had insufficient authentication scopes.")).toBe(true);
    expect(isScopeMissing(403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}')).toBe(false);
    expect(isScopeMissing(401, "ACCESS_TOKEN_SCOPE_INSUFFICIENT")).toBe(false);
  });
});

describe("PeopleClient — retries and pacing", () => {
  it("retries a 429 with backoff, draining its bucket, then succeeds", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = stubFetch([
      { status: 429, body: "" },
      { status: 200, body: '{"connections":[]}' },
    ]);
    await client(fetchImpl, { sleeps }).list("saved");
    expect(calls).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
  });

  it("retries a quota 403 but not a permissions 403", async () => {
    const quota = JSON.stringify({ error: { errors: [{ reason: "rateLimitExceeded" }] } });
    const { fetchImpl, calls } = stubFetch([
      { status: 403, body: quota },
      { status: 200, body: "{}" },
    ]);
    await client(fetchImpl).list("other");
    expect(calls).toHaveLength(2);

    const denied = stubFetch([{ status: 403, body: "insufficient authentication scopes" }]);
    await expect(client(denied.fetchImpl).list("other")).rejects.toBeInstanceOf(PeopleScopeMissing);
    expect(denied.calls).toHaveLength(1);
  });

  it("forces one token refresh after a 401 and retries with the new token", async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 401, body: "" },
      { status: 200, body: "{}" },
    ]);
    let refreshed = 0;
    await client(fetchImpl, {
      onUnauthorized: async () => {
        refreshed += 1;
        return "token-2";
      },
    }).list("saved");
    expect(refreshed).toBe(1);
    expect(calls[1].headers?.Authorization).toBe("Bearer token-2");
  });

  it("says the session is gone when the refresh produces nothing", async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: "" }]);
    const error = await client(fetchImpl, { onUnauthorized: async () => null })
      .list("saved")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GmailError);
    expect((error as GmailError).needsReauth).toBe(true);
  });

  it("charges one unit of its own bucket per request", async () => {
    const taken: number[] = [];
    let clock = 0;
    const bucket = new QuotaBucket(60, () => (clock += 60_000), async () => {}, 20);
    const spy = bucket.take.bind(bucket);
    bucket.take = (cost: number) => {
      taken.push(cost);
      return spy(cost);
    };
    const { fetchImpl } = stubFetch([{ status: 200 }, { status: 200 }]);
    const people = new PeopleClient(async () => "t", { fetchImpl, bucket });
    await people.list("saved");
    await people.list("other");
    expect(taken).toEqual([1, 1]);
  });
});

describe("the People API switched off in the user's Cloud project", () => {
  // Google's response, trimmed: a 403 PERMISSION_DENIED with a SERVICE_DISABLED reason
  // and the project's own enable link in the metadata.
  const disabled = JSON.stringify({
    error: {
      code: 403,
      message:
        "People API has not been used in project 123456 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=123456 then retry.",
      status: "PERMISSION_DENIED",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "SERVICE_DISABLED",
          metadata: { activationUrl: "https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=123456" },
        },
      ],
    },
  });

  it("is told apart from a missing scope and from a rate limit", () => {
    expect(isApiDisabled(403, disabled)).toBe(true);
    expect(isScopeMissing(403, disabled)).toBe(false);
    expect(isApiDisabled(403, JSON.stringify({ error: { errors: [{ reason: "accessNotConfigured" }] } }))).toBe(true);
    expect(isApiDisabled(403, JSON.stringify({ error: { message: "Request had insufficient authentication scopes." } }))).toBe(false);
    expect(isApiDisabled(500, disabled)).toBe(false);
  });

  it("carries Google's enable link for the project", () => {
    expect(apiActivationUrl(disabled)).toBe(
      "https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=123456",
    );
  });

  it("finds the link in the prose when the metadata is missing", () => {
    const body = JSON.stringify({ error: { message: "Enable it by visiting https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=9 then retry." } });
    expect(apiActivationUrl(body)).toBe("https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=9");
  });

  it("never hands back a link to anywhere but Google's console", () => {
    const body = JSON.stringify({ error: { details: [{ metadata: { activationUrl: "https://evil.example/apis" } }], message: "x" } });
    expect(apiActivationUrl(body)).toBeNull();
    expect(apiActivationUrl("not json http://console.developers.google.com/x")).toBeNull();
  });

  it("is thrown by the client as its own error, not a bare HTTP failure", async () => {
    const { fetchImpl } = stubFetch([{ status: 403, body: disabled }]);
    const failure = await client(fetchImpl).list("saved").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PeopleApiDisabled);
    expect((failure as PeopleApiDisabled).activationUrl).toContain("project=123456");
  });

  it("becomes a notice the user can act on, with a fallback link", () => {
    const notice = contactsFailureNotice(new PeopleApiDisabled(null));
    expect(notice?.message).toMatch(/People API is turned off/);
    expect(notice?.url).toBe(PEOPLE_API_LIBRARY_URL);
    expect(contactsFailureNotice(new PeopleApiDisabled("https://console.cloud.google.com/x"))?.url).toBe("https://console.cloud.google.com/x");
  });

  it("is recognised by name after crossing a boundary", () => {
    const crossed = Object.assign(new Error("off"), { name: "PeopleApiDisabled" });
    expect(contactsFailureNotice(crossed)).toEqual({ message: "off", url: PEOPLE_API_LIBRARY_URL });
  });

  it("stays quiet for failures that are not the user's to fix", () => {
    expect(contactsFailureNotice(new GmailHttpError(503, "busy"))).toBeNull();
    expect(contactsFailureNotice(new PeopleScopeMissing())).toBeNull();
    expect(contactsFailureNotice("offline")).toBeNull();
  });
});
