/**
 * Sign-out leaves nothing of the account on disk, even with work still in flight.
 *
 * `signOut` erases the mail cache, the cursor and the address book. The defect these
 * cover is what happened next: a sync started before the sign-out still had responses
 * on the wire, and each one it got back was upserted, and then flushed, into the cache
 * that had just been erased. So signing out halfway through a first sync left that half
 * of the mailbox in `localStorage`, for whoever used the browser next.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailSession, gatedCache, localCache } from "./session";
import type { GoogleContactsSnapshot, GoogleContactsStore } from "../contacts/google";
import type { TokenSet } from "../gmail/dto";
import type { TokenStore } from "../gmail/tokens";
import type { Email } from "../model/email";
import type { Platform } from "../../platform/types";

/** A `localStorage` in memory, since this suite runs in Node. */
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

function email(gmailId: string): Email {
  return {
    id: Number.parseInt(gmailId.replace(/\D/g, ""), 10) || 1,
    gmailId,
    sender: "ada@example.com",
    subject: "the plan",
    body: "private words",
    receivedAt: 1,
    unread: true,
    mailbox: "inbox",
  } as unknown as Email;
}

function memoryTokens(initial: TokenSet | null): TokenStore {
  let current = initial;
  return {
    read: async () => current,
    write: async (tokens) => void (current = tokens),
    clear: async () => void (current = null),
  };
}

function memoryContacts() {
  let saved: GoogleContactsSnapshot | null = null;
  const store: GoogleContactsStore = {
    read: async () => saved,
    write: async (snapshot) => void (saved = snapshot),
    clear: async () => void (saved = null),
  };
  return { store, saved: () => saved };
}

function platform(tokens: TokenStore): Platform {
  return {
    tokenStore: () => tokens,
    credentialStore: () => ({ read: async () => null, write: async () => {}, clear: async () => {} }),
  } as unknown as Platform;
}

/** The cache the session hands its sync engine and backend. Private; read for the test. */
const engineCache = (session: GmailSession) =>
  (session as unknown as { cache: ReturnType<typeof localCache> }).cache;

let storage: Map<string, string>;
beforeEach(() => {
  storage = installLocalStorage();
  // Sign-out revokes the grant at Google; these tests are about the disk, not the wire.
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("signing out with a sync still in flight", () => {
  it("drops the sync's late writes instead of putting the mailbox back on disk", async () => {
    const raw = localCache();
    const session = new GmailSession(
      platform(memoryTokens({ accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 })),
      raw,
      memoryContacts().store,
    );
    const cache = engineCache(session);

    // The sync has written half the mailbox and recorded nothing yet.
    await cache.upsert([email("m1")]);
    await cache.flush();
    expect(storage.get("winnow.gmail.cache.messages")).toContain("private words");

    await session.signOut();
    expect(storage.has("winnow.gmail.cache.messages")).toBe(false);

    // …and then its next page comes back, and it does what a sync does with one.
    await cache.upsert([email("m2")]);
    await cache.replace([email("m3")]);
    await cache.write("history-9");
    await cache.flush();

    expect(storage.has("winnow.gmail.cache.messages")).toBe(false);
    expect(storage.has("winnow.gmail.cache.cursor")).toBe(false);
    expect(await raw.all()).toEqual([]);
  });

  it("drops a contacts refresh that lands after the sign-out", async () => {
    const contacts = memoryContacts();
    const session = new GmailSession(
      platform(memoryTokens({ accessToken: "a", expiresAt: Date.now() + 3_600_000 })),
      localCache(),
      contacts.store,
    );
    // The store the contacts sync writes through: the gated one.
    const store = (session.contacts as unknown as { options: { store: GoogleContactsStore } }).options.store;
    expect(store).not.toBe(contacts.store);
    await session.signOut();
    await store.write({ version: 3, saved: { people: {} }, other: { people: {} }, syncedAt: 2 });
    expect(contacts.saved()).toBeNull();
  });
});

describe("gatedCache", () => {
  it("passes writes through while open, and reads and clear always", async () => {
    let open = true;
    const raw = localCache("t");
    const gated = gatedCache(raw, () => open);
    await gated.upsert([email("a1")]);
    expect((await gated.all()).map((e) => e.gmailId)).toEqual(["a1"]);
    open = false;
    await gated.upsert([email("a2")]);
    await gated.remove(["a1"]);
    expect((await gated.all()).map((e) => e.gmailId)).toEqual(["a1"]);
    await gated.clear();
    expect(await gated.all()).toEqual([]);
  });
});
