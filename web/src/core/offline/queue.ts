/**
 * The offline action queue: what the user did while Gmail could not be reached, kept
 * until it can be.
 *
 * Archive, trash, restore, read/unread, star, labels and send are already optimistic in
 * the store: the screen changes first and the request follows. Without this module a
 * request that gets no answer rolls the change back with an error, so on a train every
 * archive bounces. With it, an action taken while the browser says it is offline — or
 * whose request got **no HTTP response at all** — is written to a persisted queue
 * instead, the screen keeps the change, and the queue replays in order once the network
 * is back (the `online` event, the next sync, or its own backoff timer).
 *
 * The rules, each with its reason:
 *
 * - **Only an unanswered request is queued.** A request Gmail *answered* with an error
 *   is a verdict, not a network blip, and still rolls back as before. Unanswered means a
 *   `fetch` that rejected (`TypeError: Failed to fetch`), or `GoogleUnreachable`.
 * - **Order is kept.** One replay at a time, oldest first; a failing head stops the
 *   line so a later action can never land before an earlier one. While anything waits,
 *   new actions join the back of the line even when online, for the same reason.
 * - **Dedupe.** A newer star, read or move of the same message replaces the older one
 *   (only the last answer matters, and each is idempotent); a permanent delete is not
 *   queued at all. Identical label changes and the same draft sent twice collapse.
 * - **Backoff.** 1 s, 2 s, 4 s … capped at 60 s, reset by any success. 5xx and 429
 *   that outlived the client's own retries back off the same way.
 * - **Conflicts drop quietly.** 404 or 410: the message (or the draft being sent) is
 *   gone, usually because another device already did the thing. Nothing to tell.
 * - **401 waits for re-auth.** The client has already spent its one forced refresh;
 *   the queue pauses rather than spinning, and resumes when a new backend is attached
 *   (a sign-in) or a sync succeeds (the session recovered).
 * - **Never replay an `invalid_grant`.** The token manager turns it into
 *   `reauth_required` and clears the tokens; the queue treats it as the 401 case, so
 *   nothing is retried against a dead grant. The actions wait for a fresh sign-in.
 * - **Sends are never risked twice.** A send through a saved Gmail draft
 *   (`drafts.send`) is safe to replay: a second attempt on a draft already sent gets 404
 *   and drops. A raw `messages.send` (no draft) is queued only when the device was
 *   already offline before trying; if one was attempted and the answer was lost, it is
 *   dropped and reported instead of replayed, so a message can never go out twice.
 * - **A sync sees the queue.** Until an action lands, a sync's fresh reading would
 *   undo it on screen, so the queue's actions are laid over every sync result.
 * - **Sign-out clears it**, and a queue saved for another account is discarded on load.
 *
 * Pure apart from what it is handed: storage, the online test and the timers.
 */

import type { Draft, Email, Mailbox } from "../model/email";
import { applyLabelChange } from "../mail/labels";
import { forDeviceCopy } from "../mail/attachments";
import { labelTargets } from "../store/labelView";
import type { MailBackend, SyncOutcome } from "../store/store";

export const OFFLINE_QUEUE_KEY = "winnow.offlineQueue.v1";
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 60_000;
/** More than this and the oldest are dropped: a queue is a buffer, not an archive. */
export const MAX_QUEUED = 500;

export type QueuedAction =
  | { kind: "star"; id: number; starred: boolean }
  | { kind: "read"; id: number; read: boolean }
  | { kind: "move"; id: number; mailbox: Mailbox }
  | { kind: "labels"; ids: number[]; add: string[]; remove: string[] }
  | { kind: "send"; mode: "new" | "reply"; draft: Draft; inReplyTo?: string; draftId?: string };

type Entry = {
  seq: number;
  action: QueuedAction;
  /** A request for it has gone out at least once (persisted before it goes). */
  attempted: boolean;
};

export type QueueState = "idle" | "offline" | "replaying" | "backoff" | "auth";

export type QueueStatus = {
  /** Actions waiting to reach Gmail. */
  waiting: number;
  /** How many of them are sends. */
  sends: number;
  state: QueueState;
};

/** Something the queue gave up on, for the screen to say. */
export type QueueDrop = { action: QueuedAction; message: string };

export type QueueStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type QueueTimers = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

export type OfflineQueueOptions = {
  storage?: QueueStorage | null;
  isOnline?: () => boolean;
  timers?: QueueTimers;
};

export type FailureClass = "no_response" | "conflict" | "auth" | "transient" | "fatal";

/**
 * What a failed request means for the queue. Read by shape, not class, so the
 * module needs nothing from the Gmail client beyond the fields it puts on errors.
 */
export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof TypeError) {
    // `fetch` rejects with a TypeError and nothing else does it with these words; a
    // TypeError from a bug ("x is undefined") is not a network failure.
    return /fetch|network|load failed|connection/i.test(error.message) ? "no_response" : "fatal";
  }
  if (!error || typeof error !== "object") return "fatal";
  const { name, kind, status } = error as { name?: unknown; kind?: unknown; status?: unknown };
  if (name === "GoogleUnreachable" || kind === "network" || kind === "timeout") return "no_response";
  if (kind === "reauth_required" || status === 401) return "auth";
  if (status === 404 || status === 410) return "conflict";
  if (status === 408 || status === 429 || (typeof status === "number" && status >= 500)) return "transient";
  return "fatal";
}

export function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/** A raw send (no saved draft) that may already have reached Gmail must not be resent. */
function unsafeToReplay(entry: Entry): boolean {
  return entry.action.kind === "send" && !entry.action.draftId && entry.attempted;
}

/** Whether `next` makes `older` pointless, so `older` can go. */
function supersedes(next: QueuedAction, older: QueuedAction): boolean {
  switch (next.kind) {
    case "star":
    case "read":
    case "move":
      return older.kind === next.kind && older.id === next.id;
    case "labels":
      return (
        older.kind === "labels" &&
        older.ids.join() === next.ids.join() &&
        older.add.join() === next.add.join() &&
        older.remove.join() === next.remove.join()
      );
    case "send":
      return older.kind === "send" && next.draftId !== undefined && older.draftId === next.draftId;
  }
}

/** Lay one queued action over a mailbox reading, the way the store applied it. */
export function overlay(emails: Email[], actions: readonly QueuedAction[]): Email[] {
  if (actions.length === 0) return emails;
  let out = emails;
  for (const action of actions) {
    if (action.kind === "send") continue;
    // A label change covers the whole conversation, as the store applied it and as Gmail
    // will (`threads.modify`), so a reply on the thread keeps the change too.
    const ids = action.kind === "labels" ? labelTargets(out, action.ids) : new Set([action.id]);
    out = out.map((email) => {
      if (!ids.has(email.id)) return email;
      switch (action.kind) {
        case "star":
          return email.starred === action.starred ? email : { ...email, starred: action.starred };
        case "read":
          return email.unread === !action.read ? email : { ...email, unread: !action.read };
        case "move":
          return email.mailbox === action.mailbox ? email : { ...email, mailbox: action.mailbox, unread: false };
        case "labels":
          return { ...email, labels: applyLabelChange(email.labels, action.add, action.remove) };
      }
    });
  }
  return out;
}

type Waiter = { resolve: (outcome: "done" | "queued") => void; reject: (error: unknown) => void };

const realTimers: QueueTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class OfflineQueue {
  private entries: Entry[] = [];
  private seq = 0;
  private inner: MailBackend | null = null;
  private account: string | null = null;
  private loaded: Promise<void> = Promise.resolve();
  /** The account whose saved queue is in memory; `undefined` before the first load. */
  private hydratedFor: string | null | undefined = undefined;
  private state: QueueState = "idle";
  private failures = 0;
  private timer: unknown = null;
  private running: Promise<void> | null = null;
  private readonly waiters = new Map<number, Waiter>();
  private readonly listeners = new Set<() => void>();
  private readonly dropListeners = new Set<(drop: QueueDrop) => void>();
  private snapshot: QueueStatus = { waiting: 0, sends: 0, state: "idle" };

  private readonly storage: QueueStorage | null;
  private readonly isOnline: () => boolean;
  private readonly timers: QueueTimers;

  constructor(options: OfflineQueueOptions = {}) {
    this.storage = options.storage ?? null;
    this.isOnline = options.isOnline ?? (() => true);
    this.timers = options.timers ?? realTimers;
  }

  // ── Observing ─────────────────────────────────────────────────────────────

  /** For `useSyncExternalStore`: the same object until something changes. */
  status = (): QueueStatus => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Told when a queued action is given up on for a reason worth saying. */
  onDrop(listener: (drop: QueueDrop) => void): () => void {
    this.dropListeners.add(listener);
    return () => this.dropListeners.delete(listener);
  }

  /** The actions still waiting, oldest first. */
  pending(): QueuedAction[] {
    return this.entries.map((entry) => entry.action);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Put a backend behind the queue and return the one the store should use. Called on
   * every connect (a sign-in included), so it also ends an auth pause and replays what
   * was saved for this account.
   */
  wrap(inner: MailBackend, account: () => Promise<string | null>): MailBackend {
    this.inner = inner;
    if (this.state === "auth") this.state = "idle";
    this.loaded = account()
      .catch(() => null)
      .then((email) => {
        // Storage mirrors memory, so it is read once per account: a second connect (a
        // sign-in after a 401) must not load the same actions twice.
        if (this.hydratedFor !== email) this.load(email);
        this.hydratedFor = email;
        this.account = email;
        this.publish();
        void this.flush();
      });
    return this.backendFor(inner);
  }

  /** Sign-out: nothing queued for the account survives it. */
  clear(): void {
    this.entries = [];
    this.inner = null;
    this.account = null;
    this.hydratedFor = undefined;
    this.failures = 0;
    this.state = "idle";
    this.cancelTimer();
    for (const waiter of this.waiters.values()) waiter.resolve("queued");
    this.waiters.clear();
    try {
      this.storage?.removeItem(OFFLINE_QUEUE_KEY);
    } catch {
      // Storage refusing a delete leaves an entry for an account that is checked on load.
    }
    this.publish();
  }

  /** The network is back (or might be): try now rather than at the backoff's end. */
  kick(): void {
    if (this.state === "auth") return;
    this.cancelTimer();
    void this.flush();
  }

  // ── The wrapped backend ───────────────────────────────────────────────────

  private backendFor(inner: MailBackend): MailBackend {
    const wrapped: MailBackend = {
      ...inner,
      sync: async (options) => {
        await this.loaded;
        // Replay first, so the reading that follows already includes what landed.
        await this.flush();
        const outcome: SyncOutcome = await inner.sync({
          ...options,
          onPartial: options?.onPartial
            ? (emails) => options.onPartial!(overlay(emails, this.pending()))
            : undefined,
        });
        // A sync that got through means the session works again.
        if (this.state === "auth" && this.inner === inner) {
          this.state = "idle";
          this.publish();
          void this.flush();
        }
        return { ...outcome, emails: overlay(outcome.emails, this.pending()) };
      },
      toggleStar: (id, starred) => this.run({ kind: "star", id, starred }),
      moveToMailbox: (id, mailbox) => this.run({ kind: "move", id, mailbox }),
      setRead: (id, read) => this.run({ kind: "read", id, read }),
      sendReply: (draft, inReplyTo, draftId) =>
        this.run({ kind: "send", mode: "reply", draft: draft as Draft, inReplyTo, ...(draftId ? { draftId } : {}) }),
    };
    if (inner.modifyLabels) {
      wrapped.modifyLabels = (ids, add, remove) =>
        this.run({ kind: "labels", ids: [...ids], add: [...add], remove: [...remove] });
    }
    if (inner.sendNew) {
      wrapped.sendNew = (draft, draftId) => this.run({ kind: "send", mode: "new", draft, ...(draftId ? { draftId } : {}) });
    }
    return wrapped;
  }

  /**
   * One action from the store. Resolves when it reached Gmail or is safely queued;
   * rejects with Gmail's answer when Gmail refused it, so the store rolls back as before.
   */
  private async run(action: QueuedAction): Promise<void> {
    await this.loaded;
    const entry = this.enqueue(action);
    if (!this.isOnline()) {
      this.setState("offline");
      return;
    }
    const outcome = new Promise<"done" | "queued">((resolve, reject) => this.waiters.set(entry.seq, { resolve, reject }));
    // Behind a backoff or a sign-in, it waits with the rest rather than jumping the line.
    if (this.state === "backoff" || this.state === "auth") this.settle(entry.seq, "queued");
    else void this.flush();
    await outcome;
  }

  private enqueue(action: QueuedAction): Entry {
    const inFlight = this.running ? this.entries[0] : undefined;
    this.entries = this.entries.filter((older) => {
      if (older === inFlight || !supersedes(action, older.action)) return true;
      this.settle(older.seq, "queued");
      return false;
    });
    this.seq += 1;
    const entry: Entry = { seq: this.seq, action, attempted: false };
    this.entries.push(entry);
    while (this.entries.length > MAX_QUEUED) {
      // The oldest change that is not a message: a send is never dropped for space.
      const index = this.entries.findIndex((candidate) => candidate.action.kind !== "send");
      if (index < 0) break;
      const [dropped] = this.entries.splice(index, 1);
      this.settle(dropped.seq, "queued");
    }
    this.persist();
    this.publish();
    return entry;
  }

  // ── Replay ────────────────────────────────────────────────────────────────

  private flush(): Promise<void> {
    if (this.running) return this.running;
    if (this.entries.length === 0 || this.state === "auth") return Promise.resolve();
    this.running = this.drain().finally(() => {
      this.running = null;
      this.publish();
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.entries.length > 0) {
      const inner = this.inner;
      if (!inner || this.state === "auth") return;
      if (!this.isOnline()) {
        this.setState("offline");
        this.resolveAllQueued();
        return;
      }
      const entry = this.entries[0];
      if (unsafeToReplay(entry)) {
        this.remove(entry);
        this.drop(entry, "A message may not have been sent: the connection dropped while it was going out. Check Sent before sending it again.");
        continue;
      }
      this.setState("replaying");
      entry.attempted = true;
      this.persist();
      try {
        await this.execute(inner, entry.action);
        this.failures = 0;
        this.remove(entry);
        this.settle(entry.seq, "done");
        continue;
      } catch (error) {
        if (this.inner !== inner) return;
        const failure = classifyFailure(error);
        if (failure === "conflict") {
          this.remove(entry);
          this.settle(entry.seq, "done");
          continue;
        }
        if (failure === "auth") {
          // Not attempted as far as a replay is concerned: Gmail never took it.
          entry.attempted = false;
          this.persist();
          this.setState("auth");
          this.resolveAllQueued();
          return;
        }
        if (failure === "no_response" && unsafeToReplay(entry)) {
          this.remove(entry);
          const waiter = this.waiters.get(entry.seq);
          if (waiter) {
            this.waiters.delete(entry.seq);
            waiter.reject(error);
          } else {
            this.drop(entry, "A message may not have been sent: the connection dropped while it was going out. Check Sent before sending it again.");
          }
          continue;
        }
        if (failure === "no_response" || failure === "transient") {
          this.failures += 1;
          this.setState("backoff");
          this.resolveAllQueued();
          this.cancelTimer();
          this.timer = this.timers.set(() => {
            this.timer = null;
            void this.flush();
          }, backoffDelay(this.failures));
          return;
        }
        // Gmail answered and refused: give it back to whoever is waiting, or say so.
        this.remove(entry);
        const waiter = this.waiters.get(entry.seq);
        if (waiter) {
          this.waiters.delete(entry.seq);
          waiter.reject(error);
        } else {
          this.drop(entry, error instanceof Error ? error.message : "A change made offline did not save.");
        }
      }
    }
    this.setState("idle");
  }

  private async execute(inner: MailBackend, action: QueuedAction): Promise<void> {
    switch (action.kind) {
      case "star":
        return inner.toggleStar(action.id, action.starred);
      case "read":
        return inner.setRead(action.id, action.read);
      case "move":
        return inner.moveToMailbox(action.id, action.mailbox);
      case "labels":
        if (!inner.modifyLabels) throw new Error("Labels can't be changed from here.");
        return inner.modifyLabels(action.ids, action.add, action.remove);
      case "send":
        if (action.mode === "reply") {
          if (!action.inReplyTo) throw new Error("Couldn't find the message this replies to.");
          return action.draftId
            ? inner.sendReply(action.draft, action.inReplyTo, action.draftId)
            : inner.sendReply(action.draft, action.inReplyTo);
        }
        if (!inner.sendNew) throw new Error("This build cannot send new messages.");
        return action.draftId ? inner.sendNew(action.draft, action.draftId) : inner.sendNew(action.draft);
    }
  }

  // ── Bookkeeping ───────────────────────────────────────────────────────────

  private remove(entry: Entry): void {
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    this.persist();
  }

  private settle(seq: number, outcome: "done" | "queued"): void {
    const waiter = this.waiters.get(seq);
    if (!waiter) return;
    this.waiters.delete(seq);
    waiter.resolve(outcome);
  }

  private resolveAllQueued(): void {
    for (const [seq, waiter] of this.waiters) {
      this.waiters.delete(seq);
      waiter.resolve("queued");
    }
  }

  private drop(entry: Entry, message: string): void {
    for (const listener of this.dropListeners) listener({ action: entry.action, message });
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.timers.clear(this.timer);
    this.timer = null;
  }

  private setState(state: QueueState): void {
    if (this.state === state) return;
    this.state = state;
    this.publish();
  }

  private publish(): void {
    const waiting = this.entries.length;
    const sends = this.entries.filter((entry) => entry.action.kind === "send").length;
    const state = waiting === 0 && this.state !== "auth" ? "idle" : this.state;
    const prev = this.snapshot;
    if (prev.waiting === waiting && prev.sends === sends && prev.state === state) return;
    this.snapshot = { waiting, sends, state };
    for (const listener of this.listeners) listener();
  }

  private persist(): void {
    if (!this.storage) return;
    try {
      if (this.entries.length === 0) {
        this.storage.removeItem(OFFLINE_QUEUE_KEY);
        return;
      }
      this.storage.setItem(
        OFFLINE_QUEUE_KEY,
        JSON.stringify({
          v: 1,
          account: this.account,
          entries: this.entries.map(({ action, attempted }) => ({ action: forStorage(action), attempted })),
        }),
      );
    } catch {
      // Private mode or a full quota: the queue still works for this session.
    }
  }

  private load(account: string | null): void {
    if (!this.storage) return;
    let saved: unknown;
    try {
      saved = JSON.parse(this.storage.getItem(OFFLINE_QUEUE_KEY) ?? "null");
    } catch {
      saved = null;
    }
    const record = saved as { v?: unknown; account?: unknown; entries?: unknown } | null;
    if (!record || record.v !== 1 || !Array.isArray(record.entries)) return;
    if (record.account !== account) {
      // Another account's actions are not this one's to replay.
      this.persist();
      return;
    }
    const restored: Entry[] = [];
    for (const raw of record.entries as unknown[]) {
      const item = raw as { action?: unknown; attempted?: unknown };
      if (!isAction(item?.action)) continue;
      this.seq += 1;
      restored.push({ seq: this.seq, action: item.action, attempted: item.attempted === true });
    }
    // Saved ones are older than anything queued since this launch.
    this.entries = [...restored, ...this.entries];
    this.persist();
  }
}

/**
 * What of an action is written to storage. A send's files go through the drafts' own
 * device-copy budget (`forDeviceCopy`): `localStorage` is ~5 MB for the whole origin, and
 * one 25 MB attachment would make the write throw and leave nothing queued saved. This
 * session's entry keeps every byte; a send restored after a reload without a file's bytes
 * resolves it from its Gmail source, or fails with "Attach it again" and is reported.
 */
function forStorage(action: QueuedAction): QueuedAction {
  if (action.kind !== "send" || !action.draft.attachments) return action;
  const { attachments: all, ...rest } = action.draft;
  const attachments = forDeviceCopy(all);
  return { ...action, draft: attachments ? { ...rest, attachments } : rest };
}

function isAction(value: unknown): value is QueuedAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  switch (action.kind) {
    case "star":
      return typeof action.id === "number" && typeof action.starred === "boolean";
    case "read":
      return typeof action.id === "number" && typeof action.read === "boolean";
    case "move":
      return typeof action.id === "number" && typeof action.mailbox === "string";
    case "labels":
      return Array.isArray(action.ids) && Array.isArray(action.add) && Array.isArray(action.remove);
    case "send":
      return (action.mode === "new" || action.mode === "reply") && !!action.draft && typeof action.draft === "object";
    default:
      return false;
  }
}
