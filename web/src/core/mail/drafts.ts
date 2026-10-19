/**
 * Drafts: the composer's work, kept while it is being written.
 *
 * Two copies, for two different failures:
 *
 *   - **Gmail** (`DraftsApi`), debounced about two seconds after typing stops, so the
 *     draft is in the user's Drafts on every device and survives losing this one. Created
 *     once, then updated under the same id; sending sends *that* draft so nothing is left
 *     behind, and discarding deletes it.
 *   - **This device** (`LocalDrafts`), written on every change, so a reload, a crash or
 *     being offline (or the demo, which has no Gmail at all) restores the composer as it
 *     was. One most-recent draft per context — a reply to a message, a forward of one, or
 *     the new message — per account.
 *
 * Pure: no DOM, no React, no Gmail. The storage, the clock and the API are handed in, so
 * the call sequence is testable with fakes.
 */

import type { Contact, Draft, DraftAttachment, Email, GmailId } from "../model/email";
import { forDeviceCopy, restorableAttachments } from "./attachments";
import { recoverDriveFiles } from "../gmail/drive";

/** What the composer is for. Matches `Composer`'s `mode`. */
export type DraftMode = "reply" | "forward" | "new";

/**
 * Which draft this is, as a key: `new`, `reply:<gmailId>`, `forward:<gmailId>`.
 *
 * Reply and reply-all share a key on purpose — the toggle changes who it goes to, not
 * which draft it is.
 */
export function draftContextKey(mode: DraftMode, gmailId?: GmailId | null): string {
  if (mode === "new" || !gmailId) return "new";
  return `${mode}:${gmailId}`;
}

/**
 * The Gmail half. `replyTo` is the message a reply or forward answers, so the saved
 * draft carries `In-Reply-To`, `References` and the thread id, and lands on its
 * conversation in Gmail.
 */
export interface DraftsApi {
  /** Save a new draft; resolves to its id. */
  create(draft: Draft, replyTo?: GmailId): Promise<string>;
  /** Replace a draft's content under the same id; resolves to the id. */
  update(id: string, draft: Draft, replyTo?: GmailId): Promise<string>;
  /** Delete a draft for good. */
  delete(id: string): Promise<void>;
}

/** What the composer says about its draft. */
export type DraftSaveStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  /** `gmail`: in the user's Drafts. `device`: on this device only (demo, or no permission). */
  | { kind: "saved"; where: "gmail" | "device" }
  | { kind: "error"; message: string }
  /** The grant does not allow drafts. Kept on this device, and the opt-in is offered. */
  | { kind: "permission" };

/** The words for a status, or `null` for nothing to say. */
export function draftStatusLabel(status: DraftSaveStatus): string | null {
  switch (status.kind) {
    case "idle":
      return null;
    case "saving":
      return "Saving…";
    case "saved":
      return status.where === "gmail" ? "Saved" : "Saved on this device";
    case "error":
      return "Couldn't save";
    case "permission":
      return "Drafts need permission";
  }
}

/** One context's draft, as kept on this device. */
export type LocalDraft = {
  context: string;
  mode: DraftMode;
  draft: Draft;
  /** The Gmail message a reply or forward answers. */
  replyTo?: GmailId;
  /** Reply-all, for a reply. */
  replyAll?: boolean;
  /** The Gmail draft this copy belongs to, once one exists. */
  gmailDraftId?: string;
  /** A new message's recipients and subject as it opened, for the discard question. */
  initial?: Pick<Draft, "to" | "cc" | "bcc" | "subject">;
  savedAt: number;
};

/** The part of `Storage` this needs. */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** How many contexts are kept per account; the oldest goes first. */
export const MAX_LOCAL_DRAFTS = 20;

const LOCAL_PREFIX = "winnow.drafts.v1";

/**
 * The device copy: one most-recent draft per context, per account.
 *
 * Every access is guarded — private mode and a full quota throw rather than return — and
 * a corrupt entry reads as "nothing kept" rather than breaking the composer.
 */
export class LocalDrafts {
  private readonly key: string;

  constructor(
    private readonly storage: StorageLike | null,
    account: string,
  ) {
    this.key = `${LOCAL_PREFIX}:${account.toLowerCase()}`;
  }

  /** Every kept draft, newest first. */
  all(): LocalDraft[] {
    if (!this.storage) return [];
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(isLocalDraft)
        .sort((a, b) => b.savedAt - a.savedAt);
    } catch {
      return [];
    }
  }

  get(context: string): LocalDraft | null {
    return this.all().find((entry) => entry.context === context) ?? null;
  }

  /** The newest kept draft, for the restore offer on launch. */
  latest(): LocalDraft | null {
    return this.all()[0] ?? null;
  }

  /** Keep `entry` as its context's draft, replacing what was there. */
  put(entry: LocalDraft): void {
    const rest = this.all().filter((other) => other.context !== entry.context);
    this.write([entry, ...rest].slice(0, MAX_LOCAL_DRAFTS));
  }

  /** Merge fields into a kept draft, if there is one. */
  patch(context: string, fields: Partial<LocalDraft>): void {
    const current = this.get(context);
    if (current) this.put({ ...current, ...fields, context });
  }

  remove(context: string): void {
    const rest = this.all().filter((other) => other.context !== context);
    this.write(rest);
  }

  /** Forget every kept draft for this account (sign-out). */
  clear(): void {
    this.write([]);
  }

  private write(entries: LocalDraft[]): void {
    if (!this.storage) return;
    try {
      if (entries.length === 0) this.storage.removeItem(this.key);
      else this.storage.setItem(this.key, JSON.stringify(entries));
    } catch {
      // Storage refused (quota, private mode). The Gmail copy is the other half.
    }
  }
}

function isLocalDraft(value: unknown): value is LocalDraft {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<LocalDraft>;
  const draft = entry.draft as Partial<Draft> | undefined;
  return (
    typeof entry.context === "string" &&
    (entry.mode === "reply" || entry.mode === "forward" || entry.mode === "new") &&
    typeof entry.savedAt === "number" &&
    !!draft &&
    Array.isArray(draft.to) &&
    Array.isArray(draft.cc) &&
    Array.isArray(draft.bcc) &&
    typeof draft.subject === "string" &&
    typeof draft.body === "string"
  );
}

/** Timers, injectable so the debounce is testable without waiting. */
export type Timers = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How long typing has to stop before the draft is saved to Gmail, in ms. */
export const AUTOSAVE_DELAY_MS = 2000;

export type AutosaverOptions = {
  context: string;
  mode: DraftMode;
  replyTo?: GmailId;
  /** Gmail, or `null` for this device only (the demo). */
  api: DraftsApi | null;
  local: LocalDrafts | null;
  /** The Gmail draft this composer continues, when it was restored. */
  draftId?: string | null;
  /** Start with drafts known to need permission: kept on this device until granted. */
  permissionMissing?: boolean;
  delayMs?: number;
  timers?: Timers;
  now?: () => number;
  onStatus?: (status: DraftSaveStatus) => void;
};

/** Whether an error is the grant lacking a drafts scope. */
function isScopeError(error: unknown): boolean {
  return error instanceof Error && error.name === "DraftsScopeMissing";
}

/**
 * Saves one composer's draft: on this device at once, to Gmail after a pause.
 *
 * Saves are serial — one request at a time — so the first save's `create` has returned
 * its id before anything tries to `update`, and a burst of typing during a slow save
 * becomes exactly one more save rather than a race.
 */
export class DraftAutosaver {
  private readonly opts: AutosaverOptions;
  private readonly timers: Timers;
  private readonly delay: number;
  private readonly now: () => number;
  private api: DraftsApi | null;
  private id: string | null;
  private latest: Draft | null = null;
  private meta: Pick<LocalDraft, "replyAll" | "initial"> = {};
  /** Changed since the last save to Gmail. */
  private dirty = false;
  private timer: unknown = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private status: DraftSaveStatus;

  constructor(options: AutosaverOptions) {
    this.opts = options;
    this.timers = options.timers ?? realTimers;
    this.delay = options.delayMs ?? AUTOSAVE_DELAY_MS;
    this.now = options.now ?? Date.now;
    this.api = options.permissionMissing ? null : options.api;
    this.id = options.draftId ?? null;
    this.status = options.permissionMissing ? { kind: "permission" } : { kind: "idle" };
  }

  /** The Gmail draft's id, once it has one. */
  get draftId(): string | null {
    return this.id;
  }

  get currentStatus(): DraftSaveStatus {
    return this.status;
  }

  /** Whether anything has been kept yet, on either side. */
  get hasSaved(): boolean {
    return this.id !== null || this.latest !== null;
  }

  /**
   * The draft changed: keep it on this device now, and schedule the Gmail save for
   * when typing stops.
   */
  change(draft: Draft, meta: Pick<LocalDraft, "replyAll" | "initial"> = {}): void {
    if (this.closed) return;
    this.latest = draft;
    this.meta = { ...this.meta, ...meta };
    this.dirty = true;
    this.writeLocal();
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = this.timers.set(() => {
      this.timer = null;
      void this.flush();
    }, this.delay);
  }

  /** Save now rather than after the pause. Resolves when the save has settled. */
  flush(): Promise<void> {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    // Closed is closed: a saver that was finished, discarded or parked never writes
    // again, whoever asks (a sign-out stops the open composer this way).
    if (this.dirty && this.latest && !this.closed) {
      const draft = this.latest;
      this.dirty = false;
      this.chain = this.chain.then(() => this.save(draft));
    }
    return this.chain;
  }

  /** Save anything pending, wait for it, and give the draft's id (or `null`). */
  async settle(): Promise<string | null> {
    await this.flush();
    return this.id;
  }

  /**
   * Leave the draft where it is — in Gmail and on this device — and stop. For moving to
   * another message with a reply half-written: nothing is lost, and opening the reply
   * again picks it up.
   */
  async park(): Promise<void> {
    await this.flush();
    this.close();
  }

  /** The message went out: Gmail consumed the draft, so only the device copy goes. */
  finish(): void {
    this.close();
    this.opts.local?.remove(this.opts.context);
  }

  /**
   * Throw the draft away: the device copy, and the Gmail draft if one was made. Waits for
   * a save in flight first, so a `create` that lands after Discard cannot leave an
   * orphan behind.
   */
  async discard(): Promise<void> {
    this.close();
    this.opts.local?.remove(this.opts.context);
    await this.chain;
    const id = this.id;
    this.id = null;
    if (id && this.api) {
      try {
        await this.api.delete(id);
      } catch {
        // Already gone, or offline: it stays in Gmail's Drafts, where the user can see it.
      }
    }
  }

  /** Drafts were just allowed: save to Gmail from now on, starting with what is here. */
  grant(api: DraftsApi): void {
    this.api = api;
    if (this.latest) {
      this.dirty = true;
      void this.flush();
    } else {
      this.setStatus({ kind: "idle" });
    }
  }

  private close(): void {
    this.closed = true;
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
  }

  private writeLocal(): void {
    if (!this.latest || !this.opts.local) return;
    // Files past the device budget are kept by name only: the Gmail draft has them, and
    // a `localStorage` write that overflows would lose the text as well.
    const attachments = forDeviceCopy(this.latest.attachments);
    const { attachments: _all, ...rest } = this.latest;
    void _all;
    this.opts.local.put({
      context: this.opts.context,
      mode: this.opts.mode,
      draft: attachments ? { ...rest, attachments } : rest,
      replyTo: this.opts.replyTo,
      gmailDraftId: this.id ?? undefined,
      ...this.meta,
      savedAt: this.now(),
    });
  }

  private async save(draft: Draft): Promise<void> {
    if (!this.api) {
      // Demo, or no permission yet: the device copy is the save.
      if (this.status.kind !== "permission") this.setStatus({ kind: "saved", where: "device" });
      return;
    }
    this.setStatus({ kind: "saving" });
    try {
      this.id = this.id
        ? await this.api.update(this.id, draft, this.opts.replyTo)
        : await this.api.create(draft, this.opts.replyTo);
      // Discarded while the request was out: the device copy is already gone, and must
      // stay gone.
      if (!this.closed) this.opts.local?.patch(this.opts.context, { gmailDraftId: this.id });
      this.setStatus({ kind: "saved", where: "gmail" });
    } catch (error) {
      if (isScopeError(error)) {
        this.api = null;
        this.setStatus({ kind: "permission" });
        return;
      }
      // Kept on this device either way; the next change tries Gmail again.
      this.dirty = true;
      this.setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : "Couldn't save the draft.",
      });
    }
  }

  private setStatus(status: DraftSaveStatus): void {
    this.status = status;
    this.opts.onStatus?.(status);
  }
}

// ── The Drafts mailbox ──────────────────────────────────────────────────────

/** The device-copy context of a draft reopened from the Drafts mailbox. */
export function gmailDraftContext(draftId: string): string {
  return `draft:${draftId}`;
}

function contactLabel(contact: Contact): string {
  const name = contact.name?.trim();
  if (name) return name;
  return contact.address.split("@")[0] || contact.address;
}

/**
 * What a Drafts row names in the sender's place: who the draft is *to*, the way Gmail
 * does — the sender of every draft is the user, which says nothing.
 */
export function draftRowName(email: Pick<Email, "to" | "cc" | "bcc">): string {
  const people = [...(email.to ?? []), ...(email.cc ?? []), ...(email.bcc ?? [])];
  if (people.length === 0) return "No recipients";
  const first = contactLabel(people[0]!);
  return people.length === 1 ? first : `${first} +${people.length - 1}`;
}

/** What opening a Drafts row gives the composer. */
export type DraftReopen = {
  mode: DraftMode;
  draft: Draft;
  /** The cached message a reply or forward answers, so it threads exactly as before. */
  replyTo?: GmailId;
  context: string;
  gmailDraftId: string;
};

const FORWARD_SUBJECT = /^\s*(fwd?|fw)\s*:/i;

/**
 * Reopen a Drafts row in the composer.
 *
 * The message it answers is found the way Gmail threads: its `In-Reply-To` first, then
 * the newest other message on its thread. Found, it reopens as the reply (or forward —
 * read off the `Fwd:` subject) it was, on the same thread. Not found (the original is
 * older than this device's cache), it reopens as a message of its own but keeps the
 * threading headers it was saved with (`Draft.replyHeaders`) and its thread id, so it
 * still goes out on the conversation.
 *
 * The body is the draft's text exactly: no quote block to strip and nothing prefilled,
 * because all of it is the user's now.
 */
export function reopenDraft(email: Email, all: readonly Email[]): DraftReopen | null {
  const gmailDraft = email.gmailDraft;
  if (!gmailDraft) return null;
  const addresses = (contacts: readonly Contact[] | undefined) =>
    (contacts ?? []).map((contact) => contact.address);
  // Its files, by where Gmail holds them: read when the draft is next saved or sent.
  const attachments: DraftAttachment[] = (email.attachments ?? []).map((attachment, index) => ({
    id: `gmail-${index}-${attachment.id}`,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    size: attachment.size,
    source: { gmailId: email.gmailId, attachmentId: attachment.id },
  }));
  const driveFiles = recoverDriveFiles(email.body, email.bodyHtml);
  const draft: Draft = {
    to: addresses(email.to),
    cc: addresses(email.cc),
    bcc: addresses(email.bcc),
    subject: email.subject,
    body: email.body,
    ...(attachments.length > 0 ? { attachments } : {}),
    // The composer's list of Drive files is not part of a Gmail draft; Winnow's own
    // "File name (size) — link" lines are, so the files come back from them (Send also
    // reads the links off the body, so one that cannot be rebuilt here is still shared).
    ...(driveFiles.length > 0 ? { driveFiles } : {}),
  };
  const context = gmailDraftContext(gmailDraft.id);
  const others = all.filter((candidate) => candidate.mailbox !== "drafts" && candidate.gmailId !== email.gmailId);

  const byHeader = gmailDraft.inReplyTo
    ? others.find((candidate) => candidate.messageId !== undefined && candidate.messageId === gmailDraft.inReplyTo)
    : undefined;
  const byThread =
    byHeader ??
    (email.threadId
      ? others
          .filter((candidate) => candidate.threadId === email.threadId)
          .sort((a, b) => b.receivedAt - a.receivedAt)[0]
      : undefined);

  if (byThread) {
    return {
      mode: FORWARD_SUBJECT.test(email.subject) ? "forward" : "reply",
      draft: { ...draft, inReplyTo: byThread.gmailId, threadId: byThread.threadId },
      replyTo: byThread.gmailId,
      context,
      gmailDraftId: gmailDraft.id,
    };
  }
  return {
    mode: "new",
    draft: {
      ...draft,
      ...(email.threadId ? { threadId: email.threadId } : {}),
      ...(gmailDraft.inReplyTo
        ? { replyHeaders: { inReplyTo: gmailDraft.inReplyTo, references: gmailDraft.references } }
        : {}),
    },
    context,
    gmailDraftId: gmailDraft.id,
  };
}

/**
 * The Drafts row for what the composer holds now, so the list shows an edit at once
 * rather than at the next listing (and the demo, which has no listing, at all).
 */
export function draftRowFrom(
  previous: Email,
  draft: Draft,
  now: number,
): Email {
  const contacts = (list: readonly string[]) => list.map((address) => ({ address }));
  return {
    ...previous,
    to: contacts(draft.to),
    cc: contacts(draft.cc),
    bcc: contacts(draft.bcc),
    subject: draft.subject,
    body: draft.body,
    receivedAt: now,
  };
}

/**
 * A device copy, as the composer reopens it: the files that can still be sent, and the
 * names of any that were too big to keep here (they have to be attached again, unless the
 * Gmail draft is reopened from Drafts instead).
 */
export function restoreLocalDraft(kept: LocalDraft): { draft: Draft; lost: string[] } {
  if (!kept.draft.attachments) return { draft: kept.draft, lost: [] };
  const { kept: attachments, lost } = restorableAttachments(kept.draft.attachments);
  const { attachments: _all, ...rest } = kept.draft;
  void _all;
  return { draft: attachments.length > 0 ? { ...rest, attachments } : rest, lost };
}

/** What the composer says about files a restored draft could not bring back. */
export function lostAttachmentsMessage(lost: readonly string[]): string | null {
  if (lost.length === 0) return null;
  return `${lost.join(", ")} ${lost.length === 1 ? "was" : "were"} too big to keep on this device. Attach ${lost.length === 1 ? "it" : "them"} again.`;
}
