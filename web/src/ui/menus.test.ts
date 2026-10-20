import { describe, expect, it, vi } from "vitest";
import { archiveLabel, buildRowMenu, buildScheduledMenu, buildSenderMenu, canSnooze, menuHint, moveTargets, snoozeEntries, tidy, type RowMenuInput } from "./menus";
import { whenPresets } from "../core/mail/when";
import { MENU_MARGIN, placeMenu, type MenuEntry } from "./menuPlacement";
import { avatarInitial, avatarTone } from "./avatar";

const noop = () => {};
function rowInput(over: Partial<RowMenuInput> = {}): RowMenuInput {
  return {
    count: 1,
    mailbox: "inbox",
    anyUnread: false,
    sender: { name: "Ada", address: "ada@example.com", muted: false },
    subject: "Plans",
    actions: {
      reply: noop, replyAll: noop, forward: noop, archive: noop, trash: noop, setRead: noop,
      move: noop, toggleMuteSender: noop, findFrom: noop, findSubject: noop, openInGmail: noop,
    },
    ...over,
  };
}
const ids = (entries: MenuEntry[]) => entries.map((e) => (e.kind === "item" ? e.id : "—"));

describe("the row context menu", () => {
  it("has Gmail's groups, trimmed to what Winnow can do", () => {
    expect(ids(buildRowMenu(rowInput()))).toEqual([
      "reply", "reply-all", "forward", "—",
      "archive", "trash", "mark-unread", "—",
      "move", "mute-sender", "—",
      "find-from", "find-subject", "—",
      "open-gmail",
    ]);
  });

  it("never offers what Winnow cannot do", () => {
    const all = JSON.stringify(buildRowMenu(rowInput()));
    for (const missing of ["Add to tasks", "Forward as attachment"]) {
      expect(all).not.toContain(missing);
    }
  });

  it("has no Label as…: Move to is followed by Mute sender", () => {
    const single = buildRowMenu(rowInput());
    expect(ids(single).slice(8, 10)).toEqual(["move", "mute-sender"]);
    const labels = single.filter((e) => e.kind === "item" && /label/i.test(e.label));
    expect(labels).toEqual([]);
  });

  it("hides single-message items for a multi-selection and counts the rest", () => {
    const entries = buildRowMenu(rowInput({ count: 3, sender: undefined, subject: undefined, anyUnread: true }));
    expect(ids(entries)).toEqual(["archive", "trash", "mark-read", "—", "move"]);
    const archive = entries.find((e) => e.kind === "item" && e.id === "archive");
    expect(archive && archive.kind === "item" && archive.label).toBe("Archive 3");
  });

  it("offers Snooze ▸ after Archive, with the presets and Pick date & time…, where snoozing means something", () => {
    const presets = whenPresets(new Date(2026, 9, 20, 17, 1).getTime());
    const snooze = vi.fn();
    const withSnooze = (mailbox: RowMenuInput["mailbox"]) =>
      buildRowMenu(rowInput({ mailbox, snoozePresets: presets, actions: { ...rowInput().actions, snooze, snoozeCustom: noop, unsnooze: noop } }));
    const entries = withSnooze("inbox");
    expect(ids(entries).slice(4, 6)).toEqual(["archive", "snooze"]);
    const item = entries.find((e) => e.kind === "item" && e.id === "snooze");
    expect(item && item.kind === "item" && item.hint).toBe("b");
    const sub = item && item.kind === "item" ? item.submenu ?? [] : [];
    expect(ids(sub)).toEqual(["snooze-laterToday", "snooze-tomorrow", "snooze-weekend", "snooze-nextWeek", "—", "snooze-custom"]);
    const tomorrow = sub.find((e) => e.kind === "item" && e.id === "snooze-tomorrow");
    if (tomorrow?.kind === "item") tomorrow.onSelect?.();
    expect(snooze).toHaveBeenCalledWith(presets[1]!.at);
    // In Snoozed: Unsnooze in Archive's place, and a new time.
    const snoozed = withSnooze("snoozed");
    const first = snoozed.find((e) => e.kind === "item" && e.id === "archive");
    expect(first?.kind === "item" && first.label).toBe("Unsnooze");
    expect(snoozed.some((e) => e.kind === "item" && e.label === "Change snooze time")).toBe(true);
    for (const mailbox of ["sent", "trash", "spam"] as const) expect(ids(withSnooze(mailbox))).not.toContain("snooze");
    expect(canSnooze("drafts")).toBe(false);
    expect(ids(snoozeEntries([], noop, noop))).toEqual(["snooze-custom"]);
  });

  it("gives a scheduled send Edit, Send now and Cancel schedule, and only Cancel for several", () => {
    expect(ids(buildScheduledMenu({ edit: noop, sendNow: noop, cancel: noop }))).toEqual(["scheduled-edit", "scheduled-send", "scheduled-cancel"]);
    const many = buildScheduledMenu({ edit: noop, sendNow: noop, cancel: noop }, 3);
    expect(ids(many)).toEqual(["scheduled-cancel"]);
    expect(many[0]?.kind === "item" && many[0].label).toBe("Cancel 3 schedules");
    expect(archiveLabel("scheduled")).toBeNull();
    expect(moveTargets("scheduled")).toEqual([]);
  });

  it("prints the shortcut each verb really has", () => {
    const entries = buildRowMenu(rowInput());
    const hint = (id: string) => {
      const entry = entries.find((e) => e.kind === "item" && e.id === id);
      return entry && entry.kind === "item" ? entry.hint : undefined;
    };
    expect(hint("archive")).toBe("e");
    expect(hint("trash")).toBe("#");
    expect(hint("mark-unread")).toBe("u");
    expect(hint("forward")).toBe("f");
    expect(hint("reply-all")).toBe(menuHint("focusReply"));
    expect(hint("reply")).toBeUndefined();
  });

  it("reads archive the way each mailbox means it, and offers no move to Sent", () => {
    expect(archiveLabel("inbox")?.label).toBe("Archive");
    expect(archiveLabel("archive")?.label).toBe("Move to Inbox");
    expect(archiveLabel("spam")?.label).toBe("Not spam");
    expect(archiveLabel("sent")).toBeNull();
    expect(moveTargets("inbox")).toEqual(["archive", "spam", "trash"]);
    expect(ids(buildRowMenu(rowInput({ mailbox: "sent" })))).not.toContain("archive");
  });

  it("says delete forever in the bin, and skips reply there", () => {
    const entries = buildRowMenu(rowInput({ mailbox: "trash" }));
    expect(ids(entries)).not.toContain("reply");
    const trash = entries.find((e) => e.kind === "item" && e.id === "trash");
    expect(trash && trash.kind === "item" && trash.label).toBe("Delete forever");
  });

  it("calls the move action with the chosen mailbox", () => {
    const move = vi.fn();
    const entries = buildRowMenu(rowInput({ actions: { ...rowInput().actions, move } }));
    const submenu = entries.find((e) => e.kind === "item" && e.id === "move");
    const spam = submenu && submenu.kind === "item" ? submenu.submenu!.find((e) => e.kind === "item" && e.id === "move-spam") : undefined;
    if (spam?.kind === "item") spam.onSelect?.();
    expect(move).toHaveBeenCalledWith("spam");
  });
});

describe("the sender menu", () => {
  const actions = { showAll: noop, toggleMute: noop, block: noop, addToContacts: noop, unsubscribe: noop, copyAddress: noop };
  it("offers unsubscribe only with a List-Unsubscribe header", () => {
    const base = { name: "Ada", address: "a@b.c", muted: false, savedContact: false, actions };
    expect(ids(buildSenderMenu({ ...base, canUnsubscribe: false }))).not.toContain("sender-unsubscribe");
    expect(ids(buildSenderMenu({ ...base, canUnsubscribe: true }))).toEqual([
      "sender-all", "sender-copy", "sender-contact", "—", "sender-unsubscribe", "sender-mute", "sender-block",
    ]);
  });

  it("drops Add to contacts for a saved contact and flips mute to unmute", () => {
    const entries = buildSenderMenu({ name: "Ada", address: "a@b.c", muted: true, savedContact: true, canUnsubscribe: false, actions });
    expect(ids(entries)).not.toContain("sender-contact");
    const mute = entries.find((e) => e.kind === "item" && e.id === "sender-mute");
    expect(mute && mute.kind === "item" && mute.label).toBe("Unmute sender");
  });
});

describe("the sender menu's way into selection", () => {
  const actions = { showAll: noop, toggleMute: noop, block: noop, addToContacts: noop, unsubscribe: noop, copyAddress: noop };
  const base = { name: "Ada", address: "a@b.c", muted: false, savedContact: true, canUnsubscribe: false };

  it("leads with Select, set apart from the sender's own items", () => {
    const entries = buildSenderMenu({ ...base, selected: false, fromSenderCount: 1, actions: { ...actions, select: noop, selectAllFromSender: noop } });
    expect(ids(entries).slice(0, 3)).toEqual(["sender-select", "—", "sender-all"]);
    const select = entries[0]!;
    expect(select.kind === "item" && select.label).toBe("Select");
    expect(select.kind === "item" && select.icon).toBeTruthy();
  });

  it("reads Deselect for a row that is already selected", () => {
    const entries = buildSenderMenu({ ...base, selected: true, actions: { ...actions, select: noop } });
    const select = entries.find((e) => e.kind === "item" && e.id === "sender-select");
    expect(select && select.kind === "item" && select.label).toBe("Deselect");
  });

  it("offers Select all from this sender only when there is more than one", () => {
    const withAll = buildSenderMenu({ ...base, selected: false, fromSenderCount: 3, actions: { ...actions, select: noop, selectAllFromSender: noop } });
    const all = withAll.find((e) => e.kind === "item" && e.id === "sender-select-all");
    expect(all && all.kind === "item" && all.label).toBe("Select all 3 from this sender");
    const one = buildSenderMenu({ ...base, selected: false, fromSenderCount: 1, actions: { ...actions, select: noop, selectAllFromSender: noop } });
    expect(ids(one)).not.toContain("sender-select-all");
  });

  it("runs its actions", () => {
    const select = vi.fn();
    const all = vi.fn();
    const entries = buildSenderMenu({ ...base, selected: false, fromSenderCount: 2, actions: { ...actions, select, selectAllFromSender: all } });
    for (const entry of entries) if (entry.kind === "item" && entry.id.startsWith("sender-select")) entry.onSelect?.();
    expect(select).toHaveBeenCalledOnce();
    expect(all).toHaveBeenCalledOnce();
  });

  it("drops both for a message that is not a row in the list", () => {
    expect(ids(buildSenderMenu({ ...base, fromSenderCount: 4, actions: { ...actions, select: noop, selectAllFromSender: noop } }))).not.toContain("sender-select");
  });
});

describe("the sender menu's contact photos offer", () => {
  const actions = { showAll: noop, toggleMute: noop, block: noop, addToContacts: noop, unsubscribe: noop, copyAddress: noop };
  const base = { name: "Ada", address: "a@b.c", muted: false, savedContact: false, canUnsubscribe: false };

  it("offers Show contact photos while contacts are not connected", () => {
    const connect = vi.fn();
    const entries = buildSenderMenu({ ...base, offerContactPhotos: true, actions: { ...actions, connectContacts: connect } });
    const item = entries.find((e) => e.kind === "item" && e.id === "sender-photos");
    expect(item && item.kind === "item" && item.label).toBe("Show contact photos");
    if (item?.kind === "item") item.onSelect?.();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("does not once they are", () => {
    expect(ids(buildSenderMenu({ ...base, offerContactPhotos: false, actions: { ...actions, connectContacts: noop } }))).not.toContain("sender-photos");
  });
});

describe("tidy", () => {
  it("drops leading, trailing and doubled dividers", () => {
    const d = (id: string): MenuEntry => ({ kind: "divider", id });
    const i = (id: string): MenuEntry => ({ kind: "item", id, label: id });
    expect(ids(tidy([d("a"), i("x"), d("b"), d("c"), i("y"), d("e")]))).toEqual(["x", "—", "y"]);
  });
});

describe("placing a menu", () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 240, height: 300 };
  it("opens down-right of a point, flipping at the edges", () => {
    expect(placeMenu({ kind: "point", x: 100, y: 100 }, size, viewport)).toEqual({ left: 100, top: 100 });
    expect(placeMenu({ kind: "point", x: 900, y: 700 }, size, viewport)).toEqual({ left: 660, top: 400 });
  });

  it("never leaves the viewport, even when it is taller than the room", () => {
    const placed = placeMenu({ kind: "point", x: 5, y: 5 }, { width: 240, height: 900 }, viewport);
    expect(placed.left).toBeGreaterThanOrEqual(MENU_MARGIN);
    expect(placed.top).toBe(MENU_MARGIN);
  });

  it("opens under a button, above it when there is no room, and a submenu beside its item", () => {
    const rect = { kind: "rect" as const, top: 100, left: 50, bottom: 130, right: 200 };
    expect(placeMenu(rect, size, viewport)).toEqual({ left: 50, top: 134 });
    expect(placeMenu({ ...rect, top: 700, bottom: 730 }, size, viewport).top).toBe(396);
    expect(placeMenu(rect, size, viewport, "right")).toEqual({ left: 200, top: 96 });
    expect(placeMenu({ ...rect, left: 800, right: 950 }, size, viewport, "right").left).toBe(560);
  });
});

describe("the avatar monogram", () => {
  it("uses the first letter or digit of the name, then the address", () => {
    expect(avatarInitial("ada lovelace", "a@b.c")).toBe("A");
    expect(avatarInitial("  “Quoted” Name", "x@y.z")).toBe("Q");
    expect(avatarInitial("", "zed@example.com")).toBe("Z");
    expect(avatarInitial("—", "")).toBe("?");
  });

  it("gives a sender the same one of two tones every time", () => {
    expect(avatarTone("Ada@Example.com")).toBe(avatarTone("ada@example.com"));
    const tones = new Set(["a@x.y", "b@x.y", "c@x.y", "d@x.y", "e@x.y", "f@x.y"].map(avatarTone));
    expect([...tones].every((tone) => tone === "neutral" || tone === "soft")).toBe(true);
    expect(tones.size).toBe(2);
  });
});

describe("the Drafts row menu", () => {
  it("offers only opening and discarding a draft", () => {
    const entries = buildRowMenu(
      rowInput({ mailbox: "drafts", actions: { ...rowInput().actions, openDraft: noop, discardDraft: noop } }),
    );
    expect(ids(entries)).toEqual(["open-draft", "discard-draft"]);
    const many = buildRowMenu(
      rowInput({ count: 3, mailbox: "drafts", actions: { ...rowInput().actions, openDraft: noop, discardDraft: noop } }),
    );
    expect(ids(many)).toEqual(["discard-draft"]);
    expect(many[0]).toMatchObject({ label: "Discard 3 drafts", danger: true });
  });

  it("files nothing into or out of Drafts", () => {
    expect(archiveLabel("drafts")).toBeNull();
    expect(moveTargets("drafts")).toEqual([]);
    expect(moveTargets("inbox")).not.toContain("drafts");
  });
});
