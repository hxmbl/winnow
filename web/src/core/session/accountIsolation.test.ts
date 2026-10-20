/**
 * Multi-account (1.4.0): no account's cache, drafts, learning or tokens are readable
 * from another's; signing out of one leaves the others exactly as they were; adding an
 * account that is already here switches to it; and 1.3.5's single account moves into its
 * namespace without a new sign-in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localCache } from "./session";
import { createSessionBridge, ACCOUNTS_FULL_MESSAGE } from "./bridge";
import {
  ACCOUNTS_STORAGE_KEY,
  ACCOUNT_SCOPED_KEYS,
  AccountRegistry,
  MAX_ACCOUNTS,
  accountKey,
  loadAccounts,
  persistAccounts,
  saveAccounts,
  scopedStorage,
  webTokenKey,
} from "./accounts";
import { MIGRATION_ID_KEY, adoptDeviceLearning, migrateToAccounts } from "./accountMigration";
import { loadAccountState, persistAccountState, wipeAccountStorage } from "../store/accountState";
import { localStorageTokenStore, type TokenStore } from "../gmail/tokens";
import type { TokenSet } from "../gmail/dto";
import { localContactsStore } from "../contacts/google";
import { LocalDrafts } from "../mail/drafts";
import { OfflineQueue, OFFLINE_QUEUE_KEY } from "../offline/queue";
import { WinnowStore } from "../store/store";
import type { Email } from "../model/email";
import type { Platform } from "../../platform/types";

const A = "aaaa1111";
const B = "bbbb2222";

function installLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
    },
  });
  return backing;
}

function tokens(tag: string): TokenSet {
  return { accessToken: `access-${tag}`, refreshToken: `1//refresh-${tag}`, expiresAt: Date.now() + 3_600_000, scope: "https://www.googleapis.com/auth/gmail.modify" } as TokenSet;
}

function email(gmailId: string, subject: string): Email {
  return {
    id: Number.parseInt(gmailId.replace(/\D/g, ""), 10) || 1,
    gmailId,
    sender: "ada@example.com",
    subject,
    body: `private words of ${subject}`,
    receivedAt: 1,
    unread: true,
    mailbox: "inbox",
    attachments: [],
    category: "primary",
    starred: false,
    urgent: false,
  } as unknown as Email;
}

/** The addresses Google says the next sign-ins are for, in order. */
let nextSignIns: string[] = [];
/** Every authorize URL the platform was asked to open. */
let authorizeUrls: string[] = [];
/** Who each access token belongs to, as the fake Gmail answers /profile. */
const tokenOwner = new Map<string, string>();

function fakePlatform(): Platform {
  let issued = 0;
  const credentials = { clientId: "1234567890-abc123def.apps.googleusercontent.com" };
  return {
    info: async () => ({ kind: "desktop", os: "linux", nativeOAuth: true, nativeSecrets: true, backgroundSync: true, saveFiles: true, version: "1.4.0", name: "winnow" }),
    tokenStore: (account?: string) => (account ? localStorageTokenStore(webTokenKey(account)) : localStorageTokenStore()),
    credentialStore: () => ({ read: async () => credentials, write: async () => {}, clear: async () => {} }),
    beginSignIn: async ({ authorizeUrl }: { authorizeUrl: string }) => {
      authorizeUrls.push(authorizeUrl);
      const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
      issued += 1;
      return { kind: "code", code: `code-${issued}`, state, redirectUri: "http://127.0.0.1:1/winnow-oauth" };
    },
    cancelSignIn: async () => {},
  } as unknown as Platform;
}

function stubGoogle(): void {
  let minted = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      minted += 1;
      const access = `minted-${minted}`;
      tokenOwner.set(access, nextSignIns.shift() ?? "nobody@example.com");
      return json({ access_token: access, refresh_token: `1//r-${minted}`, expires_in: 3600, scope: "https://www.googleapis.com/auth/gmail.modify", token_type: "Bearer" });
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return json({});
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const owner = tokenOwner.get(auth.replace(/^Bearer /, "")) ?? "unknown@example.com";
    if (url.includes("/profile")) return json({ emailAddress: owner, historyId: "100", messagesTotal: 0 });
    if (url.includes("/history")) return json({ historyId: "100" });
    if (url.includes("/messages")) return json({ resultSizeEstimate: 0 });
    return json({});
  });
}

let storage: Map<string, string>;
beforeEach(() => {
  storage = installLocalStorage();
  nextSignIns = [];
  authorizeUrls = [];
  tokenOwner.clear();
  stubGoogle();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Two accounts' worth of data, written the way the app writes it. */
async function seedTwoAccounts(): Promise<void> {
  saveAccounts(globalThis.localStorage, {
    version: 1,
    active: A,
    accounts: [
      { id: A, email: "ada@one.example", color: "space", notify: true, addedAt: 1 },
      { id: B, email: "bob@two.example", color: "plum", notify: true, addedAt: 2 },
    ],
  });
  for (const [id, tag] of [[A, "a"], [B, "b"]] as const) {
    await localStorageTokenStore(webTokenKey(id)).write(tokens(tag));
    tokenOwner.set(`access-${tag}`, tag === "a" ? "ada@one.example" : "bob@two.example");
    const cache = localCache(undefined, { account: id, lifecycle: () => () => undefined });
    await cache.upsert([email(`m${tag === "a" ? 1 : 2}`, `${tag}-subject`)]);
    await cache.write(`cursor-${tag}`);
    await cache.flush();
    persistAccountState(globalThis.localStorage, id, {
      learning: { version: 1, weights: { starBoost: tag === "a" ? 22 : 30 }, events: [] } as never,
      filterLearning: { version: 1, owner: tag === "a" ? "ada@one.example" : "bob@two.example", corrections: [] } as never,
      activeFilters: [tag === "a" ? "urgent" : "travel"],
    });
    await localContactsStore(accountKey("winnow.google.contacts.v1", id)).write({ contacts: [{ name: tag, email: `${tag}@contact.example` }], syncTokens: {} } as never);
    new LocalDrafts(globalThis.localStorage, tag === "a" ? "ada@one.example" : "bob@two.example").put({
      context: "new",
      mode: "new",
      draft: { to: [], cc: [], bcc: [], subject: `${tag} draft`, body: `${tag} words` },
      savedAt: 1,
    } as never);
    const queue = scopedStorage(globalThis.localStorage, id);
    queue?.setItem(OFFLINE_QUEUE_KEY, JSON.stringify({ v: 1, account: tag === "a" ? "ada@one.example" : "bob@two.example", entries: [] }));
  }
}

const keysOf = (id: string) => [...storage.keys()].filter((key) => key.endsWith(`@${id}`));

describe("account isolation", () => {
  it("keeps every account's cache, cursor, drafts, learning, contacts, queue and tokens under its own keys", async () => {
    await seedTwoAccounts();
    const b = localCache(undefined, { account: B, lifecycle: () => () => undefined });
    expect((await b.all()).map((m) => m.subject)).toEqual(["b-subject"]);
    expect(await b.read()).toBe("cursor-b");
    const a = localCache(undefined, { account: A, lifecycle: () => () => undefined });
    expect((await a.all()).map((m) => m.subject)).toEqual(["a-subject"]);

    // Nothing of A's mail is in any key B reads.
    for (const key of keysOf(B)) expect(storage.get(key) ?? "").not.toContain("a-subject");
    for (const key of keysOf(A)) expect(storage.get(key) ?? "").not.toContain("b-subject");

    expect(loadAccountState(globalThis.localStorage, A).activeFilters).toEqual(["urgent"]);
    expect(loadAccountState(globalThis.localStorage, B).activeFilters).toEqual(["travel"]);
    expect((loadAccountState(globalThis.localStorage, B).filterLearning as { owner: string }).owner).toBe("bob@two.example");
    // The device's own (the demo's) is a third, separate record.
    expect(loadAccountState(globalThis.localStorage, null).learning).toBeNull();

    expect(storage.get(accountKey("winnow.google.contacts.v1", A))).toContain("a@contact.example");
    expect(storage.get(accountKey("winnow.google.contacts.v1", B))).toContain("b@contact.example");
    expect(storage.get(accountKey("winnow.google.contacts.v1", B))).not.toContain("a@contact.example");

    expect(new LocalDrafts(globalThis.localStorage, "bob@two.example").all().map((d) => d.draft.subject)).toEqual(["b draft"]);
    expect((await localStorageTokenStore(webTokenKey(A)).read())?.accessToken).toBe("access-a");
    expect((await localStorageTokenStore(webTokenKey(B)).read())?.accessToken).toBe("access-b");
    // 1.3.5's unscoped keys are not written by anyone any more.
    expect(storage.has("winnow.gmail.tokens")).toBe(false);
    expect(storage.has("winnow.gmail.cache.messages")).toBe(false);
  });

  it("an offline queue reads only its own account's waiting actions", async () => {
    await seedTwoAccounts();
    const queue = new OfflineQueue({ storage: scopedStorage(globalThis.localStorage, A), isOnline: () => true });
    queue.clear();
    expect(storage.has(accountKey(OFFLINE_QUEUE_KEY, A))).toBe(false);
    expect(storage.has(accountKey(OFFLINE_QUEUE_KEY, B))).toBe(true);
  });

  it("a scoped view passes shared keys through untouched", () => {
    const view = scopedStorage(globalThis.localStorage, A)!;
    view.setItem("winnow.preferences.v1", "{}");
    view.setItem("winnow.learning.v1", "{}");
    expect(storage.has("winnow.preferences.v1")).toBe(true);
    expect(storage.has(`winnow.learning.v1@${A}`)).toBe(true);
    expect(storage.has("winnow.learning.v1")).toBe(false);
  });

  it("wiping one account erases exactly its namespace and its device drafts", async () => {
    await seedTwoAccounts();
    const before = new Map(storage);
    wipeAccountStorage(globalThis.localStorage, B, "bob@two.example");
    expect(keysOf(B).filter((key) => !key.startsWith("winnow.gmail.tokens"))).toEqual([]);
    expect(new LocalDrafts(globalThis.localStorage, "bob@two.example").all()).toEqual([]);
    for (const [key, value] of before) {
      if (key.endsWith(`@${B}`) || key.includes("bob@two.example")) continue;
      expect(storage.get(key)).toBe(value);
    }
  });
});

describe("signing out of one account", () => {
  it("leaves the other accounts intact, and the open one stays open", async () => {
    await seedTwoAccounts();
    const store = new WinnowStore();
    const bridge = createSessionBridge(fakePlatform(), store, { storage: globalThis.localStorage });
    await bridge.prepare();
    await bridge.accounts.openActive();
    expect(store.currentAccountId()).toBe(A);
    const aBefore = keysOf(A).map((key) => [key, storage.get(key)]);

    await bridge.accounts.signOut(B, { revoke: false });

    expect(keysOf(B)).toEqual([]);
    expect(new LocalDrafts(globalThis.localStorage, "bob@two.example").all()).toEqual([]);
    expect(bridge.accounts.registry.list().map((account) => account.id)).toEqual([A]);
    expect(store.currentAccountId()).toBe(A);
    // A's tokens, mail and learning are untouched (its cache may only have been re-written as it was).
    expect((await localStorageTokenStore(webTokenKey(A)).read())?.accessToken).toBe("access-a");
    expect(keysOf(A).map((key) => key)).toEqual(aBefore.map(([key]) => key));
    expect(loadAccountState(globalThis.localStorage, A).activeFilters).toEqual(["urgent"]);
  });

  it("signing out of the open account opens the next one, with its own mail and learning", async () => {
    await seedTwoAccounts();
    const store = new WinnowStore();
    const bridge = createSessionBridge(fakePlatform(), store, { storage: globalThis.localStorage });
    await bridge.prepare();
    await bridge.accounts.openActive();
    await bridge.signOut({ revoke: false });
    expect(keysOf(A)).toEqual([]);
    expect(store.currentAccountId()).toBe(B);
    expect(store.getSnapshot().account?.email).toBe("bob@two.example");
    expect(store.getSnapshot().all.map((m) => m.subject)).not.toContain("a-subject");
    expect((await localStorageTokenStore(webTokenKey(B)).read())?.accessToken).toBe("access-b");
  });

  it("Sign out of all erases every account and leaves the app signed out", async () => {
    await seedTwoAccounts();
    const store = new WinnowStore();
    const bridge = createSessionBridge(fakePlatform(), store, { storage: globalThis.localStorage });
    await bridge.prepare();
    await bridge.accounts.openActive();
    await bridge.accounts.signOutAll({ revoke: false });
    expect(keysOf(A)).toEqual([]);
    expect(keysOf(B)).toEqual([]);
    expect(store.getSnapshot().status).toBe("signed_out");
    expect(loadAccounts(globalThis.localStorage).accounts).toEqual([]);
  });

  /** Snoozes and sends for both accounts (and the demo), under the shared keys. */
  function seedSharedRecords(): void {
    const send = (id: string, account: string, extra: Record<string, unknown> = {}) => ({
      id, account, sendAt: 1, scheduledAt: 1, mode: "new", context: `c-${id}`, draftId: null,
      draft: { to: ["x@example.com"], cc: [], bcc: [], subject: `secret ${id}`, body: `body ${id}` }, ...extra,
    });
    storage.set("winnow.scheduledSend.v1", JSON.stringify({ sends: [send("ada", "ada@one.example"), send("bob", "bob@two.example"), send("ada-via-bob", "ada@one.example", { from: B }), send("demo", "demo")] }));
    const snooze = (key: string, account: string) => ({ key, account, gmailIds: [key], wakeAt: 9e15, snoozedAt: 1, from: "inbox" });
    storage.set("winnow.snooze.v1", JSON.stringify({ snoozed: [snooze("s-ada", "ada@one.example"), snooze("s-bob", "bob@two.example")], woke: [{ gmailId: "w-bob", account: "bob@two.example", wokeAt: 1 }] }));
  }
  const sharedRecords = () => ({
    sends: (JSON.parse(storage.get("winnow.scheduledSend.v1") ?? "{}").sends ?? []).map((r: { id: string }) => r.id).sort(),
    snoozed: (JSON.parse(storage.get("winnow.snooze.v1") ?? "{}").snoozed ?? []).map((r: { key: string }) => r.key),
    woke: (JSON.parse(storage.get("winnow.snooze.v1") ?? "{}").woke ?? []).map((r: { gmailId: string }) => r.gmailId),
  });

  for (const which of ["inactive", "open"] as const) {
    it(`signing out of the ${which} account purges its scheduled sends and snoozes from the shared records`, async () => {
      await seedTwoAccounts();
      seedSharedRecords();
      const store = new WinnowStore();
      const bridge = createSessionBridge(fakePlatform(), store, { storage: globalThis.localStorage });
      await bridge.prepare();
      if (which === "open") saveAccounts(globalThis.localStorage, { ...loadAccounts(globalThis.localStorage), active: B });
      bridge.accounts.registry.reload();
      await bridge.accounts.openActive();
      await bridge.accounts.signOut(B, { revoke: false });
      expect(sharedRecords()).toEqual({ sends: ["ada", "demo"], snoozed: ["s-ada"], woke: [] });
      expect(storage.get("winnow.scheduledSend.v1")).not.toContain("secret bob");
    });
  }

  it("records of an account no longer in the registry are dropped at launch, never sent", async () => {
    await seedTwoAccounts();
    seedSharedRecords();
    saveAccounts(globalThis.localStorage, { ...loadAccounts(globalThis.localStorage), accounts: loadAccounts(globalThis.localStorage).accounts.filter((a) => a.id === A) });
    const store = new WinnowStore();
    const bridge = createSessionBridge(fakePlatform(), store, { storage: globalThis.localStorage });
    await bridge.prepare();
    expect(sharedRecords()).toEqual({ sends: ["ada", "demo"], snoozed: ["s-ada"], woke: [] });
  });

  it("switching accounts clears nothing of either", async () => {
    await seedTwoAccounts();
    const store = new WinnowStore();
    const bridge = createSessionBridge(fakePlatform(), store, { storage: globalThis.localStorage });
    await bridge.prepare();
    await bridge.accounts.openActive();
    const before = new Map([...storage].filter(([key]) => key.endsWith(`@${A}`) || key.endsWith(`@${B}`)));
    await bridge.accounts.switchTo(B);
    expect(store.currentAccountId()).toBe(B);
    expect(store.getSnapshot().activeFilters.map((f) => (f.kind === "builtin" ? f.id : ""))).toEqual(["travel"]);
    await bridge.accounts.switchTo(A);
    expect(store.getSnapshot().activeFilters.map((f) => (f.kind === "builtin" ? f.id : ""))).toEqual(["urgent"]);
    // (An empty offline queue is stored as no key at all, so it is not counted.)
    expect([...before.keys()].filter((key) => !storage.has(key) && !key.startsWith(OFFLINE_QUEUE_KEY))).toEqual([]);
  });
});

describe("adding accounts", () => {
  it("signs each account in separately, with Google's account chooser after the first, and refuses a duplicate", async () => {
    const store = new WinnowStore();
    let n = 0;
    const bridge = createSessionBridge(fakePlatform(), store, { storage: globalThis.localStorage, newId: () => `acct${++n}xx` });
    await bridge.prepare();

    nextSignIns = ["ada@one.example"];
    expect((await bridge.signIn()).email).toBe("ada@one.example");
    await bridge.accounts.openActive();
    expect(new URL(authorizeUrls[0]).searchParams.get("prompt")).toBe("consent");

    nextSignIns = ["bob@two.example"];
    const added = await bridge.accounts.add();
    expect(added).toMatchObject({ email: "bob@two.example", duplicate: false });
    expect(new URL(authorizeUrls[1]).searchParams.get("prompt")).toBe("select_account consent");
    await bridge.accounts.openActive();
    expect(store.getSnapshot().account?.email).toBe("bob@two.example");

    // The same Google account again: not a second copy, a switch to it.
    nextSignIns = ["ADA@one.example"];
    const again = await bridge.accounts.add();
    expect(again).toMatchObject({ email: "ada@one.example", duplicate: true, id: "acct1xx" });
    expect(bridge.accounts.registry.list()).toHaveLength(2);
    expect(bridge.accounts.activeId()).toBe("acct1xx");
    // Its fresh tokens replaced the old ones in its own entry; nothing was left pending.
    expect(storage.has(webTokenKey("pending"))).toBe(false);
    expect((await localStorageTokenStore(webTokenKey("acct2xx")).read())?.accessToken).toBe("minted-2");
  });

  it("holds five accounts at most", async () => {
    const registry = new AccountRegistry(globalThis.localStorage);
    for (let i = 0; i < MAX_ACCOUNTS; i++) expect("kind" in registry.add(`acct${i}xxx`, `u${i}@x.example`)).toBe(false);
    expect(registry.add("acct9xxx", "u9@x.example")).toEqual({ kind: "full" });
    expect(registry.add("acct8xxx", "U0@x.example")).toEqual({ kind: "duplicate", id: "acct0xxx" });

    const store = new WinnowStore();
    const bridge = createSessionBridge(fakePlatform(), store, { storage: globalThis.localStorage });
    await bridge.prepare();
    await expect(bridge.accounts.add()).rejects.toThrow(ACCOUNTS_FULL_MESSAGE);
  });

  it("gives every account its own colour from the accent palette, changeable", () => {
    const registry = new AccountRegistry(globalThis.localStorage);
    const colours = ["a", "b", "c", "d", "e"].map((x, i) => (registry.add(`acct${i}abc`, `${x}@x.example`) as { color: string }).color);
    expect(new Set(colours).size).toBe(5);
    expect(colours.slice(0, 4)).toEqual(["space", "plum", "ember", "aurora"]);
    registry.update("acct0abc", { color: "rose" });
    expect(loadAccounts(globalThis.localStorage).accounts[0].color).toBe("rose");
    registry.update("acct0abc", { notify: false });
    expect(loadAccounts(globalThis.localStorage).accounts[0].notify).toBe(false);
  });
});

describe("migration from 1.3.5", () => {
  function seedLegacy(): void {
    storage.set("winnow.gmail.tokens", JSON.stringify(tokens("legacy")));
    storage.set("winnow.gmail.cache.messages", JSON.stringify([email("m7", "legacy-subject")]));
    storage.set("winnow.gmail.cache.cursor", "777");
    storage.set("winnow.learning.v1", JSON.stringify({ version: 1, weights: { starBoost: 31 }, events: [] }));
    storage.set("winnow.filterLearning.v1", JSON.stringify({ version: 1, owner: "ada@one.example", corrections: [] }));
    storage.set("winnow.activeFilters.v1", JSON.stringify(["urgent"]));
    storage.set("winnow.offlineQueue.v1", JSON.stringify({ v: 1, account: "ada@one.example", entries: [] }));
    storage.set("winnow.google.contacts.v1", JSON.stringify({ contacts: [] }));
    storage.set("winnow.brandLogos.v1", "{}");
    storage.set("winnow.gravatars.v1", "{}");
    storage.set("winnow.drafts.v1:ada@one.example", "[]");
    storage.set("winnow.preferences.v1", JSON.stringify({ appearance: "dark" }));
    storage.set("winnow.google.oauthClient", JSON.stringify({ clientId: "x" }));
  }

  const legacyTokens = () => localStorageTokenStore();
  const tokensFor = (id: string) => localStorageTokenStore(webTokenKey(id));

  it("moves the one account into its namespace, tokens included, so nobody signs in again", async () => {
    seedLegacy();
    const outcome = await migrateToAccounts({ storage: globalThis.localStorage, legacyTokens: legacyTokens(), tokensFor, newId: () => "migr4ted" });
    expect(outcome).toMatchObject({ kind: "migrated", account: { id: "migr4ted", email: "ada@one.example" } });
    expect(loadAccounts(globalThis.localStorage)).toMatchObject({ active: "migr4ted", accounts: [{ id: "migr4ted", email: "ada@one.example" }] });
    expect((await tokensFor("migr4ted").read())?.accessToken).toBe("access-legacy");
    expect(await legacyTokens().read()).toBeNull();
    const cache = localCache(undefined, { account: "migr4ted", lifecycle: () => () => undefined });
    expect((await cache.all()).map((m) => m.subject)).toEqual(["legacy-subject"]);
    expect(await cache.read()).toBe("777");
    expect(loadAccountState(globalThis.localStorage, "migr4ted").activeFilters).toEqual(["urgent"]);
    for (const key of ACCOUNT_SCOPED_KEYS) expect(storage.has(key)).toBe(false);
    // Shared things stay where they were; drafts were already per address.
    expect(storage.get("winnow.preferences.v1")).toContain("dark");
    expect(storage.has("winnow.google.oauthClient")).toBe(true);
    expect(storage.has("winnow.drafts.v1:ada@one.example")).toBe(true);
    expect(storage.has(MIGRATION_ID_KEY)).toBe(false);
  });

  it("runs once: a second launch changes nothing", async () => {
    seedLegacy();
    await migrateToAccounts({ storage: globalThis.localStorage, legacyTokens: legacyTokens(), tokensFor, newId: () => "migr4ted" });
    const after = new Map(storage);
    expect(await migrateToAccounts({ storage: globalThis.localStorage, legacyTokens: legacyTokens(), tokensFor, newId: () => "other111" })).toEqual({ kind: "none" });
    expect(new Map(storage)).toEqual(after);
  });

  it("a locked keychain defers it, moving and deleting nothing", async () => {
    seedLegacy();
    const before = new Map(storage);
    const locked: TokenStore = { read: async () => { throw new Error("keychain locked"); }, write: async () => {}, clear: async () => {} };
    expect((await migrateToAccounts({ storage: globalThis.localStorage, legacyTokens: locked, tokensFor })).kind).toBe("deferred");
    expect(new Map(storage)).toEqual(before);
  });

  it("an interrupted run resumes into the same namespace", async () => {
    seedLegacy();
    let fail = true;
    const flaky = (id: string): TokenStore => ({
      ...tokensFor(id),
      write: async (t) => {
        if (fail) throw new Error("keychain busy");
        await tokensFor(id).write(t);
      },
    });
    expect((await migrateToAccounts({ storage: globalThis.localStorage, legacyTokens: legacyTokens(), tokensFor: flaky, newId: () => "first111" })).kind).toBe("deferred");
    fail = false;
    const outcome = await migrateToAccounts({ storage: globalThis.localStorage, legacyTokens: legacyTokens(), tokensFor: flaky, newId: () => "second22" });
    expect(outcome).toMatchObject({ kind: "migrated", account: { id: "first111" } });
    expect([...storage.keys()].some((key) => key.endsWith("@second22"))).toBe(false);
  });

  it("a mail cache too big to copy is dropped with its cursor, and the rest still moves", async () => {
    seedLegacy();
    const full = {
      getItem: (k: string) => globalThis.localStorage.getItem(k),
      removeItem: (k: string) => globalThis.localStorage.removeItem(k),
      setItem: (k: string, v: string) => {
        if (k === "winnow.gmail.cache.messages@migr4ted" && storage.has("winnow.gmail.cache.messages")) {
          throw new DOMException("quota", "QuotaExceededError");
        }
        globalThis.localStorage.setItem(k, v);
      },
    };
    const outcome = await migrateToAccounts({ storage: full, legacyTokens: legacyTokens(), tokensFor, newId: () => "migr4ted" });
    expect(outcome).toMatchObject({ kind: "migrated", account: { id: "migr4ted" } });
    const cache = localCache(undefined, { account: "migr4ted", lifecycle: () => () => undefined });
    expect(await cache.all()).toEqual([]);
    // No cursor over an empty cache: the first sync is a full one.
    expect(await cache.read()).toBeNull();
    expect(loadAccountState(globalThis.localStorage, "migr4ted").activeFilters).toEqual(["urgent"]);
    expect(storage.get("winnow.offlineQueue.v1@migr4ted")).toContain("ada@one.example");
    expect((await tokensFor("migr4ted").read())?.accessToken).toBe("access-legacy");
    for (const key of ACCOUNT_SCOPED_KEYS) expect(storage.has(key)).toBe(false);
  });

  /** Storage whose writes of the registry fail (`throw`) or vanish (`drop`) while `mode` says so. */
  function registryFails(mode: { now: "throw" | "drop" | "ok" }) {
    return {
      getItem: (k: string) => globalThis.localStorage.getItem(k),
      removeItem: (k: string) => globalThis.localStorage.removeItem(k),
      setItem: (k: string, v: string) => {
        if (k === ACCOUNTS_STORAGE_KEY && mode.now === "throw") throw new DOMException("quota", "QuotaExceededError");
        if (k === ACCOUNTS_STORAGE_KEY && mode.now === "drop") return;
        globalThis.localStorage.setItem(k, v);
      },
    };
  }
  const legacyKeys = () => new Map([...storage].filter(([key]) => (ACCOUNT_SCOPED_KEYS as readonly string[]).includes(key) || key === "winnow.gmail.tokens"));

  for (const failure of ["throw", "drop"] as const) {
    it(`a registry write that fails (${failure}) defers it: no legacy key or token goes, and the next launch finishes it`, async () => {
      seedLegacy();
      const before = legacyKeys();
      const mode: { now: "throw" | "drop" | "ok" } = { now: failure };
      const outcome = await migrateToAccounts({ storage: registryFails(mode), legacyTokens: legacyTokens(), tokensFor, newId: () => "migr4ted" });
      expect(outcome.kind).toBe("deferred");
      expect(legacyKeys()).toEqual(before);
      expect((await legacyTokens().read())?.accessToken).toBe("access-legacy");
      // The copies are owned: the id they sit under is still recorded for the retry.
      expect(storage.get(MIGRATION_ID_KEY)).toBe("migr4ted");
      expect(storage.has(ACCOUNTS_STORAGE_KEY)).toBe(false);

      mode.now = "ok";
      const retry = await migrateToAccounts({ storage: registryFails(mode), legacyTokens: legacyTokens(), tokensFor, newId: () => "other111" });
      expect(retry).toMatchObject({ kind: "migrated", account: { id: "migr4ted" } });
      expect(loadAccounts(globalThis.localStorage).active).toBe("migr4ted");
      expect((await tokensFor("migr4ted").read())?.accessToken).toBe("access-legacy");
      expect(await legacyTokens().read()).toBeNull();
      for (const key of ACCOUNT_SCOPED_KEYS) expect(storage.has(key)).toBe(false);
      expect([...storage.keys()].some((key) => key.endsWith("@other111"))).toBe(false);
    });
  }

  it("signed out under 1.3.5 with a registry write that fails: nothing is deleted, and the next launch retries", async () => {
    seedLegacy();
    storage.delete("winnow.gmail.tokens");
    const before = new Map(storage);
    const mode: { now: "throw" | "drop" | "ok" } = { now: "throw" };
    expect((await migrateToAccounts({ storage: registryFails(mode), legacyTokens: legacyTokens(), tokensFor })).kind).toBe("deferred");
    expect(new Map(storage)).toEqual(before);
    mode.now = "ok";
    expect((await migrateToAccounts({ storage: registryFails(mode), legacyTokens: legacyTokens(), tokensFor })).kind).toBe("signed-out");
    expect(storage.has("winnow.gmail.cache.messages")).toBe(false);
  });

  it("the tokens are copied, and read back, before the legacy ones go", async () => {
    seedLegacy();
    const events: string[] = [];
    const legacy: TokenStore = {
      ...legacyTokens(),
      clear: async () => {
        events.push("clear legacy");
        await legacyTokens().clear();
      },
    };
    const traced = (id: string): TokenStore => ({
      ...tokensFor(id),
      write: async (t) => {
        events.push("write account");
        await tokensFor(id).write(t);
      },
    });
    expect((await migrateToAccounts({ storage: globalThis.localStorage, legacyTokens: legacy, tokensFor: traced, newId: () => "migr4ted" })).kind).toBe("migrated");
    expect(events).toEqual(["write account", "clear legacy"]);
  });

  it("a token write that does not stick defers it, deleting nothing", async () => {
    seedLegacy();
    const before = legacyKeys();
    const forgetful = (id: string): TokenStore => ({ ...tokensFor(id), write: async () => {} });
    expect((await migrateToAccounts({ storage: globalThis.localStorage, legacyTokens: legacyTokens(), tokensFor: forgetful, newId: () => "migr4ted" })).kind).toBe("deferred");
    expect(legacyKeys()).toEqual(before);
    expect(storage.has(ACCOUNTS_STORAGE_KEY)).toBe(false);
  });

  it("an id that cannot be recorded defers it before anything is copied", async () => {
    seedLegacy();
    const before = new Map(storage);
    const noId = {
      getItem: (k: string) => globalThis.localStorage.getItem(k),
      removeItem: (k: string) => globalThis.localStorage.removeItem(k),
      setItem: (k: string, v: string) => {
        if (k === MIGRATION_ID_KEY) throw new DOMException("quota", "QuotaExceededError");
        globalThis.localStorage.setItem(k, v);
      },
    };
    expect((await migrateToAccounts({ storage: noId, legacyTokens: legacyTokens(), tokensFor, newId: () => "migr4ted" })).kind).toBe("deferred");
    expect(new Map(storage)).toEqual(before);
  });

  it("the device's learning is adopted only once the account's copy is written", () => {
    storage.set("winnow.learning.v1", JSON.stringify({ version: 1, weights: { starBoost: 31 }, events: [] }));
    const refusing = {
      getItem: (k: string) => globalThis.localStorage.getItem(k),
      removeItem: (k: string) => globalThis.localStorage.removeItem(k),
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    };
    adoptDeviceLearning(refusing, "first111");
    expect(storage.get("winnow.learning.v1")).toContain("31");
  });

  it("persistAccounts says whether the registry is really there", () => {
    const snapshot = { version: 1 as const, active: null, accounts: [] };
    expect(persistAccounts(globalThis.localStorage, snapshot)).toBe(true);
    expect(persistAccounts(registryFails({ now: "throw" }), snapshot)).toBe(false);
    storage.delete(ACCOUNTS_STORAGE_KEY);
    expect(persistAccounts(registryFails({ now: "drop" }), snapshot)).toBe(false);
    expect(persistAccounts(null, snapshot)).toBe(false);
  });

  it("signed out under 1.3.5: no account, and the learning stays the device's until the first account adopts it", async () => {
    seedLegacy();
    storage.delete("winnow.gmail.tokens");
    expect((await migrateToAccounts({ storage: globalThis.localStorage, legacyTokens: legacyTokens(), tokensFor })).kind).toBe("signed-out");
    expect(storage.has(ACCOUNTS_STORAGE_KEY)).toBe(true);
    expect(storage.has("winnow.gmail.cache.messages")).toBe(false);
    expect(storage.has("winnow.learning.v1")).toBe(true);
    adoptDeviceLearning(globalThis.localStorage, "first111");
    expect(storage.has("winnow.learning.v1")).toBe(false);
    expect(storage.get("winnow.learning.v1@first111")).toContain("31");
  });

  it("through the bridge: a 1.3.5 install opens its account with no sign-in", async () => {
    seedLegacy();
    tokenOwner.set("access-legacy", "ada@one.example");
    const store = new WinnowStore();
    const bridge = createSessionBridge(fakePlatform(), store, { storage: globalThis.localStorage });
    expect((await bridge.prepare()).kind).toBe("migrated");
    expect(await bridge.hasSession()).toBe(true);
    await bridge.accounts.openActive();
    expect(store.getSnapshot().account?.email).toBe("ada@one.example");
    expect(store.getSnapshot().activeFilters).toHaveLength(1);
    expect(authorizeUrls).toEqual([]);
  });
});
