/**
 * The request layer.
 *
 * Two behaviours: the single forced refresh after a 401, and the URLs the sync
 * engine depends on.
 */

import { describe, expect, it, vi } from "vitest";
import { GmailClient, MAX_PAGE_SIZE, type FetchLike } from "./client";
import { GmailError, GmailHttpError, LABEL, base64UrlDecode } from "./dto";

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };

/** A fetch stub that answers from a queue and records every call. */
function stubFetch(
  responses: { status: number; body?: string }[],
): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift() ?? { status: 200, body: "{}" };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => next.body ?? "",
    };
  };
  return { fetchImpl, calls };
}

const client = (fetchImpl: FetchLike, onUnauthorized?: () => Promise<string | null>) =>
  new GmailClient(async () => "token-1", { fetchImpl, onUnauthorized });

describe("GmailClient — the request", () => {
  it("sends the bearer token and returns the parsed body", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: '{"emailAddress":"a@b.c"}' }]);
    const profile = await client(fetchImpl).profile();
    expect(profile.emailAddress).toBe("a@b.c");
    expect(calls[0].url).toContain("/users/me/profile");
    expect(calls[0].init?.headers?.Authorization).toBe("Bearer token-1");
  });

  it("refuses to make a request with no session, without calling out", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200 }]);
    const anonymous = new GmailClient(async () => null, { fetchImpl });
    await expect(anonymous.profile()).rejects.toThrow(GmailError);
    expect(calls).toHaveLength(0);
  });

  it("reports a non-2xx with the status and the body", async () => {
    const { fetchImpl } = stubFetch([{ status: 400, body: '{"error":"bad"}' }]);
    await expect(client(fetchImpl).profile()).rejects.toThrow(GmailHttpError);
  });

  it("accepts an empty body rather than trying to parse one", async () => {
    // The label-modify endpoints answer 204; `JSON.parse("")` threw a SyntaxError
    // that surfaced to the user as a failed star.
    const { fetchImpl } = stubFetch([{ status: 204 }]);
    await expect(client(fetchImpl).setStarred("m1", true)).resolves.toBeUndefined();
  });

  it("url-encodes ids, because Gmail ids are opaque", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200 }]);
    await client(fetchImpl).message("a/b+c");
    expect(calls[0].url).toContain("/users/me/messages/a%2Fb%2Bc");
  });
});

describe("GmailClient — the one retry", () => {
  it("refreshes once and replays the request", async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 401 },
      { status: 200, body: '{"emailAddress":"a@b.c"}' },
    ]);
    const onUnauthorized = vi.fn(async () => "token-2");
    const profile = await client(fetchImpl, onUnauthorized).profile();

    expect(profile.emailAddress).toBe("a@b.c");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].init?.headers?.Authorization).toBe("Bearer token-2");
  });

  it("does not loop when the replay is also a 401", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 401 }, { status: 401 }]);
    const onUnauthorized = vi.fn(async () => "token-2");
    await expect(client(fetchImpl, onUnauthorized).profile()).rejects.toThrow(GmailHttpError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it("surfaces an expired session when the refresh returns nothing", async () => {
    const { fetchImpl } = stubFetch([{ status: 401 }]);
    await expect(client(fetchImpl, async () => null).profile()).rejects.toThrow(/expired/i);
  });

  it("treats a 401 as final when there is nothing to refresh with", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 401 }]);
    await expect(client(fetchImpl).profile()).rejects.toThrow(GmailHttpError);
    expect(calls).toHaveLength(1);
  });
});

describe("GmailClient — the verbs", () => {
  it("archives by leaving the inbox and nothing else", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 204 }]);
    await client(fetchImpl).archive("m1");
    expect(JSON.parse(calls[0].init!.body!)).toEqual({ removeLabelIds: [LABEL.inbox] });
  });

  it("refuses SENT and DRAFT before calling out, because Gmail rejects them with a 400", async () => {
    const { fetchImpl, calls } = stubFetch([]);
    await expect(client(fetchImpl).removeLabels("m1", [LABEL.inbox, LABEL.sent])).rejects.toBeInstanceOf(GmailError);
    await expect(client(fetchImpl).addLabels("m1", [LABEL.draft])).rejects.toBeInstanceOf(GmailError);
    expect(calls).toHaveLength(0);
  });

  it("marks read by removing the unread label, and unread by adding it", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 204 }, { status: 204 }]);
    const gmail = client(fetchImpl);
    await gmail.markRead("m1", true);
    await gmail.markRead("m1", false);
    expect(JSON.parse(calls[0].init!.body!)).toEqual({ removeLabelIds: [LABEL.unread] });
    expect(JSON.parse(calls[1].init!.body!)).toEqual({ addLabelIds: [LABEL.unread] });
  });

  it("restores to the inbox rather than to where it happened to be", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 204 }, { status: 204 }]);
    await client(fetchImpl).restore("m1");
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].init!.body!)).toEqual({ removeLabelIds: [LABEL.trash] });
    expect(JSON.parse(calls[1].init!.body!)).toEqual({ addLabelIds: [LABEL.inbox] });
  });

  it("not-spam is the mirror of spam", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 204 }, { status: 204 }]);
    await client(fetchImpl).markNotSpam("m1");
    expect(JSON.parse(calls[0].init!.body!)).toEqual({ removeLabelIds: [LABEL.spam] });
    expect(JSON.parse(calls[1].init!.body!)).toEqual({ addLabelIds: [LABEL.inbox] });
  });

  it("trashes by adding the label, because Gmail has no move", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 204 }]);
    await client(fetchImpl).trash("m1");
    expect(JSON.parse(calls[0].init!.body!)).toEqual({ addLabelIds: [LABEL.trash] });
  });

  it("passes the thread through on send, so a reply lands in the conversation", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: '{"id":"s1","threadId":"t1"}' }]);
    await client(fetchImpl).send("raw", "t1");
    expect(JSON.parse(calls[0].init!.body!)).toEqual({ raw: "cmF3", threadId: "t1" });
  });

  it("base64url-encodes the raw message, which is what the field requires", async () => {
    // Plain text in the JSON field is accepted for ASCII-only messages but 400s
    // on any non-ASCII header or body.
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: '{"id":"s1","threadId":"t1"}' }]);
    await client(fetchImpl).send("Réunion — Friday");
    const sent = JSON.parse(calls[0].init!.body!).raw as string;
    expect(sent).not.toMatch(/[+/=]/);
    expect(new TextDecoder().decode(base64UrlDecode(sent) ?? new Uint8Array())).toBe("Réunion — Friday");
  });

  it("omits the thread on a new conversation", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 200, body: '{"id":"s1","threadId":"t1"}' }]);
    await client(fetchImpl).send("raw");
    expect(JSON.parse(calls[0].init!.body!)).toEqual({ raw: "cmF3" });
  });
});

describe("GmailClient — the queries the sync engine relies on", () => {
  it("passes the page token through untouched", async () => {
    // The engine's pagination is driven entirely by `nextPageToken`; a mangled
    // token would silently truncate a mailbox.
    const { fetchImpl, calls } = stubFetch([{ status: 200 }, { status: 200 }]);
    const gmail = client(fetchImpl);
    await gmail.list("in:inbox", 200);
    await gmail.list("in:inbox", 200, "Cgt2aW5ib3g");
    expect(calls[0].url).not.toContain("pageToken");
    expect(calls[1].url).toContain("pageToken=Cgt2aW5ib3g");
  });

  it("asks for every history type, not just new mail", async () => {
    // Requesting `messageAdded` alone meant an archive, star, mark-read or delete
    // made elsewhere was never reported, so the incremental sync kept the stale
    // copy forever.
    const { fetchImpl, calls } = stubFetch([{ status: 200 }]);
    await client(fetchImpl).history("1234");
    const types = new URLSearchParams(calls[0].url.split("?")[1]).get("historyTypes")!.split(",");
    expect(types.sort()).toEqual(
      ["labelsAdded", "labelsRemoved", "messageAdded", "messagesDeleted"].sort(),
    );
  });

  it("clamps nothing itself — Gmail clamps silently, so the engine caps instead", () => {
    expect(MAX_PAGE_SIZE).toBe(200);
  });
});
