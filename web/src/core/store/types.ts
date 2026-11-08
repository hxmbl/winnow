/**
 * Types the store shares with its collaborators.
 *
 * Only things that cross a module boundary live here: the backend and platform
 * contracts, what a sync produced, and the per-account shapes. State that the store
 * owns is in `state.ts`; types that belong to one feature sit with that feature.
 */

import type { Draft, Email, LoadedBody, Mailbox } from "../model/email";
import type { SyncProgress } from "../gmail/sync";
import type { LearningModel } from "../learn/learning";
import type { FilterLearningSnapshot } from "../learn/filterLearning";
import type { KeyValueBacking } from "./keyedStorage";
import type { DownloadBlock } from "../offline/downloader";
import type { OfflineBackend } from "../offline/offlineSave";
import type { GoogleContact } from "../contacts/google";
import type { TrashRecord } from "../model/profile";
import type { DraftsApi } from "../mail/drafts";
import type { Preferences } from "./state";

/**
 * Which half of a sync is running, for the status line.
 *
 * Named here rather than reusing `SyncProgress["phase"]`, whose union also contains
 * `idle` and `sending`: a completed phase is `null` here, which makes "not syncing"
 * answerable without a second boolean.
 */
export type SyncPhase = "full" | "incremental";

/**
 * Where the offline-storage question stands.
 *
 * `ask` — the last sync could not persist the cache and the user has not answered.
 * `saving` — "Save" is in progress. `failed` — it was tried and did not work.
 */
export type StoragePrompt = "ask" | "saving" | "failed";

/** The server side. Absent in demo mode, which is why every call is optional. */
export interface MailBackend {
  /**
   * Fetch everything changed since the last run.
   *
   * `onProgress` is a *request*, not a notification: the engine calls it as often as it
   * likes and the store decides whether that is worth a re-render, because a first sync
   * downloads thousands of messages and a callback that re-rendered per message would
   * make the app unusable during the one operation it is least able to hide.
   */
  sync(options?: {
    onProgress?: (progress: SyncProgress) => void;
    /**
     * The mailbox so far, while the sync is still running — the inbox first, as soon as
     * it has a screenful. Optional: a backend that cannot publish early simply doesn't.
     */
    onPartial?: (emails: Email[]) => void;
  }): Promise<SyncOutcome>;
  toggleStar(id: number, starred: boolean): Promise<void>;
  moveToMailbox(id: number, mailbox: Mailbox): Promise<void>;
  setRead(id: number, read: boolean): Promise<void>;
  deletePermanently(id: number): Promise<void>;
  /**
   * Snooze or wake one message in Gmail (`core/mail/snooze.ts`): snoozing puts the
   * `Winnow/Snoozed` label on and takes `INBOX` off; waking takes the label off and puts
   * `INBOX` back (unless `toInbox` is false: an Undo of a snooze from the Archive), with
   * `UNREAD` when `unread`. By Gmail id, because a message being woken
   * may not be in this device's cache. Optional: without it the store files the message
   * with `moveToMailbox` instead, which is what a failure falls back to as well (the
   * offline queue carries that one).
   */
  setSnoozed?(gmailId: string, snoozed: boolean, options?: { unread?: boolean; toInbox?: boolean }): Promise<void>;
  /**
   * Send a reply. With `draftId`, the composer's saved Gmail draft is what is sent
   * (`drafts.send`), so nothing is left behind in Drafts.
   */
  sendReply(draft: unknown, inReplyTo: string, draftId?: string): Promise<void>;
  /**
   * Send a new message: no `In-Reply-To`, no `References`, no thread. Optional so a
   * backend written before composing existed (and every test fake) still type-checks;
   * the store reports a backend without it as unable to send.
   */
  sendNew?(draft: Draft, draftId?: string): Promise<void>;
  /**
   * The user's Gmail drafts as Drafts rows, newest first. `previous` is the last
   * listing, so an unchanged draft is not fetched again. Optional like `sendNew`.
   */
  listDrafts?(previous: readonly Email[]): Promise<Email[]>;
  /**
   * Gmail drafts, for the composer's autosave. Optional for the same reason as
   * `sendNew`; without it the composer keeps its draft on the device only.
   */
  drafts?: DraftsApi;
  /**
   * The header block a notification's inline reply is sent with, by Gmail id: the
   * composer's own `rawFor` → `buildMime`, for `notificationReplyDraft` with an empty
   * body. Optional like `drafts`; absent means notifications offer no inline reply.
   */
  replyHeads?(gmailIds: readonly string[]): Promise<Record<string, string>>;
  /**
   * Download one attachment's bytes.
   *
   * Separate from `sendReply` because it is the only operation that returns binary and
   * the only one that is *not* a mutation — so the reader calls it directly rather than
   * through the optimistic-update path.
   */
  fetchAttachment(
    gmailId: string,
    attachmentId: string,
  ): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
  /**
   * The HTML body of one message, fetched on demand.
   *
   * The counterpart to `BODY_RETENTION`: the body is two thirds of a message's cost and
   * is only read for the message on screen, so the store keeps a recent window and asks
   * for anything older.
   *
   * `undefined` for a message with no HTML part is not an error — plain-text mail has
   * none, and the reader falls back to the body it already has.
   */
  fetchBody(gmailId: string): Promise<string | undefined>;
  /**
   * The whole body of a metadata-only message — plain text, HTML and attachments —
   * written into the offline cache as well as returned.
   *
   * Optional so a backend that only ever syncs whole messages (and the test doubles
   * written before metadata-first sync) need not implement it; without it the store
   * falls back to `fetchBody`.
   */
  loadMessage?(gmailId: string): Promise<LoadedBody>;
  /**
   * One whole message by Gmail id, fetched and written into the offline cache: what a
   * notification opens when its message is not cached yet (a light sync announced it,
   * or the cache was trimmed). `null` when Gmail no longer has it. Optional like
   * `loadMessage`.
   */
  fetchMessage?(gmailId: string): Promise<Email | null>;
  /**
   * One message's raw source (`format=raw`, decoded), for Dev Options → View Original.
   * Optional: the demo has none, and builds one from the message instead.
   */
  fetchRaw?(gmailId: string): Promise<string>;
  /**
   * Try again to write the offline cache, after asking the platform to keep it.
   *
   * On the web this requests persistent storage first (`navigator.storage.persist()`);
   * on the desktop it just retries. `true` when the cache landed.
   */
  persistCache?(): Promise<boolean>;
  /**
   * Saving the whole mailbox offline: the account's durable store, the user's answer,
   * and the requests the background download makes. Absent on a host with no durable
   * store and in test doubles; Save then only retries the write, as it used to.
   */
  offline?: OfflineBackend;
}

/** What one sync produced. */
export type SyncOutcome = {
  emails: Email[];
  failed: number;
  /** A mailbox hit its cap, so the cache is a triage set rather than an export. */
  truncated: boolean;
  /**
   * The mailbox could not be written to persistent storage.
   *
   * Distinct from `failed`, which counts messages that could not be fetched: the sync
   * worked and the user has their mail, and what is missing is the offline copy.
   */
  cacheUnpersisted?: boolean;
};

/**
 * The OS surface the store drives.
 *
 * Exactly three things, each a *reflection of state the store already holds* — the
 * unread count for the badge, the cadence for the scheduler, the new arrivals for the
 * notification. Absent in demo mode, which is why every call on it is optional.
 */
export interface PlatformBridge {
  notifyNewMail(emails: readonly Email[]): Promise<void>;
  /**
   * Take down the open account's notifications of messages that no longer need
   * attention: deleted on the server, read, archived, snoozed or moved out of the Inbox,
   * here or on Gmail anywhere. Optional.
   */
  withdrawNotifications?(gmailIds: readonly string[]): Promise<void>;
  /**
   * The notifications that are up now, by account, including ones Android's background
   * service posted while the app was closed. Optional.
   */
  activeNotifications?(): Promise<{ account: string | null; gmailId: string }[]>;
  /** Signed out of `account`: all of its notifications go. Optional. */
  clearNotifications?(account: string | null): Promise<void>;
  /** What stops the offline download right now (offline, hidden on a phone, metered, battery), or `null`. Optional. */
  downloadConditions?(): DownloadBlock | null;
  setUnreadBadge(count: number): Promise<void>;
  setBackgroundSync(intervalSeconds: number | null): Promise<void>;
}

export type StoreOptions = {
  /** Seed messages for demo mode. */
  seed?: readonly Email[];
  /** The demo's address book, so suggestions show the merge with no network. */
  seedContacts?: readonly GoogleContact[];
  seedTrash?: readonly TrashRecord[];
  /** The demo's drafts, for the Drafts mailbox. */
  seedDrafts?: readonly Email[];
  /**
   * Where snoozes and scheduled sends are kept. `globalThis.localStorage` by default;
   * tests hand in a memory backing (or `() => null` for none).
   */
  storage?: () => KeyValueBacking | null;
  backend?: MailBackend;
  platform?: PlatformBridge;
  preferences?: Partial<Preferences>;
  /**
   * The reference instant for the list's day sections. Injected rather than read: a
   * demo seed is built around a fixed date, and a real clock would collapse it all.
   */
  now?: number;
  /** Called whenever anything persists-worthy changes. */
  onPersist?: (patch: PersistPatch) => void;
  /** Called when the learning weights change, so the inbox can reclassify. */
  onWeightsChanged?: (model: LearningModel) => void;
};

/** One account as the switcher shows it. */
export type AccountSummary = {
  id: string;
  email: string;
  color: string;
  /** Notifications while this account is not the open one. */
  notify: boolean;
  /** Unread in its inbox; the open account's comes from its mail, the others' from their light sync. */
  unread: number | null;
  active: boolean;
  /** A demo account: the switcher shows it, nothing is signed in. */
  demo?: boolean;
  /**
   * The account's own Google profile picture (STRM-461): a kept `data:` copy or the URL
   * on Google's image host. Absent: the monogram.
   */
  picture?: string;
  /**
   * The picture's most dominant colour (`#RRGGBB`, raw), for the halo around the avatar
   * (`ui/ringColor.ts` adjusts it per theme). Absent: the account colour.
   */
  pictureColor?: string;
};

/** What one account (or the demo, with no account) persisted: see `core/store/accountState.ts`. */
export type AccountState = {
  learning?: ReturnType<LearningModel["toSnapshot"]> | null;
  filterLearning?: unknown;
  activeFilters?: readonly string[];
  mailbox?: Mailbox | null;
  /** Per-account email nicknames. */
  emailNicknames?: Record<string, string>;
};

export type PersistPatch = {
  preferences?: Partial<Preferences>;
  learning?: ReturnType<LearningModel["toSnapshot"]>;
  /** Local only, never synced: see `learn/filterLearning.ts`. */
  filterLearning?: FilterLearningSnapshot;
  activeFilters?: string[];
  mailbox?: Mailbox;
  emailNicknames?: Record<string, string>;
};
