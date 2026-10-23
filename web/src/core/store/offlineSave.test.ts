import { describe, expect, it, vi } from "vitest";
import { WinnowStore, type MailBackend, type PlatformBridge } from "./store";
import { DEMO_EMAILS } from "../data/demo";
import type { Email } from "../model/email";
import { GmailHttpError } from "../gmail/dto";
import { memoryOfflineStore } from "../offline/offlineStore";
import { LARGE_MAILBOX, offlineNextStep, offlineSummary, type OfflineDecision } from "../offline/offlineSave";

function mailbox(count: number): Email[] {
  const base = DEMO_EMAILS[0];
  return Array.from({ length: count }, (_, i) => ({
    ...base,
    id: 10_000 + i,
    gmailId: `g${i}`,
    threadId: `t${i}`,
    receivedAt: base.receivedAt - i * 60_000,
    bodyLoaded: false,
    bodyHtml: undefined,
  }));
}

/** A backend with an offline store, a server that has `server`, and a sync that answers `emails()`. */
function backendWith(initial: Email[], options: { persist?: boolean } = {}) {
  let emails = initial;
  const server = new Set(initial.map((e) => e.gmailId));
  const store = memoryOfflineStore();
  let decision: OfflineDecision | null = null;
  const requests: string[] = [];
  const backend: MailBackend = {
    async sync() {
      return { emails: [...emails], failed: 0, truncated: false };
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
      return { bytes: new Uint8Array(), filename: "a", mimeType: "text/plain" };
    },
    async persistCache() {
      requests.push("persist");
      return options.persist ?? true;
    },
    offline: {
      store,
      decision: () => decision,
      setDecision: (value) => void (decision = value),
      async body(gmailId) {
        requests.push(`body:${gmailId}`);
        if (!server.has(gmailId)) throw new GmailHttpError(404, "gone");
        return { body: `Body ${gmailId}`, attachments: [] };
      },
      async attachment() {
        return new Uint8Array([1]);
      },
      async gone(gmailIds) {
        await store.remove(gmailIds);
        emails = emails.filter((e) => !gmailIds.includes(e.gmailId));
      },
    },
  };
  return {
    backend,
    store,
    requests,
    decision: () => decision,
    setEmails: (next: Email[]) => void (emails = next),
    deleteOnServer: (gmailId: string) => void server.delete(gmailId),
  };
}

function platform() {
  const withdrawn: string[] = [];
  const bridge: PlatformBridge = {
    notifyNewMail: async () => {},
    setUnreadBadge: async () => {},
    setBackgroundSync: async () => {},
    withdrawNotifications: async (ids) => void withdrawn.push(...ids),
    downloadConditions: () => null,
  };
  return { bridge, withdrawn };
}

const settled = async (store: WinnowStore) =>
  vi.waitFor(() => expect(["done", "paused", "stopped"]).toContain(store.getSnapshot().offline.progress?.state));

describe("the storage question, made real", () => {
  it("a small mailbox is saved without asking: every body downloaded, progress in the snapshot", async () => {
    const store = new WinnowStore();
    const fake = backendWith(mailbox(30));
    store.attach({ platform: platform().bridge });
    await store.connect(fake.backend, { email: "me@example.com" });
    await settled(store);
    const snap = store.getSnapshot();
    expect(snap.storagePrompt).toBeNull();
    expect(fake.decision()).toBe("on");
    expect(snap.offline).toMatchObject({ available: true, decision: "on", progress: { saved: 30, total: 30, state: "done" } });
    expect(fake.requests.filter((r) => r.startsWith("body:"))[0]).toBe("body:g0");
    expect(offlineSummary(snap.offline)).toMatch(/^Saved 30 of 30 · \d+ KB · up to date$/);
  });

  it("a large mailbox asks first; Save persists, remembers yes, and downloads all of it", async () => {
    const store = new WinnowStore();
    const fake = backendWith(mailbox(LARGE_MAILBOX));
    store.attach({ platform: platform().bridge });
    await store.connect(fake.backend, { email: "me@example.com" });
    expect(store.getSnapshot().storagePrompt).toBe("ask");
    expect(fake.requests.some((r) => r.startsWith("body:"))).toBe(false);

    await store.saveMailboxOffline();
    expect(store.getSnapshot().storagePrompt).toBeNull();
    expect(fake.decision()).toBe("on");
    await settled(store);
    expect(store.getSnapshot().offline.progress).toMatchObject({ saved: LARGE_MAILBOX, total: LARGE_MAILBOX });
    expect((await fake.store.savedIds()).size).toBe(LARGE_MAILBOX);
  });

  it("Not now downloads nothing and records no answer (asked again next launch)", async () => {
    const store = new WinnowStore();
    const fake = backendWith(mailbox(LARGE_MAILBOX));
    await store.connect(fake.backend, { email: "me@example.com" });
    store.declineMailboxStorage();
    await store.refresh();
    expect(store.getSnapshot().storagePrompt).toBeNull();
    expect(fake.decision()).toBeNull();
    expect(fake.requests.some((r) => r.startsWith("body:"))).toBe(false);
  });

  it("Save that still cannot write starts nothing", async () => {
    const store = new WinnowStore();
    const fake = backendWith(mailbox(LARGE_MAILBOX), { persist: false });
    await store.connect(fake.backend, { email: "me@example.com" });
    await store.saveMailboxOffline();
    expect(store.getSnapshot().storagePrompt).toBe("failed");
    expect(fake.decision()).toBeNull();
  });

  it("Settings: off stops, Remove downloads empties the store and turns saving off", async () => {
    const store = new WinnowStore();
    const fake = backendWith(mailbox(10));
    await store.connect(fake.backend, { email: "me@example.com" });
    await settled(store);
    expect((await fake.store.savedIds()).size).toBe(10);

    await store.removeOfflineDownloads();
    expect(fake.decision()).toBe("off");
    expect((await fake.store.savedIds()).size).toBe(0);
    await vi.waitFor(() => expect(store.getSnapshot().offline.progress?.saved).toBe(0));
    await store.refresh();
    expect((await fake.store.savedIds()).size).toBe(0);

    store.setOfflineSave(true);
    await vi.waitFor(() => expect(store.getSnapshot().offline.progress).toMatchObject({ saved: 10, state: "done" }));
  });

  it("a message gone on the server leaves the screen and takes its notification down", async () => {
    const store = new WinnowStore();
    const { bridge, withdrawn } = platform();
    store.attach({ platform: bridge });
    const all = mailbox(5);
    const fake = backendWith(all);
    fake.backend.offline!.setDecision("off");
    await store.connect(fake.backend, { email: "me@example.com" });

    // Reported by sync (history or the reconciliation).
    fake.setEmails(all.filter((e) => e.gmailId !== "g1"));
    await store.refresh();
    expect(store.getSnapshot().all.some((e) => e.gmailId === "g1")).toBe(false);
    expect(withdrawn).toEqual(["g1"]);

    // Found by the download: a 404.
    fake.deleteOnServer("g3");
    store.setOfflineSave(true);
    await settled(store);
    expect(store.getSnapshot().all.some((e) => e.gmailId === "g3")).toBe(false);
    expect(withdrawn).toEqual(["g1", "g3"]);
    expect(await fake.store.getBody("g3")).toBeNull();
  });

  it("signing out stops the download; nothing more is written", async () => {
    const store = new WinnowStore();
    const fake = backendWith(mailbox(200));
    await store.connect(fake.backend, { email: "me@example.com" });
    await store.signOut();
    const saved = (await fake.store.savedIds()).size;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await fake.store.savedIds()).size).toBe(saved);
    expect(saved).toBeLessThan(200);
    expect(store.getSnapshot().offline.available).toBe(false);
  });
});

describe("offlineNextStep", () => {
  it("asks for a large or unwritable mailbox, saves a small one, and keeps an answer", () => {
    expect(offlineNextStep(null, LARGE_MAILBOX, { declined: false, unpersisted: false })).toBe("ask");
    expect(offlineNextStep(null, 10, { declined: false, unpersisted: true })).toBe("ask");
    expect(offlineNextStep(null, 10, { declined: false, unpersisted: false })).toBe("save");
    expect(offlineNextStep(null, LARGE_MAILBOX, { declined: true, unpersisted: false })).toBe("keep");
    expect(offlineNextStep("off", 10, { declined: false, unpersisted: false })).toBe("keep");
    expect(offlineNextStep("on", LARGE_MAILBOX, { declined: false, unpersisted: true })).toBe("keep");
  });
});

describe("offlineSummary", () => {
  it("reads like Settings → Storage", () => {
    const progress = { state: "running" as const, saved: 1234, total: 1500, bytes: 312 * 1024 * 1024, failed: 0 };
    expect(offlineSummary({ available: true, decision: "on", progress })).toBe("Saved 1,234 of 1,500 · 312 MB");
    expect(offlineSummary({ available: true, decision: "on", progress: { ...progress, state: "paused", reason: "offline" } })).toBe(
      "Saved 1,234 of 1,500 · 312 MB · waiting for a connection",
    );
    expect(offlineSummary({ available: true, decision: "off", progress: { ...progress, saved: 0 } })).toBe("Not saved offline");
    expect(offlineSummary({ available: false, decision: null, progress: null })).toBe("Not available here");
  });
});
