import { describe, expect, it } from "vitest";
import {
  pillTop,
  PILL_HEIGHT,
  SYNC_RETURN_MS,
  currentNotice,
  isAction,
  noticeKey,
  pillAnnouncement,
  pillClock,
  pillText,
  returnsToSync,
  sendingText,
  type PillNotice,
} from "./statusPill";
import { PULL_RESULT_MS } from "./pullRefresh";

const undo = (at: number, label = "Moved to Trash."): PillNotice => ({ kind: "undo", at, label });
const flash = (at: number, text = "Draft saved."): PillNotice => ({ kind: "flash", at, text });
const sending = (at: number, deadline = at + 10_000): PillNotice => ({ kind: "sending", at, deadline });
const sync = (at: number, text = "Synced just now"): PillNotice => ({ kind: "sync", at, text, ok: true });

describe("what the status pill shows", () => {
  it("shows nothing when nothing is on offer", () => {
    expect(currentNotice([])).toBeNull();
    expect(currentNotice([null, undefined, null])).toBeNull();
  });

  it("shows the newest notice", () => {
    expect(currentNotice([undo(1), flash(2)])).toEqual(flash(2));
    expect(currentNotice([flash(2), undo(3)])).toEqual(undo(3));
    expect(currentNotice([sending(5), undo(3), flash(4), sync(1)])).toEqual(sending(5));
    // A pull's result after an Undo was offered: the newer one, the sync line.
    expect(currentNotice([undo(1), sync(2)])).toEqual(sync(2));
  });

  it("brings an older notice back when the newer one goes", () => {
    // "Draft saved." over a Trash undo: once the flash has gone, the Undo is back.
    expect(currentNotice([undo(1), flash(2)])?.kind).toBe("flash");
    expect(currentNotice([undo(1), null])?.kind).toBe("undo");
  });

  it("breaks a tie by what matters more: a waiting send, an undo, a flash, the sync line", () => {
    expect(currentNotice([sync(1), flash(1), undo(1), sending(1)])?.kind).toBe("sending");
    expect(currentNotice([sync(1), flash(1), undo(1)])?.kind).toBe("undo");
    expect(currentNotice([sync(1), flash(1)])?.kind).toBe("flash");
  });

  it("puts an update notice under an undo and over a flash, and lets newer notices cover it", () => {
    const update: PillNotice = { kind: "update", at: 1, text: "Winnow 1.5.0 is available.", button: "Update" };
    expect(currentNotice([flash(1), update, sync(1)])?.kind).toBe("update");
    expect(currentNotice([undo(1), update])?.kind).toBe("undo");
    expect(currentNotice([update, flash(2)])?.kind).toBe("flash");
    expect(currentNotice([update, null])?.kind).toBe("update");
    expect(isAction(update)).toBe(true);
  });

  it("gives each notice its own key, so a repeat of the same words still arrives anew", () => {
    expect(noticeKey(undo(1))).not.toBe(noticeKey(undo(2)));
    expect(noticeKey(undo(1))).not.toBe(noticeKey(flash(1)));
  });
});

describe("returning to the sync status", () => {
  it("happens when an action notice ends", () => {
    expect(returnsToSync(undo(1), null)).toBe(true);
    expect(returnsToSync(flash(1), null)).toBe(true);
    expect(returnsToSync(sending(1), null)).toBe(true);
  });

  it("does not happen when one action replaces another, or the sync line itself ends", () => {
    expect(returnsToSync(undo(1), flash(2))).toBe(false);
    expect(returnsToSync(sending(1), undo(2))).toBe(false);
    expect(returnsToSync(sync(1), null)).toBe(false);
    expect(returnsToSync(null, null)).toBe(false);
  });

  it("is an action notice ending into a pull's result too: the result is the sync status", () => {
    expect(returnsToSync(undo(1), sync(2))).toBe(true);
  });

  it("lasts as long as a pull's result", () => {
    expect(SYNC_RETURN_MS).toBe(PULL_RESULT_MS);
  });

  it("knows an action from the sync line", () => {
    expect(isAction(undo(1))).toBe(true);
    expect(isAction(sync(1))).toBe(false);
    expect(isAction(null)).toBe(false);
  });
});

describe("the words", () => {
  it("counts a waiting send down in whole seconds", () => {
    expect(sendingText(10_000, 0)).toBe("Sending in 10s…");
    expect(sendingText(10_000, 9_100)).toBe("Sending in 1s…");
    expect(sendingText(10_000, 10_000)).toBe("Sending…");
    expect(sendingText(10_000, 12_000)).toBe("Sending…");
  });

  it("never counts a new send from a stale tick", () => {
    // The pill's clock last ticked a minute ago; a 10s send starts now.
    const notice = sending(60_000, 70_000);
    expect(pillText(notice, pillClock(0, notice))).toBe("Sending in 10s…");
    expect(pillClock(65_000, notice)).toBe(65_000);
    expect(pillClock(5, null)).toBe(5);
  });

  it("says each notice as it is", () => {
    expect(pillText(undo(1, "Draft discarded."), 0)).toBe("Draft discarded.");
    expect(pillText(flash(1, "Message sent."), 0)).toBe("Message sent.");
    expect(pillText(sync(1, "Synced just now · 3 waiting on you"), 0)).toBe("Synced just now · 3 waiting on you");
    expect(pillText(sending(0, 5_000), 0)).toBe("Sending in 5s…");
  });

  it("tells a screen reader once, with the Undo, and never the countdown", () => {
    expect(pillAnnouncement(undo(1))).toBe("Moved to Trash. Undo is available.");
    expect(pillAnnouncement(sending(1))).toBe("Sending. Undo is available.");
    expect(pillAnnouncement(sending(1))).not.toMatch(/\d/);
    expect(pillAnnouncement(flash(1))).toBe("Draft saved.");
    expect(pillAnnouncement(null)).toBe("");
    expect(
      pillAnnouncement({ kind: "update", at: 1, text: "Winnow 1.5.0 is available.", button: "Update" }),
    ).toBe("Winnow 1.5.0 is available. Button: Update.");
    expect(
      pillAnnouncement({ kind: "update", at: 1, text: "Winnow 1.5.0 is out. Run git pull to update.", button: null }),
    ).toBe("Winnow 1.5.0 is out. Run git pull to update.");
    expect(pillText({ kind: "update", at: 1, text: "Winnow 1.5.0 is available.", button: "Update" }, 0)).toBe(
      "Winnow 1.5.0 is available.",
    );
  });
});

describe("keeping off the demo strip", () => {
  const rest = 76;
  it("rests under the chrome with nothing to avoid", () => {
    expect(pillTop(rest, null)).toBe(rest);
  });
  it("drops below the strip when it would cover it (Connect Gmail)", () => {
    const strip = { top: 66, bottom: 118 };
    const top = pillTop(rest, strip);
    expect(top).toBe(126);
    // Never overlapping: the pill starts below the strip's bottom edge.
    expect(top).toBeGreaterThanOrEqual(strip.bottom);
  });
  it("follows a strip that is partly scrolled under the top bar", () => {
    expect(pillTop(rest, { top: 40, bottom: 92 })).toBe(100);
  });
  it("stays put once the strip has scrolled away above it, or sits wholly below it", () => {
    expect(pillTop(rest, { top: 10, bottom: rest })).toBe(rest);
    expect(pillTop(rest, { top: rest + PILL_HEIGHT, bottom: rest + PILL_HEIGHT + 50 })).toBe(rest);
  });
  it("ignores an empty box", () => {
    expect(pillTop(rest, { top: 80, bottom: 80 })).toBe(rest);
  });
});
