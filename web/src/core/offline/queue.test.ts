import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  OFFLINE_QUEUE_KEY,
  OfflineQueue,
  backoffDelay,
  classifyFailure,
  overlay,
  type DriveHooks,
  type QueueDrop,
  type QueueStorage,
  type QueueTimers,
} from "./queue";
import { GmailError, GmailHttpError, GoogleUnreachable } from "../gmail/dto";
import type { Draft, DraftDriveShare, Email } from "../model/email";
import type { MailBackend } from "../store/store";

const offlineError = () => new TypeError("Failed to fetch");

function memoryStorage(): QueueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function manualTimers(): QueueTimers & { fire: () => void; delays: number[]; pending: () => number } {
  let jobs: { handle: number; callback: () => void }[] = [];
  let next = 0;
  const delays: number[] = [];
  return {
    delays,
    set(callback, ms) {
      next += 1;
      delays.push(ms);
      jobs.push({ handle: next, callback });
      return next;
    },
    clear(handle) {
      jobs = jobs.filter((job) => job.handle !== handle);
    },
    fire() {
      const due = jobs;
      jobs = [];
      for (const job of due) job.callback();
    },
    pending: () => jobs.length,
  };
}

type Call = [string, ...unknown[]];

/** A backend whose every mutation is recorded, and fails with `failWith` while set. */
function fakeBackend(emails: Email[] = []) {
  const calls: Call[] = [];
  const state: { failWith: ((call: Call) => unknown) | null } = { failWith: null };
  const record = async (call: Call) => {
    const failure = state.failWith?.(call);
    if (failure) throw failure;
    calls.push(call);
  };
  const backend: MailBackend = {
    sync: async (options) => {
      options?.onPartial?.(emails);
      return { emails, failed: 0, truncated: false };
    },
    toggleStar: (id, starred) => record(["star", id, starred]),
    moveToMailbox: (id, mailbox) => record(["move", id, mailbox]),
    setRead: (id, read) => record(["read", id, read]),
    deletePermanently: (id) => record(["delete", id]),
    sendReply: (draft, inReplyTo, draftId) => record(["sendReply", (draft as Draft).subject, inReplyTo, draftId]),
    sendNew: (draft, draftId) => record(["sendNew", draft.subject, draftId]),
    fetchAttachment: async () => ({ bytes: new Uint8Array(), filename: "", mimeType: "" }),
    fetchBody: async () => undefined,
  };
  return { backend, calls, state };
}

function setup(options: { online?: boolean; storage?: ReturnType<typeof memoryStorage>; account?: string } = {}) {
  const net = { online: options.online ?? true };
  const storage = options.storage ?? memoryStorage();
  const timers = manualTimers();
  const queue = new OfflineQueue({ storage, isOnline: () => net.online, timers });
  const fake = fakeBackend([email(1), email(2), email(3)]);
  const wrapped = queue.wrap(fake.backend, async () => options.account ?? "me@example.com");
  const drops: QueueDrop[] = [];
  queue.onDrop((drop) => drops.push(drop));
  return { net, storage, timers, queue, fake, wrapped, drops };
}

function email(id: number, extra: Partial<Email> = {}): Email {
  return {
    id,
    gmailId: `g${id}`,
    sender: "a@example.com",
    address: "a@example.com",
    name: "A",
    mailbox: "inbox",
    receivedAt: 1_000 + id,
    subject: `s${id}`,
    body: "",
    category: "primary",
    starred: false,
    unread: true,
    urgent: false,
    attachments: [],
    ...extra,
  } as Email;
}

const draft = (subject: string): Draft => ({ to: ["b@example.com"], cc: [], bcc: [], subject, body: "hi" });

/** Let queued promise chains run. */
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

describe("classifyFailure", () => {
  it("treats a fetch that got no response as offline", () => {
    expect(classifyFailure(offlineError())).toBe("no_response");
    expect(classifyFailure(new TypeError("NetworkError when attempting to fetch resource."))).toBe("no_response");
    expect(classifyFailure(new TypeError("Load failed"))).toBe("no_response");
    expect(classifyFailure(new GoogleUnreachable("down"))).toBe("no_response");
  });

  it("does not mistake a programming TypeError for the network", () => {
    expect(classifyFailure(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe("fatal");
  });

  it("reads Gmail's answers", () => {
    expect(classifyFailure(new GmailHttpError(404, "{}"))).toBe("conflict");
    expect(classifyFailure(new GmailHttpError(410, "{}"))).toBe("conflict");
    expect(classifyFailure(new GmailHttpError(401, "{}"))).toBe("auth");
    // What the token manager throws for invalid_grant: it must never be retried.
    expect(classifyFailure(new GmailError("Your Google session is no longer valid.", 400, "reauth_required"))).toBe("auth");
    expect(classifyFailure(new GmailHttpError(503, "{}"))).toBe("transient");
    expect(classifyFailure(new GmailHttpError(429, "{}"))).toBe("transient");
    expect(classifyFailure(new GmailHttpError(400, "{}"))).toBe("fatal");
    expect(classifyFailure("nope")).toBe("fatal");
  });
});

describe("backoffDelay", () => {
  it("doubles from a second and stops at a minute", () => {
    expect([1, 2, 3, 4].map(backoffDelay)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(backoffDelay(30)).toBe(BACKOFF_MAX_MS);
  });
});

describe("the offline queue", () => {
  it("passes straight through when online and nothing waits", async () => {
    const { wrapped, fake, queue } = setup();
    await wrapped.toggleStar(1, true);
    expect(fake.calls).toEqual([["star", 1, true]]);
    expect(queue.status().waiting).toBe(0);
  });

  it("queues while offline, resolves at once, and persists", async () => {
    const { wrapped, fake, queue, net, storage } = setup({ online: false });
    await wrapped.moveToMailbox(1, "archive");
    await wrapped.setRead(2, true);
    expect(fake.calls).toEqual([]);
    expect(queue.status()).toEqual({ waiting: 2, sends: 0, state: "offline" });
    expect(JSON.parse(storage.data.get(OFFLINE_QUEUE_KEY)!).entries).toHaveLength(2);
    net.online = true;
    queue.kick();
    await settle();
    expect(fake.calls).toEqual([
      ["move", 1, "archive"],
      ["read", 2, true],
    ]);
    expect(queue.status()).toEqual({ waiting: 0, sends: 0, state: "idle" });
    expect(storage.data.has(OFFLINE_QUEUE_KEY)).toBe(false);
  });

  it("queues a request that got no response, then replays it after a backoff", async () => {
    const { wrapped, fake, queue, timers } = setup();
    fake.state.failWith = () => offlineError();
    await wrapped.toggleStar(1, true); // resolves: kept, not rolled back
    expect(queue.status().waiting).toBe(1);
    expect(queue.status().state).toBe("backoff");
    expect(timers.delays).toEqual([1_000]);
    timers.fire();
    await settle();
    expect(timers.delays).toEqual([1_000, 2_000]);
    fake.state.failWith = null;
    timers.fire();
    await settle();
    expect(fake.calls).toEqual([["star", 1, true]]);
    expect(queue.status().waiting).toBe(0);
  });

  it("still rejects what Gmail answered, so the store rolls it back", async () => {
    const { wrapped, fake, queue } = setup();
    fake.state.failWith = () => new GmailHttpError(400, "bad");
    await expect(wrapped.moveToMailbox(1, "trash")).rejects.toThrow(/400/);
    expect(queue.status().waiting).toBe(0);
  });

  it("keeps order: a new action waits behind the queue even when online", async () => {
    const { wrapped, fake, queue, timers } = setup();
    fake.state.failWith = (call) => (call[0] === "move" ? offlineError() : null);
    await wrapped.moveToMailbox(1, "archive");
    await wrapped.toggleStar(2, true);
    expect(fake.calls).toEqual([]);
    expect(queue.status().waiting).toBe(2);
    fake.state.failWith = null;
    timers.fire();
    await settle();
    expect(fake.calls).toEqual([
      ["move", 1, "archive"],
      ["star", 2, true],
    ]);
  });

  it("dedupes: the last star, read or move of a message wins", async () => {
    const { wrapped, fake, queue, net } = setup({ online: false });
    await wrapped.toggleStar(1, true);
    await wrapped.toggleStar(1, false);
    await wrapped.moveToMailbox(1, "trash");
    await wrapped.moveToMailbox(1, "inbox");
    await wrapped.setRead(1, true);
    await wrapped.setRead(2, true);
    expect(queue.status().waiting).toBe(4);
    net.online = true;
    queue.kick();
    await settle();
    expect(fake.calls).toEqual([
      ["star", 1, false],
      ["move", 1, "inbox"],
      ["read", 1, true],
      ["read", 2, true],
    ]);
  });

  it("drops a conflict (404/410) quietly and carries on", async () => {
    const { wrapped, fake, queue, net, drops } = setup({ online: false });
    await wrapped.moveToMailbox(1, "archive");
    await wrapped.moveToMailbox(2, "archive");
    net.online = true;
    fake.state.failWith = (call) => (call[1] === 1 ? new GmailHttpError(404, "gone") : null);
    queue.kick();
    await settle();
    expect(fake.calls).toEqual([["move", 2, "archive"]]);
    expect(queue.status().waiting).toBe(0);
    expect(drops).toEqual([]);
  });

  it("waits for re-auth on a 401 and never retries it on a timer", async () => {
    const { wrapped, fake, queue, net, timers } = setup({ online: false });
    await wrapped.toggleStar(1, true);
    net.online = true;
    fake.state.failWith = () => new GmailHttpError(401, "expired");
    queue.kick();
    await settle();
    expect(queue.status()).toEqual({ waiting: 1, sends: 0, state: "auth" });
    expect(timers.pending()).toBe(0);
    // A kick (the online event) does not try again either.
    queue.kick();
    await settle();
    expect(fake.calls).toEqual([]);
    // A sync that gets through means the session is back.
    fake.state.failWith = null;
    await wrapped.sync();
    await settle();
    expect(fake.calls).toEqual([["star", 1, true]]);
  });

  it("never replays after an invalid_grant until a fresh sign-in attaches a backend", async () => {
    const storage = memoryStorage();
    const { wrapped, fake, queue, net } = setup({ online: false, storage });
    await wrapped.setRead(1, true);
    net.online = true;
    let refreshes = 0;
    fake.state.failWith = () => {
      refreshes += 1;
      return new GmailError("Your Google session is no longer valid. Sign in again.", 400, "reauth_required");
    };
    queue.kick();
    await settle();
    queue.kick();
    await settle();
    expect(refreshes).toBe(1);
    expect(queue.status().state).toBe("auth");
    // Signing in again builds a new backend; the queue replays through it.
    const fresh = fakeBackend();
    queue.wrap(fresh.backend, async () => "me@example.com");
    await settle();
    expect(fresh.calls).toEqual([["read", 1, true]]);
    expect(refreshes).toBe(1);
  });

  it("survives a restart for the same account, and not for another", async () => {
    const storage = memoryStorage();
    const first = setup({ online: false, storage });
    await first.wrapped.moveToMailbox(3, "trash");

    const again = new OfflineQueue({ storage, isOnline: () => true, timers: manualTimers() });
    const replay = fakeBackend();
    again.wrap(replay.backend, async () => "me@example.com");
    await settle();
    expect(replay.calls).toEqual([["move", 3, "trash"]]);

    const second = setup({ online: false, storage });
    await second.wrapped.moveToMailbox(3, "trash");
    const other = new OfflineQueue({ storage, isOnline: () => true, timers: manualTimers() });
    const otherBackend = fakeBackend();
    other.wrap(otherBackend.backend, async () => "someone-else@example.com");
    await settle();
    expect(otherBackend.calls).toEqual([]);
    expect(other.status().waiting).toBe(0);
  });

  it("lays waiting actions over a sync, so a fresh reading does not undo them on screen", async () => {
    const { wrapped, queue, fake, timers } = setup();
    fake.state.failWith = (call) => (call[0] === "sync" ? null : offlineError());
    await wrapped.moveToMailbox(1, "archive");
    await wrapped.toggleStar(2, true);
    expect(queue.status().waiting).toBe(2);
    const partials: Email[][] = [];
    const outcome = await wrapped.sync({ onPartial: (emails) => partials.push(emails) });
    const byId = new Map(outcome.emails.map((e) => [e.id, e]));
    expect(byId.get(1)).toMatchObject({ mailbox: "archive", unread: false });
    expect(byId.get(2)).toMatchObject({ starred: true });
    expect(partials[0].find((e) => e.id === 1)?.mailbox).toBe("archive");
    expect(timers.pending()).toBe(1);
  });

  it("replays a draft send (drafts.send) and drops it as sent when the draft is gone", async () => {
    const { wrapped, fake, queue, net, drops } = setup({ online: false });
    await wrapped.sendNew!(draft("hello"), "d1");
    await wrapped.sendNew!(draft("hello again"), "d1"); // the same draft: one send
    expect(queue.status()).toEqual({ waiting: 1, sends: 1, state: "offline" });
    net.online = true;
    fake.state.failWith = () => new GmailHttpError(404, "no such draft");
    queue.kick();
    await settle();
    expect(queue.status().waiting).toBe(0);
    expect(drops).toEqual([]);
  });

  it("replays a reply on its thread", async () => {
    const { wrapped, fake, queue, net } = setup({ online: false });
    await wrapped.sendReply(draft("re"), "g1", "d7");
    net.online = true;
    queue.kick();
    await settle();
    expect(fake.calls).toEqual([["sendReply", "re", "g1", "d7"]]);
  });

  it("never sends a raw message twice: an attempted one whose answer was lost is reported, not replayed", async () => {
    const { wrapped, fake, queue, net, drops } = setup({ online: false });
    await wrapped.sendNew!(draft("raw"));
    net.online = true;
    fake.state.failWith = () => offlineError();
    queue.kick();
    await settle();
    expect(queue.status().waiting).toBe(0);
    expect(drops).toHaveLength(1);
    expect(drops[0].action).toMatchObject({ kind: "send", draft: { subject: "raw" } });
    expect(drops[0].message).toMatch(/may not have been sent/);
  });

  it("rejects a raw send online when the answer is lost, so the composer keeps it", async () => {
    const { wrapped, fake, queue } = setup();
    fake.state.failWith = () => offlineError();
    await expect(wrapped.sendNew!(draft("raw"))).rejects.toThrow(/fetch/);
    expect(queue.status().waiting).toBe(0);
  });

  it("drops a raw send left attempted by a closed app on the next launch", async () => {
    const storage = memoryStorage();
    storage.setItem(
      OFFLINE_QUEUE_KEY,
      JSON.stringify({
        v: 1,
        account: "me@example.com",
        entries: [{ action: { kind: "send", mode: "new", draft: draft("lost") }, attempted: true }],
      }),
    );
    const queue = new OfflineQueue({ storage, isOnline: () => true, timers: manualTimers() });
    const drops: QueueDrop[] = [];
    queue.onDrop((drop) => drops.push(drop));
    const fake = fakeBackend();
    queue.wrap(fake.backend, async () => "me@example.com");
    await settle();
    expect(fake.calls).toEqual([]);
    expect(drops).toHaveLength(1);
  });

  it("reports a refusal for a replayed action nobody is waiting on", async () => {
    const { wrapped, fake, queue, net, drops } = setup({ online: false });
    await wrapped.moveToMailbox(1, "archive");
    net.online = true;
    fake.state.failWith = () => new GmailHttpError(400, "bad request");
    queue.kick();
    await settle();
    expect(queue.status().waiting).toBe(0);
    expect(drops).toHaveLength(1);
  });

  it("ignores a corrupt saved queue", async () => {
    const storage = memoryStorage();
    storage.setItem(OFFLINE_QUEUE_KEY, "{not json");
    const queue = new OfflineQueue({ storage, isOnline: () => true, timers: manualTimers() });
    queue.wrap(fakeBackend().backend, async () => "me@example.com");
    await settle();
    expect(queue.status().waiting).toBe(0);
    storage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify({ v: 1, account: "me@example.com", entries: [{ action: { kind: "explode" } }] }));
    const again = new OfflineQueue({ storage, isOnline: () => true, timers: manualTimers() });
    again.wrap(fakeBackend().backend, async () => "me@example.com");
    await settle();
    expect(again.status().waiting).toBe(0);
  });

  it("clears on sign-out", async () => {
    const { wrapped, queue, storage } = setup({ online: false });
    await wrapped.toggleStar(1, true);
    queue.clear();
    expect(queue.status().waiting).toBe(0);
    expect(storage.data.has(OFFLINE_QUEUE_KEY)).toBe(false);
  });

  it("tells subscribers when the count changes, with a stable snapshot between", async () => {
    const { wrapped, queue } = setup({ online: false });
    let told = 0;
    queue.subscribe(() => (told += 1));
    const before = queue.status();
    expect(queue.status()).toBe(before);
    await wrapped.toggleStar(1, true);
    expect(told).toBeGreaterThan(0);
    expect(queue.status()).not.toBe(before);
  });
});

describe("queued sends with Drive links", () => {
  const share = (): DraftDriveShare => ({
    links: [{ id: "demo-drive-1", link: "https://drive.google.com/file/d/demo-drive-1/view", own: true, name: "film.mov" }],
    recipients: ["b@example.com"],
    state: "pending",
    created: [],
  });
  const withShare = (subject: string, driveShare: DraftDriveShare): Draft => ({ ...draft(subject), driveShare });
  function hooks() {
    const log: string[] = [];
    const drive: DriveHooks & { log: string[]; fail: unknown } = {
      log,
      fail: null,
      async prepare(plan) {
        log.push("prepare");
        if (drive.fail) throw drive.fail;
        plan.created = [...plan.created, { fileId: "demo-drive-1", permissionId: "perm-1", email: "b@example.com" }];
        plan.state = "shared";
      },
      async revoke(created) {
        log.push(`revoke ${created.map((p) => p.permissionId).join(",")}`);
      },
    };
    return drive;
  }

  it("shares a pending send's links at replay, just before the send, and persists what it made", async () => {
    const { wrapped, fake, queue, net, storage } = setup({ online: false });
    const drive = hooks();
    queue.setDriveHooks(drive);
    const plan = share();
    await wrapped.sendNew!(withShare("film", plan), "d1");
    expect(drive.log).toEqual([]); // nothing shared while it only waits
    net.online = true;
    fake.state.failWith = () => new GmailHttpError(503, "busy");
    queue.kick();
    await settle();
    expect(drive.log).toEqual(["prepare"]);
    expect(JSON.parse(storage.data.get(OFFLINE_QUEUE_KEY)!).entries[0].action.draft.driveShare.created).toHaveLength(1);
    // The Gmail half failed and retries: it keeps its permissions, and shares nothing twice.
    fake.state.failWith = null;
    queue.kick();
    await settle();
    expect(fake.calls).toEqual([["sendNew", "film", "d1"]]);
    expect(drive.log).toEqual(["prepare"]);
  });

  it("a share that gets no answer backs off without marking a raw send attempted", async () => {
    const { wrapped, fake, queue, net, timers, drops } = setup({ online: false });
    const drive = hooks();
    drive.fail = offlineError();
    queue.setDriveHooks(drive);
    await wrapped.sendNew!(withShare("raw", share()));
    net.online = true;
    queue.kick();
    await settle();
    expect(queue.status().state).toBe("backoff");
    drive.fail = null;
    timers.fire();
    await settle();
    expect(fake.calls).toEqual([["sendNew", "raw", undefined]]);
    expect(drops).toEqual([]);
  });

  it("a send Gmail refused, with nobody waiting, takes back the permissions it created", async () => {
    const { wrapped, fake, queue, net, drops } = setup({ online: false });
    const drive = hooks();
    queue.setDriveHooks(drive);
    await wrapped.sendNew!(withShare("refused", share()), "d2");
    net.online = true;
    fake.state.failWith = (call) => (call[0] === "sendNew" ? new GmailHttpError(400, "invalid to") : null);
    queue.kick();
    await settle();
    expect(drops).toHaveLength(1);
    expect(drive.log).toEqual(["prepare", "revoke perm-1"]);
  });

  it("a send that may have gone (answer lost, draft gone) keeps them: a delivered link must open", async () => {
    const { wrapped, fake, queue, net } = setup({ online: false });
    const drive = hooks();
    queue.setDriveHooks(drive);
    await wrapped.sendNew!(withShare("maybe", share()));
    net.online = true;
    fake.state.failWith = () => offlineError();
    queue.kick();
    await settle();
    expect(drive.log).toEqual(["prepare"]);
    await wrapped.sendNew!(withShare("gone", { ...share(), state: "shared", created: [{ fileId: "f", permissionId: "p9", email: "b@example.com" }] }), "d404");
    fake.state.failWith = () => new GmailHttpError(404, "no such draft");
    queue.kick();
    await settle();
    expect(drive.log).toEqual(["prepare"]);
  });

  it("a sign-out takes back what waiting sends shared, before the queue is cleared", async () => {
    const { wrapped, queue } = setup({ online: false });
    const drive = hooks();
    queue.setDriveHooks(drive);
    await wrapped.sendNew!(withShare("waiting", { ...share(), state: "shared", created: [{ fileId: "f", permissionId: "p5", email: "b@example.com" }] }), "d5");
    await queue.revokeQueuedShares();
    queue.clear();
    expect(drive.log).toEqual(["revoke p5"]);
    expect(queue.status().waiting).toBe(0);
  });
});

describe("overlay", () => {
  it("removes nothing and leaves untouched mail as the same objects", () => {
    const mail = [email(1), email(2)];
    const out = overlay(mail, [{ kind: "star", id: 1, starred: true }]);
    expect(out[1]).toBe(mail[1]);
    expect(out[0].starred).toBe(true);
    expect(overlay(mail, [])).toBe(mail);
  });

  it("drops a label change an older build queued, and never replays it", async () => {
    const storage = memoryStorage();
    storage.data.set(
      OFFLINE_QUEUE_KEY,
      JSON.stringify({
        v: 1,
        account: "me@example.com",
        entries: [
          { action: { kind: "labels", ids: [1], add: ["Label_7"], remove: [] } },
          { action: { kind: "star", id: 2, starred: true } },
        ],
      }),
    );
    const { fake, queue } = setup({ storage });
    queue.kick();
    await settle();
    expect(fake.calls).toEqual([["star", 2, true]]);
  });
});

describe("queued sends with files", () => {
  it("keeps every byte for this session but writes only the device-copy budget to storage", async () => {
    const { wrapped, fake, queue, net, storage } = setup({ online: false });
    const big = "A".repeat(3_000_000);
    const withFiles: Draft = {
      ...draft("files"),
      attachments: [
        { id: "a", filename: "small.txt", mimeType: "text/plain", size: 3, data: "aGkh" },
        { id: "b", filename: "big.bin", mimeType: "application/octet-stream", size: 2_250_000, data: big },
      ],
    };
    const sent: Draft[] = [];
    const inner = fake.backend.sendNew!;
    fake.backend.sendNew = async (d, id) => {
      sent.push(d);
      return inner(d, id);
    };
    await wrapped.sendNew!(withFiles, "d1");
    const saved = JSON.parse(storage.data.get(OFFLINE_QUEUE_KEY)!);
    const files = saved.entries[0].action.draft.attachments;
    expect(files.map((f: { filename: string }) => f.filename)).toEqual(["small.txt", "big.bin"]);
    expect(files[0].data).toBe("aGkh");
    expect(files[1].data).toBeUndefined();
    expect(storage.data.get(OFFLINE_QUEUE_KEY)!.length).toBeLessThan(100_000);
    net.online = true;
    queue.kick();
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0].attachments![1].data).toBe(big);
  });
});

describe("the store behind the queue", () => {
  it("keeps an archive made offline on screen, with no error, through a sync, and replays it", async () => {
    const { WinnowStore } = await import("../store/store");
    const net = { online: true };
    const timers = manualTimers();
    const queue = new OfflineQueue({ storage: memoryStorage(), isOnline: () => net.online, timers });
    const fake = fakeBackend([email(1), email(2)]);
    const store = new WinnowStore({});
    await store.connect(queue.wrap(fake.backend, async () => "me@example.com"), { email: "me@example.com" });
    net.online = false;
    store.archive(1);
    store.toggleStar(2);
    await settle();
    const after = store.getSnapshot();
    expect(after.error).toBeNull();
    expect(after.all.find((e) => e.id === 1)?.mailbox).toBe("archive");
    expect(queue.status().waiting).toBe(2);
    // Back online: the sync replays first, then reads, and the result already agrees.
    net.online = true;
    await store.refresh();
    expect(fake.calls).toEqual([
      ["move", 1, "archive"],
      ["star", 2, true],
    ]);
    expect(queue.status().waiting).toBe(0);
  });
});
