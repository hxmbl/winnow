import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  bodyBytes,
  gatedOfflineStore,
  indexedDbOfflineStore,
  loadedFromStored,
  memoryOfflineStore,
  offlineDbName,
  type OfflineStore,
  type StoredBody,
} from "./offlineStore";

function stored(gmailId: string, extra: Partial<StoredBody> = {}): StoredBody {
  return {
    gmailId,
    body: `Body of ${gmailId}`,
    bodySource: "html",
    bodyHtml: `<p>Body of ${gmailId}</p>`,
    attachments: [{ id: "a1", partId: "1", filename: "a.pdf", mimeType: "application/pdf", size: 3, inline: false }],
    files: ["a1"],
    skipped: 0,
    bytes: 100,
    savedAt: 1,
    ...extra,
  };
}

const bytes = (...values: number[]) => new Uint8Array(values);

/** The same contract, run against both implementations. */
const stores: [string, () => OfflineStore][] = [
  ["memory", () => memoryOfflineStore()],
  ["IndexedDB", () => indexedDbOfflineStore("winnow-offline@test", new IDBFactory())],
];

describe.each(stores)("the offline store (%s)", (_name, make) => {
  it("keeps the mailbox JSON, a body and its files, and reads them back", async () => {
    const store = make();
    expect(await store.readMailbox()).toBeNull();
    await store.writeMailbox("[1,2]");
    expect(await store.readMailbox()).toBe("[1,2]");

    await store.putBody(stored("m1"), [{ attachmentId: "a1", bytes: bytes(1, 2, 3) }]);
    expect((await store.getBody("m1"))?.bodyHtml).toBe("<p>Body of m1</p>");
    expect([...((await store.getFile("m1", "a1")) ?? [])]).toEqual([1, 2, 3]);
    expect(await store.getFile("m1", "nope")).toBeNull();
    expect([...(await store.savedIds())]).toEqual(["m1"]);
    expect(await store.stats()).toEqual({ messages: 1, bytes: 100 });
  });

  it("remove and keepOnly take bodies and files together; clearDownloads keeps the mailbox; clear takes everything", async () => {
    const store = make();
    await store.writeMailbox("[]");
    for (const id of ["m1", "m2", "m3"]) await store.putBody(stored(id), [{ attachmentId: "a1", bytes: bytes(9) }]);

    await store.remove(["m1"]);
    expect(await store.getBody("m1")).toBeNull();
    expect(await store.getFile("m1", "a1")).toBeNull();
    expect(await store.getFile("m2", "a1")).not.toBeNull();

    expect(await store.keepOnly(["m2"])).toBe(1);
    expect([...(await store.savedIds())]).toEqual(["m2"]);
    expect(await store.getFile("m3", "a1")).toBeNull();

    await store.clearDownloads();
    expect(await store.stats()).toEqual({ messages: 0, bytes: 0 });
    expect(await store.readMailbox()).toBe("[]");

    await store.putBody(stored("m4"), []);
    await store.clear();
    expect(await store.readMailbox()).toBeNull();
    expect(await store.getBody("m4")).toBeNull();
  });

  it("a re-saved body replaces its files rather than adding to them", async () => {
    const store = make();
    await store.putBody(stored("m1"), [{ attachmentId: "a1", bytes: bytes(1) }]);
    await store.putBody(stored("m1", { files: [] }), []);
    expect(await store.getFile("m1", "a1")).toBeNull();
  });
});

describe("the offline store's edges", () => {
  it("one database per account", () => {
    expect(offlineDbName("abcd1234")).toBe("winnow-offline@abcd1234");
    expect(offlineDbName()).toBe("winnow-offline");
  });

  it("deleting a database does not reach another account's", async () => {
    const idb = new IDBFactory();
    const a = indexedDbOfflineStore(offlineDbName("aaaa"), idb);
    const b = indexedDbOfflineStore(offlineDbName("bbbb"), idb);
    await a.putBody(stored("m1"), []);
    await b.putBody(stored("m1"), []);
    await a.clear();
    expect(await a.getBody("m1")).toBeNull();
    expect(await b.getBody("m1")).not.toBeNull();
  });

  it("gated: writes are dropped while closed, reads and deletes still work", async () => {
    const inner = memoryOfflineStore();
    let open = true;
    const gated = gatedOfflineStore(inner, () => open);
    await gated.putBody(stored("m1"), []);
    open = false;
    await gated.putBody(stored("m2"), []);
    await gated.writeMailbox("[]");
    expect([...(await inner.savedIds())]).toEqual(["m1"]);
    expect(await inner.readMailbox()).toBeNull();
    await gated.clear();
    expect(await inner.stats()).toEqual({ messages: 0, bytes: 0 });
  });

  it("sizes count text twice (UTF-16) plus file bytes, and a stored body reads back as a loaded one", () => {
    expect(bodyBytes({ body: "ab", bodyHtml: "cde" }, [{ attachmentId: "x", bytes: bytes(1, 2) }])).toBe(12);
    const loaded = loadedFromStored(stored("m1"));
    expect(loaded).toEqual({
      body: "Body of m1",
      bodySource: "html",
      bodyHtml: "<p>Body of m1</p>",
      attachments: stored("m1").attachments,
    });
  });
});
