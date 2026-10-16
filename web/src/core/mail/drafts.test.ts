/**
 * The composer's autosave, against a fake `DraftsApi` and an in-memory `Storage`.
 *
 * Pinned: the debounce (one save per pause, not per keystroke); serial saves (create
 * returns its id before anything updates); discard deletes, including a save still in
 * flight; the device copy is written at once, restorable, one per context and account;
 * and a grant without drafts keeps everything on the device and says so.
 */

import { describe, expect, it } from "vitest";
import {
  DraftAutosaver,
  LocalDrafts,
  MAX_LOCAL_DRAFTS,
  draftContextKey,
  draftStatusLabel,
  type DraftSaveStatus,
  type DraftsApi,
  type StorageLike,
  type Timers,
} from "./drafts";
import type { Draft } from "../model/email";

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function manualTimers(): Timers & { fire: () => void; pending: () => number; lastDelay: () => number } {
  let queue: { id: number; callback: () => void; ms: number }[] = [];
  let next = 0;
  let last = 0;
  return {
    set(callback, ms) {
      next += 1;
      last = ms;
      queue.push({ id: next, callback, ms });
      return next;
    },
    clear(handle) {
      queue = queue.filter((entry) => entry.id !== handle);
    },
    fire() {
      const due = queue;
      queue = [];
      for (const entry of due) entry.callback();
    },
    pending: () => queue.length,
    lastDelay: () => last,
  };
}

/** A fake Gmail: records calls; each call can be held open to test ordering. */
function fakeApi(options: { hold?: boolean; fail?: Error } = {}) {
  const calls: string[] = [];
  const held: (() => void)[] = [];
  let ids = 0;
  const wait = () =>
    options.hold ? new Promise<void>((resolve) => held.push(resolve)) : Promise.resolve();
  const api: DraftsApi = {
    async create(draft, replyTo) {
      calls.push(`create ${draft.body}${replyTo ? ` @${replyTo}` : ""}`);
      await wait();
      if (options.fail) throw options.fail;
      ids += 1;
      return `d-${ids}`;
    },
    async update(id, draft) {
      calls.push(`update ${id} ${draft.body}`);
      await wait();
      if (options.fail) throw options.fail;
      return id;
    },
    async delete(id) {
      calls.push(`delete ${id}`);
    },
  };
  return { api, calls, release: () => held.splice(0).forEach((resolve) => resolve()) };
}

const draft = (body: string, extra: Partial<Draft> = {}): Draft => ({
  to: ["ana@example.com"],
  cc: [],
  bcc: [],
  subject: "Hello",
  body,
  ...extra,
});

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("draftContextKey", () => {
  it("one key per reply, forward, and the new message", () => {
    expect(draftContextKey("new")).toBe("new");
    expect(draftContextKey("reply", "g1")).toBe("reply:g1");
    expect(draftContextKey("forward", "g1")).toBe("forward:g1");
    expect(draftContextKey("reply", null)).toBe("new");
  });
});

describe("DraftAutosaver — debounce", () => {
  it("saves once, about two seconds after typing stops", async () => {
    const timers = manualTimers();
    const { api, calls } = fakeApi();
    const saver = new DraftAutosaver({ context: "new", mode: "new", api, local: null, timers });
    saver.change(draft("H"));
    saver.change(draft("He"));
    saver.change(draft("Hey"));
    expect(timers.pending()).toBe(1);
    expect(timers.lastDelay()).toBe(2000);
    expect(calls).toEqual([]);
    timers.fire();
    await saver.settle();
    expect(calls).toEqual(["create Hey"]);
  });

  it("updates the same draft after the first save, and reports each step", async () => {
    const timers = manualTimers();
    const { api, calls } = fakeApi();
    const statuses: DraftSaveStatus["kind"][] = [];
    const saver = new DraftAutosaver({
      context: "reply:g1",
      mode: "reply",
      replyTo: "g1",
      api,
      local: null,
      timers,
      onStatus: (status) => statuses.push(status.kind),
    });
    saver.change(draft("a"));
    timers.fire();
    await saver.settle();
    saver.change(draft("ab"));
    timers.fire();
    expect(await saver.settle()).toBe("d-1");
    expect(calls).toEqual(["create a @g1", "update d-1 ab"]);
    expect(statuses).toEqual(["saving", "saved", "saving", "saved"]);
    expect(draftStatusLabel(saver.currentStatus)).toBe("Saved");
  });

  it("typing during a slow create becomes one update with the id, never a second create", async () => {
    const timers = manualTimers();
    const { api, calls, release } = fakeApi({ hold: true });
    const saver = new DraftAutosaver({ context: "new", mode: "new", api, local: null, timers });
    saver.change(draft("one"));
    timers.fire();
    await flushMicrotasks();
    expect(draftStatusLabel(saver.currentStatus)).toBe("Saving…");
    saver.change(draft("one two"));
    timers.fire();
    release();
    await flushMicrotasks();
    release();
    await saver.settle();
    expect(calls).toEqual(["create one", "update d-1 one two"]);
  });

  it("does nothing more once closed", async () => {
    const timers = manualTimers();
    const { api, calls } = fakeApi();
    const saver = new DraftAutosaver({ context: "new", mode: "new", api, local: null, timers });
    saver.finish();
    saver.change(draft("late"));
    expect(timers.pending()).toBe(0);
    await saver.settle();
    expect(calls).toEqual([]);
  });
});

describe("DraftAutosaver — discard and send", () => {
  it("discard deletes the Gmail draft and the device copy", async () => {
    const timers = manualTimers();
    const storage = memoryStorage();
    const local = new LocalDrafts(storage, "me@example.com");
    const { api, calls } = fakeApi();
    const saver = new DraftAutosaver({ context: "new", mode: "new", api, local, timers });
    saver.change(draft("bye"));
    timers.fire();
    await saver.settle();
    await saver.discard();
    expect(calls).toEqual(["create bye", "delete d-1"]);
    expect(local.get("new")).toBeNull();
  });

  it("discard while the first save is out still deletes what it made", async () => {
    const timers = manualTimers();
    const { api, calls, release } = fakeApi({ hold: true });
    const saver = new DraftAutosaver({ context: "new", mode: "new", api, local: null, timers });
    saver.change(draft("x"));
    timers.fire();
    await flushMicrotasks();
    const discarding = saver.discard();
    release();
    await discarding;
    expect(calls).toEqual(["create x", "delete d-1"]);
  });

  it("discard before any save makes no request", async () => {
    const { api, calls } = fakeApi();
    const saver = new DraftAutosaver({ context: "new", mode: "new", api, local: null, timers: manualTimers() });
    saver.change(draft("x"));
    await saver.discard();
    expect(calls).toEqual([]);
  });

  it("settle hands the id to send; finish drops only the device copy", async () => {
    const timers = manualTimers();
    const local = new LocalDrafts(memoryStorage(), "me@example.com");
    const { api, calls } = fakeApi();
    const saver = new DraftAutosaver({ context: "new", mode: "new", api, local, timers });
    saver.change(draft("send me"));
    // Send pressed before the pause ended: settle saves now rather than losing the text.
    expect(await saver.settle()).toBe("d-1");
    saver.finish();
    expect(calls).toEqual(["create send me"]);
    expect(local.get("new")).toBeNull();
  });

  it("park keeps both copies, for coming back to the reply later", async () => {
    const timers = manualTimers();
    const local = new LocalDrafts(memoryStorage(), "me@example.com");
    const { api } = fakeApi();
    const saver = new DraftAutosaver({ context: "reply:g1", mode: "reply", replyTo: "g1", api, local, timers });
    saver.change(draft("later"), { replyAll: false });
    await saver.park();
    expect(local.get("reply:g1")).toMatchObject({ gmailDraftId: "d-1", replyAll: false, replyTo: "g1" });
  });
});

describe("DraftAutosaver — failures and permission", () => {
  it("a failed save says Couldn't save and keeps the device copy", async () => {
    const timers = manualTimers();
    const local = new LocalDrafts(memoryStorage(), "me@example.com");
    const { api } = fakeApi({ fail: new Error("offline") });
    const saver = new DraftAutosaver({ context: "new", mode: "new", api, local, timers });
    saver.change(draft("kept"));
    timers.fire();
    await saver.settle();
    expect(draftStatusLabel(saver.currentStatus)).toBe("Couldn't save");
    expect(local.get("new")?.draft.body).toBe("kept");
  });

  it("a scope refusal switches to the device copy and asks for permission", async () => {
    const timers = manualTimers();
    const scope = Object.assign(new Error("Drafts need permission."), { name: "DraftsScopeMissing" });
    const { api, calls } = fakeApi({ fail: scope });
    const saver = new DraftAutosaver({ context: "new", mode: "new", api, local: null, timers });
    saver.change(draft("a"));
    timers.fire();
    await saver.settle();
    expect(saver.currentStatus).toEqual({ kind: "permission" });
    // No more requests once Gmail has said no.
    saver.change(draft("ab"));
    timers.fire();
    await saver.settle();
    expect(calls).toEqual(["create a"]);
    expect(draftStatusLabel(saver.currentStatus)).toBe("Drafts need permission");
  });

  it("starting without permission makes no request, and a grant saves what is there", async () => {
    const timers = manualTimers();
    const local = new LocalDrafts(memoryStorage(), "me@example.com");
    const { api, calls } = fakeApi();
    const saver = new DraftAutosaver({
      context: "new",
      mode: "new",
      api,
      local,
      timers,
      permissionMissing: true,
    });
    expect(saver.currentStatus).toEqual({ kind: "permission" });
    saver.change(draft("held"));
    timers.fire();
    await saver.settle();
    expect(calls).toEqual([]);
    expect(local.get("new")?.draft.body).toBe("held");
    saver.grant(api);
    await saver.settle();
    expect(calls).toEqual(["create held"]);
    expect(saver.currentStatus).toEqual({ kind: "saved", where: "gmail" });
  });

  it("the demo saves on the device and says so", async () => {
    const timers = manualTimers();
    const local = new LocalDrafts(memoryStorage(), "demo");
    const saver = new DraftAutosaver({ context: "new", mode: "new", api: null, local, timers });
    saver.change(draft("demo"));
    expect(local.get("new")?.draft.body).toBe("demo");
    timers.fire();
    await saver.settle();
    expect(draftStatusLabel(saver.currentStatus)).toBe("Saved on this device");
  });
});

describe("LocalDrafts — the restore copy", () => {
  it("restores after a reload: a new instance over the same storage reads it back", () => {
    const storage = memoryStorage();
    const timers = manualTimers();
    const saver = new DraftAutosaver({
      context: "reply:g7",
      mode: "reply",
      replyTo: "g7",
      api: null,
      local: new LocalDrafts(storage, "Me@Example.com"),
      timers,
      now: () => 42,
    });
    saver.change(draft("half a reply", { quoteBlock: "> q" }), { replyAll: true });

    const reloaded = new LocalDrafts(storage, "me@example.com");
    expect(reloaded.latest()).toEqual({
      context: "reply:g7",
      mode: "reply",
      replyTo: "g7",
      replyAll: true,
      draft: draft("half a reply", { quoteBlock: "> q" }),
      savedAt: 42,
    });
  });

  it("keeps one draft per context, the newest, and separate per account", () => {
    const storage = memoryStorage();
    const mine = new LocalDrafts(storage, "me@example.com");
    const demo = new LocalDrafts(storage, "demo");
    mine.put({ context: "new", mode: "new", draft: draft("first"), savedAt: 1 });
    mine.put({ context: "new", mode: "new", draft: draft("second"), savedAt: 2 });
    mine.put({ context: "reply:g1", mode: "reply", draft: draft("r"), savedAt: 3 });
    expect(mine.all().map((entry) => entry.draft.body)).toEqual(["r", "second"]);
    expect(mine.latest()?.context).toBe("reply:g1");
    expect(demo.latest()).toBeNull();
    mine.remove("reply:g1");
    expect(mine.latest()?.draft.body).toBe("second");
  });

  it("caps how many it keeps, dropping the oldest", () => {
    const local = new LocalDrafts(memoryStorage(), "me@example.com");
    for (let i = 0; i < MAX_LOCAL_DRAFTS + 5; i += 1) {
      local.put({ context: `reply:g${i}`, mode: "reply", draft: draft(String(i)), savedAt: i });
    }
    expect(local.all()).toHaveLength(MAX_LOCAL_DRAFTS);
    expect(local.get("reply:g0")).toBeNull();
  });

  it("reads corrupt or missing storage as nothing kept", () => {
    const storage = memoryStorage();
    storage.setItem("winnow.drafts.v1:me@example.com", "{not json");
    expect(new LocalDrafts(storage, "me@example.com").latest()).toBeNull();
    storage.setItem("winnow.drafts.v1:me@example.com", JSON.stringify([{ context: "new" }]));
    expect(new LocalDrafts(storage, "me@example.com").latest()).toBeNull();
    expect(new LocalDrafts(null, "me@example.com").latest()).toBeNull();
  });

  it("survives storage that throws", () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
    };
    const local = new LocalDrafts(throwing, "me@example.com");
    expect(() => local.put({ context: "new", mode: "new", draft: draft("x"), savedAt: 1 })).not.toThrow();
    expect(local.latest()).toBeNull();
  });
});
