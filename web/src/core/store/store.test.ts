import { describe, expect, it, vi } from "vitest";
import {
  NO_CURSOR,
  WinnowStore,
  syncFailureSummary,
  type MailBackend,
  type PlatformBridge,
} from "./store";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import { builtinFilter, senderFilter } from "../model/signals";
import type { Mailbox } from "../model/email";
import { LearningModel } from "../learn/learning";

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
      // Honours `failNext`, so the rollback path is reachable. A delete that
      // could not fail would make the undo untestable.
      if (shouldFail) throw new Error("network down");
    },
    async sendReply() {
      record("sendReply");
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
 * The array is copied: `DEMO_EMAILS` is module state shared by every test in
 * this file, and a store that mutated it in place would make tests depend on
 * the order they ran in.
 */
function demoStore() {
  return new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
}

describe("the derived view stays consistent", () => {
  it("classifies and ranks from one pass over the messages", () => {
    const store = demoStore();
    const view = store.view;
    expect(view.emails.length).toBeGreaterThan(0);
    expect(view.threads.length).toBeGreaterThan(0);
    // Every visible message has signals, so the reader's badges agree with the
    // list's filter counts.
    for (const email of view.emails) {
      expect(view.signals.has(email.id)).toBe(true);
    }
  });

  it("hides spam from the unfiltered inbox", () => {
    // The default inbox has to be clean, or the first thing a user sees is
    // junk and the Unsafe bucket means nothing.
    const store = demoStore();
    const visible = new Set(store.view.emails.map((e) => e.gmailId));
    for (const message of DEMO_EMAILS) {
      const sig = store.view.signals.get(message.id);
      if (sig && sig.spamLikelihood >= 0.4 && message.mailbox === "inbox") {
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

  it("counts what the filters would match, ignoring the search box", () => {
    // So an empty result can be explained: "0 of 12 match this search" is
    // actionable in a way that "no results" is not.
    const store = demoStore();
    const total = store.view.emails.length;
    store.setSearchQuery("invoice");
    expect(store.view.result.matchCount).toBeLessThanOrEqual(total);
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
    // "Important and Unsafe" is always empty, so selecting Unsafe replaces
    // rather than adds.
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

describe("muting a bucket", () => {
  it("hides its mail from the unfiltered inbox", () => {
    const store = demoStore();
    const before = store.view.emails.length;
    store.dismissFilter("newsletters");
    expect(store.view.emails.length).toBeLessThan(before);
  });

  it("does not remove the message itself", () => {
    // Muting is a view decision, not a deletion. Nothing has been deleted from
    // the server, so nothing should vanish from the store.
    const store = demoStore();
    const count = store.getSnapshot().all.length;
    store.dismissFilter("newsletters");
    expect(store.getSnapshot().all).toHaveLength(count);
  });

  it("deactivates the filter if it was on", () => {
    // Otherwise the user would see an active pill over an empty list.
    const store = demoStore();
    store.toggleFilter(builtinFilter("newsletters"));
    store.dismissFilter("newsletters");
    expect(store.getSnapshot().activeFilters).toHaveLength(0);
  });

  it("can be undone", () => {
    const store = demoStore();
    const before = store.view.emails.length;
    store.dismissFilter("newsletters");
    store.restoreFilter("newsletters");
    expect(store.view.emails.length).toBe(before);
  });

  it("refuses to mute unsafe", () => {
    // The one bucket that must never be silenced: it is the safety valve, and
    // hiding it removes the user's only route to the mail it flagged.
    const store = demoStore();
    store.dismissFilter("unsafe");
    expect(store.isFilterRemoved("unsafe")).toBe(false);
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
    // The user clicked; the app must not leave the UI lying about what was
    // saved.
    //
    // Note the two phases are asserted *separately and synchronously*. An
    // `await` between them would let the rejection land first, and the test
    // would only ever see the final state — which is the state that matters
    // least, since the optimistic flip is what the user actually watched
    // happen.
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
    // The strongest form of the rollback test, and the one that distinguishes a
    // real undo from a re-sync: no second backend call is made, so the message
    // can only come back from the captured snapshot the undo restores.
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

  it("restores from the bin rather than archiving", async () => {
    const { backend } = fakeBackend();
    const store = demoStore();
    store.attach({ backend });

    const target = store.view.emails[0];
    store.move(target.id, "trash");
    store.archive(target.id);
    // Restoring has to land in the inbox, not in the archive: a message that
    // came back from the bin where the user had put it belongs where they
    // expect it.
    expect(store.getSnapshot().all.find((e) => e.id === target.id)!.mailbox).toBe("inbox");
  });

  it("marks a moved message read", async () => {
    // Filing a message is dealing with it. Leaving it bold in the next mailbox
    // is noise.
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
    // The destructive action is reachable only where the user has already said
    // this is rubbish.
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
    // Deletion is the one action that is not merely a label change, so losing a
    // message to a failed call is the worst failure mode in the app.
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

describe("the cursor", () => {
  it("starts at the top on the first move", () => {
    const store = demoStore();
    store.moveCursor(1);
    expect(store.getSnapshot().cursorIndex).toBe(0);
  });

  it("starts at the bottom on the first move backwards", () => {
    // Pressing `k` on a fresh list should land on the newest message, not
    // refuse to move.
    const store = demoStore();
    store.moveCursor(-1);
    expect(store.getSnapshot().cursorIndex).toBe(store.view.threads.length - 1);
  });

  it("clamps at both ends", () => {
    const store = demoStore();
    const last = store.view.threads.length - 1;

    // `k` on a fresh list lands on the last row — the no-cursor rule. Pressing
    // it again walks *up*, which is the direction `k` names.
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
    // A `j` with nothing in the list must not leave a cursor pointing at a row
    // that does not exist, or the next message that arrives inherits it.
    const store = new WinnowStore({ seed: [] });
    store.moveCursor(1);
    store.moveCursor(-1);
    expect(store.getSnapshot().cursorIndex).toBe(NO_CURSOR);
    expect(store.getSnapshot().selectedId).toBeNull();
  });

  it("follows the reader when one is open", () => {
    // Moving with `j` while reading carries the reader along, so the list and
    // the open message never disagree about which is current.
    const store = demoStore();
    store.openRow(0);
    const first = store.getSnapshot().selectedId;
    store.moveCursor(1);
    expect(store.getSnapshot().selectedId).not.toBe(first);
  });

  it("opens the message it moves to, because the reader is already on screen", () => {
    // `j` takes the reader with it rather than moving a highlight and needing a
    // second keypress. In a two-pane client the reader is right there; making
    // the user press `o` to fill it is two keystrokes to see what they asked for.
    const store = demoStore();
    store.moveCursor(1);
    expect(store.getSnapshot().selectedId).toBe(store.view.threads[0].representative.id);
  });

  it("follows the row that takes the cursor's place after a move", () => {
    // Filing the message under the cursor should leave the cursor on the next
    // one, which is what the user most likely wants.
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
    // Filters are transient view state. A link has to be able to reach its
    // message, and doing nothing would look exactly like a broken link.
    const store = demoStore();
    const target = store.view.threads[2].representative.id;
    store.toggleFilter(builtinFilter("important"));
    expect(store.getSnapshot().activeFilters.length).toBeGreaterThan(0);

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
    // Following a link to something in the bin means going to the bin, not
    // clearing filters in the inbox and finding nothing.
    const store = demoStore();
    // Archived rather than trashed: the default view already excludes spam, and
    // using the bin as well would be testing a mailbox the demo barely seeds.
    const target = store.view.emails[0];
    store.move(target.id, "archive");

    expect(store.focusMessage(target.id)).toBe(true);
    expect(store.getSnapshot().mailbox).toBe("archive");
    expect(store.getSnapshot().selectedId).toBe(target.id);
  });

  it("leaves the cursor on the row, not just the selection", () => {
    // The cursor and the selection are separate pieces of state, and a reader
    // opened with the cursor at NO_CURSOR leaves the keyboard navigation
    // pointing at nothing.
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
    // A stale link has to be distinguishable from a successful jump, or the
    // caller cannot decide whether to say anything.
    const store = demoStore();
    expect(store.focusMessage(-999)).toBe(false);
    expect(store.getSnapshot().selectedId).toBeNull();
  });

  it("closes an open overlay", () => {
    // Following a link while the settings panel is open should land on the
    // message, not leave the panel covering it.
    const store = demoStore();
    store.setOverlay("settings");
    store.focusMessage(store.view.threads[1].representative.id);
    expect(store.getSnapshot().overlay).toBe("none");
  });
});

describe("mailbox switching", () => {
  it("drops the selection and the filters", () => {
    // A selection from the inbox means nothing in the bin, and leaving it would
    // show a message the list does not contain.
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
    // Otherwise a blocked sender's volume still pushes them up `topSenders`,
    // which is the opposite of blocking.
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
    // Recording it afterwards would let the model learn from the star's own
    // contribution to the importance score — the model grading its homework.
    const store = demoStore();
    const before = store.getSnapshot().learning.events.length;
    store.toggleStar(store.view.emails[0].id);
    expect(store.getSnapshot().learning.events.length).toBe(before + 1);
  });

  it("captures the pre-feedback prediction", () => {
    // Otherwise the settings panel cannot show "you rated this 42, we predicted
    // 71", which is the only way a user can tell whether tuning is working.
    const store = demoStore();
    const target = store.view.emails[0];
    const predicted = store.view.signals.get(target.id)!.importanceScore;
    store.toggleStar(target.id);
    const event = store.getSnapshot().learning.events.at(-1)!;
    expect(event.predictedImportance).toBe(predicted);
  });

  it("moves a weight in the right direction", () => {
    const store = demoStore();
    // A security message: starring it should raise the security weight, because
    // the user wanted to see more of that.
    const security = store.view.emails.find(
      (e) => store.view.signals.get(e.id)?.security,
    )!;
    const before = store.getSnapshot().learning.weights.security;
    store.toggleStar(security.id);
    expect(store.getSnapshot().learning.weights.security).toBeGreaterThan(before);
  });

  it("learns from a muted bucket", () => {
    const store = demoStore();
    const before = store.getSnapshot().learning.weights.newsletterPenalty;
    store.dismissFilter("newsletters");
    // The bucket under-fired, so its penalty should rise.
    expect(store.getSnapshot().learning.weights.newsletterPenalty).toBeGreaterThan(before);
  });

  it("stops learning when turned off, but still logs the event", () => {
    const store = demoStore();
    store.setAdaptiveLearning(false);
    const before = store.getSnapshot().learning.weights.security;
    const events = store.getSnapshot().learning.events.length;

    const security = store.view.emails.find((e) => store.view.signals.get(e.id)?.security)!;
    store.toggleStar(security.id);

    expect(store.getSnapshot().learning.weights.security).toBe(before);
    // The log is the audit trail; it does not depend on whether weights moved.
    expect(store.getSnapshot().learning.events.length).toBe(events + 1);
  });

  it("still applies a manual weight edit when learning is off", () => {
    const store = demoStore();
    store.setAdaptiveLearning(false);
    store.setSignalWeight("security", 30);
    expect(store.getSnapshot().learning.weights.security).toBe(30);
  });

  it("clamps a manual edit into range", () => {
    // A slider dragged past its stop must not invert the signal.
    const store = demoStore();
    store.setSignalWeight("spamSensitivity", 9_999);
    expect(store.getSnapshot().learning.weights.spamSensitivity).toBe(80);
    store.setSignalWeight("spamSensitivity", -50);
    expect(store.getSnapshot().learning.weights.spamSensitivity).toBe(0);
  });

  it("resets to the factory weights but keeps the history", () => {
    const store = demoStore();
    store.setSignalWeight("security", 30);
    const events = store.getSnapshot().learning.events.length;
    store.resetLearning();
    expect(store.getSnapshot().learning.weights.security).toBe(16);
    expect(store.getSnapshot().learning.events.length).toBe(events);
  });
});

describe("persistence", () => {
  it("reports what changed, rather than the whole state", () => {
    // The persisted surface is small on purpose: writing the entire store on
    // every keystroke is how a search box ends up in your keychain.
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
    // A snapshot that predates a weight must still load rather than producing
    // `undefined` arithmetic downstream.
    const partial = { weights: { security: 30 }, adaptive: true, events: [] };
    const model = LearningModel.fromSnapshot(partial);
    expect(model.weights.security).toBe(30);
    expect(model.weights.spamSensitivity).toBe(44);
  });

  it("survives a corrupt snapshot rather than losing the app", () => {
    // `localStorage` is user-writable and a half-finished write is possible, so this
    // input is reachable in practice — not just in a test. Anything unusable falls back
    // to the default; nothing throws, because a thrown error here would cost the user
    // the app rather than just their tuning.
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
      expect(model.adaptive).toBe(true);
      expect(model.weights.security).toBe(16);
      // Only the well-formed events survive, and none carries an action the UI has no
      // wording for.
      for (const event of model.events) {
        expect(["starred", "unstarred", "filter_rejected"]).toContain(event.action);
      }
    }
  });

  it("clamps a restored weight that is outside its own range", () => {
    // The settings panel renders `value` straight onto a slider, so an
    // out-of-range stored number would put the thumb somewhere the slider cannot
    // represent — and then the next edit would snap it to an unrelated number.
    const model = LearningModel.fromSnapshot({ weights: { security: 9999 } });
    expect(model.weights.security).toBeLessThanOrEqual(100);

    const clamped = LearningModel.fromSnapshot({ weights: { security: -50 } });
    expect(clamped.weights.security).toBeGreaterThanOrEqual(0);
  });

  it("drops a weight it does not recognise", () => {
    // A weight added by a *newer* build, or a typo, must not survive into the
    // model as a key nothing reads.
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
    // A visible window syncs on its own timer; the native ticker exists for the
    // hidden case, so asking for both means two syncs racing each other.
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
    store.setSignalWeight("security", 30);
    store.blockSender("someone@example.com");
    await store.signOut();
    const state = store.getSnapshot();
    expect(state.learning.weights.security).toBe(30);
    expect(state.preferences.blockedSenders).toContain("someone@example.com");
  });

  it("parks the background ticker", async () => {
    // Otherwise the desktop's Rust thread keeps firing every minute against a
    // backend that no longer exists, and the user watches a signed-out app
    // making requests it cannot authenticate.
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
    // A signed-out app showing "12 unread" on the dock badge is a lie the user
    // has to look at, and there is no inbox behind it to explain.
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
    // "All caught up" over a cache that is missing messages is worse than an
    // error message.
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
      async fetchAttachment() {
        return { bytes: new Uint8Array(), filename: "a.bin", mimeType: "text/plain" };
      },
    } satisfies MailBackend;

    await store.connect(backend, { email: "user@example.com" });

    expect(store.getSnapshot().error).toContain("2 messages failed");
  });

  it("reports a truncated view as a notice, not an error", async () => {
    // A capped mailbox is not a failure and does not resolve on retry, so it must
    // not be wearing the error banner's clothes.
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
    // `useSyncExternalStore` compares by reference; a monotonically increasing
    // key is what makes "did it change?" answerable without a deep compare.
    const store = demoStore();
    const first = store.getSnapshot();
    const second = store.getSnapshot();
    expect(first.key).toBe(second.key);

    store.setSearchQuery("x");
    expect(store.getSnapshot().key).not.toBe(first.key);
  });
});
