import { describe, expect, it } from "vitest";
import { ariaKey, readerActions } from "./readerActions";

const ids = (list: ReturnType<typeof readerActions>) => list.map((action) => action.id);

describe("the reader's action bar", () => {
  it("leads with Reply all, then the two ways out, then the toggles", () => {
    const inbox = readerActions("inbox", { starred: false, unread: false });
    expect(ids(inbox)).toEqual(["reply", "forward", "archive", "trash", "read", "star"]);
    expect(inbox.filter((action) => action.primary).map((action) => action.id)).toEqual(["reply"]);
    expect(inbox.map((action) => action.group)).toEqual(["respond", "respond", "leave", "leave", "toggle", "toggle"]);
  });

  it("names Archive and Delete for the mailbox the message is in", () => {
    const text = (mailbox: Parameters<typeof readerActions>[0]) =>
      readerActions(mailbox, { starred: false, unread: false }).map((action) => action.text);
    expect(text("inbox").slice(2, 4)).toEqual(["Archive", "Delete"]);
    expect(text("archive").slice(2, 4)).toEqual(["Inbox", "Delete"]);
    expect(text("trash").slice(2, 4)).toEqual(["Restore", "Delete forever"]);
    expect(ids(readerActions("spam", { starred: false, unread: false })).slice(2, 4)).toEqual(["notSpam", "trash"]);
  });

  it("shows each action's key from the shortcut table, and none where there is none", () => {
    const list = readerActions("inbox", { starred: false, unread: false });
    const keys = Object.fromEntries(list.map((action) => [action.id, action.keys]));
    expect(keys).toMatchObject({ reply: "r", forward: "f", archive: "e", star: "s" });
    expect(keys.trash).toMatch(/^#/);
    // Opening marks read, so "Mark read" has no key of its own; "Mark unread" does.
    expect(readerActions("inbox", { starred: false, unread: true }).find((a) => a.id === "read")?.keys).toBeNull();
  });

  it("reflects the star and read state in the toggles", () => {
    const list = readerActions("inbox", { starred: true, unread: true });
    expect(list.find((a) => a.id === "star")).toMatchObject({ label: "Unstar", pressed: true });
    expect(list.find((a) => a.id === "read")?.label).toBe("Mark read");
  });

  it("gives aria-keyshortcuts a single plain key", () => {
    expect(ariaKey("e")).toBe("e");
    expect(ariaKey("# / ⌫")).toBe("#");
    expect(ariaKey("u / m")).toBe("u");
    expect(ariaKey(null)).toBeNull();
    expect(ariaKey("Esc")).toBeNull();
  });
});
