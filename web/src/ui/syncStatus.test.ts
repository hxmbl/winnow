import { describe, expect, it } from "vitest";
import { syncStatus, syncedAgo, type SyncStatusInput } from "./syncStatus";

const NOW = Date.UTC(2026, 9, 14, 10, 45);

function input(over: Partial<SyncStatusInput> = {}): SyncStatusInput {
  return {
    signedIn: true,
    syncing: false,
    syncPhase: null,
    syncStage: null,
    syncFetched: 0,
    syncTotal: null,
    lastSyncedAt: NOW,
    syncError: null,
    syncFailed: 0,
    sending: false,
    online: true,
    paused: false,
    now: NOW,
    clock: () => "10:42",
    ...over,
  };
}

describe("syncStatus — idle", () => {
  it("says Synced just now, with a Sync now button", () => {
    const status = syncStatus(input());
    expect(status).toMatchObject({ line: "Synced just now", button: "Sync now", busy: false, tone: "idle" });
  });

  it("counts minutes, and refreshes as `now` moves", () => {
    expect(syncStatus(input({ now: NOW + 3 * 60_000 })).line).toBe("Synced 3 min ago");
    expect(syncStatus(input({ now: NOW + 61 * 60_000 })).line).toBe("Synced 1 hr ago");
  });

  it("says Not synced yet before the first sync", () => {
    expect(syncStatus(input({ lastSyncedAt: null })).line).toBe("Not synced yet");
  });

  it("says Sync paused when automatic sync is off", () => {
    expect(syncStatus(input({ paused: true, now: NOW + 3 * 60_000 })).line).toBe(
      "Sync paused: last synced 3 min ago",
    );
    expect(syncStatus(input({ paused: true, lastSyncedAt: null })).line).toBe("Sync paused");
  });

  it("says Offline with the last sync's wall-clock time", () => {
    const status = syncStatus(input({ online: false, lastSyncedAt: NOW - 3 * 60_000 }));
    expect(status.line).toBe("Offline: last synced 10:42");
    expect(status.busy).toBe(false);
    expect(syncStatus(input({ online: false, lastSyncedAt: null })).line).toBe("Offline: not synced yet");
  });

  it("is the demo line in the demo", () => {
    expect(syncStatus(input({ signedIn: false })).line).toBe("Demo mailbox. Nothing leaves this device.");
  });
});

describe("syncStatus — syncing", () => {
  it("shows the inbox count while a full sync walks the inbox", () => {
    const status = syncStatus(
      input({ syncing: true, syncPhase: "full", syncStage: "inbox", syncFetched: 340, syncTotal: 1200 }),
    );
    expect(status).toMatchObject({ line: "Syncing inbox, 340 of 1,200", button: "Syncing…", busy: true, tone: "busy" });
  });

  it("then says it is syncing the other folders", () => {
    expect(
      syncStatus(input({ syncing: true, syncPhase: "full", syncStage: "other", syncFetched: 1300, syncTotal: 1600 })).line,
    ).toBe("Syncing other folders");
  });

  it("counts changes on an incremental sync, and falls back to Syncing… with no count", () => {
    expect(syncStatus(input({ syncing: true, syncPhase: "incremental", syncFetched: 3, syncTotal: 5 })).line).toBe(
      "Syncing changes, 3 of 5",
    );
    expect(syncStatus(input({ syncing: true, syncPhase: "incremental" })).line).toBe("Syncing…");
    expect(syncStatus(input({ syncing: true })).line).toBe("Syncing…");
    expect(syncStatus(input({ syncing: true, syncPhase: "full", syncStage: "inbox" })).line).toBe("Syncing inbox…");
  });

  it("says Sending… while a reply goes out", () => {
    expect(syncStatus(input({ sending: true })).line).toBe("Sending…");
  });

  it("never shows an idle label mid-sync — even with an old error or failures on record", () => {
    const status = syncStatus(input({ syncing: true, syncError: "boom", syncFailed: 3, online: false }));
    expect(status.line).toMatch(/^Syncing/);
    expect(status.button).toBe("Syncing…");
  });

  it("never shows a syncing label when nothing is running", () => {
    for (const over of [{}, { syncError: "x" }, { syncFailed: 2 }, { online: false }, { paused: true }, { sending: true }]) {
      const status = syncStatus(input({ ...over, syncPhase: "full", syncStage: "inbox", syncTotal: 10 }));
      expect(status.line).not.toMatch(/^Syncing/);
      expect(status.button).not.toMatch(/Syncing/);
      expect(status.busy).toBe(false);
    }
  });
});

describe("syncStatus — failures", () => {
  it("says Couldn't sync with the reason, and offers Retry", () => {
    const status = syncStatus(input({ syncError: "Could not reach Gmail." }));
    expect(status).toMatchObject({ line: "Couldn't sync: Could not reach Gmail.", button: "Retry", tone: "error" });
  });

  it("says how many messages failed to download", () => {
    expect(syncStatus(input({ syncFailed: 12 })).line).toBe("12 messages failed to download");
    expect(syncStatus(input({ syncFailed: 1 })).line).toBe("1 message failed to download");
    expect(syncStatus(input({ syncFailed: 1 })).button).toBe("Retry");
  });
});

describe("syncedAgo", () => {
  it("reads naturally at each scale", () => {
    expect(syncedAgo(NOW, NOW + 10_000)).toBe("just now");
    expect(syncedAgo(NOW, NOW + 60_000)).toBe("1 min ago");
    expect(syncedAgo(NOW, NOW + 2 * 86_400_000)).toBe("2 days ago");
  });
});
