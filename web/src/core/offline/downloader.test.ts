import { describe, expect, it, vi } from "vitest";
import { GmailHttpError } from "../gmail/dto";
import { TaskQueue } from "../gmail/pool";
import type { Attachment, LoadedBody } from "../model/email";
import {
  ATTACHMENT_DOWNLOAD_CAP,
  OfflineDownloader,
  attachmentsToSave,
  type DownloadBlock,
  type DownloadSource,
  type DownloadTarget,
} from "./downloader";
import { memoryOfflineStore } from "./offlineStore";

const MB = 1024 * 1024;

function attachment(id: string, size: number, inline = false): Attachment {
  return { id, partId: id, filename: `${id}.bin`, mimeType: "application/octet-stream", size, inline };
}

/** A source over `count` messages, m0 the oldest; records every request. */
function source(count: number, options: { attachments?: Record<string, Attachment[]>; fail?: Record<string, number | "transient"> } = {}) {
  const targets: DownloadTarget[] = Array.from({ length: count }, (_, i) => ({ gmailId: `m${i}`, receivedAt: 1000 + i }));
  const requests: string[] = [];
  const gone: string[] = [];
  const impl: DownloadSource = {
    targets: () => targets,
    async body(gmailId): Promise<LoadedBody> {
      requests.push(`body:${gmailId}`);
      const fail = options.fail?.[gmailId];
      if (fail === "transient") throw new TypeError("Failed to fetch");
      if (typeof fail === "number") throw new GmailHttpError(fail, "nope");
      return { body: `Body ${gmailId}`, bodyHtml: `<p>${gmailId}</p>`, attachments: options.attachments?.[gmailId] ?? [] };
    },
    async attachment(gmailId, attachmentId) {
      requests.push(`file:${gmailId}:${attachmentId}`);
      return new Uint8Array([1, 2, 3]);
    },
    async gone(gmailId) {
      gone.push(gmailId);
      const at = targets.findIndex((target) => target.gmailId === gmailId);
      if (at >= 0) targets.splice(at, 1);
    },
  };
  return { impl, targets, requests, gone };
}

const direct = <T,>(task: () => Promise<T>) => task();

describe("OfflineDownloader", () => {
  it("saves every message newest first, with its body, and reports progress", async () => {
    const store = memoryOfflineStore();
    const src = source(4);
    const progress = vi.fn();
    const run = new OfflineDownloader({ store, source: src.impl, schedule: direct, onProgress: progress, batchSize: 2 });
    await run.start();
    expect(src.requests).toEqual(["body:m3", "body:m2", "body:m1", "body:m0"]);
    expect((await store.getBody("m2"))?.bodyHtml).toBe("<p>m2</p>");
    expect(run.progress()).toMatchObject({ state: "done", saved: 4, total: 4 });
    expect(run.progress().bytes).toBeGreaterThan(0);
  });

  it("resumes after a restart without downloading anything twice", async () => {
    const store = memoryOfflineStore();
    const first = source(5);
    let calls = 0;
    // The first run is cut short (the app closed) after two messages.
    const cut = new OfflineDownloader({
      store,
      source: first.impl,
      schedule: direct,
      conditions: () => (calls++ >= 2 ? "offline" : null),
    });
    await cut.start();
    expect(cut.progress()).toMatchObject({ state: "paused", reason: "offline", saved: 2 });

    const second = source(5);
    const resumed = new OfflineDownloader({ store, source: second.impl, schedule: direct });
    await resumed.start();
    expect(second.requests).toEqual(["body:m2", "body:m1", "body:m0"]);
    expect(resumed.progress()).toMatchObject({ state: "done", saved: 5, total: 5 });
  });

  it("goes through the shared queue at low priority, so an opened message never waits behind the walk", async () => {
    const queue = new TaskQueue(1);
    const order: string[] = [];
    const store = memoryOfflineStore();
    const src = source(3);
    const original = src.impl.body;
    src.impl.body = async (id) => {
      order.push(`download:${id}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return original(id);
    };
    const run = new OfflineDownloader({ store, source: src.impl, schedule: (task) => queue.push(task, "low") });
    const walk = run.start();
    // The reader opens a message while the first download is on the wire.
    await new Promise((resolve) => setTimeout(resolve, 1));
    const opened = queue.push(async () => order.push("opened"), "high");
    await Promise.all([walk, opened]);
    expect(order[0]).toBe("download:m2");
    expect(order[1]).toBe("opened");
    // One download at a time: never more than one queue slot taken by the walk.
    expect(order.filter((step) => step.startsWith("download")).length).toBe(3);
  });

  it("saves attachments up to the cap (inline pictures included) and leaves bigger ones on demand", async () => {
    expect(ATTACHMENT_DOWNLOAD_CAP).toBe(10 * MB);
    const body: LoadedBody = {
      body: "",
      attachments: [attachment("small", MB), attachment("edge", 10 * MB), attachment("big", 10 * MB + 1), attachment("logo", 2000, true)],
    };
    expect(attachmentsToSave(body)).toEqual({ save: ["small", "edge", "logo"], skipped: 1 });

    const store = memoryOfflineStore();
    const src = source(1, { attachments: { m0: body.attachments } });
    await new OfflineDownloader({ store, source: src.impl, schedule: direct }).start();
    expect(src.requests).toEqual(["body:m0", "file:m0:small", "file:m0:edge", "file:m0:logo"]);
    const saved = await store.getBody("m0");
    expect(saved).toMatchObject({ files: ["small", "edge", "logo"], skipped: 1 });
    expect(await store.getFile("m0", "big")).toBeNull();
    expect(await store.getFile("m0", "small")).not.toBeNull();
  });

  it("pauses for each condition and picks up again on the next start", async () => {
    for (const block of ["offline", "hidden", "metered", "battery"] satisfies DownloadBlock[]) {
      const store = memoryOfflineStore();
      const src = source(2);
      let now: DownloadBlock | null = block;
      const run = new OfflineDownloader({ store, source: src.impl, schedule: direct, conditions: () => now });
      await run.start();
      expect(run.progress()).toMatchObject({ state: "paused", reason: block, saved: 0 });
      expect(src.requests).toEqual([]);
      now = null;
      await run.start();
      expect(run.progress()).toMatchObject({ state: "done", saved: 2 });
    }
  });

  it("a 404 removes the message locally; nothing is stored for it", async () => {
    const store = memoryOfflineStore();
    const src = source(3, { fail: { m1: 404 } });
    const run = new OfflineDownloader({ store, source: src.impl, schedule: direct });
    await run.start();
    expect(src.gone).toEqual(["m1"]);
    expect(await store.getBody("m1")).toBeNull();
    expect(run.progress()).toMatchObject({ state: "done", saved: 2, total: 2 });
  });

  it("a network or auth error pauses everything and deletes nothing", async () => {
    for (const fail of ["transient", 401, 503] as const) {
      const store = memoryOfflineStore();
      const src = source(3, { fail: { m1: fail } });
      const run = new OfflineDownloader({ store, source: src.impl, schedule: direct });
      await run.start();
      expect(src.gone).toEqual([]);
      expect(run.progress()).toMatchObject({ state: "paused", reason: "error", saved: 1 });
      expect(src.requests).toEqual(["body:m2", "body:m1"]);
    }
  });

  it("another failure skips that message for the session and carries on", async () => {
    const store = memoryOfflineStore();
    const src = source(3, { fail: { m1: 400 } });
    const run = new OfflineDownloader({ store, source: src.impl, schedule: direct });
    await run.start();
    expect(run.progress()).toMatchObject({ state: "done", saved: 2, failed: 1 });
    expect(src.gone).toEqual([]);
  });

  it("stop() (sign-out, switch, Remove downloads) writes nothing more, even for a request already on the wire", async () => {
    const store = memoryOfflineStore();
    const src = source(3);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = src.impl.body;
    src.impl.body = async (id) => {
      await gate;
      return original(id);
    };
    const run = new OfflineDownloader({ store, source: src.impl, schedule: direct });
    const walk = run.start();
    run.stop();
    release();
    await walk;
    expect((await store.savedIds()).size).toBe(0);
    expect(run.progress().state).toBe("stopped");
  });

  it("logs each batch for the Debug log", async () => {
    const store = memoryOfflineStore();
    const log = vi.fn();
    await new OfflineDownloader({ store, source: source(5).impl, schedule: direct, log, batchSize: 2 }).start();
    const batches = log.mock.calls.filter(([event]) => event === "batch");
    expect(batches.length).toBe(3);
    expect(batches[2][1]).toMatchObject({ saved: 1, done: 5, total: 5 });
  });
});
