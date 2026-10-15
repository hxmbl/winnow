/**
 * Google's address book: the local copy, and the incremental refresh that keeps it.
 *
 * The People client is replaced by a scripted listing per source, so each test says
 * exactly which pages Google returns for which token. Every address is `.example`.
 */

import { describe, expect, it } from "vitest";
import {
  GoogleContactsSync,
  MAX_PAGES,
  applyListing,
  emptySnapshot,
  flattenSnapshot,
  reviveSnapshot,
  safePhotoUrl,
  toStoredPerson,
  type GoogleContactsSnapshot,
  type GoogleContactsStore,
} from "./google";
import {
  ExpiredSyncToken,
  PeopleScopeMissing,
  type PeoplePage,
  type PeoplePerson,
  type PeopleSource,
} from "../gmail/people";

function person(resourceName: string, name: string | undefined, ...emails: string[]): PeoplePerson {
  return {
    resourceName,
    names: name ? [{ displayName: name, metadata: { primary: true } }] : undefined,
    emailAddresses: emails.map((value, i) => ({ value, metadata: { primary: i === 0 } })),
  };
}

const deleted = (resourceName: string): PeoplePerson => ({ resourceName, metadata: { deleted: true } });

/** A store that keeps the snapshot in memory and counts writes. */
function memoryStore(initial: GoogleContactsSnapshot | null = null) {
  let saved = initial;
  let writes = 0;
  const store: GoogleContactsStore = {
    read: async () => (saved ? structuredClone(saved) : null),
    write: async (snapshot) => {
      writes += 1;
      saved = structuredClone(snapshot);
    },
    clear: async () => {
      saved = null;
    },
  };
  return { store, saved: () => saved, writes: () => writes };
}

type Script = (options: { pageToken?: string; syncToken?: string }) => PeoplePage | Error;

/** A People client whose answers are a function of the source and the request. */
function scriptedClient(scripts: Record<PeopleSource, Script>) {
  const calls: { source: PeopleSource; pageToken?: string; syncToken?: string }[] = [];
  return {
    calls,
    client: {
      async list(source: PeopleSource, options: { pageToken?: string; syncToken?: string } = {}) {
        calls.push({ source, ...options });
        const answer = scripts[source](options);
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

const empty: Script = () => ({ people: [], nextSyncToken: "empty-token" });

describe("toStoredPerson", () => {
  it("keeps the primary name and puts the primary address first", () => {
    const stored = toStoredPerson({
      resourceName: "people/c1",
      names: [{ displayName: "Ada L" }, { displayName: "Ada Lovelace", metadata: { primary: true } }],
      emailAddresses: [
        { value: "ada@old.example" },
        { value: "ada@new.example", metadata: { primary: true } },
        { value: "ADA@old.example" },
      ],
    });
    expect(stored).toEqual({ name: "Ada Lovelace", emails: ["ada@new.example", "ada@old.example"] });
  });

  it("drops a person with no usable address", () => {
    expect(toStoredPerson({ resourceName: "people/c2", names: [{ displayName: "Phone Only" }] })).toBeNull();
    expect(toStoredPerson({ resourceName: "people/c3", emailAddresses: [{ value: "not an address" }] })).toBeNull();
  });
});

describe("applyListing", () => {
  const previous = {
    syncToken: "t0",
    people: {
      "people/c1": { name: "Ada", emails: ["ada@example.com"] },
      "people/c2": { name: "Grace", emails: ["grace@example.com"] },
    },
  };

  it("replaces everything on a full listing", () => {
    const next = applyListing(previous, [[person("people/c3", "Linus", "linus@example.com")]], "full", "t1");
    expect(Object.keys(next.people)).toEqual(["people/c3"]);
    expect(next.syncToken).toBe("t1");
  });

  it("applies changes and deletions on an incremental one", () => {
    const next = applyListing(
      previous,
      [[person("people/c1", "Ada Lovelace", "ada@example.com")], [deleted("people/c2")]],
      "incremental",
      "t1",
    );
    expect(next.people).toEqual({ "people/c1": { name: "Ada Lovelace", emails: ["ada@example.com"] } });
  });

  it("drops a person whose last address was removed", () => {
    const next = applyListing(previous, [[{ resourceName: "people/c1", names: [{ displayName: "Ada" }] }]], "incremental", "t1");
    expect(next.people["people/c1"]).toBeUndefined();
  });

  it("does not mutate the previous state", () => {
    applyListing(previous, [[deleted("people/c1")]], "incremental", "t1");
    expect(previous.people["people/c1"]).toBeDefined();
  });
});

describe("flattenSnapshot", () => {
  it("lists one row per address, saved winning over other", () => {
    const snapshot: GoogleContactsSnapshot = {
      ...emptySnapshot(),
      saved: { people: { "people/c1": { name: "Ada Lovelace", emails: ["ada@example.com", "ada@work.example"] } } },
      other: {
        people: {
          "otherContacts/c1": { name: "ada", emails: ["Ada@Example.com"] },
          "otherContacts/c2": { emails: ["linus@example.com"] },
        },
      },
    };
    const rows = flattenSnapshot(snapshot);
    expect(rows).toEqual([
      { address: "ada@example.com", name: "Ada Lovelace", source: "saved" },
      { address: "ada@work.example", name: "Ada Lovelace", source: "saved" },
      { address: "linus@example.com", name: undefined, source: "other" },
    ]);
  });

  it("borrows an other contact's name for a saved contact that has none", () => {
    const rows = flattenSnapshot({
      ...emptySnapshot(),
      saved: { people: { "people/c1": { emails: ["ada@example.com"] } } },
      other: { people: { "otherContacts/c1": { name: "Ada", emails: ["ada@example.com"] } } },
    });
    expect(rows).toEqual([{ address: "ada@example.com", name: "Ada", source: "saved" }]);
  });
});

describe("reviveSnapshot", () => {
  it("round-trips a snapshot and refuses anything else", () => {
    const snapshot: GoogleContactsSnapshot = {
      version: 3,
      saved: { syncToken: "s", people: { "people/c1": { name: "Ada", emails: ["ada@example.com"] } } },
      other: { people: {} },
      syncedAt: 5,
    };
    expect(reviveSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(reviveSnapshot({ version: 3 })).toBeNull();
    expect(reviveSnapshot("nope")).toBeNull();
    expect(reviveSnapshot({ version: 3, saved: {}, other: { people: {} } })).toBeNull();
  });
});

describe("GoogleContactsSync — full, then incremental", () => {
  it("does a full listing of both sources first, following pages, and stores the tokens", async () => {
    const { client, calls } = scriptedClient({
      saved: ({ pageToken }) =>
        pageToken === "p2"
          ? { people: [person("people/c2", "Grace Hopper", "grace@example.com")], nextSyncToken: "saved-1" }
          : { people: [person("people/c1", "Ada Lovelace", "ada@example.com")], nextPageToken: "p2" },
      other: () => ({ people: [person("otherContacts/c1", undefined, "linus@example.com")], nextSyncToken: "other-1" }),
    });
    const memory = memoryStore();
    const sync = new GoogleContactsSync({ client, store: memory.store, now: () => 1234 });

    const rows = await sync.refresh();

    expect(calls).toEqual([
      { source: "saved", pageToken: undefined, syncToken: undefined },
      { source: "saved", pageToken: "p2", syncToken: undefined },
      { source: "other", pageToken: undefined, syncToken: undefined },
    ]);
    expect(rows.map((row) => [row.address, row.source])).toEqual([
      ["ada@example.com", "saved"],
      ["grace@example.com", "saved"],
      ["linus@example.com", "other"],
    ]);
    expect(memory.saved()?.saved.syncToken).toBe("saved-1");
    expect(memory.saved()?.other.syncToken).toBe("other-1");
    expect(memory.saved()?.syncedAt).toBe(1234);
  });

  it("asks only for changes next time, and applies deletions", async () => {
    const memory = memoryStore({
      version: 3,
      saved: {
        syncToken: "saved-1",
        people: {
          "people/c1": { name: "Ada Lovelace", emails: ["ada@example.com"] },
          "people/c2": { name: "Grace Hopper", emails: ["grace@example.com"] },
        },
      },
      other: { syncToken: "other-1", people: {} },
      syncedAt: 1,
    });
    const { client, calls } = scriptedClient({
      saved: ({ syncToken }) => {
        expect(syncToken).toBe("saved-1");
        return { people: [deleted("people/c2"), person("people/c3", "Linus", "linus@example.com")], nextSyncToken: "saved-2" };
      },
      other: ({ syncToken }) => {
        expect(syncToken).toBe("other-1");
        return { people: [], nextSyncToken: "other-2" };
      },
    });
    const sync = new GoogleContactsSync({ client, store: memory.store });

    const rows = await sync.refresh();

    expect(calls.every((call) => call.syncToken !== undefined)).toBe(true);
    expect(rows.map((row) => row.address)).toEqual(["ada@example.com", "linus@example.com"]);
    expect(memory.saved()?.saved.syncToken).toBe("saved-2");
    expect(memory.saved()?.other.syncToken).toBe("other-2");
  });

  it("repeats the sync token on every page of an incremental listing", async () => {
    const memory = memoryStore({ ...emptySnapshot(), saved: { syncToken: "s1", people: {} }, other: { syncToken: "o1", people: {} } });
    const { client, calls } = scriptedClient({
      saved: ({ pageToken }) => (pageToken ? { people: [], nextSyncToken: "s2" } : { people: [], nextPageToken: "next" }),
      other: () => ({ people: [], nextSyncToken: "o2" }),
    });
    await new GoogleContactsSync({ client, store: memory.store }).refresh();
    expect(calls.filter((call) => call.source === "saved")).toEqual([
      { source: "saved", pageToken: undefined, syncToken: "s1" },
      { source: "saved", pageToken: "next", syncToken: "s1" },
    ]);
  });

  it("keeps the old token when an incremental listing returns none", async () => {
    const memory = memoryStore({ ...emptySnapshot(), saved: { syncToken: "s1", people: {} }, other: { syncToken: "o1", people: {} } });
    const { client } = scriptedClient({ saved: () => ({ people: [] }), other: () => ({ people: [] }) });
    await new GoogleContactsSync({ client, store: memory.store }).refresh();
    expect(memory.saved()?.saved.syncToken).toBe("s1");
  });
});

describe("GoogleContactsSync — an expired sync token", () => {
  it("falls back to a full listing that replaces the stale copy", async () => {
    const memory = memoryStore({
      version: 3,
      saved: {
        syncToken: "too-old",
        people: {
          "people/c1": { name: "Ada", emails: ["ada@example.com"] },
          // Deleted at Google while the token was expired: only a full listing can tell.
          "people/gone": { name: "Gone", emails: ["gone@example.com"] },
        },
      },
      other: { syncToken: "other-1", people: {} },
      syncedAt: 1,
    });
    const { client, calls } = scriptedClient({
      saved: ({ syncToken }) =>
        syncToken
          ? new ExpiredSyncToken()
          : { people: [person("people/c1", "Ada Lovelace", "ada@example.com")], nextSyncToken: "fresh" },
      other: empty,
    });

    const rows = await new GoogleContactsSync({ client, store: memory.store }).refresh();

    expect(calls.filter((call) => call.source === "saved")).toEqual([
      { source: "saved", pageToken: undefined, syncToken: "too-old" },
      { source: "saved", pageToken: undefined, syncToken: undefined },
    ]);
    expect(rows.map((row) => row.address)).toEqual(["ada@example.com"]);
    expect(memory.saved()?.saved.syncToken).toBe("fresh");
    expect(memory.saved()?.saved.people["people/gone"]).toBeUndefined();
  });

  it("does the same for other contacts, independently of saved ones", async () => {
    const memory = memoryStore({ ...emptySnapshot(), saved: { syncToken: "s1", people: {} }, other: { syncToken: "old", people: {} } });
    const { client, calls } = scriptedClient({
      saved: () => ({ people: [], nextSyncToken: "s2" }),
      other: ({ syncToken }) => (syncToken ? new ExpiredSyncToken() : { people: [], nextSyncToken: "o-fresh" }),
    });
    await new GoogleContactsSync({ client, store: memory.store }).refresh();
    expect(calls.filter((call) => call.source === "saved")).toHaveLength(1);
    expect(memory.saved()?.other.syncToken).toBe("o-fresh");
  });
});

describe("GoogleContactsSync — failures", () => {
  it("leaves the previous copy and token alone when a page fails partway", async () => {
    const before: GoogleContactsSnapshot = {
      version: 3,
      saved: { syncToken: "s1", people: { "people/c1": { name: "Ada", emails: ["ada@example.com"] } } },
      other: { syncToken: "o1", people: {} },
      syncedAt: 1,
    };
    const memory = memoryStore(before);
    const { client } = scriptedClient({
      saved: ({ pageToken }) => (pageToken ? new Error("network down") : { people: [deleted("people/c1")], nextPageToken: "p2" }),
      other: empty,
    });
    const sync = new GoogleContactsSync({ client, store: memory.store });
    await expect(sync.refresh()).rejects.toThrow("network down");
    expect(memory.saved()).toEqual(before);
    expect(await sync.cached()).toEqual([{ address: "ada@example.com", name: "Ada", source: "saved" }]);
  });

  it("persists saved contacts even if other contacts then fail", async () => {
    const memory = memoryStore();
    const { client } = scriptedClient({
      saved: () => ({ people: [person("people/c1", "Ada", "ada@example.com")], nextSyncToken: "s1" }),
      other: () => new PeopleScopeMissing(),
    });
    await expect(new GoogleContactsSync({ client, store: memory.store }).refresh()).rejects.toBeInstanceOf(PeopleScopeMissing);
    expect(memory.saved()?.saved.syncToken).toBe("s1");
    expect(memory.saved()?.syncedAt).toBeNull();
  });

  it("stops a runaway listing and keeps no token, so the next refresh starts over", async () => {
    const memory = memoryStore();
    let pages = 0;
    const { client } = scriptedClient({
      saved: () => {
        pages += 1;
        return { people: [], nextPageToken: `p${pages}` };
      },
      other: empty,
    });
    await new GoogleContactsSync({ client, store: memory.store }).refresh();
    expect(pages).toBe(MAX_PAGES);
    expect(memory.saved()?.saved.syncToken).toBeUndefined();
  });
});

describe("GoogleContactsSync — bookkeeping", () => {
  it("shares one refresh between concurrent callers", async () => {
    let calls = 0;
    const { client } = scriptedClient({
      saved: () => {
        calls += 1;
        return { people: [], nextSyncToken: "s" };
      },
      other: empty,
    });
    const sync = new GoogleContactsSync({ client, store: memoryStore().store });
    await Promise.all([sync.refresh(), sync.refresh(), sync.refresh()]);
    expect(calls).toBe(1);
  });

  it("reads the stored copy without the network, and forgets it on clear", async () => {
    const memory = memoryStore({
      ...emptySnapshot(),
      other: { people: { "otherContacts/c1": { name: "Linus", emails: ["linus@example.com"] } } },
      syncedAt: 42,
    });
    const { client, calls } = scriptedClient({ saved: empty, other: empty });
    const sync = new GoogleContactsSync({ client, store: memory.store });
    expect(await sync.cached()).toEqual([{ address: "linus@example.com", name: "Linus", source: "other" }]);
    expect(await sync.lastSyncedAt()).toBe(42);
    expect(calls).toHaveLength(0);

    await sync.clear();
    expect(await sync.cached()).toEqual([]);
    expect(memory.saved()).toBeNull();
  });
});

describe("contact photos", () => {
  it("keeps a real https photo and skips Google's default placeholder", () => {
    expect(
      toStoredPerson({
        resourceName: "people/c1",
        emailAddresses: [{ value: "ada@example.com" }],
        photos: [
          { url: "https://lh3.googleusercontent.com/default", default: true },
          { url: "https://lh3.googleusercontent.com/ada", metadata: { primary: true } },
        ],
      }),
    ).toEqual({ name: undefined, emails: ["ada@example.com"], photo: "https://lh3.googleusercontent.com/ada" });
    expect(
      toStoredPerson({
        resourceName: "people/c2",
        emailAddresses: [{ value: "bo@example.com" }],
        photos: [{ url: "https://lh3.googleusercontent.com/default", default: true }],
      })?.photo,
    ).toBeUndefined();
  });

  it("refuses a photo that is not https", () => {
    expect(safePhotoUrl("http://example.com/a.png")).toBeUndefined();
    expect(safePhotoUrl("javascript:alert(1)")).toBeUndefined();
    expect(safePhotoUrl(4)).toBeUndefined();
    expect(safePhotoUrl("https://lh3.googleusercontent.com/a")).toBe("https://lh3.googleusercontent.com/a");
  });

  it("flattens with the photo, borrowing an other-contact photo for a saved contact without one", () => {
    const rows = flattenSnapshot({
      ...emptySnapshot(),
      saved: { people: { "people/c1": { name: "Ada", emails: ["ada@example.com"] } } },
      other: { people: { "otherContacts/c1": { emails: ["ada@example.com"], photo: "https://lh3.googleusercontent.com/ada" } } },
    });
    expect(rows).toEqual([
      { address: "ada@example.com", name: "Ada", source: "saved", photo: "https://lh3.googleusercontent.com/ada" },
    ]);
  });

  it("reads a version-1 snapshot as nothing, so the next refresh fetches photos in full", () => {
    expect(reviveSnapshot({ version: 1, saved: { people: {} }, other: { people: {} }, syncedAt: 1 })).toBeNull();
  });
});
