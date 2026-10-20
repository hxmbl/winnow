import { describe, expect, it } from "vitest";
import type { KeptReply } from "../core/notify/notifications";
import type { WinnowStore } from "../core/store/store";
import type { Platform } from "../platform/types";
import { provideAccountRouter, resetAccountRouter, routeNotificationAction, saveKeptReplies } from "./notificationActions";

const KEPT = {
  requestId: "req-1",
  gmailId: "abc123",
  threadId: "t1",
  messageId: 7,
  title: "Ada",
  subject: "Re: plans",
  replyHead: null,
  reply: "On my way",
  at: 1,
};

function fakes() {
  const saved: KeptReply[][] = [];
  const released: string[][] = [];
  const notices: string[] = [];
  let phone = [KEPT];
  const store = {
    getSnapshot: () => ({ status: "ready" }),
    currentAccountId: () => null,
    saveKeptReplies: async (kept: readonly KeptReply[]) => {
      saved.push([...kept]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { saved: kept.length, failed: [] };
    },
    setNotice: (text: string) => void notices.push(text),
  } as unknown as WinnowStore;
  const platform = {
    keptReplies: async () => phone,
    releaseKeptReplies: async (ids: string[]) => {
      released.push(ids);
      phone = phone.filter((reply) => !ids.includes(reply.requestId));
    },
  } as unknown as Platform;
  return { store, platform, saved, released, notices };
}

describe("replies a phone kept", () => {
  it("saves each one to Drafts once when ready, visible and online fire together", async () => {
    const { store, platform, saved, released, notices } = fakes();
    await Promise.all([
      saveKeptReplies(store, platform),
      saveKeptReplies(store, platform),
      saveKeptReplies(store, platform),
    ]);
    expect(saved).toEqual([[expect.objectContaining({ requestId: "req-1" })]]);
    expect(released).toEqual([["req-1"]]);
    expect(notices).toHaveLength(1);

    // A later run starts afresh, and finds nothing left on the phone.
    await saveKeptReplies(store, platform);
    expect(saved).toHaveLength(1);
  });
});

describe("a notification's press, routed to its account", () => {
  it("waits for the launch to restore, switches to the account, then opens the exact message", async () => {
    resetAccountRouter();
    const calls: string[] = [];
    let open = "acct1xx";
    let restored: () => void = () => {};
    const ready = new Promise<void>((resolve) => (restored = resolve));
    const store = {
      openMessage: async (gmailId: string) => {
        calls.push(`open:${open}:${gmailId}`);
        return true;
      },
      getSnapshot: () => ({ all: [] }),
    } as unknown as WinnowStore;
    const platform = { focusWindow: async () => void calls.push("focus") } as unknown as Platform;
    // Pressed before the app is up (a cold start from the notification).
    const done = routeNotificationAction(store, platform, { action: "open", messageId: 5, gmailId: "g5", origin: "desktop", account: "acct2xx" });
    provideAccountRouter({
      ready: () => ready,
      isOpen: (id) => id === open,
      openAccount: async (id) => {
        calls.push(`switch:${id}`);
        open = id;
        return true;
      },
      refreshAccount: async () => {},
      refreshInactive: async () => {},
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([]);
    restored();
    expect(await done).toBe("opened");
    expect(calls).toEqual(["focus", "switch:acct2xx", "open:acct2xx:g5"]);
    resetAccountRouter();
  });

  it("a reply kept for another account waits on the phone until that account is open", async () => {
    const { store, platform, saved, released } = fakes();
    const elsewhere = { ...KEPT, requestId: "req-2", account: "acct2xx" };
    (platform as unknown as { keptReplies: () => Promise<unknown[]> }).keptReplies = async () => [elsewhere];
    await saveKeptReplies(store, platform);
    expect(saved).toEqual([]);
    expect(released).toEqual([]);
  });
});
