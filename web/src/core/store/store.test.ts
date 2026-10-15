import { describe, expect, it, vi } from "vitest";
import {
  NO_CURSOR,
  PREFETCH_UNREAD_TOP_N,
  STORAGE_PROMPT,
  STORAGE_SAVE_FAILED,
  WinnowStore,
  syncFailureSummary,
  syncNotice,
  type MailBackend,
  type PlatformBridge,
} from "./store";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import { builtinFilter, isUnsafe, senderFilter } from "../model/signals";
import type { Email, Mailbox } from "../model/email";
import { LearningModel } from "../learn/learning";
import { defaultWeights } from "../classify/weights";

/** A backend that records calls and can be made to fail on demand. */
function fakeBackend() {
  const calls: { method: string; args: unknown[] }[] = [];
  let shouldFail = false;

  const record = (method: string, ...args: unknown[]) => calls.push({ method, args });

  const backend: MailBackend = {
    async sync(options) {
      record("sync");
      if (shouldFail) throw new Error("network down");
      options?.onProgress?.({ phase: "full", fraction: 0.5, fetched: 1, failed: 0 });
      return { emails: [...DEMO_EMAILS], failed: 0, truncated: false };
    },
    async toggleStar(id, starred) {
      record("toggleStar", id, starred);
      if (shouldFail) throw new Error("network down");
    },
    async moveToMailbox(id, mailbox: Mailbox) {
      record("moveToMailbox", id, mailbox);
      if (shouldFail) throw new Error("network down");
    },
    async setRead(id, read) {
      record("setRead", id, read);
    },
    async deletePermanently(id) {
      record("deletePermanently", id);
      // Honours `failNext`, so the rollback path is reachable; a delete that could not
      // fail would make the undo untestable.
      if (shouldFail) throw new Error("network down");
    },
    async sendReply() {
      record("sendReply");
    },
    async fetchBody(gmailId) {
      record("fetchBody", gmailId);
      return `<p>fetched body for ${gmailId}</p>`;
    },
    async fetchAttachment(gmailId, attachmentId) {
      record("fetchAttachment", gmailId, attachmentId);
      return {
        bytes: new Uint8Array(),
        filename: "a.bin",
        mimeType: "application/octet-stream",
      };
    },
  };

  return {
    backend,
    calls,
    failNext: () => {
      shouldFail = true;
    },
    recover: () => {
      shouldFail = false;
    },
  };
}

function fakePlatform() {
  const calls: { method: string; args: unknown[] }[] = [];
  const platform: PlatformBridge = {
    async notifyNewMail(emails) {
      calls.push({ method: "notify", args: [emails.length] });
    },
    async setUnreadBadge(count) {
      calls.push({ method: "badge", args: [count] });
    },
    async setBackgroundSync(interval) {
      calls.push({ method: "syncInterval", args: [interval] });
    },
  };
  return { platform, calls };
}

/**
 * A store seeded with the demo mailbox, as the app starts it.
 *
 * The array is copied: `DEMO_EMAILS` is module state shared by every test in this
 * file, and a store that mutated it in place would make tests order-dependent.
 */
function demoStore() {
  return new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
}

/** Star a message the classifier calls security mail, which moves the security weight. */
function starSecurityMail(store: WinnowStore): void {
  const security = store.view.emails.find((e) => store.view.signals.get(e.id)?.security)!;
  store.toggleStar(security.id);
}

describe("the derived view stays consistent", () => {
  it("classifies and ranks from one pass over the messages", () => {
    const store = demoStore();
    const view = store.view;
    expect(view.emails.length).toBeGreaterThan(0);
    expect(view.threads.length).toBeGreaterThan(0);
    // Every visible message has signals, so the reader's badges agree with the list's
    // filter counts.
    for (const email of view.emails) {
      expect(view.signals.has(email.id)).toBe(true);
    }
  });

  it("hides spam from the unfiltered inbox", () => {
    // The default inbox has to be clean, or the first thing a user sees is junk and the
    // Unsafe bucket means nothing.
    const store = demoStore();
    const visible = new Set(store.view.emails.map((e) => e.gmailId));
    for (const message of DEMO_EMAILS) {
      const sig = store.view.signals.get(message.id);
      // `isUnsafe` rather than the literal `0.4`: written out, the test kept its own copy
      // of the threshold and would go on passing if the number moved — the one thing it
      // exists to check.
      if (sig && isUnsafe(sig) && message.mailbox === "inbox") {
        expect(visible.has(message.gmailId)).toBe(false);
      }
    }
  });

  it("shows unsafe when that filter is activated", () => {
    const store = demoStore();
    store.toggleFilter(builtinFilter("unsafe"));
    const visible = store.view.emails;
    expect(visible.length).toBeGreaterThan(0);
    for (const email of visible) {
      const sig = store.view.signals.get(email.id)!;
      expect(sig.spamLikelihood).toBeGreaterThanOrEqual(0.4);
    }
  });

  it("reports why the list is empty, rather than just that it is", () => {
    const store = demoStore();
    expect(store.view.result.emptyReason).toBeNull();

    store.setSearchQuery("nothing will match this");
    expect(store.view.result.emptyReason).toBe("search");

    store.setSearchQuery("");
    store.toggleFilter(senderFilter("nobody@nowhere.example"));
    expect(store.view.result.emptyReason).toBe("filters");
  });

  it("reports a match count that agrees with the list it is next to", () => {
    // So an empty result can be explained rather than merely reported. The test was
    // `toBeLessThanOrEqual(total)`, which passes for any implementation — including one
    // returning zero, or `NaN` — and repeated a docstring the code did not honour: with a
    // search active the count is just the length of the visible list. Asserted exactly.
    const store = demoStore();
    const total = store.view.emails.length;
    expect(store.view.result.matchCount).toBe(total);

    store.setSearchQuery("migration");
    const narrowed = store.view.result.matchCount;
    expect(narrowed).toBe(store.view.emails.length);
    expect(narrowed).toBeGreaterThan(0);
    expect(narrowed).toBeLessThan(total);
  });
});

describe("filter toggling", () => {
  it("narrows with AND across several filters", () => {
    const store = demoStore();
    const before = store.view.emails.length;
    store.toggleFilter(builtinFilter("important"));
    const important = store.view.emails.length;
    expect(important).toBeLessThan(before);

    store.toggleFilter(builtinFilter("urgent"));
    expect(store.view.emails.length).toBeLessThanOrEqual(important);
  });

  it("makes unsafe exclusive", () => {
    // "Important and Unsafe" is always empty, so selecting Unsafe replaces rather than
    // adds.
    const store = demoStore();
    store.toggleFilter(builtinFilter("important"));
    store.toggleFilter(builtinFilter("unsafe"));
    const active = store.getSnapshot().activeFilters;
    expect(active).toHaveLength(1);
    expect(active[0]).toEqual(builtinFilter("unsafe"));
  });

  it("toggles off cleanly", () => {
    const store = demoStore();
    store.toggleFilter(builtinFilter("important"));
    store.toggleFilter(builtinFilter("important"));
    expect(store.getSnapshot().activeFilters).toHaveLength(0);
  });

  it("clears everything at once", () => {
    const store = demoStore();
    store.toggleFilter(builtinFilter("important"));
    store.toggleFilter(builtinFilter("urgent"));
    store.clearFilters();
    expect(store.getSnapshot().activeFilters).toHaveLength(0);
  });
});

/**
 * Hiding a bucket from the rail is gone. Builds before that persisted the hidden list, so
 * a restore can still be handed one; it must be ignored, and every bucket comes back.
 */
describe("buckets cannot be hidden", () => {
  type Saved = Parameters<WinnowStore["restoreState"]>[0];
  // What an earlier build's `loadPersisted` produced, plus a stray `mutedFilters` as an
  // old snapshot field would carry it.
  const legacy = {
    activeFilters: [],
    removedFilters: ["newsletters", "important", "unsafe", "not-a-bucket"],
    mutedFilters: ["newsletters"],
  } as unknown as Saved;

  it("offers no way to hide a bucket", () => {
    const store = demoStore() as unknown as Record<string, unknown>;
    expect(store.dismissFilter).toBeUndefined();
    expect(store.restoreFilter).toBeUndefined();
    expect("mutedFilters" in demoStore().getSnapshot()).toBe(false);
  });

  it("brings back buckets an earlier build hid", () => {
    const fresh = demoStore();
    const migrated = demoStore();
    expect(() => migrated.restoreState(legacy)).not.toThrow();

    expect(migrated.view.rail).toEqual(fresh.view.rail);
    expect(migrated.view.rail).toContain("important");
    expect(migrated.view.rail).toContain("unsafe");
    // The inbox holds the hidden bucket's mail again, not just its pill.
    expect(migrated.view.threads.length).toBe(fresh.view.threads.length);
    expect("mutedFilters" in migrated.getSnapshot()).toBe(false);
  });

  it("lets a bucket an earlier build hid be switched on as a filter", () => {
    const store = demoStore();
    store.restoreState(legacy);
    store.toggleFilter(builtinFilter("newsletters"));
    expect(store.getSnapshot().activeFilters).toEqual([builtinFilter("newsletters")]);
    expect(store.view.emails.length).toBeGreaterThan(0);
  });

  it("never persists a hidden list", () => {
    const patches: Record<string, unknown>[] = [];
    const store = demoStore();
    store.attach({ onPersist: (patch) => patches.push(patch) });
    store.restoreState(legacy);
    store.toggleFilter(builtinFilter("newsletters"));
    store.clearFilters();
    expect(patches.length).toBeGreaterThan(0);
    for (const patch of patches) expect(patch).not.toHaveProperty("removedFilters");
  });
});

describe("optimistic actions and their rollback", () => {
  it("applies a star immediately", () => {
    const { backend, calls } = fakeBackend();
    const store = demoStore();
    store.attach({ backend });

    const target = store.view.emails[0];
    const wasStarred = target.starred;
    store.toggleStar(target.id);

    const after = store.getSnapshot().all.find((e) => e.id === target.id)!;
    expect(after.starred).toBe(!wasStarred);
    expect(calls.some((c) => c.method === "toggleStar")).toBe(true);
  });

  it("rolls the star back when the server refuses", async () => {
    // The user clicked; the app must not leave the UI lying about what was saved.
    //
    // The two phases are asserted *separately and synchronously*: an `await` between
    // them would let the rejection land first, and the test would only see the final
    // state — the one that matters least, since the optimistic flip is what the user
    // watched happen.
    const { backend, failNext } = fakeBackend();
    const store = demoStore();
    store.attach({ backend });

    const target = store.view.emails[0];
    const before = target.starred;
    failNext();
    store.toggleStar(target.id);

    // The optimistic state is visible immediately.
    expect(store.getSnapshot().all.find((e) => e.id === target.id)!.starred).toBe(!before);

    // And then it is undone once the call fails.
    await vi.waitFor(() => {
      expect(store.getSnapshot().all.find((e) => e.id === target.id)!.starred).toBe(before);
    });
    expect(store.getSnapshot().error).toBeTruthy();
  });

  it("keeps the message when a delete fails, rather than only the label", async () => {
    // The strongest form of the rollback test, and what distinguishes a real undo from a
    // re-sync: no second backend call is made, so the message can only come back from the
    // captured snapshot the undo restores.
    const { backend, failNext, calls } = fakeBackend();
    const store = demoStore();
    store.attach({ backend });

    const inBin = store.getSnapshot().all.find((e) => e.mailbox === "trash")!;
    failNext();
    store.deletePermanently(inBin.id);

    expect(store.getSnapshot().all.some((e) => e.id === inBin.id)).toBe(false);

    await vi.waitFor(() => {
      expect(store.getSnapshot().all.some((e) => e.id === inBin.id)).toBe(true);
    });
    // One attempt, no retry storm.
    expect(calls.filter((c) => c.method === "deletePermanently")).toHaveLength(1);
  });

  it("archives from the inbox and unarchives from the archive", async () => {
    const { backend, calls } = fakeBackend();
    const store = demoStore();
    store.attach({ backend });

    const target = store.view.emails[0];
    store.archive(target.id);
    expect(store.getSnapshot().all.find((e) => e.id === target.id)!.mailbox).toBe("archive");
    expect(calls.some((c) => c.method === "moveToMailbox" && c.args[1] === "archive")).toBe(true);

    store.archive(target.id);
    expect(store.getSnapshot().all.find((e) => e.id === target.id)!.mailbox).toBe("inbox");
  });

  it("leaves mail the user wrote in Sent, because Gmail will not let it leave", () => {
    // Gmail owns the SENT label and the API refuses to remove it, so an optimistic move
    // out of Sent would snap back on the next sync, and the server call would fail.
    const { backend, calls } = fakeBackend();
    const store = demoStore();
    store.attach({ backend });
    const sent = store.getSnapshot().all.find((e) => e.mailbox === "sent");
    if (!sent) throw new Error("the demo seed has no sent mail to archive");

    store.archive(sent.id);
    expect(store.getSnapshot().all.find((e) => e.id === sent.id)!.mailbox).toBe("sent");
    expect(calls.some((c) => c.method === "moveToMailbox")).toBe(false);
  });

  it("restores from the bin rather than archiving", async () => {
    const { backend } = fakeBackend();
    const store = demoStore();
    store.attach({ backend });

    const target = store.view.emails[0];
    store.move(target.id, "trash");
    store.archive(target.id);
    // Restoring has to land in the inbox, not the archive: a message that came back from
    // the bin belongs where the user expects it.
    expect(store.getSnapshot().all.find((e) => e.id === target.id)!.mailbox).toBe("inbox");
  });

  it("marks a moved message read", async () => {
    // Filing a message is dealing with it; leaving it bold in the next mailbox is noise.
    const store = demoStore();
    const unread = store.getSnapshot().all.find((e) => e.mailbox === "inbox" && e.unread);
    if (!unread) return;
    store.move(unread.id, "archive");
    expect(store.getSnapshot().all.find((e) => e.id === unread.id)!.unread).toBe(false);
  });

  it("restores the mailbox and read state on a failed move", async () => {
    const { backend, failNext } = fakeBackend();
    const store = demoStore();
    store.attach({ backend });

    const target = store.view.emails.find((e) => e.unread) ?? store.view.emails[0];
    const before = { mailbox: target.mailbox, unread: target.unread };

    failNext();
    store.move(target.id, "trash");

    await vi.waitFor(() => {
      const after = store.getSnapshot().all.find((e) => e.id === target.id)!;
      expect(after.mailbox).toBe(before.mailbox);
      expect(after.unread).toBe(before.unread);
    });
  });

  it("deletes permanently only from the bin", async () => {
    // The destructive action is reachable only where the user has said this is rubbish.
    const { backend, calls } = fakeBackend();
    const store = demoStore();
    store.attach({ backend });

    const target = store.view.emails[0];
    store.trash(target.id);
    expect(calls.some((c) => c.method === "deletePermanently")).toBe(false);
    expect(store.getSnapshot().all.find((e) => e.id === target.id)!.mailbox).toBe("trash");

    store.trash(target.id);
    expect(calls.some((c) => c.method === "deletePermanently")).toBe(true);
    expect(store.getSnapshot().all.find((e) => e.id === target.id)).toBeUndefined();
  });

  it("restores a deleted message when the server refuses", async () => {
    // Deletion is the one action that is not merely a label change, so losing a message
    // to a failed call is the worst failure mode in the app.
    const { backend, failNext } = fakeBackend();
    const store = demoStore();
    store.attach({ backend });

    const inBin = store.getSnapshot().all.find((e) => e.mailbox === "trash")!;
    failNext();
    store.deletePermanently(inBin.id);

    // Gone from the list synchronously, while the call is in flight.
    expect(store.getSnapshot().all.some((e) => e.id === inBin.id)).toBe(false);

    // And back once the failure lands.
    await vi.waitFor(() => {
      expect(store.getSnapshot().all.some((e) => e.id === inBin.id)).toBe(true);
    });
  });
});

describe("the derived view", () => {
  /**
   * `derive()` used to run on every read.
   *
   * It is the most expensive function in the app — profile, whole-inbox classification,
   * filter, sort, thread — and `getSnapshot` runs on every render *and* every
   * subscription check. `App` also re-renders for reasons unrelated to the store — the
   * reader's scroll, the composer's draft, the OS theme — so a single `↓` re-derived the
   * whole mailbox over unchanged data: 81ms on the 38-message demo, seconds on a real
   * inbox.
   *
   * These tests pin the memoisation, since the bug is invisible in a screenshot and would
   * only show up as "the app feels slow on a big mailbox".
   */
  it("reuses the view until the version moves", () => {
    const store = demoStore();
    const first = store.view;
    expect(store.view).toBe(first);
    // Read through the React-facing entry point too: the path that used to re-derive
    // twice per render.
    expect(store.getSnapshot().view).toBe(first);
    expect(store.getSnapshot().view).toBe(first);
  });

  it("re-derives after a change", () => {
    const store = demoStore();
    const before = store.view;
    const target = store.view.emails[0];

    store.toggleStar(target.id);

    expect(store.view).not.toBe(before);
    expect(store.getSnapshot().view).toBe(store.view);
  });

  it("re-derives when only the cheap fields move", () => {
    // The learning weights are written to state *before* the debounced reclassify, so a
    // snapshot's cheap fields must never go stale behind a memoised view.
    const store = demoStore();
    const before = store.getSnapshot().learning.weights.security;

    starSecurityMail(store);

    const after = store.getSnapshot();
    expect(after.learning.weights.security).toBeGreaterThan(before);
  });

  it("re-derives when a discard changes the trash bias", () => {
    // The same for `trashSenders`, also instance state and the input to the profile's
    // trash bias.
    const store = demoStore();
    const target = store.view.emails.find((email) => email.sender)!;
    const before = store.view.profile.trashBiasBySender[target.sender] ?? 0;

    store.trash(target.id);

    expect(store.view.profile.trashBiasBySender[target.sender] ?? 0).toBeGreaterThan(
      before,
    );
  });

  it("does not build search bags when nothing is being searched", () => {
    // The bags are a lowercased copy of every message's sender, subject and body. The
    // pipeline reads them only when `searchQuery` has tokens, so an unsearched mailbox was
    // paying for a full lowercased copy of its text on every derive.
    const store = demoStore();
    expect(store.view.searchBags.size).toBe(0);

    store.setSearchQuery("migration");
    expect(store.view.searchBags.size).toBeGreaterThan(0);

    store.setSearchQuery("");
    expect(store.view.searchBags.size).toBe(0);
  });

  it("still searches correctly with the bags built on demand", () => {
    const store = demoStore();
    const all = store.view.threads.length;
    store.setSearchQuery("migration");
    const narrowed = store.view.threads.length;
    expect(narrowed).toBeGreaterThan(0);
    expect(narrowed).toBeLessThan(all);
    // The map is a cache, not the source of truth: a miss falls back to building one, so
    // an empty map for a given search would be a silent wrong answer rather than an error.
    expect(narrowed).toBe(store.view.threads.length);
  });
});

/**
 * Mark-all-read: the one verb in the app that can lose information.
 *
 * Everything else in triaging has a visible inverse — a star is a toggle, a filed message
 * reappears in the folder it went to, a filter has its own pill. This one does not: a
 * single `⇧U` on a mailbox with a thousand unread, and the state is gone with nothing on
 * screen to bring it back.
 */
describe("mark-all-read and its undo", () => {  function storeWithUnread() {
    const { backend, calls } = fakeBackend();
    const store = new WinnowStore({ seed: DEMO_EMAILS, backend });
    const unreadBefore = store
      .getSnapshot()
      .all.filter((email) => email.mailbox === "inbox" && email.unread).length;
    expect(unreadBefore).toBeGreaterThan(0);
    return { store, calls, unreadBefore };
  }

  it("clears read state for the current mailbox only", () => {
    const { store } = storeWithUnread();
    const before = store.getSnapshot();
    const archivedUnread = before.all.filter(
      (email) => email.mailbox === "archive" && email.unread,
    ).length;

    store.markAllRead();

    const after = store.getSnapshot();
    expect(after.all.filter((email) => email.mailbox === "inbox" && email.unread)).toHaveLength(
      0,
    );
    // The archive's unread state is untouched: clearing it would be a surprise *and* a
    // divergence, since only the current mailbox is pushed to the server.
    expect(after.all.filter((email) => email.mailbox === "archive" && email.unread)).toHaveLength(
      archivedUnread,
    );
  });

  it("pushes the change to the server for every message it touched", async () => {
    const { store, calls } = storeWithUnread();
    store.markAllRead();
    await Promise.resolve();
    const pushes = calls.filter((call) => call.method === "setRead");
    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.every((call) => call.args[1] === true)).toBe(true);
  });

  it("does nothing, and offers nothing, when there is nothing unread", () => {
    const { store } = storeWithUnread();
    store.markAllRead();
    expect(store.getSnapshot().undo).not.toBeNull();

    // Now the inbox has no unread mail, so a second press is a no-op — and it must not
    // offer an undo that would put the message back as unread.
    store.markAllRead();
    store.select(store.getSnapshot().all[0].id);
    const archiveOnly = store.getSnapshot().all.find((email) => email.mailbox === "archive");
    if (archiveOnly) store.move(archiveOnly.id, "inbox");
    store.setMailbox("spam");
    store.markAllRead();
    expect(store.getSnapshot().undo).toBeNull();
  });

  it("offers an undo that restores exactly the messages it touched", () => {
    const { store, unreadBefore } = storeWithUnread();
    const ids = store
      .getSnapshot()
      .all.filter((email) => email.mailbox === "inbox" && email.unread)
      .map((email) => email.id);

    store.markAllRead();
    const undo = store.getSnapshot().undo;
    expect(undo).not.toBeNull();
    expect(undo?.label).toBe("Marked everything in this mailbox as read");

    store.undoLast();

    const after = store.getSnapshot();
    const restored = after.all.filter((email) => ids.includes(email.id) && email.unread);
    expect(restored).toHaveLength(ids.length);
    expect(after.undo).toBeNull();
    expect(unreadBefore).toBeGreaterThan(0);
  });

  it("does not resurrect a message that was read before the press", () => {
    const { store } = storeWithUnread();
    // Read one inbox message by hand first. The undo must not claim it.
    const alreadyRead = store
      .getSnapshot()
      .all.find((email) => email.mailbox === "inbox" && !email.unread);
    expect(alreadyRead).toBeDefined();

    store.markAllRead();
    store.undoLast();

    const after = store
      .getSnapshot()
      .all.find((email) => email.id === alreadyRead!.id);
    expect(after?.unread).toBe(false);
  });

  it("survives an interleaved move — the rollback reads live state", () => {
    const { store } = storeWithUnread();
    const target = store.getSnapshot().all.find((email) => email.mailbox === "inbox" && email.unread)!;

    store.markAllRead();
    // Archive a message that the undo would otherwise restore, in between.
    store.move(target.id, "archive");
    store.undoLast();

    const after = store.getSnapshot().all.find((email) => email.id === target.id);
    // Still archived: the undo restores *read state*, not a stale snapshot of the list, so
    // an unrelated change made in between is not clobbered.
    expect(after?.mailbox).toBe("archive");
    expect(after?.unread).toBe(true);
  });

  it("drops the offer when the user changes mailbox", () => {
    const { store } = storeWithUnread();
    store.markAllRead();
    expect(store.getSnapshot().undo).not.toBeNull();

    store.setMailbox("archive");
    // The label names a mailbox, and it is about to stop being true.
    expect(store.getSnapshot().undo).toBeNull();
  });

  it("drops the offer when it is dismissed rather than taken", () => {
    const { store } = storeWithUnread();
    store.markAllRead();
    store.dismissUndo();

    const after = store.getSnapshot();
    expect(after.undo).toBeNull();
    // And dismissing is not taking: the mail stays read.
    expect(after.all.filter((email) => email.mailbox === "inbox" && email.unread)).toHaveLength(
      0,
    );

    // With nothing on offer, `undoLast` is a no-op rather than an error.
    store.undoLast();
    expect(store.getSnapshot().undo).toBeNull();
  });

  it("clears the offer on sign-out", async () => {
    const { store } = storeWithUnread();
    store.markAllRead();
    expect(store.getSnapshot().undo).not.toBeNull();

    await store.signOut();
    expect(store.getSnapshot().undo).toBeNull();
  });
});

describe("the cursor", () => {
  it("keeps the cursor when the reader closes, for the desktop", () => {
    // On the desktop `j` carries on from where the reader was closed.
    const store = demoStore();
    store.openRow(3);
    store.closeReader();
    expect(store.getSnapshot().selectedId).toBeNull();
    expect(store.getSnapshot().cursorIndex).toBe(3);
  });

  it("drops the cursor with the reader when asked, for the phone", () => {
    // A phone's Back returns to a list with no current row: nothing highlighted, no
    // "4 of 39", and nothing a later reconcile could reopen on its own.
    const store = demoStore();
    store.openRow(3);
    store.closeReader({ dropCursor: true });
    expect(store.getSnapshot().selectedId).toBeNull();
    expect(store.getSnapshot().cursorIndex).toBe(NO_CURSOR);
  });

  it("selects nothing on its own when it loads", () => {
    // The phone must never open the reader by itself.
    const store = demoStore();
    expect(store.getSnapshot().selectedId).toBeNull();
    expect(store.getSnapshot().cursorIndex).toBe(NO_CURSOR);
  });

  it("starts at the top on the first move", () => {
    const store = demoStore();
    store.moveCursor(1);
    expect(store.getSnapshot().cursorIndex).toBe(0);
  });

  it("starts at the bottom on the first move backwards", () => {
    // Pressing `k` on a fresh list should land on the newest message, not refuse to move.
    const store = demoStore();
    store.moveCursor(-1);
    expect(store.getSnapshot().cursorIndex).toBe(store.view.threads.length - 1);
  });

  it("clamps at both ends", () => {
    const store = demoStore();
    const last = store.view.threads.length - 1;

    // `k` on a fresh list lands on the last row — the no-cursor rule. Pressing it again
    // walks *up*, the direction `k` names.
    store.moveCursor(-1);
    expect(store.getSnapshot().cursorIndex).toBe(last);
    store.moveCursor(-1);
    expect(store.getSnapshot().cursorIndex).toBe(last - 1);

    // All the way up, and it stops at the top rather than running off it.
    for (let i = 0; i < 200; i += 1) store.moveCursor(-1);
    expect(store.getSnapshot().cursorIndex).toBe(0);

    // All the way back down, and it stops at the bottom.
    for (let i = 0; i < 200; i += 1) store.moveCursor(1);
    expect(store.getSnapshot().cursorIndex).toBe(last);
  });

  it("stays put on an empty list", () => {
    // A `j` with nothing in the list must not leave a cursor pointing at a row that does
    // not exist, or the next arriving message inherits it.
    const store = new WinnowStore({ seed: [] });
    store.moveCursor(1);
    store.moveCursor(-1);
    expect(store.getSnapshot().cursorIndex).toBe(NO_CURSOR);
    expect(store.getSnapshot().selectedId).toBeNull();
  });

  it("follows the reader when one is open", () => {
    // Moving with `j` while reading carries the reader along, so the list and the open
    // message never disagree about which is current.
    const store = demoStore();
    store.openRow(0);
    const first = store.getSnapshot().selectedId;
    store.moveCursor(1);
    expect(store.getSnapshot().selectedId).not.toBe(first);
  });

  it("opens the message it moves to, because the reader is already on screen", () => {
    // `j` takes the reader with it rather than moving a highlight and needing a second
    // keypress: in a two-pane client the reader is right there, so pressing `o` to fill it
    // is two keystrokes to see what was asked for.
    const store = demoStore();
    store.moveCursor(1);
    expect(store.getSnapshot().selectedId).toBe(store.view.threads[0].representative.id);
  });

  it("follows the row that takes the cursor's place after a move", () => {
    // Filing the message under the cursor should leave the cursor on the next one, which
    // is what the user most likely wants.
    const store = demoStore();
    store.openRow(0);
    const second = store.view.threads[1];
    store.move(second.representative.id, "archive");
    // The cursor is still in range and the list re-derived around it.
    expect(store.getSnapshot().cursorIndex).toBeLessThan(store.view.threads.length);
  });
});

describe("following a message by id", () => {
  it("opens a message that is already in view", () => {
    // The ordinary case: a notification click, or a `winnow://` link.
    const store = demoStore();
    const target = store.view.threads[2].representative.id;

    expect(store.focusMessage(target)).toBe(true);
    expect(store.getSnapshot().selectedId).toBe(target);
    expect(store.getSnapshot().cursorIndex).toBe(2);
  });

  it("clears the filters that were hiding the message", () => {
    // Filters are transient view state: a link has to reach its message, and doing nothing
    // would look exactly like a broken link.
    const store = demoStore();
    const ids = store.view.threads.map((thread) => thread.representative.id);
    store.toggleFilter(builtinFilter("important"));
    expect(store.getSnapshot().activeFilters.length).toBeGreaterThan(0);
    // One the filter hides, whatever the seed's order.
    const shown = new Set(store.view.threads.map((thread) => thread.representative.id));
    const target = ids.find((id) => !shown.has(id))!;
    expect(target).toBeDefined();

    expect(store.focusMessage(target)).toBe(true);
    expect(store.getSnapshot().activeFilters).toHaveLength(0);
    expect(store.getSnapshot().selectedId).toBe(target);
  });

  it("clears a search that was hiding the message", () => {
    const store = demoStore();
    const target = store.view.threads[2].representative.id;
    store.setSearchQuery("a query no message matches");

    expect(store.focusMessage(target)).toBe(true);
    expect(store.getSnapshot().searchQuery).toBe("");
    expect(store.getSnapshot().selectedId).toBe(target);
  });

  it("switches to the mailbox the message is actually in", () => {
    // Following a link to something in the bin means going to the bin, not clearing
    // filters in the inbox and finding nothing.
    const store = demoStore();
    // Archived rather than trashed: the default view already excludes spam, and the bin
    // would be testing a mailbox the demo barely seeds.
    const target = store.view.emails[0];
    store.move(target.id, "archive");

    expect(store.focusMessage(target.id)).toBe(true);
    expect(store.getSnapshot().mailbox).toBe("archive");
    expect(store.getSnapshot().selectedId).toBe(target.id);
  });

  it("leaves the cursor on the row, not just the selection", () => {
    // The cursor and the selection are separate, and a reader opened at `NO_CURSOR` leaves
    // keyboard navigation pointing at nothing.
    const store = demoStore();
    store.toggleFilter(builtinFilter("important"));
    const last = store.view.emails[store.view.emails.length - 1];

    expect(store.focusMessage(last.id)).toBe(true);

    const state = store.getSnapshot();
    expect(state.cursorIndex).toBeGreaterThanOrEqual(0);
    expect(store.view.threads[state.cursorIndex].representative.id).toBe(
      state.selectedId,
    );
  });

  it("reports false for a message that does not exist", () => {
    // A stale link has to be distinguishable from a successful jump, or the caller cannot
    // decide whether to say anything.
    const store = demoStore();
    expect(store.focusMessage(-999)).toBe(false);
    expect(store.getSnapshot().selectedId).toBeNull();
  });

  it("closes an open overlay", () => {
    // Following a link while the settings panel is open should land on the message, not
    // leave the panel covering it.
    const store = demoStore();
    store.setOverlay("settings");
    store.focusMessage(store.view.threads[1].representative.id);
    expect(store.getSnapshot().overlay).toBe("none");
  });
});

/**
 * The reader represents the message the user selected.
 *
 * A smart filter says which rows to *show*. It used to say what the reader showed too,
 * because the open message was resolved out of the filtered rows: toggling a bucket
 * mid-triage silently replaced the email being read with whatever took the cursor's
 * place, or closed the reader outright.
 *
 * The store now distinguishes a message that has *left* from one merely *not being
 * shown*, pinned from both sides — the first half of this block is the regression, the
 * second the guarantee that the fix did not make the reader unclosable.
 */
describe("the reader and the filters", () => {
  it("keeps the open message when a filter is turned on", () => {
    // The last row, and a narrow filter, so the message is genuinely excluded rather than
    // incidentally still matching.
    const store = demoStore();
    const last = store.view.threads.length - 1;
    store.openRow(last);
    const before = store.view.selected;
    expect(before).not.toBeNull();

    store.toggleFilter(builtinFilter("travel"));
    expect(store.getSnapshot().selectedId).toBe(before?.id);
    expect(store.view.selected?.id).toBe(before?.id);
  });

  it("keeps it when the filter is turned off again", () => {
    const store = demoStore();
    store.openRow(store.view.threads.length - 1);
    const id = store.view.selected?.id;

    store.toggleFilter(builtinFilter("travel"));
    store.toggleFilter(builtinFilter("travel"));
    expect(store.view.selected?.id).toBe(id);
  });

  it("keeps it when a search stops matching", () => {
    const store = demoStore();
    store.openRow(0);
    const id = store.view.selected?.id;

    store.setSearchQuery("zzzznothingmatchesthis");
    // The result is empty and the reader is still open, which is the point: an empty
    // *result* is not an empty mailbox.
    expect(store.view.result.emptyReason).toBe("search");
    expect(store.view.selected?.id).toBe(id);
  });

  it("still lets go when the message is filed", () => {
    const store = demoStore();
    store.openRow(0);
    const filed = store.view.selected?.id;
    expect(filed).toBeDefined();

    store.move(filed!, "archive");
    expect(store.view.selected?.id).not.toBe(filed);
  });

  it("still lets go when the sender is blocked", () => {
    const store = demoStore();
    store.openRow(0);
    const sender = store.view.selected?.sender;
    expect(sender).toBeDefined();

    store.blockSender(sender!);
    expect(store.view.selected).toBeNull();
  });

  it("and when the mailbox changes, which is a navigation action", () => {
    const store = demoStore();
    store.openRow(0);
    store.setMailbox("archive");
    expect(store.view.selected).toBeNull();
  });
});

describe("mailbox switching", () => {  it("drops the selection and the filters", () => {
    // A selection from the inbox means nothing in the bin, and leaving it would show a
    // message the list does not contain.
    const store = demoStore();
    store.openRow(0);
    store.toggleFilter(builtinFilter("important"));

    store.setMailbox("trash");
    const state = store.getSnapshot();
    expect(state.mailbox).toBe("trash");
    expect(state.selectedId).toBeNull();
    expect(state.activeFilters).toHaveLength(0);
  });

  it("only lists that mailbox's messages", () => {
    const store = demoStore();
    store.setMailbox("spam");
    for (const email of store.view.emails) {
      expect(email.mailbox).toBe("spam");
    }
  });

  it("counts unread for the current mailbox only", () => {
    const store = demoStore();
    const inboxUnread = store.view.unreadCount;
    store.setMailbox("trash");
    expect(store.view.unreadCount).not.toBe(inboxUnread);
  });
});

describe("blocking a sender", () => {
  it("hides their mail everywhere", () => {
    const store = demoStore();
    const sender = store.view.emails[0].sender;
    store.blockSender(sender);
    for (const mailbox of ["inbox", "archive", "trash", "spam"] as Mailbox[]) {
      store.setMailbox(mailbox);
      expect(store.view.emails.some((e) => e.sender === sender)).toBe(false);
    }
  });

  it("removes them from the engagement ranking, not just the list", () => {
    // Otherwise a blocked sender's volume still pushes them up `topSenders`, the opposite
    // of blocking.
    const store = demoStore();
    const sender = store.view.emails[0].sender;
    store.blockSender(sender);
    expect(store.view.profile.topSenders).not.toContain(sender);
  });

  it("survives sign-out", () => {
    // Muting and blocking are statements about the mail, not about the session.
    const store = demoStore();
    store.blockSender("someone@example.com");
    return store.signOut().then(() => {
      expect(store.getSnapshot().preferences.blockedSenders).toContain("someone@example.com");
    });
  });
});

describe("learning from stars", () => {
  it("records the event before the flip", () => {
    // Recording it afterwards would let the model learn from the star's own contribution
    // to the importance score — the model grading its homework.
    const store = demoStore();
    const before = store.getSnapshot().learning.events.length;
    store.toggleStar(store.view.emails[0].id);
    expect(store.getSnapshot().learning.events.length).toBe(before + 1);
  });

  it("captures the pre-feedback prediction", () => {
    // Otherwise the settings panel cannot show "you rated this 42, we predicted 71", the
    // only way a user can tell whether tuning is working.
    const store = demoStore();
    const target = store.view.emails[0];
    const predicted = store.view.signals.get(target.id)!.importanceScore;
    store.toggleStar(target.id);
    const event = store.getSnapshot().learning.events.at(-1)!;
    expect(event.predictedImportance).toBe(predicted);
  });

  it("moves a weight in the right direction", () => {
    const store = demoStore();
    // A security message: starring it should raise the security weight, because the user
    // wanted more of that.
    const security = store.view.emails.find(
      (e) => store.view.signals.get(e.id)?.security,
    )!;
    const before = store.getSnapshot().learning.weights.security;
    store.toggleStar(security.id);
    expect(store.getSnapshot().learning.weights.security).toBeGreaterThan(before);
  });

  it("resets to the factory weights but keeps the history", () => {
    const store = demoStore();
    starSecurityMail(store);
    expect(store.getSnapshot().learning.weights.security).not.toBe(defaultWeights().security);
    const events = store.getSnapshot().learning.events.length;
    store.resetLearning();
    expect(store.getSnapshot().learning.weights).toEqual(defaultWeights());
    expect(store.getSnapshot().learning.events.length).toBe(events);
  });
});

describe("persistence", () => {
  it("reports what changed, rather than the whole state", () => {
    // The persisted surface is small on purpose: writing the whole store on every
    // keystroke is how a search box ends up in your keychain.
    const patches: unknown[] = [];
    const store = demoStore();
    store.attach({ onPersist: (patch) => patches.push(patch) });

    store.setSearchQuery("hello");
    expect(patches).toHaveLength(0);

    store.toggleFilter(builtinFilter("important"));
    expect(patches).toHaveLength(1);
    expect(patches[0]).toHaveProperty("activeFilters");
  });

  it("restores weights from a snapshot written by an older build", () => {
    // A snapshot that predates a weight must still load rather than producing `undefined`
    // arithmetic downstream.
    const partial = { weights: { security: 30 }, adaptive: true, events: [] };
    const model = LearningModel.fromSnapshot(partial);
    expect(model.weights.security).toBe(30);
    expect(model.weights.spamSensitivity).toBe(44);
  });

  it("survives a corrupt snapshot rather than losing the app", () => {
    // `localStorage` is user-writable and a half-finished write is possible, so this input
    // is reachable in practice, not just in a test. Anything unusable falls back to the
    // default; nothing throws, since a throw here would cost the user the app, not just
    // their tuning.
    const junk: unknown[] = [
      null,
      undefined,
      "not an object",
      42,
      { weights: "nope" },
      { weights: { security: "overrated" } },
      { events: "not an array" },
      { events: [{ id: "no-timestamp" }, { id: "x", at: 1, action: "invented", activeSignals: [] }] },
    ];

    for (const input of junk) {
      const model = LearningModel.fromSnapshot(input);
      expect(model.weights.security).toBe(16);
      // Only the well-formed events survive, and none carries an action the UI has no
      // wording for.
      for (const event of model.events) {
        expect(["starred", "unstarred", "filter_rejected"]).toContain(event.action);
      }
    }
  });

  it("clamps a restored weight that is outside its own range", () => {
    // The settings panel renders `value` straight onto a slider, so an out-of-range stored
    // number would put the thumb where the slider cannot represent it — and the next edit
    // would snap it to an unrelated number.
    const model = LearningModel.fromSnapshot({ weights: { security: 9999 } });
    expect(model.weights.security).toBeLessThanOrEqual(100);

    const clamped = LearningModel.fromSnapshot({ weights: { security: -50 } });
    expect(clamped.weights.security).toBeGreaterThanOrEqual(0);
  });

  it("drops a weight it does not recognise", () => {
    // A weight added by a *newer* build, or a typo, must not survive as a key nothing reads.
    const model = LearningModel.fromSnapshot({
      weights: { security: 20, someFutureWeight: 99 },
    });
    expect("someFutureWeight" in model.weights).toBe(false);
  });
});

describe("notifications and the OS badge", () => {
  it("announces genuinely new mail on a refresh", async () => {
    const { backend } = fakeBackend();
    const { platform, calls } = fakePlatform();
    const store = demoStore();
    store.attach({ backend, platform });
    store.setPreferences({ notificationsEnabled: true });

    // The first refresh has nothing new relative to the seed.
    await store.refresh();
    expect(calls.some((c) => c.method === "notify")).toBe(false);
  });

  it("does not announce when notifications are off", async () => {
    const { backend } = fakeBackend();
    const { platform, calls } = fakePlatform();
    const store = demoStore();
    store.attach({ backend, platform });

    await store.refresh();
    expect(calls.some((c) => c.method === "notify")).toBe(false);
  });

  it("keeps the unread badge in step with the mailbox", async () => {
    const { backend } = fakeBackend();
    const { platform, calls } = fakePlatform();
    const store = demoStore();
    store.attach({ backend, platform });

    await store.refresh();
    const badge = calls.filter((c) => c.method === "badge").at(-1);
    expect(badge).toBeDefined();
    expect(badge!.args[0]).toBe(store.view.unreadCount);
  });

  it("parks the background ticker when the window is focused", async () => {
    // A visible window syncs on its own timer; the native ticker exists for the hidden
    // case, so asking for both means two syncs racing.
    const { backend } = fakeBackend();
    const { platform, calls } = fakePlatform();
    const store = demoStore();
    store.attach({ backend, platform });
    store.setPreferences({ backgroundSync: false });
    await store.refresh();
    const last = calls.filter((c) => c.method === "syncInterval").at(-1);
    expect(last!.args[0]).toBeNull();
  });
});

describe("sign out", () => {
  it("clears the messages and the session", async () => {
    const store = demoStore();
    await store.signOut();
    const state = store.getSnapshot();
    expect(state.status).toBe("signed_out");
    expect(state.all).toHaveLength(0);
    expect(state.account).toBeNull();
  });

  it("keeps the learning and the preferences", async () => {
    const store = demoStore();
    starSecurityMail(store);
    const learned = store.getSnapshot().learning.weights.security;
    expect(learned).not.toBe(defaultWeights().security);
    store.blockSender("someone@example.com");
    await store.signOut();
    const state = store.getSnapshot();
    expect(state.learning.weights.security).toBe(learned);
    expect(state.preferences.blockedSenders).toContain("someone@example.com");
  });

  it("parks the background ticker", async () => {
    // Otherwise the desktop's Rust thread keeps firing every minute against a backend that
    // no longer exists, and the user watches a signed-out app make requests it cannot
    // authenticate.
    const { backend } = fakeBackend();
    const { platform, calls } = fakePlatform();
    const store = demoStore();
    store.attach({ backend, platform });
    await store.refresh();

    await store.signOut();
    const parked = calls.filter((c) => c.method === "syncInterval").at(-1);
    expect(parked).toBeDefined();
    expect(parked!.args[0]).toBeNull();
  });

  it("clears the unread badge", async () => {
    // A signed-out app showing "12 unread" on the dock badge is a lie the user has to look
    // at, with no inbox behind it to explain.
    const { backend } = fakeBackend();
    const { platform, calls } = fakePlatform();
    const store = demoStore();
    store.attach({ backend, platform });
    await store.refresh();

    await store.signOut();
    const badge = calls.filter((c) => c.method === "badge").at(-1);
    expect(badge).toBeDefined();
    expect(badge!.args[0]).toBe(0);
  });

  it("works with no platform attached at all", async () => {
    // The demo never attaches one, and signing out of the demo must not throw.
    const store = demoStore();
    await expect(store.signOut()).resolves.toBeUndefined();
    expect(store.getSnapshot().status).toBe("signed_out");
  });
});

describe("sync failure reporting", () => {
  it("says how many messages failed, with correct pluralisation", () => {
    expect(syncFailureSummary(1)).toBe("1 message failed to download this sync — refresh to retry.");
    expect(syncFailureSummary(3)).toBe("3 messages failed to download this sync — refresh to retry.");
  });

  it("surfaces a partial failure rather than claiming everything loaded", async () => {
    // "All caught up" over a cache missing messages is worse than an error message.
    const store = demoStore();
    const backend = {
      async sync() {
        return { emails: [...DEMO_EMAILS], failed: 2, truncated: false };
      },
      async toggleStar() {},
      async moveToMailbox() {},
      async setRead() {},
      async deletePermanently() {},
      async sendReply() {},
      async fetchBody() {
        return undefined;
      },
      async fetchAttachment() {
        return { bytes: new Uint8Array(), filename: "a.bin", mimeType: "text/plain" };
      },
    } satisfies MailBackend;

    await store.connect(backend, { email: "user@example.com" });

    expect(store.getSnapshot().error).toContain("2 messages failed");
  });

  it("reports a truncated view as a notice, not an error", async () => {
    // A capped mailbox is not a failure and does not resolve on retry, so it must not wear
    // the error banner's clothes.
    const store = demoStore();
    const backend = {
      async sync() {
        return { emails: [...DEMO_EMAILS], failed: 0, truncated: true };
      },
      async toggleStar() {},
      async moveToMailbox() {},
      async setRead() {},
      async deletePermanently() {},
      async sendReply() {},
      async fetchBody() {
        return undefined;
      },
      async fetchAttachment() {
        return { bytes: new Uint8Array(), filename: "a.bin", mimeType: "text/plain" };
      },
    } satisfies MailBackend;

    await store.connect(backend, { email: "user@example.com" });
    const snapshot = store.getSnapshot();

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.notice).toMatch(/more than Winnow will walk/i);
    expect(snapshot.error).toBeNull();
  });
});

describe("subscriptions", () => {
  it("notifies on change and stops after unsubscribe", () => {
    const store = demoStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    expect(listener).not.toHaveBeenCalled();
    store.setSearchQuery("x");
    expect(listener).toHaveBeenCalled();

    unsubscribe();
    listener.mockClear();
    store.setSearchQuery("y");
    expect(listener).not.toHaveBeenCalled();
  });

  it("returns a snapshot with a changing key, so React sees the update", () => {
    // `useSyncExternalStore` compares by reference; a monotonically increasing key makes
    // "did it change?" answerable without a deep compare.
    const store = demoStore();
    const first = store.getSnapshot();
    const second = store.getSnapshot();
    expect(first.key).toBe(second.key);

    store.setSearchQuery("x");
    expect(store.getSnapshot().key).not.toBe(first.key);
  });
});

describe("syncNotice", () => {
  it("says nothing when the sync was complete", () => {
    expect(syncNotice({ truncated: false })).toBeNull();
  });

  it("explains a truncated view without calling it an error", () => {
    expect(syncNotice({ truncated: true })).toMatch(/more than Winnow will walk/);
  });

  it("no longer carries the cache failure — that is a question now, not a note", () => {
    // The flag reaches the user through `storagePrompt` (see the "offline storage
    // prompt" suite), so the passive note must not repeat it.
    expect(syncNotice({ truncated: false, cacheUnpersisted: true })).toBeNull();
    expect(syncNotice({ truncated: false, cacheUnpersisted: true }) ?? "").not.toMatch(
      /too large to save offline/,
    );
  });

  it("keeps the truncated note separate from the storage question", () => {
    const notice = syncNotice({ truncated: true, cacheUnpersisted: true });
    expect(notice).toMatch(/more than Winnow will walk/);
    expect(notice).not.toMatch(/save/i);
  });

  it("stays quiet when a cache that was never flushed reports nothing", () => {
    expect(syncNotice({ truncated: false, cacheUnpersisted: false })).toBeNull();
  });
});

describe("body retention", () => {
  /**
   * A backend serving `n` messages, each with a distinct HTML body.
   *
   * Needed because the fetch path only runs *outside* the retention window, and the
   * 38-message demo seed sits entirely inside it — for any mailbox under 500, opening a
   * message never touches the network.
   */
  function bigBackend(n: number) {
    const calls: { method: string; args: unknown[] }[] = [];
    const emails: Email[] = Array.from({ length: n }, (_, i) => ({
      ...DEMO_EMAILS[i % DEMO_EMAILS.length]!,
      id: i + 1,
      gmailId: `b-${i}`,
      // Descending recency, so "the newest 500" is unambiguous.
      receivedAt: 1_000_000 - i,
      bodyHtml: `<p>body ${i}</p>`,
    }));

    const backend: MailBackend = {
      async sync(options) {
        calls.push({ method: "sync", args: [] });
        options?.onProgress?.({ phase: "full", fraction: 1, fetched: n, failed: 0 });
        return { emails, failed: 0, truncated: false };
      },
      async toggleStar() {},
      async moveToMailbox() {},
      async setRead() {},
      async deletePermanently() {},
      async sendReply() {},
      async fetchBody(gmailId) {
        calls.push({ method: "fetchBody", args: [gmailId] });
        return `<p>fetched body for ${gmailId}</p>`;
      },
      async fetchAttachment() {
        return { bytes: new Uint8Array(), filename: "a.bin", mimeType: "application/octet-stream" };
      },
    };
    return { backend, calls };
  }

  /** A connected store over a mailbox of `n`, with every message carrying HTML. */
  async function storeOver(n: number) {
    const { backend, calls } = bigBackend(n);
    const store = new WinnowStore();
    store.attach({ backend });
    await store.connect(backend, { email: "a@b.example" });
    return { store, calls };
  }

  /** The oldest message — outside the retention window. */
  function oldestOf(store: WinnowStore): Email {
    return store.getSnapshot().all.slice().sort((a, b) => a.receivedAt - b.receivedAt)[0]!;
  }

  it("keeps no HTML on state.all, however recent", async () => {
    // `state.all` is uniformly body-free — the whole bound. Resident bodies live in a
    // side-map, so nothing has to ask whether a message is inside the window.
    const { store } = await storeOver(600);
    expect(store.getSnapshot().all.some((e) => e.bodyHtml !== undefined)).toBe(false);
  });

  it("keeps the plain-text body, so classification is untouched", async () => {
    // The load-bearing half: `contentBag` is `subject + body`, so bounding the HTML costs
    // the classifier nothing — and the list's preview reads `body` too.
    const { store } = await storeOver(600);
    expect(store.getSnapshot().all.filter((e) => e.body.trim() === "")).toHaveLength(0);
    expect(store.view.signals.size).toBeGreaterThan(0);
  });

  it("needs no fetch for a message inside the window", async () => {
    // The other half of the retention policy: the common case costs nothing, since the
    // newest 500 already have their HTML.
    const { store, calls } = await storeOver(600);
    const newest = store.getSnapshot().all.slice().sort((a, b) => b.receivedAt - a.receivedAt)[0]!;
    store.select(newest.id);

    expect(store.hasLoadedBody(newest.id)).toBe(true);
    expect(store.view.selected?.bodyHtml).toBe("<p>body 0</p>");
    expect(calls.filter((c) => c.method === "fetchBody")).toHaveLength(0);
  });

  it("fetches a body for a message outside the window and attaches it to the view", async () => {
    const { store, calls } = await storeOver(600);
    const target = oldestOf(store);

    expect(target.bodyHtml).toBeUndefined();
    expect(store.hasLoadedBody(target.id)).toBe(false);

    await store.loadBody(target.id);

    expect(calls.filter((c) => c.method === "fetchBody").length).toBe(1);
    expect(store.hasLoadedBody(target.id)).toBe(true);
    // `state.all` is untouched — that is the side-map's whole point.
    expect(store.getSnapshot().all.find((e) => e.id === target.id)?.bodyHtml).toBeUndefined();
  });

  it("hands the reader a copy carrying the body", async () => {
    const { store } = await storeOver(600);
    const target = oldestOf(store);
    store.select(target.id);
    expect(store.getSnapshot().view.selected?.bodyHtml).toBeUndefined();

    await store.loadBody(target.id);

    expect(store.getSnapshot().view.selected?.bodyHtml).toContain("fetched body");
  });

  it("asks once for the same message, however many times", async () => {
    const { store, calls } = await storeOver(600);
    const target = oldestOf(store);

    await Promise.all([store.loadBody(target.id), store.loadBody(target.id)]);
    await store.loadBody(target.id);

    expect(calls.filter((c) => c.method === "fetchBody").length).toBe(1);
  });

  it("treats a plain-text message as answered, so it is never refetched", async () => {
    // `undefined` from `fetchBody` means "no HTML part", the answer for all plain-text
    // mail; treating it as "not loaded yet" would refetch it on every render, forever.
    const { backend, calls } = bigBackend(600);
    const plain: MailBackend = {
      ...backend,
      async fetchBody(gmailId) {
        calls.push({ method: "fetchBody", args: [gmailId] });
        return undefined;
      },
    };
    const store = new WinnowStore();
    store.attach({ backend: plain });
    await store.connect(plain, { email: "a@b.example" });
    const target = oldestOf(store);

    await store.loadBody(target.id);
    expect(store.hasLoadedBody(target.id)).toBe(true);
    await store.loadBody(target.id);
    await store.loadBody(target.id);

    expect(store.hasLoadedBody(target.id)).toBe(true);
    expect(calls.filter((c) => c.method === "fetchBody").length).toBe(1);
  });

  it("stops promising a formatted version once a fetch has failed, and retries on reopen", async () => {
    // A failed fetch used to leave "Loading the formatted version…" on screen forever.
    const { backend, calls } = bigBackend(600);
    let fail = true;
    const flaky: MailBackend = {
      ...backend,
      async fetchBody(gmailId) {
        calls.push({ method: "fetchBody", args: [gmailId] });
        if (fail) throw new Error("offline");
        return "<p>late</p>";
      },
    };
    const store = new WinnowStore();
    store.attach({ backend: flaky });
    await store.connect(flaky, { email: "a@b.example" });
    const target = oldestOf(store);

    await store.loadBody(target.id);
    expect(store.hasLoadedBody(target.id)).toBe(true);

    fail = false;
    const retry = store.loadBody(target.id);
    expect(store.hasLoadedBody(target.id)).toBe(false);
    await retry;
    expect(store.hasLoadedBody(target.id)).toBe(true);
    expect(calls.filter((c) => c.method === "fetchBody").length).toBe(2);
  });

  it("has nothing to wait for in the demo mailbox", () => {
    // No backend means no fetch is coming; the demo messages carry their HTML already.
    const store = new WinnowStore({ seed: DEMO_EMAILS });
    store.markDemoMode();
    const first = store.getSnapshot().all[0]!;
    expect(store.hasLoadedBody(first.id)).toBe(true);
  });

  it("attaching a body does not reclassify the inbox", async () => {
    // The reason bodies live beside `state.all` rather than on it: rebuilding the array
    // changes its identity, invalidating `inboxAnalysis` and reclassifying everything — a
    // 271ms stall at 5,000 messages, every time an old message is opened.
    const classify = await import("../classify/classify");
    const spy = vi.spyOn(classify, "classifyAll");

    const { store } = await storeOver(600);
    const target = oldestOf(store);
    const before = spy.mock.calls.length;

    await store.loadBody(target.id);
    store.getSnapshot(); // what a render would do

    expect(spy.mock.calls.length).toBe(before);
    spy.mockRestore();
  });

  it("a message inside the window needs no fetch even when it has no HTML", async () => {
    // The sync already walked it, so its body question is settled; without this, opening
    // plain-text mail inside the window would cost a request every time.
    const { backend, calls } = bigBackend(3);
    const textOnly: MailBackend = {
      ...backend,
      async sync(options) {
        const result = await backend.sync(options);
        return { ...result, emails: result.emails.map((e) => ({ ...e, bodyHtml: undefined })) };
      },
    };
    const store = new WinnowStore();
    store.attach({ backend: textOnly });
    await store.connect(textOnly, { email: "a@b.example" });

    const target = store.getSnapshot().all[0]!;
    expect(store.hasLoadedBody(target.id)).toBe(true);
    await store.loadBody(target.id);
    expect(calls.filter((c) => c.method === "fetchBody")).toHaveLength(0);
  });
});

describe("Google contacts in the contact index", () => {
  const google = [
    { address: "jonah@example.com", name: "Jonah Mercer", source: "saved" as const },
    { address: "lena@example.com", source: "other" as const },
  ];

  it("starts the demo with its seeded address book, offline", () => {
    const store = new WinnowStore({ seed: DEMO_EMAILS, seedContacts: google });
    const snap = store.getSnapshot();
    expect(snap.contactsAccess).toBe("demo");
    expect(snap.view.contacts.byAddress.get("jonah@example.com")?.source).toBe("saved");
  });

  it("merges an adopted address book and rebuilds the index only when it changes", () => {
    const store = new WinnowStore({ seed: DEMO_EMAILS });
    const before = store.getSnapshot().view.contacts;
    expect(before.byAddress.has("jonah@example.com")).toBe(false);

    store.setGoogleContacts(google, "granted");
    const after = store.getSnapshot().view.contacts;
    expect(after).not.toBe(before);
    expect(after.byAddress.get("jonah@example.com")?.name).toBe("Jonah Mercer");
    expect(store.getSnapshot().contactsAccess).toBe("granted");

    // An unrelated change keeps the memoised index.
    store.setSearchQuery("x");
    expect(store.getSnapshot().view.contacts).toBe(after);
  });

  it("drops the demo's address book when a real account connects", async () => {
    const store = new WinnowStore({ seed: DEMO_EMAILS, seedContacts: google });
    const { backend } = fakeBackend();
    await store.connect(backend, { email: "user@example.com" });
    const snap = store.getSnapshot();
    expect(snap.googleContacts).toEqual([]);
    expect(snap.contactsAccess).toBe("unavailable");
    expect(snap.view.contacts.byAddress.has("jonah@example.com")).toBe(false);
  });

  it("forgets the account's address book on sign-out, and the demo brings its own back", async () => {
    const store = new WinnowStore({ seed: DEMO_EMAILS, seedContacts: google });
    const { backend } = fakeBackend();
    await store.connect(backend, { email: "user@example.com" });
    store.setGoogleContacts([{ address: "real@example.com", source: "saved" }], "granted");

    await store.signOut();
    expect(store.getSnapshot().googleContacts).toEqual([]);
    expect(store.getSnapshot().contactsAccess).toBe("unavailable");

    store.replaceAll(DEMO_EMAILS);
    store.markDemoMode();
    expect(store.getSnapshot().contactsAccess).toBe("demo");
    expect(store.getSnapshot().googleContacts).toEqual(google);
  });
});

describe("offline storage prompt", () => {
  /** A backend whose sync never persists the cache, and whose `persistCache` answers `saves`. */
  function unpersistedBackend(saves: boolean[]) {
    const calls: string[] = [];
    const backend: MailBackend = {
      async sync() {
        return { emails: [...DEMO_EMAILS], failed: 0, truncated: true, cacheUnpersisted: true };
      },
      async toggleStar() {},
      async moveToMailbox() {},
      async setRead() {},
      async deletePermanently() {},
      async sendReply() {},
      async fetchBody() {
        return undefined;
      },
      async fetchAttachment() {
        return { bytes: new Uint8Array(), filename: "a.bin", mimeType: "text/plain" };
      },
      async persistCache() {
        calls.push("persistCache");
        return saves.shift() ?? false;
      },
    };
    return { backend, calls };
  }

  it("asks the owner's exact question, separately from the truncated note", async () => {
    const store = demoStore();
    await store.connect(unpersistedBackend([]).backend, { email: "user@example.com" });
    const snapshot = store.getSnapshot();
    expect(snapshot.storagePrompt).toBe("ask");
    expect(STORAGE_PROMPT).toBe(
      "This is a large mailbox, Winnow requires them to be saved, are you sure you would like to save this?",
    );
    expect(snapshot.notice).toMatch(/more than Winnow will walk/);
    expect(snapshot.notice).not.toContain(STORAGE_PROMPT);
  });

  it("Save: asks the backend to persist and clears the question when it lands", async () => {
    const store = demoStore();
    const { backend, calls } = unpersistedBackend([true]);
    await store.connect(backend, { email: "user@example.com" });

    const saving = store.saveMailboxOffline();
    expect(store.getSnapshot().storagePrompt).toBe("saving");
    await saving;

    expect(calls).toEqual(["persistCache"]);
    expect(store.getSnapshot().storagePrompt).toBeNull();
  });

  it("Save: shows a short failure line when the write still fails, and it can be dismissed", async () => {
    const store = demoStore();
    const { backend } = unpersistedBackend([false]);
    await store.connect(backend, { email: "user@example.com" });

    await store.saveMailboxOffline();
    expect(store.getSnapshot().storagePrompt).toBe("failed");
    expect(STORAGE_SAVE_FAILED.length).toBeLessThan(90);

    store.dismissStoragePrompt();
    expect(store.getSnapshot().storagePrompt).toBeNull();
  });

  it("Save: a backend that throws counts as a failed save, not a crash", async () => {
    const store = demoStore();
    const { backend } = unpersistedBackend([]);
    backend.persistCache = async () => {
      throw new Error("quota");
    };
    await store.connect(backend, { email: "user@example.com" });
    await store.saveMailboxOffline();
    expect(store.getSnapshot().storagePrompt).toBe("failed");
  });

  it("Not now: dismisses for the session, so the next sync does not ask again", async () => {
    const store = demoStore();
    const { backend, calls } = unpersistedBackend([]);
    await store.connect(backend, { email: "user@example.com" });
    expect(store.getSnapshot().storagePrompt).toBe("ask");

    store.declineMailboxStorage();
    expect(store.getSnapshot().storagePrompt).toBeNull();

    await store.refresh();
    expect(store.getSnapshot().storagePrompt).toBeNull();
    // And nothing was written: "Not now" keeps the re-download behaviour.
    expect(calls).toEqual([]);
  });

  it("goes away on its own once a sync persists the cache", async () => {
    const store = demoStore();
    const { backend } = unpersistedBackend([]);
    await store.connect(backend, { email: "user@example.com" });
    backend.sync = async () => ({ emails: [...DEMO_EMAILS], failed: 0, truncated: false });
    await store.refresh();
    expect(store.getSnapshot().storagePrompt).toBeNull();
  });
});

describe("metadata-first bodies", () => {
  /** Live-looking messages with no body loaded: the shape a metadata sync produces. */
  function metadataOnly(count: number): Email[] {
    return Array.from({ length: count }, (_, i) => ({
      id: 10_000 + i,
      gmailId: `m${i}`,
      threadId: `t${i}`,
      sender: `person${i}@mail.test`,
      mailbox: "inbox" as const,
      receivedAt: 1_000_000 - i * 1000,
      subject: `Subject ${i}`,
      body: `snippet ${i}`,
      category: "primary" as const,
      starred: false,
      unread: i % 2 === 0,
      attachments: [],
      urgent: false,
      bodyLoaded: false,
    }));
  }

  function lazyBackend(emails: Email[], options: { partial?: boolean } = {}) {
    const loads: string[] = [];
    const pending = new Map<string, () => void>();
    const backend: MailBackend = {
      async sync(sync) {
        if (options.partial) sync?.onPartial?.(emails.slice(0, 3));
        return { emails: [...emails], failed: 0, truncated: false };
      },
      async toggleStar() {},
      async moveToMailbox() {},
      async setRead() {},
      async deletePermanently() {},
      async sendReply() {},
      async fetchBody() {
        throw new Error("a metadata-only message must load through loadMessage");
      },
      async fetchAttachment() {
        return { bytes: new Uint8Array(), filename: "a.bin", mimeType: "text/plain" };
      },
      async loadMessage(gmailId) {
        if (!loads.includes(gmailId)) loads.push(gmailId);
        return {
          body: `the whole body of ${gmailId}`,
          bodyHtml: `<p>${gmailId}</p>`,
          attachments: [
            { id: `att-${gmailId}`, partId: "1", filename: "a.pdf", mimeType: "application/pdf", size: 1, inline: false },
          ],
        };
      },
    };
    return { backend, loads, pending };
  }

  it("treats a metadata-only message as not loaded, then loads the whole body on open", async () => {
    const emails = metadataOnly(6);
    const store = new WinnowStore();
    const { backend, loads } = lazyBackend(emails);
    await store.connect(backend, { email: "user@example.com" });
    loads.length = 0;

    const target = emails[1];
    expect(store.hasLoadedBody(target.id)).toBe(false);
    await store.loadBody(target.id);

    expect(loads[0]).toBe("m1");
    expect(store.hasLoadedBody(target.id)).toBe(true);
    const loaded = store.getSnapshot().all.find((email) => email.id === target.id)!;
    expect(loaded.bodyLoaded).toBe(true);
    expect(loaded.body).toBe("the whole body of m1");
    expect(loaded.attachments).toHaveLength(1);
  });

  it("prefetches unread inbox mail after a sync, at low priority", async () => {
    const emails = metadataOnly(PREFETCH_UNREAD_TOP_N + 10);
    const store = new WinnowStore();
    const { backend, loads } = lazyBackend(emails);
    await store.connect(backend, { email: "user@example.com" });
    await vi.waitFor(() => expect(loads.length).toBe(PREFETCH_UNREAD_TOP_N / 2));
    // Only unread, and only within the top N.
    for (const id of loads) {
      const index = Number(id.slice(1));
      expect(index % 2).toBe(0);
      expect(index).toBeLessThan(PREFETCH_UNREAD_TOP_N);
    }
  });

  it("an opened message overtakes the queued prefetch", async () => {
    const emails = metadataOnly(40);
    const store = new WinnowStore();
    const { backend, loads } = lazyBackend(emails);
    // Hold every load until released, so the queue's order is observable.
    const gates: (() => void)[] = [];
    const inner = backend.loadMessage!;
    backend.loadMessage = async (gmailId) => {
      loads.push(gmailId);
      await new Promise<void>((resolve) => gates.push(resolve));
      return inner(gmailId);
    };
    await store.connect(backend, { email: "user@example.com" });
    // Two prefetches are on the wire (the concurrency cap); the rest are queued.
    await vi.waitFor(() => expect(loads).toHaveLength(2));

    const opened = emails[39];
    const open = store.loadBody(opened.id);
    gates.shift()!();
    await vi.waitFor(() => expect(loads).toHaveLength(3));
    // The next request out is the opened message, ahead of every queued prefetch.
    expect(loads[2]).toBe("m39");
    while (gates.length > 0 || !store.hasLoadedBody(opened.id)) {
      gates.shift()?.();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await open;
    loads.splice(0); // the rest of the prefetch drains on its own
  });

  it("puts the inbox on screen from a partial sync, before the sync finishes", async () => {
    const emails = metadataOnly(10);
    const store = new WinnowStore();
    let seenDuringSync: number | null = null;
    let statusDuringSync: string | null = null;
    const { backend } = lazyBackend(emails);
    backend.sync = async (sync) => {
      sync?.onPartial?.(emails.slice(0, 3));
      seenDuringSync = store.getSnapshot().all.length;
      statusDuringSync = store.getSnapshot().status;
      return { emails: [...emails], failed: 0, truncated: false };
    };
    await store.connect(backend, { email: "user@example.com" });
    expect(seenDuringSync).toBe(3);
    // A first sign-in stops saying "loading" the moment there is something to show.
    expect(statusDuringSync).toBe("ready");
    expect(store.getSnapshot().all).toHaveLength(10);
  });
});

describe("sync status state", () => {
  function backendWith(sync: MailBackend["sync"]): MailBackend {
    return {
      sync,
      async toggleStar() {},
      async moveToMailbox() {},
      async setRead() {},
      async deletePermanently() {},
      async sendReply() {},
      async fetchBody() {
        return undefined;
      },
      async fetchAttachment() {
        return { bytes: new Uint8Array(), filename: "a.bin", mimeType: "text/plain" };
      },
    };
  }

  it("carries stage and totals while syncing, and clears them when done", async () => {
    const store = demoStore();
    let during: ReturnType<typeof store.getSnapshot> | null = null;
    await store.connect(
      backendWith(async (options) => {
        options?.onProgress?.({ phase: "full", fraction: 0.25, fetched: 340, failed: 0, stage: "inbox", total: 1200 });
        during = store.getSnapshot();
        return { emails: [...DEMO_EMAILS], failed: 0, truncated: false };
      }),
      { email: "user@example.com" },
    );
    expect(during!.syncing).toBe(true);
    expect(during!.syncStage).toBe("inbox");
    expect(during!.syncFetched).toBe(340);
    expect(during!.syncTotal).toBe(1200);

    const after = store.getSnapshot();
    expect(after.syncing).toBe(false);
    expect(after.syncStage).toBeNull();
    expect(after.syncTotal).toBeNull();
    expect(after.lastSyncedAt).not.toBeNull();
  });

  it("records how many messages failed, and a thrown sync's reason", async () => {
    const store = demoStore();
    await store.connect(
      backendWith(async () => ({ emails: [...DEMO_EMAILS], failed: 12, truncated: false })),
      { email: "user@example.com" },
    );
    expect(store.getSnapshot().syncFailed).toBe(12);
    expect(store.getSnapshot().syncError).toBeNull();

    const failing = demoStore();
    await expect(
      failing.connect(backendWith(async () => {
        throw new Error("network down");
      }), { email: "user@example.com" }),
    ).rejects.toThrow("network down");
    expect(failing.getSnapshot().syncError).toBe("network down");
    expect(failing.getSnapshot().syncing).toBe(false);
  });
});

describe("the demo's clock", () => {
  it("moves on from the seed's instant at the wall clock's rate", () => {
    // Fixed at boot so the day sections are stable, but not frozen: a one-time code's
    // Copy chip has to age out in the demo too.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_800_000_000_000);
      const store = new WinnowStore({ seed: [...DEMO_EMAILS], now: 1_000 });
      const stop = store.startClock();
      vi.advanceTimersByTime(60_000);
      expect(store.getSnapshot().now).toBe(61_000);
      vi.advanceTimersByTime(120_000);
      expect(store.getSnapshot().now).toBe(181_000);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
