/**
 * Offline saving and remote deletions, end to end through the session: a real
 * `GmailSession` over a real `localCache` and an in-memory offline store, talking to a
 * fake Gmail behind `fetch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailSession, OFFLINE_SAVE_KEY, RECONCILE_EVERY_MS, RECONCILE_KEY, localCache, reconcileDue } from "./session";
import { accountKey } from "./accounts";
import { LABEL, type GmailMessage, type TokenSet } from "../gmail/dto";
import type { TokenStore } from "../gmail/tokens";
import type { Platform } from "../../platform/types";
import { memoryOfflineStore } from "../offline/offlineStore";
import { OfflineDownloader } from "../offline/downloader";

const ACCOUNT = "acct1xx";

function installLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, v),
      removeItem: (k: string) => void backing.delete(k),
    },
  });
  return backing;
}

const b64url = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function message(id: string, labels: string[] = [LABEL.inbox], options: { attachment?: number; at?: number } = {}): GmailMessage {
  const parts = [
    { partId: "0", mimeType: "text/html", headers: [], body: { data: b64url(`<p>Body of ${id}</p>`), size: 20 } },
    ...(options.attachment !== undefined
      ? [
          {
            partId: "1",
            mimeType: "application/pdf",
            filename: `${id}.pdf`,
            headers: [{ name: "Content-Disposition", value: `attachment; filename="${id}.pdf"` }],
            body: { attachmentId: `att-${id}`, size: options.attachment },
          },
        ]
      : []),
  ];
  return {
    id,
    threadId: `t-${id}`,
    labelIds: labels,
    snippet: `snippet ${id}`,
    internalDate: String(options.at ?? Date.UTC(2026, 9, 1, 12, Number(id.replace(/\D/g, "")) || 0)),
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "From", value: `Sender <sender-${id}@example.com>` },
        { name: "Subject", value: `Subject ${id}` },
      ],
      parts,
    } as GmailMessage["payload"],
  };
}

/** A fake Gmail behind `fetch`. */
function fakeGmail(messages: GmailMessage[]) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const requests: string[] = [];
  let history: unknown[] = [];
  let historyExpired = false;
  let offline = false;
  let listAll: ((ids: string[]) => { ids: string[]; status?: number }) | null = null;

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  vi.stubGlobal("fetch", async (input: string) => {
    if (offline) throw new TypeError("Failed to fetch");
    const url = new URL(String(input));
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    requests.push(`${path}${url.search}`);
    if (path === "/profile") return json({ emailAddress: "me@example.com", historyId: "100" });
    if (path === "/history") {
      if (historyExpired) return json({ error: { code: 404 } }, 404);
      return json({ history, historyId: "101" });
    }
    if (path === "/messages") {
      if (url.searchParams.get("includeSpamTrash") === "true") {
        const all = [...byId.keys()];
        const answer = listAll ? listAll(all) : { ids: all };
        if (answer.status) return json({ error: { code: answer.status } }, answer.status);
        return json({ messages: answer.ids.map((id) => ({ id })) });
      }
      const q = url.searchParams.get("q") ?? "";
      const ids = [...byId.values()]
        .filter((m) => {
          const labels = m.labelIds ?? [];
          if (q === "in:inbox") return labels.includes(LABEL.inbox);
          if (q === "in:trash") return labels.includes(LABEL.trash);
          if (q === "in:spam") return labels.includes(LABEL.spam);
          if (q === "in:sent") return labels.includes(LABEL.sent);
          return !labels.includes(LABEL.inbox) && !labels.includes(LABEL.trash) && !labels.includes(LABEL.spam) && !labels.includes(LABEL.sent);
        })
        .map((m) => ({ id: m.id, threadId: m.threadId }));
      return json({ messages: ids });
    }
    const attachment = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (attachment) {
      if (!byId.has(attachment[1])) return json({ error: { code: 404 } }, 404);
      return json({ data: b64url(`bytes of ${attachment[2]}`), size: 10 });
    }
    const one = /^\/messages\/([^/]+)$/.exec(path);
    if (one) {
      const found = byId.get(decodeURIComponent(one[1]));
      if (!found) return json({ error: { code: 404, message: "Not Found" } }, 404);
      return json(found);
    }
    return json({ error: "unexpected" }, 400);
  });

  return {
    requests,
    /** Deleted at Gmail, permanently (no history record unless one is set). */
    expunge: (id: string) => byId.delete(id),
    /** A changed copy of a message (its labels), as Gmail now has it. */
    put: (m: GmailMessage) => void byId.set(m.id, m),
    setHistory: (records: unknown[]) => void (history = records),
    expireHistory: () => void (historyExpired = true),
    setOffline: (value: boolean) => void (offline = value),
    setListAll: (fn: typeof listAll) => void (listAll = fn),
  };
}

function memoryTokens(): TokenStore {
  let current: TokenSet | null = { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 };
  return { read: async () => current, write: async (t) => void (current = t), clear: async () => void (current = null) };
}

function platform(tokens: TokenStore): Platform {
  return {
    tokenStore: () => tokens,
    credentialStore: () => ({ read: async () => ({ clientId: "id" }), write: async () => {}, clear: async () => {} }),
    info: async () => ({ kind: "web" }),
  } as unknown as Platform;
}

const contacts = () => ({ read: async () => null, write: async () => {}, clear: async () => {} });

let storage: Map<string, string>;
beforeEach(() => {
  storage = installLocalStorage();
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "localStorage");
});

function setup(messages: GmailMessage[]) {
  const gmail = fakeGmail(messages);
  const offline = memoryOfflineStore();
  const cache = localCache(undefined, { account: ACCOUNT, offline, lifecycle: () => () => undefined });
  const session = new GmailSession(platform(memoryTokens()), cache, contacts(), { account: ACCOUNT, tokenStore: memoryTokens() });
  const backend = session.backend();
  return { gmail, offline, cache, session, backend };
}

const ids = (emails: { gmailId: string }[]) => emails.map((e) => e.gmailId).sort();

/** Download everything through the backend's own offline source, as the store does. */
async function downloadAll(backend: ReturnType<GmailSession["backend"]>, targets: () => { gmailId: string; receivedAt: number }[]) {
  const offline = backend.offline!;
  const run = new OfflineDownloader({
    store: offline.store,
    schedule: (task) => task(),
    source: { targets, body: offline.body, attachment: offline.attachment, gone: (id) => offline.gone([id]) },
  });
  await run.start();
  return run;
}

describe("saving the mailbox offline (the large-mailbox prompt's Save)", () => {
  it("the mailbox goes to the offline store, not localStorage, and a 1.5.5 copy moves over", async () => {
    // What 1.5.5 left in localStorage.
    const legacyKey = accountKey("winnow.gmail.cache.messages", ACCOUNT);
    storage.set(legacyKey, JSON.stringify([]));
    const { cache, offline, backend } = setup([message("m1"), message("m2")]);
    await backend.sync();
    await cache.flush();
    expect(storage.has(legacyKey)).toBe(false);
    const saved = JSON.parse((await offline.readMailbox()) ?? "[]") as { gmailId: string }[];
    expect(ids(saved)).toEqual(["m1", "m2"]);
  });

  it("downloads every body and the attachments under the cap; opening then needs no network", async () => {
    const big = 11 * 1024 * 1024;
    const { gmail, backend, offline, cache } = setup([message("m1", [LABEL.inbox], { attachment: 1000 }), message("m2", [LABEL.inbox], { attachment: big })]);
    const result = await backend.sync();
    expect(result.emails.every((e) => !e.bodyLoaded)).toBe(true);
    const all = await cache.all();
    const run = await downloadAll(backend, () => all.map((e) => ({ gmailId: e.gmailId, receivedAt: e.receivedAt })));
    expect(run.progress()).toMatchObject({ saved: 2, total: 2, state: "done" });
    expect(await offline.getFile("m1", "att-m1")).not.toBeNull();
    expect(await offline.getFile("m2", "att-m2")).toBeNull();

    gmail.setOffline(true);
    const loaded = await backend.loadMessage!("m2");
    expect(loaded.bodyHtml).toContain("Body of m2");
    const file = await backend.fetchAttachment("m1", "att-m1");
    expect(new TextDecoder().decode(file.bytes)).toBe("bytes of att-m1");
    expect(await backend.fetchBody("m1")).toContain("Body of m1");
  });

  it("a body already opened is not downloaded again", async () => {
    const { gmail, backend, cache } = setup([message("m1")]);
    await backend.sync();
    await backend.loadMessage!("m1");
    const before = gmail.requests.filter((r) => r.startsWith("/messages/m1")).length;
    const all = await cache.all();
    await downloadAll(backend, () => all.map((e) => ({ gmailId: e.gmailId, receivedAt: e.receivedAt })));
    expect(gmail.requests.filter((r) => r.startsWith("/messages/m1")).length).toBe(before);
  });

  it("remembers the answer per account, and signing out erases the downloads, the mailbox and the answer", async () => {
    const { backend, offline, session, cache } = setup([message("m1")]);
    await backend.sync();
    backend.offline!.setDecision("on");
    expect(backend.offline!.decision()).toBe("on");
    expect(storage.get(accountKey(OFFLINE_SAVE_KEY, ACCOUNT))).toBe("on");
    const all = await cache.all();
    await downloadAll(backend, () => all.map((e) => ({ gmailId: e.gmailId, receivedAt: e.receivedAt })));
    expect((await offline.stats()).messages).toBe(1);

    await session.signOut({ revoke: false });
    expect(await offline.stats()).toEqual({ messages: 0, bytes: 0 });
    expect(await offline.readMailbox()).toBeNull();
    expect(storage.has(accountKey(OFFLINE_SAVE_KEY, ACCOUNT))).toBe(false);
    expect(storage.has(accountKey(RECONCILE_KEY, ACCOUNT))).toBe(false);
  });

  it("a download still on the wire at sign-out writes nothing back", async () => {
    const { backend, offline, session } = setup([message("m1")]);
    await backend.sync();
    const body = await backend.offline!.body("m1");
    await session.signOut({ revoke: false });
    await backend.offline!.store.putBody({ gmailId: "m1", ...body, files: [], skipped: 0, bytes: 1, savedAt: 1 }, []);
    expect((await offline.stats()).messages).toBe(0);
  });
});

describe("mail deleted on the server", () => {
  async function synced(messages: GmailMessage[]) {
    const ctx = setup(messages);
    await ctx.backend.sync();
    const all = await ctx.cache.all();
    await downloadAll(ctx.backend, () => all.map((e) => ({ gmailId: e.gmailId, receivedAt: e.receivedAt })));
    return ctx;
  }

  it("history's messagesDeleted removes the message, its body and its attachments", async () => {
    const { gmail, backend, offline } = await synced([message("m1", [LABEL.inbox], { attachment: 10 }), message("m2")]);
    expect(await offline.getFile("m1", "att-m1")).not.toBeNull();
    gmail.expunge("m1");
    gmail.setHistory([{ id: "101", messagesDeleted: [{ message: { id: "m1", threadId: "t-m1" } }] }]);
    const result = await backend.sync();
    expect(ids(result.emails)).toEqual(["m2"]);
    expect(await offline.getBody("m1")).toBeNull();
    expect(await offline.getFile("m1", "att-m1")).toBeNull();
    expect(await offline.getBody("m2")).not.toBeNull();
  });

  it("Trash is a label, not a deletion; deleting from Trash is", async () => {
    const { gmail, backend, offline } = await synced([message("m1")]);
    gmail.setHistory([{ id: "101", labelsAdded: [{ message: { id: "m1" } }] }]);
    // Moved to Trash at Gmail: still here, body kept.
    gmail.put(message("m1", [LABEL.trash]));
    const result = await backend.sync();
    expect(result.emails.find((e) => e.gmailId === "m1")?.mailbox).toBe("trash");
    expect(await offline.getBody("m1")).not.toBeNull();

    // Then deleted forever from the Trash.
    gmail.expunge("m1");
    gmail.setHistory([{ id: "102", messagesDeleted: [{ message: { id: "m1" } }] }]);
    expect(ids((await backend.sync()).emails)).toEqual([]);
    expect(await offline.getBody("m1")).toBeNull();
  });

  it("a re-fetch that answers 404 removes it; one that fails on the network keeps it", async () => {
    const { gmail, backend, offline } = await synced([message("m1"), message("m2")]);
    gmail.expunge("m1");
    gmail.setHistory([{ id: "101", labelsRemoved: [{ message: { id: "m1" } }] }]);
    expect(ids((await backend.sync()).emails)).toEqual(["m2"]);
    expect(await offline.getBody("m1")).toBeNull();

    gmail.setOffline(true);
    gmail.setHistory([{ id: "102", labelsRemoved: [{ message: { id: "m2" } }] }]);
    await expect(backend.sync()).rejects.toThrow();
    gmail.setOffline(false);
    expect(await offline.getBody("m2")).not.toBeNull();
  });

  it("a history id too old for Gmail falls back to a full rebuild that drops what is gone", async () => {
    const { gmail, backend, offline } = await synced([message("m1"), message("m2")]);
    gmail.expunge("m2");
    gmail.expireHistory();
    expect(ids((await backend.sync()).emails)).toEqual(["m1"]);
    expect(await offline.getBody("m2")).toBeNull();
  });

  it("the daily reconciliation removes what history never reported, at most once a day", async () => {
    const { gmail, backend, offline } = await synced([message("m1"), message("m2"), message("m3")]);
    // The first (full) sync started the clock.
    expect(Number(storage.get(accountKey(RECONCILE_KEY, ACCOUNT)))).toBeGreaterThan(0);
    gmail.expunge("m3");
    gmail.setHistory([]);
    expect(ids((await backend.sync()).emails)).toEqual(["m1", "m2", "m3"]);

    // A day later (or a launch after a day): reconciled.
    storage.set(accountKey(RECONCILE_KEY, ACCOUNT), String(Date.now() - RECONCILE_EVERY_MS - 1));
    expect(ids((await backend.sync()).emails)).toEqual(["m1", "m2"]);
    expect(await offline.getBody("m3")).toBeNull();
    expect(gmail.requests.some((r) => r.includes("includeSpamTrash=true"))).toBe(true);
  });

  it("the reconciliation deletes nothing on a failed or partial listing", async () => {
    const messages = Array.from({ length: 22 }, (_, i) => message(`m${i}`));
    const { gmail, backend, offline } = await synced(messages);
    const old = () => storage.set(accountKey(RECONCILE_KEY, ACCOUNT), "0");
    gmail.setHistory([]);

    // An auth error while listing.
    old();
    gmail.setListAll(() => ({ ids: [], status: 403 }));
    expect((await backend.sync()).emails).toHaveLength(22);

    // A listing that came back with almost nothing, while the messages still exist.
    old();
    gmail.setListAll((all) => ({ ids: all.slice(0, 2) }));
    expect((await backend.sync()).emails).toHaveLength(22);
    expect((await offline.stats()).messages).toBe(22);

    // A network failure.
    old();
    gmail.setListAll(null);
    gmail.setOffline(true);
    await expect(backend.sync()).rejects.toThrow();
    gmail.setOffline(false);
    expect((await offline.stats()).messages).toBe(22);
  });
});

describe("reconcileDue", () => {
  it("is due with no record, after a day, and when the clock went backwards", () => {
    const now = 10 * RECONCILE_EVERY_MS;
    expect(reconcileDue(null, now)).toBe(true);
    expect(reconcileDue(now - 1000, now)).toBe(false);
    expect(reconcileDue(now - RECONCILE_EVERY_MS, now)).toBe(true);
    expect(reconcileDue(now + 5000, now)).toBe(true);
  });
});

