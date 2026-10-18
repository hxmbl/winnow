import { describe, expect, it } from "vitest";
import type { KeptReply } from "../core/notify/notifications";
import type { WinnowStore } from "../core/store/store";
import type { Platform } from "../platform/types";
import { saveKeptReplies } from "./notificationActions";

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
