import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { KeptReply, NotificationBatch } from "../core/notify/notifications";
import {
  TEST_GMAIL_ID,
  TEST_MESSAGE_ID,
  TEST_REPLY_HEAD,
  isTestNotification,
  testNotificationEmail,
  testPressText,
} from "../core/notify/testNotification";
import { hashId } from "../core/model/ids";
import type { WinnowStore } from "../core/store/store";
import type { Platform } from "../platform/types";
import { resetAccountRouter, routeNotificationAction, saveKeptReplies, sendTestNotification } from "./notificationActions";

/** Rust's side of the test notification (`plan::execute` answers it without a request). */
const PLAN_RS = readFileSync(new URL("../../../native/src-tauri/src/notify_actions/plan.rs", import.meta.url), "utf8");

/** A store with the user's notification settings at their quietest: no buttons, previews hidden. */
function quietStore(flashes: string[] = []) {
  return {
    getSnapshot: () => ({
      status: "ready",
      accountId: null,
      accounts: [],
      all: [],
      preferences: { notificationHidePreview: true, notificationActions: { reply: false, read: false, trash: false } },
    }),
    notificationReplyHeads: async () => {
      throw new Error("the sample's reply head is its own, never built from Gmail");
    },
    flash: (text: string) => void flashes.push(text),
    currentAccountId: () => null,
  } as unknown as WinnowStore;
}

describe("Dev Options → Send test notification", () => {
  it("is a sample that can never be a real message, and Rust stops at the same id", () => {
    expect(isTestNotification(TEST_GMAIL_ID)).toBe(true);
    expect(isTestNotification("18c2f4a9b1d3e5f7")).toBe(false);
    // Real Gmail ids are hex; this one is not.
    expect(/^[0-9a-f]+$/.test(TEST_GMAIL_ID)).toBe(false);
    expect(TEST_MESSAGE_ID).toBe(hashId(TEST_GMAIL_ID));
    expect(PLAN_RS).toContain(`pub const TEST_GMAIL_ID: &str = "${TEST_GMAIL_ID}";`);
    // The reply head Rust's test proves the batch keeps is this exact text.
    expect(PLAN_RS).toContain(`let web_head = ${JSON.stringify(TEST_REPLY_HEAD)};`);
    expect(TEST_REPLY_HEAD).toMatch(/^To: test@winnow\.invalid\r$/m);
    const email = testNotificationEmail(1_000);
    expect(email).toMatchObject({ gmailId: TEST_GMAIL_ID, id: TEST_MESSAGE_ID, unread: true, mailbox: "inbox", receivedAt: 1_000, name: "Winnow" });
  });

  it("posts it through announce with Delete, Mark read and Reply and its picture, whatever the settings say", async () => {
    resetAccountRouter();
    const batches: NotificationBatch[] = [];
    const platform = {
      requestNotificationPermission: async () => true,
      // Android: the monogram is drawn natively (no canvas here, so no bytes), never a URL.
      info: async () => ({ kind: "desktop", os: "android" }),
      notifyNewMail: async (batch: NotificationBatch) => void batches.push(batch),
    } as unknown as Platform;
    expect(await sendTestNotification(quietStore(), platform)).toBe("sent");
    expect(batches).toHaveLength(1);
    const [batch] = batches;
    expect(batch.actions).toEqual({ reply: true, trash: true, read: true });
    expect(batch.hidePreview).toBe(false);
    expect(batch.messages).toEqual([
      expect.objectContaining({ gmailId: TEST_GMAIL_ID, messageId: TEST_MESSAGE_ID, title: "Winnow", subject: "Test notification", replyHead: TEST_REPLY_HEAD }),
    ]);
  });

  it("posts nothing when notifications are not allowed, and says why", async () => {
    let posted = 0;
    const platform = {
      requestNotificationPermission: async () => false,
      info: async () => ({ kind: "desktop", os: "android" }),
      notifyNewMail: async () => void (posted += 1),
    } as unknown as Platform;
    expect(await sendTestNotification(quietStore(), platform)).toBe("denied");
    expect(posted).toBe(0);
    const failing = { ...platform, requestNotificationPermission: async () => true, notifyNewMail: async () => Promise.reject(new Error("no")) } as unknown as Platform;
    expect(await sendTestNotification(quietStore(), failing)).toBe("failed");
  });

  it("a press on it touches no mail: the app only says so (and confirms on the desktop)", async () => {
    resetAccountRouter();
    const flashes: string[] = [];
    const confirmed: unknown[][] = [];
    let focused = 0;
    // No openMessage, setRead, moveWithUndo, ensureMessage or refresh: calling any would throw.
    const store = quietStore(flashes);
    const platform = {
      focusWindow: async () => void (focused += 1),
      confirmNotificationAction: async (...args: unknown[]) => void confirmed.push(args),
    } as unknown as Platform;
    for (const action of ["trash", "read", "reply", "open"] as const) {
      expect(await routeNotificationAction(store, platform, { action, messageId: TEST_MESSAGE_ID, gmailId: TEST_GMAIL_ID, origin: "desktop" })).toBe("test");
    }
    // Android has already answered it natively (without a request); the app just says so.
    expect(
      await routeNotificationAction(store, platform, { action: "trash", messageId: TEST_MESSAGE_ID, gmailId: TEST_GMAIL_ID, origin: "android", outcome: "done" }),
    ).toBe("test");
    expect(flashes).toEqual([
      testPressText("trash"),
      testPressText("read"),
      testPressText("reply"),
      testPressText("open"),
      testPressText("trash"),
    ]);
    expect(flashes[0]).toBe("Test notification: Delete did nothing. It isn't a real message.");
    expect(confirmed.map((args) => args[1])).toEqual(["Test notification", "Test notification", "Test notification"]);
    expect(focused).toBe(1);
  });

  it("a reply typed into it and kept on the phone is let go, never saved to Drafts", async () => {
    const saved: KeptReply[][] = [];
    const released: string[][] = [];
    const store = {
      ...quietStore(),
      getSnapshot: () => ({ status: "ready" }),
      currentAccountId: () => null,
      saveKeptReplies: async (kept: readonly KeptReply[]) => {
        saved.push([...kept]);
        return { saved: kept.length, failed: [] };
      },
      setNotice: () => {},
    } as unknown as WinnowStore;
    const platform = {
      keptReplies: async () => [
        { requestId: "req-t", gmailId: TEST_GMAIL_ID, threadId: null, messageId: TEST_MESSAGE_ID, title: "Winnow", subject: "Test notification", replyHead: TEST_REPLY_HEAD, reply: "hi", at: 1 },
      ],
      releaseKeptReplies: async (ids: string[]) => void released.push(ids),
    } as unknown as Platform;
    await saveKeptReplies(store, platform);
    expect(saved).toEqual([]);
    expect(released).toEqual([["req-t"]]);
  });
});
