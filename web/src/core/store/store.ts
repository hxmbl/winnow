/**
 * The store: one object holding everything the UI reads.
 *
 * A hand-rolled observable rather than a state library, because Winnow's state is
 * *derived*: the profile, signals, rail order and visible list are all functions of
 * the messages, and they must stay consistent at every keystroke. One `recompute`
 * means the list and the rail cannot disagree.
 *
 * Two properties make it usable from React without a framework binding:
 *
 *   - `subscribe(listener)` — a single callback on any change, which
 *     `useSyncExternalStore` maps onto directly. No context, no provider.
 *   - **Mutations are optimistic and reversible.** Every action that touches a
 *     message records how to undo it before it changes anything; a failed server
 *     call runs the undo, so a network blip cannot leave a message in a mailbox it
 *     is not in.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Store/WinnowStore.swift`.
 */

import { summarizeAttention, type AttentionSummary } from "../classify/attention";
import {
  MAILBOX_LABEL,
  isBodyLoaded,
  withLoadedBody,
  withCode,
  type Draft,
  type Email,
  type LoadedBody,
  type Mailbox,
} from "../model/email";
import { hashId } from "../model/ids";
import {
  catalogIndex,
  FILTER_LABELS,
  filterKey,
  parseFilterKey,
  senderFilter,
  PERMANENT_FILTERS,
  NAVIGATION_ITEMS,
  NEUTRAL_SIGNALS,
  navigationIndexFor,
  clampIndex,
  isUnsafe,
  type BuiltinSmartFilter,
  type EmailSignals,
  type FilterId,
  type NavigationItem,
} from "../model/signals";
import {
  profileFromStats,
  profileStats,
  sameProfile,
  sendersReclassifiedBy,
  updateProfileStats,
  type ProfileStats,
  type TrashRecord,
  type UserProfile,
} from "../model/profile";
import { classifyAll, classifyEmail, type SignalMap } from "../classify/classify";
import { countAllFilters, matchesBuiltin, rankFilters } from "../classify/filters";
import {
  buildSearchBags,
  conversationFor,
  groupThreads,
  runInboxQuery,
  type InboxResult,
  type SearchBags,
  type ThreadRow,
} from "../classify/pipeline";
import { DEFAULT_SORT, type SortBy } from "../classify/scoring";
import { DEFAULT_UNDO_SEND_SECONDS, type UndoSendSeconds } from "../mail/undoSend";
import { LearningModel } from "../learn/learning";
import { buildContactIndex, type ContactIndex } from "../contacts/index";
import type { GoogleContact } from "../contacts/google";
import type { DraftsApi } from "../mail/drafts";
import {
  DEFAULT_NOTIFICATION_ACTIONS,
  draftForKeptReply,
  notifiable,
  type KeptReply,
  type NotificationActions,
} from "../notify/notifications";
import type { SignalWeights } from "../classify/weights";
import {
  FilterLearning,
  applyFilterLearning,
  builtInSays,
  clueBackground,
  EMPTY_BACKGROUND,
  LEARNABLE_FILTERS,
  type ClueBackground,
  type FilterLearningSnapshot,
  type LearnableFilter,
} from "../learn/filterLearning";
import { explainFilters, type FilterReason } from "../learn/filterExplain";
import { DEMO_ACCOUNT, DEMO_NOW } from "../data/demo";
import type { SyncProgress, SyncStage } from "../gmail/sync";
import {
  DEFAULT_ACCENT_THEME,
  DEFAULT_APPEARANCE,
  type AccentTheme,
  type Appearance,
} from "../model/appearance";
import { TaskCancelled, TaskQueue, type Priority } from "../gmail/pool";
import { keyedStorage, type KeyValueBacking, type KeyedStorage } from "./keyedStorage";
import {
  SnoozeOverlay,
  abandonedSnoozes,
  addSnooze,
  dueSnoozes,
  markWoke,
  parseSnoozes,
  pruneWoke,
  removeSnooze,
  repliedSnoozes,
  snoozeKeyFor,
  snoozedById,
  type SnoozeRecord,
  type SnoozeState,
} from "../mail/snooze";
import {
  addSchedule,
  parseSchedules,
  removeSchedule,
  scheduledRow,
  serializeSchedules,
  updateSchedule,
  type ScheduledSend,
} from "../mail/scheduledSend";
import { formatWhen } from "../mail/when";

/** The mailboxes, in the order the sidebar shows them; Snoozed and Scheduled are views (1.4.0). */
export const MAILBOX_ORDER: readonly Mailbox[] = ["inbox", "snoozed", "archive", "sent", "drafts", "scheduled", "trash", "spam"];

/**
 * Which half of a sync is running, for the status line.
 *
 * Named here rather than reusing `SyncProgress["phase"]`, whose union also contains
 * `idle` and `sending`: a completed phase is `null` here, which makes "not syncing"
 * answerable without a second boolean.
 */
export type SyncPhase = "full" | "incremental";

/** `cursorIndex` meaning "the user has not touched the list yet". */
export const NO_CURSOR = -1;

/**
 * How long a draft discarded with Undo waits before Gmail's copy is deleted, when the
 * offer is neither taken nor let go sooner.
 */
export const DRAFT_DISCARD_UNDO_MS = 10_000;

/** How long the pill says a snooze woke. */
export const WAKE_FLASH_MS = 6_000;
/** A wake later than this after its time happened because the app was closed then. */
export const LATE_WAKE_MS = 2 * 60 * 1000;
/** How long a window's claim on a due scheduled send holds (`claimScheduled`). */
export const CLAIM_HOLD_MS = 2 * 60 * 1000;

/**
 * How often the list's reference clock is refreshed.
 *
 * A minute: the coarsest thing it drives is a relative timestamp, and a store that
 * ticks faster than its own display resolution pays for nothing.
 */
const CLOCK_INTERVAL_MS = 60_000;

/**
 * How many messages keep their HTML body resident.
 *
 * A bound on *this field* rather than on the number of messages. On a representative
 * HTML email the body is 67% of the bytes, and it is read in exactly two places —
 * `Reader` and `reply`, both for the message being opened — so retaining it for every
 * message is the whole of the waste: 5,000 messages cost 12.1MB rather than 3.9MB.
 *
 * The plain-text `body` is kept unconditionally, which is load-bearing: `contentBag`
 * is `subject + body`, so every keyword the classifier matches is still there.
 * Bounding `bodyHtml` costs one request when an old message is opened and costs the
 * classifier nothing. 500 keeps ordinary reading fetch-free, at ~1.2MB resident.
 */
const BODY_RETENTION = 500;

/**
 * Background body prefetch: how many of the newest inbox messages are scanned for
 * unread mail whose body has not been loaded yet. Unread mail is what gets opened
 * next, and its body is also what the classifier reads best.
 */
export const PREFETCH_UNREAD_TOP_N = 50;

/** How many rows either side of an opened message have their body prefetched. */
export const PREFETCH_NEIGHBOURS = 2;

/**
 * Bodies in flight at once. Small on purpose: prefetch shares the quota bucket with
 * sync, and an opened message (high priority) must never wait behind more than this.
 */
const BODY_CONCURRENCY = 2;

/** At most how often sync progress re-renders. */
const PROGRESS_NOTIFY_MS = 500;

/** How long background-loaded bodies wait to be applied together, so a burst reclassifies once. */
const BODY_APPLY_DELAY_MS = 400;

/** The question asked when the offline cache could not be written. Wording is the owner's. */
export const STORAGE_PROMPT =
  "This is a large mailbox, Winnow requires them to be saved, are you sure you would like to save this?";

/** Shown when "Save" was tried and the cache still would not write. */
export const STORAGE_SAVE_FAILED =
  "Still couldn't save this mailbox offline. It will re-download next launch.";

/**
 * Where the offline-storage question stands.
 *
 * `ask` — the last sync could not persist the cache and the user has not answered.
 * `saving` — "Save" is in progress. `failed` — it was tried and did not work.
 */
export type StoragePrompt = "ask" | "saving" | "failed";

/**
 * Split a synced mailbox into its messages and its resident HTML bodies.
 *
 * The bodies are held *beside* `state.all` rather than inside it: attaching one to a
 * message rebuilds the array, which changes `state.all`'s identity, invalidates the
 * memo in `inboxAnalysis` and reclassifies the whole inbox — a 271ms stall at 5,000
 * messages. A side-map leaves `state.all` alone, so the body arrives for the price of
 * a re-render, and `state.all` is uniformly body-free, so nothing has to ask whether a
 * message is inside the window.
 */
function partitionBodies(emails: readonly Email[]): {
  emails: Email[];
  bodies: Map<number, string>;
  /** Messages whose body question is settled — resident, or known to have no HTML. */
  checked: Set<number>;
} {
  const byRecency = [...emails].sort((a, b) => b.receivedAt - a.receivedAt);
  const bodies = new Map<number, string>();
  const checked = new Set<number>();
  let changed = false;

  for (const email of byRecency.slice(0, BODY_RETENTION)) {
    // Every loaded message in the window counts as settled, not just the ones with
    // HTML: recording that stops the reader asking again for a plain-text message it
    // opens. A metadata-only row is not settled — its body has never been fetched.
    if (!isBodyLoaded(email)) continue;
    checked.add(email.id);
    if (email.bodyHtml !== undefined) bodies.set(email.id, email.bodyHtml);
  }

  const stripped = emails.map((email) => {
    // Rows cached before codes existed are looked at once, on the way in.
    const coded = withCode(email);
    if (coded !== email) changed = true;
    if (coded.bodyHtml === undefined) return coded;
    changed = true;
    return { ...coded, bodyHtml: undefined };
  });

  // The same array when nothing had a body, so the demo seed keeps the identity
  // `inboxAnalysis` is keyed on.
  return { emails: changed ? stripped : (emails as Email[]), bodies, checked };
}

/**
 * What Winnow does about remote images in a message.
 *
 * Three states, where a boolean could only say "never" or "always". "Stop asking" is
 * not "never" — a user who has said it three times wants their mail to look like
 * mail. `ask` is the default, and the only state in which the offer appears.
 */
export type ImagePolicy = "ask" | "always" | "never";

/** What the user can change about how Winnow behaves. */
export type Preferences = {
  sortBy: SortBy;
  /**
   * Remote images and tracking pixels. See `ImagePolicy`.
   *
   * `never` is the honest default: loading a remote image tells the sender the message
   * was opened and roughly where, and a pixel does it without showing anything.
   */
  imagePolicy: ImagePolicy;
  /**
   * Brand logos (BIMI) in sender avatars.
   *
   * Its own switch, off by default, rather than riding on `imagePolicy`: that policy is
   * about one message's content and defaults to *asking*, which an avatar in a list has
   * no way to do. A logo lookup also leaks something remote images do not — every sender
   * domain in the list goes to a DNS resolver, opened or not — so it is a separate,
   * explicit yes.
   */
  brandLogos: boolean;
  /**
   * Gravatar photos in sender avatars, for people who are not in the user's contacts.
   * Off by default, for the same reason as `brandLogos`: it sends a hash of every sender
   * address in the list to Gravatar, opened or not.
   */
  gravatars: boolean;
  /**
   * Mark a message read when it is opened in the reader, as Gmail does. On by default.
   * Off restores the old behaviour, where mail stays unread until the user says so.
   */
  markReadOnOpen: boolean;
  /**
   * Swipe a row on a phone: left to Trash (with Undo), right to toggle read. On by
   * default. The same actions stay in the selection bar and the reader, so turning it
   * off loses nothing but the gesture.
   */
  swipeActions: boolean;
  /**
   * Left-handed: on a phone the thumb-anchored floating controls (the reader's action
   * pill, the dock's compose button and pill order) are mirrored to the left edge. Off
   * (right-handed) by default.
   */
  leftHanded: boolean;
  /**
   * Offer "Send as a Drive link" for a file over Gmail's 25 MB. On by default, but it does
   * nothing until the user allows `drive.file` (asked the first time, never at sign-in).
   * Settings → Privacy → Stop turns it off on this device; the grant itself goes with a
   * sign-out, or at Google's account page. See `core/gmail/drive`.
   */
  driveLinks: boolean;
  /**
   * How long Send waits before the message goes out, so Undo can bring it back. `0` is
   * Off. See `core/mail/undoSend`: closing the app in the wait keeps it as a draft.
   */
  undoSendSeconds: UndoSendSeconds;
  notificationsEnabled: boolean;
  /** Which buttons a new-mail notification offers (Reply, Delete, Mark read). */
  notificationActions: NotificationActions;
  /** Lock screen: "New message" instead of the sender and subject. */
  notificationHidePreview: boolean;
  /** Light, dark, true-black OLED, or whatever the OS says. See `core/model/appearance`. */
  appearance: Appearance;
  /** The accent theme, applied across every mode. */
  accent: AccentTheme;
  /**
   * Email dark mode (1.4.0): in the dark and OLED modes, draw message bodies dark too
   * (`core/mail/emailDark`) rather than as a white card. On by default; light mode is
   * never affected, and the reader's sun/moon button shows one message's original
   * colours without changing this.
   */
  emailDarkMode: boolean;
  /** Keep syncing while the window is closed. Desktop only. */
  backgroundSync: boolean;
  /** How often, in seconds. */
  backgroundSyncInterval: number;
  blockedSenders: string[];
  /**
   * Senders whose mail still arrives and is still listed, but never notifies and is not
   * counted in the unread badge. Gentler than `blockedSenders`, which hides the mail.
   * Local to Winnow: Gmail's API has no per-sender mute without a filter, and filters
   * need a settings scope Winnow does not ask for.
   */
  mutedSenders: string[];
};

export const DEFAULT_PREFERENCES: Preferences = {
  sortBy: DEFAULT_SORT,
  imagePolicy: "ask",
  brandLogos: false,
  gravatars: false,
  markReadOnOpen: true,
  swipeActions: true,
  leftHanded: false,
  driveLinks: true,
  undoSendSeconds: DEFAULT_UNDO_SEND_SECONDS,
  notificationsEnabled: false,
  notificationActions: DEFAULT_NOTIFICATION_ACTIONS,
  notificationHidePreview: false,
  appearance: DEFAULT_APPEARANCE,
  accent: DEFAULT_ACCENT_THEME,
  emailDarkMode: true,
  backgroundSync: true,
  backgroundSyncInterval: 300,
  blockedSenders: [],
  mutedSenders: [],
};

/** Where the app is in its lifecycle. Drives which screen is shown. */
export type SessionStatus =
  | "loading"
  | "signed_out"
  | "signing_in"
  | "ready"
  | "error";

/**
 * Where Google contacts stand, for the opt-in.
 *
 *   - `demo` — the demo mailbox, whose address book is seeded and offline.
 *   - `unavailable` — signed out, or a host that cannot ask.
 *   - `not_granted` — signed in without the contact scopes; the opt-in is offered.
 *   - `granted` — the address book is part of the suggestions.
 */
export type ContactsAccessState = "demo" | "unavailable" | "not_granted" | "granted";

export type StoreState = {
  status: SessionStatus;
  /** Set when `status` is `error`, or when a background action failed. */
  error: string | null;
  /** A transient message: "3 messages failed to download". */
  notice: string | null;
  /**
   * A short-lived word about something the user just did ("Draft saved.", "Message
   * sent."), shown in the status pill and gone by itself after its time. `at` orders it
   * against the other notices the pill could show: the newest wins.
   */
  flash: { text: string; at: number } | null;

  account: { email: string } | null;

  /**
   * The account namespace that is open (1.4.0), or `null` in the demo and signed out.
   * What the store persists (learning, active filters, the mailbox) is written under it.
   */
  accountId: string | null;
  /**
   * Every signed-in account, for the switcher: set by the session bridge, which owns the
   * registry and the inactive accounts' light sync. The open one is `active`.
   */
  accounts: readonly AccountSummary[];

  /**
   * Google's address book, merged into the contact index. Empty until the user opts in.
   *
   * Replaced whole, never mutated, so the contact index can memoise on its identity.
   */
  googleContacts: readonly GoogleContact[];
  contactsAccess: ContactsAccessState;

  /** Every message the app knows about, across all mailboxes. */
  all: Email[];
  /**
   * The user's Gmail drafts, the rows of the Drafts mailbox (each with `gmailDraft`).
   *
   * Kept apart from `all` because they are listed through the drafts API, not synced:
   * a sync replaces `all` wholesale and would drop them, and nothing that reads `all`
   * (the profile, the contact index, new-mail notices, the mutations) should ever see a
   * draft as mail.
   */
  drafts: Email[];
  /** A drafts listing is in flight. */
  draftsLoading: boolean;
  /**
   * Snoozed conversations and the messages that woke, for every account this device has
   * seen (each record names its own; see `core/mail/snooze.ts`). Mirrors
   * `winnow.snooze.v1`.
   */
  snoozes: SnoozeState;
  /** Messages waiting to be sent later (`core/mail/scheduledSend.ts`). Mirrors `winnow.scheduledSend.v1`. */
  scheduled: readonly ScheduledSend[];
  /** The messages in the current mailbox, newest first. */
  mailbox: Mailbox;

  activeFilters: FilterId[];
  searchQuery: string;
  /** The reader's message, or `null`. */
  selectedId: number | null;
  /**
   * The list cursor, independent of what the reader has open.
   *
   * `-1` means "no cursor", distinct from "on the first row": `j` on a fresh list
   * should start at the top and `k` at the bottom, which cannot be expressed if row 0
   * is also "nothing selected yet".
   */
  cursorIndex: number;
  /**
   * Bumped whenever the cursor moved by *navigation* — `j`/`k`, the arrows, prev/next,
   * a deep link, or the auto-advance after marking a message unread — and never by a
   * click or a data change.
   *
   * The list scrolls a row into view only when this changes. Following the cursor index
   * itself scrolled on every re-render that touched the list (a measured row height, a
   * sync, a reclassify), which snapped a user who had scrolled away from the open message
   * straight back to it.
   */
  revealSeq: number;

  preferences: Preferences;
  learning: LearningModel;
  /**
   * What "Change smart filters…" has taught, for this account only. See
   * `learn/filterLearning.ts`; cleared on sign-out and when another account connects.
   */
  filterLearning: FilterLearning;

  /** Which modal is up, if any. */
  overlay: "none" | "shortcuts" | "navigation" | "settings";
  navigationIndex: number;

  syncing: boolean;
  /**
   * A single undo, offered by whatever can be taken back: a swipe's Trash or Restore, a
   * draft discarded with a swipe. Shown in the status pill with its Undo button.
   *
   * `null` most of the time, and that is the point: an Undo that is always on screen is
   * a banner, and a banner you cannot act on is noise. Only one action is offered at a
   * time — a new offer lets the previous one go — so the pill's Undo always takes back
   * the action it names. `at` orders it against the pill's other notices.
   */
  undo: { label: string; at: number } | null;
  /**
   * What the sync is doing, for the status line. `null` when not syncing.
   *
   * Nullable rather than an enum with an `idle` member: "is a sync running" and "which
   * kind is it" are two questions, and only the first is asked most of the time.
   * `syncing` answers the first for callers that need the *count*; this answers the
   * second.
   */
  syncPhase: SyncPhase | null;
  /** 0–1 while the total is known, else `null`. */
  syncFraction: number | null;
  /** Messages that arrived in the run in progress, or the last completed one. */
  syncFetched: number;
  /** Full sync only: the inbox, or the folders behind it. `null` otherwise. */
  syncStage: SyncStage | null;
  /** How many messages the running sync knows it has to fetch, when known. */
  syncTotal: number | null;
  /** The last sync threw, with this message; cleared when a sync starts or succeeds. */
  syncError: string | null;
  /** How many messages the last completed sync could not download. */
  syncFailed: number;
  lastSyncedAt: number | null;
  /**
   * True when a sync walked a mailbox to its cap, so the cache is a triage set rather
   * than an export. Showing 500 archived messages as though they were all of it would
   * be a lie about the user's own mail.
   */
  truncated: boolean;
  /** Ids that arrived in the last sync, for the "new" marker. */
  recentIds: ReadonlySet<number>;
  /**
   * The offline-cache question, or `null` when there is nothing to ask.
   *
   * A prompt rather than a passive notice, because the answer changes what happens:
   * "Save" asks the platform for persistent storage and retries the write, "Not now"
   * keeps the re-download-next-launch behaviour for the rest of the session.
   */
  storagePrompt: StoragePrompt | null;
  /**
   * The reference instant the list's day sections are computed against.
   *
   * A property rather than a `Date.now()` at the point of use: the demo mailbox is
   * seeded around a fixed date, and a real clock would put every one of its messages
   * in "Earlier", making the day sections stop testing anything. Live mode uses the
   * wall clock; demo mode uses the seed's.
   */
  now: number;
};

/** The messages a sync produced for the current mailbox. */
export type MailboxView = {
  emails: Email[];
  signals: SignalMap;
  profile: UserProfile;
  /**
   * Lowercased haystacks for the current mailbox — but only when a search is
   * actually running.
   *
   * Empty otherwise, on purpose: building a bag concatenates sender + subject + body
   * for every message and lowercases it, and the pipeline only reads one when
   * `tokens.length > 0`. `runInboxQuery` builds a single bag on demand, so the empty
   * map is a fast path rather than a missing feature.
   */
  searchBags: SearchBags;
  result: InboxResult;
  threads: ThreadRow[];
  /** The rail, ranked over the open mailbox, with activated buckets kept on it. */
  rail: BuiltinSmartFilter[];
  /**
   * How many messages in the *open mailbox* each bucket holds, before search and filters:
   * the numbers on the pills (1.3.3; they were inbox-wide wherever you were). `unsafe`
   * is counted even though the inbox hides those rows with no filter on.
   */
  railCounts: ReadonlyMap<BuiltinSmartFilter, number>;
  /** Messages per sender in the open mailbox, for the sender pills. */
  railSenderCounts: ReadonlyMap<string, number>;
  /**
   * How many inbox messages land in each bucket.
   *
   * Over the *inbox*, not over `emails`, which is why it is a field: the rail is ranked
   * against the inbox so opening the bin does not reshuffle it, and the counts must
   * agree with that ranking. The number on a pill is a claim about your mail, not the
   * current result set. `unsafe` is counted even though it is excluded from the list —
   * its members *are* the hidden rows, and counting only what is on screen would report
   * the one bucket you need to reach as permanently empty.
   */
  inboxCounts: ReadonlyMap<BuiltinSmartFilter, number>;
  /** Messages per sender, over the inbox, for the sender pills. */
  inboxSenderCounts: ReadonlyMap<string, number>;
  /**
   * Conversations the unfiltered inbox list shows, for the sidebar's Inbox count: the
   * same rows (unsafe mail is held back from the list, so it is not counted here).
   */
  inboxThreadCount: number;
  /**
   * What in the inbox needs attention, for the triage line. Over the inbox for the same
   * reason as `inboxCounts`: it is a claim about your mail, not about the current filter.
   */
  attention: AttentionSummary;
  selected: Email | null;
  /**
   * The row of the open message's conversation in `threads`, or `-1`.
   *
   * Matched by thread, not only by representative: a message opened from inside a
   * thread, or one whose thread gained a newer reply since it was opened, is still read
   * on that row. `-1` when nothing is open or the open message's conversation is not a
   * visible row (a filter or search is hiding it, or it has left the mailbox).
   *
   * This, not `cursorIndex`, is where the reader *is*; see `readoutIndex`.
   */
  selectedIndex: number;
  conversation: Email[];
  unreadCount: number;
  totalCount: number;
  /** Everything the app knows that is not in the current mailbox. */
  otherMailboxCount: number;
  /**
   * Everyone the mail in the store says the user has corresponded with.
   *
   * Part of the one derived pass because it is derived from `state.all` like everything
   * else, and like everything else it is memoised — see `contactCache`. Without that the
   * 60-second clock tick would rebuild the index over a 5,000-message mailbox, which is
   * the same mistake `inboxAnalysis` exists to avoid.
   */
  contacts: ContactIndex;
};

/** Everything the store owns. Read this in React; never mutate it. */
export type Snapshot = StoreState & {
  view: MailboxView;
  key: string;
};

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
   * Try again to write the offline cache, after asking the platform to keep it.
   *
   * On the web this requests persistent storage first (`navigator.storage.persist()`);
   * on the desktop it just retries. `true` when the cache landed.
   */
  persistCache?(): Promise<boolean>;
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
  setUnreadBadge(count: number): Promise<void>;
  setBackgroundSync(intervalSeconds: number | null): Promise<void>;
}

type Listener = () => void;

/**
 * What the pill says after a move that can be undone, in the swipe's words: "Moved to
 * Trash." / "Archived." for one message, "Moved 5 to Trash." / "Archived 5." for a
 * batch, and "Moved 5." when a batch went to more than one place.
 */
export function undoLabel(destinations: readonly Mailbox[]): string {
  const count = destinations.length;
  const first = destinations[0];
  const same = destinations.every((to) => to === first);
  if (!same) return `Moved ${count}.`;
  if (first === "archive") return count === 1 ? "Archived." : `Archived ${count}.`;
  return count === 1 ? `Moved to ${MAILBOX_LABEL[first]}.` : `Moved ${count} to ${MAILBOX_LABEL[first]}.`;
}

/** How a mutation can be undone. */
type Undo = () => void;

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
};

/** What one account (or the demo, with no account) persisted: see `core/store/accountState.ts`. */
export type AccountState = {
  learning?: ReturnType<LearningModel["toSnapshot"]> | null;
  filterLearning?: unknown;
  activeFilters?: readonly string[];
  mailbox?: Mailbox | null;
};

export type PersistPatch = {
  preferences?: Partial<Preferences>;
  learning?: ReturnType<LearningModel["toSnapshot"]>;
  /** Local only, never synced: see `learn/filterLearning.ts`. */
  filterLearning?: FilterLearningSnapshot;
  activeFilters?: string[];
  mailbox?: Mailbox;
};

/**
 * The application store.
 *
 * Not a React store: it has no idea React exists, and `useSyncExternalStore` is the
 * only bridge — which is why the same class drives the desktop app, the web app and
 * the tests.
 */
export class WinnowStore {
  private state: StoreState;
  private listeners = new Set<Listener>();
  private version = 0;
  private key = "0";

  /**
   * The last derived view, and the version it was derived at.
   *
   * `derive()` builds the profile, classifies the whole inbox, filters, sorts and
   * threads; recomputing it on every *read* is what makes the list, the rail and the
   * reader impossible to disagree, but reads far outnumber changes — a single `↓` in
   * the reader produced an 81ms long task over a mailbox that had not changed a byte.
   *
   * So the view is memoised against `version`, which only `notify()` increments: every
   * mutation funnels through `set`, `notify`, or the two methods that bump the version,
   * so "the version has not moved" is exactly "nothing the view depends on has moved".
   * `getSnapshot` still spreads the current `state`, so cheap fields read
   * synchronously (the learning weights) never go stale behind the debounced
   * reclassify.
   */
  private derived: { version: number; view: MailboxView } | null = null;

  private backend: MailBackend | undefined;
  private platform: PlatformBridge | undefined;
  /** The demo's address book, restored whenever the demo is. */
  private readonly seedContacts: readonly GoogleContact[];

  /**
   * Resident HTML bodies, by message id. Bounded by `BODY_RETENTION`, and held apart
   * from `state.all` so attaching one cannot change `all`'s identity — see
   * `partitionBodies`.
   */
  private bodies = new Map<number, string>();

  /**
   * Messages whose body has been resolved either way.
   *
   * Separate from `bodies` because "fetched, no HTML part" and "not fetched yet" both
   * mean `bodies.has(id) === false`, and only the second should hit the network —
   * otherwise plain-text mail is refetched on every render.
   */
  private bodyChecked = new Set<number>();

  /** In-flight body fetches, so opening the same message twice asks once. */
  private bodyInFlight = new Map<number, Promise<void>>();
  /** Bodies whose last fetch failed. Not an answer (opening again retries), but the reader stops saying "Loading". */
  private bodyFailed = new Set<number>();

  /** Body fetches, opened-message first. See `BODY_CONCURRENCY`. */
  private bodyQueue = new TaskQueue(BODY_CONCURRENCY);

  /** Background-loaded bodies waiting to be applied to `state.all` in one pass. */
  private pendingBodies = new Map<number, LoadedBody>();
  private bodyApplyTimer: ReturnType<typeof setTimeout> | null = null;

  /** "Not now" on the storage question, for the rest of this session. */
  private storageDeclined = false;

  /**
   * The binned senders, kept separately from the message list.
   *
   * A trash row carries only a sender address, deliberately: the discard is the signal,
   * and retaining the body of something the user binned is a privacy problem.
   */
  private trashSenders: string[] = [];

  /**
   * Undo handles for in-flight mutations, keyed by message id.
   *
   * Keyed rather than a single stack, so a second star toggle supersedes the first
   * instead of rolling it back out of order.
   */
  private pending = new Map<number, Undo>();

  /** Reclassify after a debounce, so a slider drag is not a reclassify per tick. */
  private classifyTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The offered undo's handler. On the instance rather than in `StoreState`, because a
   * function in the public snapshot would make the whole state object unserialisable.
   */
  private undoAction: (() => void) | null = null;
  /**
   * What happens when the offered undo is let go rather than taken, for an action that
   * waits for that before it reaches Gmail (discarding a draft). Run when the offer is
   * dismissed, replaced, or left behind by a mailbox change; dropped, never run, by
   * sign-out and the demo, where keeping the draft is the safe side.
   */
  private undoCommit: (() => void) | null = null;
  /** The commit's deadline, so a forgotten strip does not hold a draft back for ever. */
  private undoCommitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Drafts discarded with Undo still on offer: a listing landing meanwhile keeps them out. */
  private pendingDiscards = new Set<string>();

  /** `winnow.snooze.v1` and `winnow.scheduledSend.v1`. */
  private readonly snoozeSlot: KeyedStorage;
  private readonly scheduleSlot: KeyedStorage;
  /** Lays the snoozes over every reading of the mailbox; see `set`. */
  private readonly snoozeOverlay = new SnoozeOverlay();

  constructor(options: StoreOptions = {}) {
    this.snoozeSlot = keyedStorage("snooze", options.storage);
    this.scheduleSlot = keyedStorage("scheduledSend", options.storage);
    this.backend = options.backend;
    this.platform = options.platform;
    this.seedContacts = options.seedContacts ?? [];
    this.trashSenders = (options.seedTrash ?? []).map((row) => row.sender);

    const seed = (options.seed ?? []).slice();
    this.state = {
      status: options.backend ? "loading" : "ready",
      error: null,
      notice: null,
      flash: null,
      account: null,
      accountId: null,
      accounts: [],
      googleContacts: options.backend ? [] : this.seedContacts,
      contactsAccess: options.backend ? "unavailable" : "demo",
      all: seed,
      drafts: options.backend ? [] : (options.seedDrafts ?? []).slice(),
      draftsLoading: false,
      snoozes: parseSnoozes(this.snoozeSlot.read()),
      scheduled: parseSchedules(this.scheduleSlot.read()),
      mailbox: "inbox",
      activeFilters: [],
      searchQuery: "",
      selectedId: null,
      cursorIndex: NO_CURSOR,
      revealSeq: 0,
      preferences: { ...DEFAULT_PREFERENCES, ...options.preferences },
      learning: LearningModel.initial(),
      filterLearning: FilterLearning.empty(),
      overlay: "none",
      navigationIndex: 0,
      syncing: false,
      undo: null,
      syncPhase: null,
      syncFraction: null,
      syncFetched: 0,
      syncStage: null,
      syncTotal: null,
      syncError: null,
      syncFailed: 0,
      lastSyncedAt: null,
      truncated: false,
      recentIds: new Set(),
      storagePrompt: null,
      now: options.now ?? Date.now(),
    };
    this.state = { ...this.state, all: this.overlaid(this.state.all) };
  }

  /**
   * Advance the list's reference clock.
   *
   * `state.now` is latched, and every day section and relative timestamp is computed
   * against it. That is right for the demo and wrong for live mail: an app left open
   * overnight would still say its newest message arrived "2 minutes ago". So it is
   * refreshed on a slow tick; the store owns the timer because the store owns `now`.
   */
  startClock(): () => void {
    let last = Date.now();
    const tick = (): void => {
      const wall = Date.now();
      // Live mail reads the wall clock. The demo's instant is wherever the seed was put
      // (`demoMailbox` moves it onto the real clock at boot) and moves on at the same
      // rate from there, so its day sections are fixed at boot while things that age,
      // like a one-time code's Copy chip, still age out.
      if (this.backend) this.set({ now: wall });
      else if (wall > last) this.set({ now: this.state.now + (wall - last) });
      last = wall;
    };
    const handle = setInterval(tick, CLOCK_INTERVAL_MS);
    return () => clearInterval(handle);
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => {
    this.key = String(this.version);
    return { ...this.state, view: this.deriveCached(), key: this.key };
  };

  /** The current view, for non-React callers (the keybind handler, tests). */
  get view(): MailboxView {
    return this.deriveCached();
  }

  /** `derive()`, at most once per version. See `derived`. */
  private deriveCached(): MailboxView {
    const cached = this.derived;
    if (cached && cached.version === this.version) return cached.view;
    const view = this.derive();
    this.derived = { version: this.version, view };
    return view;
  }

  /**
   * Everything derived from the messages, in dependency order, so no consumer can see
   * a half-updated world: profile → signals → search bags → visible list → rail.
   */
  /**
   * The user profile and the inbox's signals, memoised on the only inputs that can
   * change them.
   *
   * `derive()` is memoised on `version`, the right granularity for "recompute the
   * world" but the wrong one for the app's most expensive step: `state.now` is part of
   * that state, so the 60-second clock tick reclassified every inbox message — 271ms
   * for 5,000 messages. None of these four inputs move when the clock does, so a tick
   * now costs one number.
   */
  private inboxCache: {
    all: readonly Email[];
    weights: SignalWeights;
    trash: readonly string[];
    blocked: readonly string[];
    filterLearning: FilterLearning;
    /** The inbox the profile was counted from, and those counts, for the incremental update. */
    inbox: ReadonlySet<Email>;
    stats: ProfileStats;
    profile: UserProfile;
    /**
     * What the built-in rules said, before `filterLearning`: for "Why it's here" and for
     * star learning, which must see the classifier's own output, never corrections.
     */
    baseSignals: SignalMap;
    /** How common each clue is in this inbox; the decision and its explanation share it. */
    background: ClueBackground;
    signals: SignalMap;
    /**
     * The built-in answer per message *object*, for the incremental pass: a change to one
     * message (opened and so read, archived, starred) replaces that object only, so when
     * the profile comes out the same every other message keeps its classification.
     */
    byEmail: WeakMap<Email, EmailSignals>;
  } | null = null;

  /** Which filters each message object is in, so the rail's counts recount only what changed. */
  private readonly filterHits = new WeakMap<
    Email,
    { signal: EmailSignals; profile: UserProfile; ids: readonly BuiltinSmartFilter[] }
  >();

  /**
   * The contact index, memoised on the only two inputs that can change it.
   *
   * `all` is the whole story — the index is derived from the messages and is not itself
   * persisted, so there is nothing to fall out of step with. The account address matters
   * only as the authoritative answer to "which address is the user's own", which the
   * signed-out demo does not have; signed in it is read from `state.account`.
   *
   * Keyed on identity rather than contents for the reason `inboxCache` is: a clock tick
   * and a weight change both bump the version without touching a single message, and
   * neither should cost a pass over the whole mailbox.
   */
  private contactCache: {
    all: readonly Email[];
    self: string | null;
    google: readonly GoogleContact[];
    index: ContactIndex;
  } | null = null;

  private contacts(): ContactIndex {
    const all = this.state.all;
    const self = this.state.account?.email ?? null;
    const google = this.state.googleContacts;
    const hit = this.contactCache;
    if (hit && hit.all === all && hit.self === self && hit.google === google) return hit.index;
    const index = buildContactIndex(all, { selfAddress: self, googleContacts: google });
    this.contactCache = { all, self, google, index };
    return index;
  }

  /**
   * Adopt Google's address book, and say where access stands.
   *
   * Called by the app after a refresh, and with `[]` when access is missing or revoked —
   * so a permission the user took back stops shaping the suggestions immediately.
   */
  setGoogleContacts(contacts: readonly GoogleContact[], access: ContactsAccessState): void {
    this.set({ googleContacts: contacts.slice(), contactsAccess: access });
  }

  private inboxAnalysis(): { profile: UserProfile; signals: SignalMap } {
    const state = this.state;
    const { all, learning, preferences } = state;
    const weights = learning.weights;
    const trash = this.trashSenders;
    const blocked = preferences.blockedSenders;

    const hit = this.inboxCache;
    if (
      hit &&
      hit.all === all &&
      hit.weights === weights &&
      hit.trash === trash &&
      hit.blocked === blocked &&
      hit.filterLearning === state.filterLearning
    ) {
      return { profile: hit.profile, signals: hit.signals };
    }

    // Blocked senders excluded here for the same reason as `visible`: their volume must
    // not reach the engagement ranking.
    const blockedLower = new Set(blocked.map((s) => s.toLowerCase()));
    const inboxForProfile = all.filter(
      (email) => email.mailbox === "inbox" && !blockedLower.has(email.sender.toLowerCase()),
    );
    const inboxSet = new Set(inboxForProfile);
    // The incremental path: the weights and the blocked list are as they were, so only
    // messages moved (read, starred, archived, binned, arrived). The profile's counts are
    // updated for the messages that left the inbox and the ones that joined it, rather than
    // recounted, and only the senders whose classification inputs actually changed (see
    // `sendersReclassifiedBy`) are reclassified, along with any message object that is
    // new. Archiving one message in a 3,000-message inbox used to reclassify all 3,000,
    // because it moved that sender's count and so the profile.
    const incremental = hit !== null && hit.weights === weights && hit.blocked === blocked;
    /** The same message objects in the inbox as last time: the clue background still holds. */
    let sameInbox = false;
    let stats: ProfileStats;
    let profile: UserProfile;
    let baseSignals: SignalMap;
    const byEmail = new WeakMap<Email, EmailSignals>();
    if (incremental) {
      const removed: Email[] = [];
      for (const email of hit.inbox) if (!inboxSet.has(email)) removed.push(email);
      const added = inboxForProfile.filter((email) => !hit.inbox.has(email));
      sameInbox = removed.length === 0 && added.length === 0;
      stats = updateProfileStats(hit.stats, removed, added, this.trashRecords());
      const built = profileFromStats(stats);
      const unchanged = sameProfile(hit.profile, built);
      profile = unchanged ? hit.profile : built;
      const affected = unchanged ? null : sendersReclassifiedBy(hit.profile, built);
      const map = new Map<number, EmailSignals>();
      for (const email of inboxForProfile) {
        let signals = affected?.has(email.sender) ? undefined : hit.byEmail.get(email);
        if (!signals) {
          signals = classifyEmail(email, profile, weights);
          // The same answer as before (a read flag flipped): keep the old object, so the
          // per-message memos below it (the rail's counts) still hit.
          const previous = hit.baseSignals.get(email.id);
          if (previous && sameSignals(previous, signals)) signals = previous;
        }
        map.set(email.id, signals);
        byEmail.set(email, signals);
      }
      baseSignals = map;
    } else {
      stats = profileStats(inboxForProfile, this.trashRecords());
      profile = profileFromStats(stats);
      baseSignals = classifyAll(inboxForProfile, profile, weights);
      for (const email of inboxForProfile) byEmail.set(email, baseSignals.get(email.id)!);
    }
    const filterLearning = state.filterLearning;
    // The clue background is only read by learning, so with nothing learned it is not
    // built at all; otherwise it is kept while the inbox holds the same message objects
    // (a star, a weight-free re-derive), since `clueBackground`'s own memo is keyed on
    // the array and `inboxForProfile` is a fresh one every pass.
    const background = filterLearning.isEmpty
      ? EMPTY_BACKGROUND
      : sameInbox && hit !== null && hit.background !== EMPTY_BACKGROUND
        ? hit.background
        : clueBackground(inboxForProfile);
    const signals = applyFilterLearning(inboxForProfile, baseSignals, filterLearning, background);
    this.inboxCache = { all, weights, trash, blocked, filterLearning, inbox: inboxSet, stats, profile, baseSignals, background, signals, byEmail };
    return { profile, signals };
  }

  /** Base classification per message object for non-inbox mailboxes; see `mailboxSignals`. */
  private readonly mailboxBase = new WeakMap<Email, { profile: UserProfile; weights: StoreState["learning"]["weights"]; signal: EmailSignals }>();

  /**
   * A non-inbox mailbox, classified for smart filters with the inbox's profile and
   * weights, then what has been learned applied over it. Memoised per message object
   * and profile, so switching back and forth, or one message changing, reclassifies only
   * what changed.
   */
  private mailboxSignals(emails: readonly Email[], profile: UserProfile): SignalMap {
    const weights = this.state.learning.weights;
    const base = new Map<number, EmailSignals>();
    for (const email of emails) {
      const hit = this.mailboxBase.get(email);
      let signal = hit && hit.profile === profile && hit.weights === weights ? hit.signal : undefined;
      if (!signal) {
        signal = classifyEmail(email, profile, weights);
        this.mailboxBase.set(email, { profile, weights, signal });
      }
      base.set(email.id, signal);
    }
    const learning = this.state.filterLearning;
    if (learning.isEmpty) return base;
    const background = this.inboxCache?.background ?? EMPTY_BACKGROUND;
    return applyFilterLearning(emails, base, learning, background);
  }

  private derive(): MailboxView {
    const state = this.state;
    const blocked = new Set(state.preferences.blockedSenders.map((s) => s.toLowerCase()));

    // Blocked senders are hidden from every view, and before the profile is built, or
    // their volume would still push them up the engagement ranking.
    const visible = state.all.filter((email) => !blocked.has(email.sender.toLowerCase()));
    // Drafts are their own list (see `StoreState.drafts`), never filtered by sender: the
    // sender of every draft is the user.
    const mailboxEmails = this.listedIn(visible);

    // The profile is built from the *inbox*, not the current mailbox: learning "who you
    // read" from an archive or a bin would teach it the wrong thing. Memoised; see
    // `inboxAnalysis`.
    const { profile, signals: inboxSignals } = this.inboxAnalysis();
    const inboxForProfile = visible.filter((email) => email.mailbox === "inbox");

    // Smart filters apply to whichever mailbox is open (1.3.3), classified with the
    // inbox's profile and what has been learned: the inbox's signals are reused there,
    // every other mailbox is classified on demand (`mailboxSignals`, memoised per
    // message). Only the inbox holds back unsafe mail with no filter on (`hideUnsafe`
    // below): applying that rule to the bin or the spam folder is how they once showed
    // nothing. Drafts are the user's own and stay unclassified.
    const signals =
      state.mailbox === "inbox"
        ? inboxSignals
        : state.mailbox === "drafts" || state.mailbox === "scheduled"
          ? neutralSignalsFor(mailboxEmails)
          : this.mailboxSignals(mailboxEmails, profile);

    // Only when a search is running. See `searchBags`: the pipeline builds a bag on
    // demand, so the unsearched case is a fast path, not a different code path.
    const searching = state.searchQuery.trim().length > 0;
    const searchBags = searching ? buildSearchBags(mailboxEmails) : new Map<number, string>();

    const queried = runInboxQuery({
      emails: mailboxEmails,
      profile,
      signals,
      filters: state.activeFilters,
      searchQuery: state.searchQuery,
      sortBy: state.preferences.sortBy,
      searchBags,
      hideUnsafe: state.mailbox === "inbox",
    });
    // Snoozed and Scheduled are lists of times: whatever comes back (or goes) soonest
    // leads, whatever the sort setting says about mail.
    const result =
      state.mailbox === "snoozed" || state.mailbox === "scheduled"
        ? { ...queried, emails: [...queried.emails].sort((a, b) => timedAt(a) - timedAt(b)) }
        : queried;

    const threads = groupThreads(result.emails);

    // The rail is ranked and counted over the *open mailbox* (1.3.3), before search and
    // filters: a pill's number is how many messages in this mailbox it would show, so
    // the count, the list a filter gives and "Why it's here" all agree. The permanent
    // pair stays pinned wherever you are.
    const railEmails = state.mailbox === "drafts" || state.mailbox === "scheduled" ? [] : mailboxEmails;
    const rail = rankFilters(railEmails, signals, profile);
    const railWithActive = this.orderedRail(rail);
    const railCounts =
      state.mailbox === "inbox"
        ? countAllFilters(inboxForProfile, inboxSignals, profile, this.filterHits)
        : countAllFilters(railEmails, signals, profile, this.filterHits);
    const railSenderCounts = new Map<string, number>();
    for (const email of railEmails) {
      railSenderCounts.set(email.sender, (railSenderCounts.get(email.sender) ?? 0) + 1);
    }

    // Over the inbox whatever is open: the drawer's and the triage line's claims.
    const inboxCounts =
      state.mailbox === "inbox" ? railCounts : countAllFilters(inboxForProfile, inboxSignals, profile, this.filterHits);

    const attention = summarizeAttention(inboxForProfile, inboxSignals, state.now);

    const inboxThreadCount = new Set(
      inboxForProfile
        .filter((email) => {
          const signal = inboxSignals.get(email.id);
          return !signal || !isUnsafe(signal);
        })
        .map((email) => email.threadId ?? email.gmailId),
    ).size;

    const inboxSenderCounts = new Map<string, number>();
    for (const email of inboxForProfile) {
      inboxSenderCounts.set(email.sender, (inboxSenderCounts.get(email.sender) ?? 0) + 1);
    }

    /*
     * The open message, resolved from the *result* first and from the mailbox second.
     *
     * Turning on a smart filter must not take away the message somebody is reading —
     * it only says which rows to *show* — so the fallback deliberately looks in
     * `mailboxEmails`, the same mailbox's messages *before* filters and search. A
     * message a filter is hiding is still found; one that was archived, trashed,
     * moved, blocked or removed by a sync is not there, so the reader still closes for
     * every reason it should. Switching mailbox drops the selection outright, in
     * `setMailbox`.
     */
    const selectedRow = threads.find((row) => row.representative.id === state.selectedId) ?? null;
    const selectedIndex = rowIndexOf(threads, state.selectedId, mailboxEmails);
    const selectedFallback =
      selectedRow === null && state.selectedId !== null
        ? (mailboxEmails.find((email) => email.id === state.selectedId) ?? null)
        : null;
    const selectedEmail = selectedRow?.representative ?? selectedFallback;
    const selected = selectedEmail ? this.withBody(selectedEmail) : null;
    // From `visible`, not `state.all`: finding a blocked sender's mail quoted in an open
    // thread is not blocking them. Body-bearing copies, because this is where a message
    // is actually *read*; everything above works on the body-free messages `state.all`
    // holds.
    const conversation = selected
      ? conversationFor(visible, selected.threadId, selected.gmailId).map((m) => this.withBody(m))
      : [];

    return {
      emails: result.emails,
      signals,
      profile,
      searchBags,
      result,
      threads,
      rail: railWithActive,
      railCounts,
      railSenderCounts,
      inboxCounts,
      inboxSenderCounts,
      inboxThreadCount,
      attention,
      selected,
      selectedIndex,
      conversation,
      unreadCount: mailboxEmails.filter((email) => email.unread).length,
      totalCount: mailboxEmails.length,
      otherMailboxCount:
        state.mailbox === "drafts" || state.mailbox === "scheduled"
          ? visible.length
          : visible.length - mailboxEmails.length,
      contacts: this.contacts(),
    };
  }

  /**
   * The rail's final order: the permanent pair leads, then activated buckets (in the
   * order they were turned on, *whether or not they match anything* — an empty active
   * bucket must keep its pill or a live filter is left with no control), then the
   * ranking.
   *
   * Ported from `legacy/swift-native/Sources/winnow/Store/WinnowStore.swift`, which
   * pins the permanent pair *before* hoisting actives; the order matters.
   */
  private orderedRail(ranked: BuiltinSmartFilter[]): BuiltinSmartFilter[] {
    const activeBuiltins = this.state.activeFilters
      .filter((filter): filter is Extract<FilterId, { kind: "builtin" }> => filter.kind === "builtin")
      .map((filter) => filter.id);

    const pinned = [...PERMANENT_FILTERS];

    // An active bucket keeps its place in the rail rather than being hoisted to the
    // front: a tab that jumped when clicked would move away from the pointer and
    // repoint the digit shortcuts. (The rail scrolls a newly active tab into the clear
    // itself.) Only an active bucket the ranking left out is added, after the ranked
    // ones and in catalog order, so it can be turned off.
    const placed = new Set([...pinned, ...ranked]);
    const extra = activeBuiltins
      .filter((id) => !placed.has(id))
      .sort((a, b) => catalogIndex(a) - catalogIndex(b));
    const rest = ranked.filter((id) => !pinned.includes(id));

    return [...pinned, ...rest, ...extra];
  }

  // ── Changing ──────────────────────────────────────────────────────────────

  /**
   * Apply a partial update and notify.
   *
   * The version bump is what `useSyncExternalStore` reads: `getSnapshot` returns a fresh
   * object each time, so a monotonically increasing key answers "did it change?" without
   * a deep comparison.
   */
  private set(patch: Partial<StoreState>, persist?: PersistPatch): void {
    this.state = { ...this.state, ...patch };
    // Every reading of the mailbox (a sync, a partial, an optimistic change, the demo)
    // has the snoozes laid over it here, the one door `all` comes in by, so a snoozed
    // message can never flash back into the Inbox between a sync and a wake.
    if (patch.all !== undefined || patch.snoozes !== undefined || patch.account !== undefined) {
      const all = this.overlaid(this.state.all);
      if (all !== this.state.all) this.state = { ...this.state, all };
    }
    this.notify();
    if (persist) this.onPersist?.(persist);
  }

  /**
   * Tell every subscriber the world moved.
   *
   * Split out of `set` because the sync engine's progress callback needs to advance
   * state without notifying on every message it downloads.
   */
  private notify(): void {
    this.version += 1;
    this.followOpenMessage();
    for (const listener of this.listeners) listener();
  }

  /**
   * Keep the cursor on the open message's row, whatever moved the rows.
   *
   * The cursor is an index and the reader an id, and every change to the list — a sync,
   * new mail, an archive or delete above, an undo, a filter, a search, a re-sort, the
   * open thread gaining a reply — shifts indices without touching the id. Patching each
   * of those paths is how they drifted apart ("4 of 39" over the fifth message, `j`
   * stepping from a row nobody is on), so the invariant is restored here instead, once,
   * on every change: while the open message is a visible row, the cursor is that row.
   *
   * When it is not a row the cursor is left where it was. That is where the message
   * *was*, which `stepTarget` steps on from, and the readout shows no number.
   *
   * Run between the version bump and the listeners, so the cached view it derives is the
   * one they read. `derive` does not read `cursorIndex`, so patching it here leaves that
   * cache valid.
   */
  private followOpenMessage(): void {
    if (this.state.selectedId === null) return;
    const at = this.deriveCached().selectedIndex;
    if (at >= 0 && at !== this.state.cursorIndex) this.state = { ...this.state, cursorIndex: at };
  }

  /** Wired by `attach`; see `StoreOptions`. */
  private onPersist: ((patch: PersistPatch) => void) | undefined;
  private onWeightsChanged: ((model: LearningModel) => void) | undefined;

  /**
   * Late-bind the store's collaborators.
   *
   * Separate from the constructor because the backend and platform need the store and
   * the store needs them — constructing both at once would be a cycle.
   */
  attach(options: {
    backend?: MailBackend;
    platform?: PlatformBridge;
    onPersist?: (patch: PersistPatch) => void;
    onWeightsChanged?: (model: LearningModel) => void;
  }): void {
    this.backend = options.backend ?? this.backend;
    this.platform = options.platform ?? this.platform;
    if (options.onPersist) this.onPersist = options.onPersist;
    if (options.onWeightsChanged) this.onWeightsChanged = options.onWeightsChanged;
  }

  /**
   * Trash rows for the profile: senders the user has binned from.
   *
   * Two sources describe the same habit and are combined with `max` rather than summed:
   * the messages currently in the bin, and the discards the store has witnessed.
   * Summing counted a sender twice for every message still in the bin, so the bias
   * tracked the *size* of the bin rather than how often the user discards — the number
   * the profile reads.
   *
   * `max` also makes purging work: deleting a message for good removes it from
   * `state.all`, and without the witnessed log that discard would stop existing.
   */
  private trashRecords(): TrashRecord[] {
    const witnessed = new Map<string, number>();
    for (const sender of this.trashSenders) {
      witnessed.set(sender, (witnessed.get(sender) ?? 0) + 1);
    }

    const inBin = new Map<string, number>();
    for (const email of this.state.all) {
      if (email.mailbox === "trash") {
        inBin.set(email.sender, (inBin.get(email.sender) ?? 0) + 1);
      }
    }

    const senders = new Set([...witnessed.keys(), ...inBin.keys()]);
    return [...senders].map((sender) => ({
      sender,
      count: Math.max(witnessed.get(sender) ?? 0, inBin.get(sender) ?? 0),
    }));
  }

  /**
   * Adopt everything the last session persisted.
   *
   * One call and one notification, on purpose: restoring in three separate `set` calls
   * meant three renders, each classifying the whole mailbox against a half-restored
   * world. Called from `main.tsx` before the first paint, which is why it is separate
   * from the constructor — the constructor cannot notify.
   */
  restoreState(saved: {
    mailbox?: Mailbox | null;
    activeFilters?: readonly string[];
    preferences?: Partial<Preferences>;
    learning?: ReturnType<LearningModel["toSnapshot"]> | null;
    filterLearning?: unknown;
  }): void {
    const filters = (saved.activeFilters ?? [])
      .map(parseFilterKey)
      .filter((filter): filter is FilterId => filter !== null);

    this.state = {
      ...this.state,
      mailbox: MAILBOX_ORDER.includes(saved.mailbox as Mailbox)
        ? (saved.mailbox as Mailbox)
        : this.state.mailbox,
      activeFilters: filters,
      preferences: { ...this.state.preferences, ...(saved.preferences ?? {}) },
      learning: saved.learning
        ? LearningModel.fromSnapshot(saved.learning)
        : this.state.learning,
      filterLearning: saved.filterLearning
        ? FilterLearning.fromSnapshot(saved.filterLearning)
        : this.state.filterLearning,
    };
    this.notify();
  }

  /**
   * The clock, as a method: injected in tests so a feedback event's timestamp is
   * deterministic. Every `Date.now()` in the store goes through here.
   */
  now = (): number => Date.now();

  // ── Session ───────────────────────────────────────────────────────────────

  /** The connection `connect` is establishing, so a failed one can be retried. */
  private pendingConnect: { backend: MailBackend; account: { email: string } } | null = null;

  /**
   * Point the store at a backend and start the first sync.
   *
   * `signing_in` is a real status because the OAuth round trip is the one step where
   * the app waits for a human, and saying so is the difference between "hanging" and
   * "waiting for you". It is set here but not read for rendering.
   */
  async connect(backend: MailBackend, account: { email: string }): Promise<void> {
    this.backend = backend;
    this.pendingConnect = { backend, account };
    this.claimFilterLearning(account.email);
    this.set({
      status: "signing_in",
      account,
      error: null,
      // Live mail is real, so the wall clock is the right reference instant.
      now: Date.now(),
      // The demo's seeded address book is not this account's. The app adopts the real
      // one (if the user has opted in) once the session says where access stands.
      ...(this.state.contactsAccess === "demo"
        ? { googleContacts: [], contactsAccess: "unavailable" as const }
        : {}),
      // The demo's drafts are not this account's; its own are listed when Drafts opens.
      drafts: [],
      draftsLoading: false,
    });
    this.draftsGeneration += 1;
    if (this.state.mailbox === "drafts") void this.refreshDrafts();
    await this.runSync({ initial: true });
    this.wakeDue();
    // The retained connection only exists so a *failed* connect can be retried;
    // keeping it would let "Try again" resurrect a revoked session.
    this.pendingConnect = null;
  }

  /**
   * Refresh.
   *
   * New messages are diffed against what was known *before* the sync, so the "new"
   * marker appears only for genuinely new mail and the list does not flash.
   */
  async refresh(): Promise<void> {
    if (!this.backend || this.state.syncing) return;
    // Drafts are listed only while they are on screen: a listing on every 30 s poll
    // would spend quota on a folder nobody is looking at.
    if (this.state.mailbox === "drafts") void this.refreshDrafts();
    await this.runSync({ initial: false });
    // A sync is one of the moments snoozes wake (the poll runs it every 10 s while focused).
    this.wakeDue();
  }

  // ── Snooze and send later ─────────────────────────────────────────────────

  /**
   * Whose snoozes and scheduled sends apply now: the signed-in account's address, or
   * `demo`. Records carry it, so the demo's never act on a real account (a scheduled demo
   * message must never reach Gmail) and an account's never show in another's lists.
   */
  accountKey(): string {
    if (!this.backend) return "demo";
    return this.state.account?.email.toLowerCase() ?? "";
  }

  private overlaid(all: Email[]): Email[] {
    return this.snoozeOverlay.apply(all, this.state.snoozes, this.accountKey());
  }

  private snoozedCache: { snoozes: SnoozeState; account: string; map: Map<string, SnoozeRecord> } | null = null;

  /** This account's snoozes, by Gmail id. */
  private snoozedMap(): Map<string, SnoozeRecord> {
    const account = this.accountKey();
    const cached = this.snoozedCache;
    if (cached && cached.snoozes === this.state.snoozes && cached.account === account) return cached.map;
    const map = snoozedById(this.state.snoozes, account);
    this.snoozedCache = { snoozes: this.state.snoozes, account, map };
    return map;
  }

  /** A Snoozed row's copy of each message, stable per message object. */
  private readonly snoozedRowCache = new WeakMap<Email, Email>();

  /** The Snoozed view: the archived messages this device is holding, each with its wake time. */
  private snoozedRows(visible: readonly Email[]): Email[] {
    const map = this.snoozedMap();
    if (map.size === 0) return [];
    const rows: Email[] = [];
    for (const email of visible) {
      const record = email.mailbox === "archive" ? map.get(email.gmailId) : undefined;
      if (!record) continue;
      let row = this.snoozedRowCache.get(email);
      if (!row || row.snoozedUntil !== record.wakeAt) {
        row = { ...email, snoozedUntil: record.wakeAt };
        this.snoozedRowCache.set(email, row);
      }
      rows.push(row);
    }
    return rows;
  }

  private scheduledCache: { sends: readonly ScheduledSend[]; account: string; self: string; rows: Email[] } | null = null;

  /** The Scheduled view's rows, one per send of this account. */
  private scheduledRows(): Email[] {
    const account = this.accountKey();
    const self = this.state.account?.email ?? DEMO_ACCOUNT.email;
    const cached = this.scheduledCache;
    if (cached && cached.sends === this.state.scheduled && cached.account === account && cached.self === self) return cached.rows;
    const rows = this.state.scheduled
      .filter((send) => send.account === account)
      .map((send) => scheduledRow(send, { email: self, name: this.backend ? undefined : DEMO_ACCOUNT.name }));
    this.scheduledCache = { sends: this.state.scheduled, account, self, rows };
    return rows;
  }

  /**
   * The Drafts rows, without the drafts waiting to be sent later: those are listed in
   * Scheduled, and opening one there is how it is edited.
   */
  private listedDrafts(): Email[] {
    const account = this.accountKey();
    const waiting = new Set(
      this.state.scheduled.filter((send) => send.account === account && send.draftId).map((send) => send.draftId!),
    );
    if (waiting.size === 0) return this.state.drafts;
    return this.state.drafts.filter((row) => !waiting.has(row.gmailDraft?.id ?? ""));
  }

  private saveSnoozes(snoozes: SnoozeState, extra: Partial<StoreState> = {}): void {
    this.snoozeSlot.write(snoozes);
    this.set({ snoozes, ...extra });
  }

  /** Whether a message is snoozed on this device for the current account. */
  isSnoozed(gmailId: string): boolean {
    return this.snoozedMap().has(gmailId);
  }

  /** The snooze holding a message, for the reader's "Snoozed until …". */
  snoozeFor(gmailId: string): SnoozeRecord | null {
    return this.snoozedMap().get(gmailId) ?? null;
  }

  /**
   * Snooze the conversations of `ids` until `wakeAt`: each conversation's Inbox messages
   * leave the Inbox now (archived, with the `Winnow/Snoozed` label) and come back at the
   * time, unread, at the top. From the Inbox, the Archive, or Snoozed (a new time). One
   * Undo for all of them, in the status pill. Returns how many conversations it snoozed.
   */
  snooze(ids: Iterable<number>, wakeAt: number, { undo = true }: { undo?: boolean } = {}): number {
    const account = this.accountKey();
    if (!account) return 0;
    const now = this.now();
    const map = this.snoozedMap();
    const records = new Map<string, SnoozeRecord>();
    const moved: { email: Email; from: Mailbox }[] = [];
    for (const id of new Set(ids)) {
      const email = this.state.all.find((candidate) => candidate.id === id);
      if (!email || (email.mailbox !== "inbox" && email.mailbox !== "archive")) continue;
      const key = snoozeKeyFor(email);
      if (records.has(key)) continue;
      const previous = map.get(email.gmailId);
      const members = this.state.all.filter(
        (other) =>
          other.id === email.id ||
          (email.threadId !== undefined && other.threadId === email.threadId && other.mailbox === "inbox") ||
          (previous !== undefined && previous.gmailIds.includes(other.gmailId)),
      );
      const gmailIds = [...new Set([...members.map((m) => m.gmailId), ...(previous?.gmailIds ?? [])])];
      records.set(key, {
        key,
        account,
        gmailIds,
        wakeAt,
        snoozedAt: now,
        from: previous?.from ?? email.mailbox,
        subject: email.subject,
      });
      for (const member of members) moved.push({ email: member, from: previous ? previous.from : member.mailbox });
    }
    if (records.size === 0) return 0;
    let snoozes = this.state.snoozes;
    for (const record of records.values()) snoozes = addSnooze(snoozes, record);
    this.saveSnoozes(snoozes);
    for (const { email } of moved) this.snoozeInGmail(email);
    const backend = this.backend;
    const keys = [...records.keys()];
    if (!undo) return records.size;
    this.offerUndo(
      `Snoozed until ${formatWhen(wakeAt, now)}.`,
      () => {
        if (this.backend !== backend) return;
        this.releaseSnoozes(keys, { restore: new Map(moved.map((m) => [m.email.gmailId, m])) });
      },
    );
    return records.size;
  }

  /** One message into its snooze: out of the Inbox now, labelled in Gmail. */
  private snoozeInGmail(email: Email): void {
    const backend = this.backend;
    const label = async () => {
      if (!backend) return;
      if (backend.setSnoozed) {
        try {
          await backend.setSnoozed(email.gmailId, true);
          return;
        } catch {
          // No label (offline, or Gmail refused it): archiving is the part that matters,
          // and the offline queue carries that one.
        }
      }
      if (email.mailbox === "inbox") await backend.moveToMailbox(email.id, "archive");
    };
    if (email.mailbox !== "inbox") {
      void label().catch(() => undefined);
      return;
    }
    this.mutate(
      email.id,
      () => ({ ...email, mailbox: "archive" }),
      async () => {
        try {
          await label();
        } catch (error) {
          // Gmail refused even the archive: the snooze did not happen, so the record goes
          // before the rollback puts the message back.
          this.forgetSnoozed([email.gmailId]);
          throw error;
        }
      },
      { previousMailbox: "inbox", previousUnread: email.unread },
    );
  }

  /** Drop messages from their snoozes, without moving anything. */
  private forgetSnoozed(gmailIds: readonly string[]): void {
    const ids = new Set(gmailIds);
    const account = this.accountKey();
    let changed = false;
    const snoozed = this.state.snoozes.snoozed
      .map((record) => {
        if (record.account !== account || !record.gmailIds.some((id) => ids.has(id))) return record;
        changed = true;
        return { ...record, gmailIds: record.gmailIds.filter((id) => !ids.has(id)) };
      })
      .filter((record) => record.gmailIds.length > 0);
    if (changed) this.saveSnoozes({ ...this.state.snoozes, snoozed });
  }

  /**
   * Bring snoozed conversations back. Woken (`wake`): to the Inbox, unread, placed at
   * `wokeAt`. Unsnoozed by hand: to the Inbox at the top, read state kept. Undone
   * (`restore`): back where each message was, read state as it was, label off.
   */
  private releaseSnoozes(
    keys: readonly string[],
    how: { wake?: Map<string, number>; restore?: Map<string, { email: Email; from: Mailbox }> } = {},
  ): string[] {
    const account = this.accountKey();
    const now = this.now();
    const records = this.state.snoozes.snoozed.filter((r) => r.account === account && keys.includes(r.key));
    if (records.length === 0) return [];
    let snoozes = this.state.snoozes;
    for (const record of records) snoozes = removeSnooze(snoozes, account, record.key);
    const woken: string[] = [];
    const placed = new Map<string, number>();
    for (const record of records) {
      for (const gmailId of record.gmailIds) {
        const restore = how.restore?.get(gmailId);
        if (restore && restore.from !== "inbox") continue;
        woken.push(gmailId);
        placed.set(gmailId, how.wake?.get(record.key) ?? now);
      }
    }
    if (!how.restore) {
      for (const [gmailId, at] of placed) snoozes = markWoke(snoozes, account, [gmailId], at);
    }
    const ids = new Set(records.flatMap((r) => r.gmailIds));
    const recent = how.wake
      ? new Set([...this.state.recentIds, ...this.state.all.filter((e) => ids.has(e.gmailId)).map((e) => e.id)])
      : this.state.recentIds;
    this.saveSnoozes(snoozes, { recentIds: recent });

    const backend = this.backend;
    for (const gmailId of ids) {
      const restore = how.restore?.get(gmailId);
      const toInbox = !restore || restore.from === "inbox";
      const unread = how.wake ? true : restore ? restore.email.unread : undefined;
      const email = this.state.all.find((candidate) => candidate.gmailId === gmailId);
      const call = async () => {
        if (!backend) return;
        if (backend.setSnoozed) {
          try {
            await backend.setSnoozed(gmailId, false, { unread: unread === true, toInbox });
            return;
          } catch {
            // Fall back to the plain move (queued when offline); the label may stay.
          }
        }
        if (!email) return;
        if (toInbox) await backend.moveToMailbox(email.id, "inbox");
        if (unread === true) await backend.setRead(email.id, false);
      };
      if (!email) {
        void call().catch(() => undefined);
        continue;
      }
      if (!toInbox) {
        void call().catch(() => undefined);
        continue;
      }
      this.mutate(
        email.id,
        () => ({ ...email, mailbox: "inbox", unread: unread ?? email.unread }),
        call,
        { previousMailbox: email.mailbox, previousUnread: email.unread },
      );
    }
    return woken;
  }

  /**
   * Unsnooze by hand (the Snoozed view's Unsnooze): the conversations of `ids` go back to
   * the Inbox now, at the top, with Undo (which snoozes them again until the same time).
   */
  unsnooze(ids: Iterable<number>): number {
    const map = this.snoozedMap();
    const records = new Map<string, SnoozeRecord>();
    for (const id of ids) {
      const email = this.state.all.find((candidate) => candidate.id === id);
      const record = email ? map.get(email.gmailId) : undefined;
      if (record) records.set(record.key, record);
    }
    if (records.size === 0) return 0;
    const taken = [...records.values()];
    this.releaseSnoozes([...records.keys()]);
    const backend = this.backend;
    this.offerUndo(taken.length === 1 ? "Unsnoozed." : `Unsnoozed ${taken.length}.`, () => {
      if (this.backend !== backend) return;
      for (const record of taken) {
        const targets = this.state.all.filter((email) => record.gmailIds.includes(email.gmailId)).map((e) => e.id);
        this.snooze(targets, record.wakeAt, { undo: false });
      }
    });
    return records.size;
  }

  /**
   * Wake whatever is due: snoozes whose time has passed (late if the app was closed then)
   * and conversations a new message has woken early; drop snoozes whose mail went to the
   * Trash elsewhere, and woken places that no longer matter. Run on start, after every
   * sync, on focus and on the app's timer. Returns how many conversations woke.
   */
  wakeDue(): number {
    const account = this.accountKey();
    if (!account) return 0;
    const now = this.now();
    const all = this.state.all;
    let snoozes = this.state.snoozes;
    for (const record of abandonedSnoozes(snoozes, account, all)) snoozes = removeSnooze(snoozes, account, record.key);
    snoozes = pruneWoke(snoozes, all, now);
    const due = new Map<string, SnoozeRecord>();
    for (const record of dueSnoozes(snoozes, account, now)) due.set(record.key, record);
    const replied = repliedSnoozes(snoozes, account, all, now).filter((record) => !due.has(record.key));
    if (snoozes !== this.state.snoozes) this.saveSnoozes(snoozes);
    if (due.size === 0 && replied.length === 0) return 0;
    // Placed at the moment it came back: the chosen time when Winnow was open then, the
    // next open when it was closed (so a late wake still lands at the top, not below the
    // mail that arrived while it was away).
    const wake = new Map<string, number>();
    for (const record of due.values()) wake.set(record.key, now);
    for (const record of replied) wake.set(record.key, now);
    this.releaseSnoozes([...wake.keys()], { wake });
    const count = wake.size;
    const late = [...due.values()].filter((record) => now - record.wakeAt > LATE_WAKE_MS);
    const text =
      count === 1 ? "A snoozed conversation is back in your Inbox." : `${count} snoozed conversations are back in your Inbox.`;
    this.flash(
      late.length > 0
        ? `${text} It was due ${formatWhen(Math.min(...late.map((r) => r.wakeAt)), now)}, while Winnow was closed.`
        : text,
      WAKE_FLASH_MS,
    );
    return count;
  }

  /** This account's scheduled sends, soonest first. */
  scheduledSends(): ScheduledSend[] {
    const account = this.accountKey();
    return this.state.scheduled.filter((send) => send.account === account);
  }

  /** The scheduled send behind a Scheduled row (by row id), or by its own id. */
  scheduledSend(idOrRow: string | number): ScheduledSend | null {
    if (typeof idOrRow === "string") return this.state.scheduled.find((send) => send.id === idOrRow) ?? null;
    const row = this.scheduledRows().find((email) => email.id === idOrRow);
    return row?.scheduled ? (this.state.scheduled.find((send) => send.id === row.scheduled!.id) ?? null) : null;
  }

  private saveSchedules(scheduled: ScheduledSend[]): void {
    this.scheduleSlot.write(serializeSchedules(scheduled));
    const selectedGone =
      this.state.mailbox === "scheduled" &&
      this.state.selectedId !== null &&
      !scheduled.some((send) => scheduledRow(send, { email: "" }).id === this.state.selectedId);
    this.set({ scheduled, ...(selectedGone ? { selectedId: null } : {}) });
  }

  /** Record a message to send later (replacing an earlier time for the same draft). */
  scheduleSend(send: ScheduledSend): void {
    this.saveSchedules(addSchedule(this.state.scheduled, send));
  }

  /** Cancel a schedule; the draft stays a draft. Returns what was cancelled. */
  cancelSchedule(id: string): ScheduledSend | null {
    const send = this.scheduledSend(id);
    if (!send) return null;
    this.saveSchedules(removeSchedule(this.state.scheduled, id));
    return send;
  }

  updateScheduled(id: string, patch: Partial<Pick<ScheduledSend, "claimedAt" | "problem" | "sendAt" | "draftId">>): void {
    if (!this.state.scheduled.some((send) => send.id === id)) return;
    this.saveSchedules(updateSchedule(this.state.scheduled, id, patch));
  }

  /**
   * Claim a due send for this window, so a second window of the app does not send it
   * too: read what storage says now (another window may have claimed it a moment ago),
   * and write the claim. `false` when someone else holds it.
   */
  claimScheduled(id: string, now: number = this.now()): boolean {
    const stored = parseSchedules(this.scheduleSlot.read()).find((send) => send.id === id);
    if (stored?.claimedAt !== undefined && now - stored.claimedAt <= CLAIM_HOLD_MS) return false;
    this.updateScheduled(id, { claimedAt: now });
    return true;
  }

  // ── Drafts ────────────────────────────────────────────────────────────────

  /** Drafts listings, one at a time; a second request while one runs waits for it. */
  private draftsInFlight: Promise<void> | null = null;
  /** Bumped by sign-out and the demo, so a listing landing afterwards is dropped. */
  private draftsGeneration = 0;

  /**
   * List the user's Gmail drafts into the Drafts mailbox. A no-op in the demo, whose
   * drafts are seeded and edited locally. A failure is a notice, not an error state:
   * the rows already listed stay.
   */
  refreshDrafts(): Promise<void> {
    const backend = this.backend;
    if (!backend?.listDrafts) return Promise.resolve();
    if (this.draftsInFlight) return this.draftsInFlight;
    const generation = this.draftsGeneration;
    this.set({ draftsLoading: true });
    const run = (async () => {
      try {
        const listed = await backend.listDrafts!(this.state.drafts);
        if (generation !== this.draftsGeneration || this.backend !== backend) return;
        // A draft discarded with Undo still on offer is still in Gmail; keep it out.
        const drafts = listed.filter((email) => !this.pendingDiscards.has(email.gmailDraft?.id ?? ""));
        this.set({ drafts, draftsLoading: false });
      } catch (error) {
        if (generation !== this.draftsGeneration || this.backend !== backend) return;
        this.set({
          draftsLoading: false,
          notice: error instanceof Error ? `Couldn't list drafts: ${error.message}` : "Couldn't list drafts.",
        });
      } finally {
        this.draftsInFlight = null;
      }
    })();
    this.draftsInFlight = run;
    return run;
  }

  /** A Drafts row, by message id. */
  draftRow(id: number): Email | null {
    return this.state.drafts.find((email) => email.id === id) ?? null;
  }

  /**
   * Show what the composer holds as its Drafts row now, ahead of the next listing (the
   * demo's only listing). Replaces the row with the same Gmail draft id, or adds one.
   */
  putDraftRow(row: Email): void {
    const draftId = row.gmailDraft?.id;
    if (!draftId) return;
    const rest = this.state.drafts.filter((email) => email.gmailDraft?.id !== draftId);
    this.set({ drafts: [row, ...rest].sort((a, b) => b.receivedAt - a.receivedAt) });
  }

  /** The draft was sent or discarded: its row goes at once. */
  removeDraftRow(draftId: string): void {
    if (!this.state.drafts.some((email) => email.gmailDraft?.id === draftId)) return;
    this.set({ drafts: this.state.drafts.filter((email) => email.gmailDraft?.id !== draftId) });
  }

  /**
   * Discard drafts from the Drafts mailbox: the rows go at once, and each Gmail draft is
   * deleted (`drafts.delete`, which does not go through Trash). The demo just drops them.
   */
  async discardDrafts(ids: Iterable<number>): Promise<void> {
    const targets = [...ids]
      .map((id) => this.draftRow(id))
      .filter((row): row is Email => row?.gmailDraft !== undefined);
    if (targets.length === 0) return;
    const gone = new Set(targets.map((row) => row.id));
    this.set({
      drafts: this.state.drafts.filter((email) => !gone.has(email.id)),
      ...(this.state.selectedId !== null && gone.has(this.state.selectedId) ? { selectedId: null } : {}),
    });
    const api = this.backend?.drafts;
    if (!api) return;
    const failed: Email[] = [];
    for (const row of targets) {
      try {
        await api.delete(row.gmailDraft!.id);
      } catch {
        failed.push(row);
      }
    }
    if (failed.length > 0) {
      this.set({
        drafts: [...failed, ...this.state.drafts].sort((a, b) => b.receivedAt - a.receivedAt),
        notice: failed.length === 1 ? "Couldn't discard that draft." : `Couldn't discard ${failed.length} drafts.`,
      });
    }
  }

  /**
   * One sync, shared by `connect` and `refresh`.
   *
   * `connect` also moves the session through `loading` and announces nothing, because
   * a first sync has no "new" mail: telling someone about forty messages they have
   * never seen is noise, not news. A failure is put on screen *and* re-thrown, so
   * `connect`'s caller can decide what it means for the session.
   */
  private async runSync({ initial }: { initial: boolean }): Promise<void> {
    const backend = this.backend;
    if (!backend) return;

    this.set({
      ...(initial ? { status: "loading" as const } : {}),
      syncing: true,
      error: null,
      syncPhase: null,
      syncFraction: null,
      syncFetched: 0,
      syncStage: null,
      syncTotal: null,
      syncError: null,
    });
    let lastProgressNotify = 0;

    const known = new Set(this.state.all.map((email) => email.gmailId));

    try {
      const result = await backend.sync({
        // 1.4.0: a sync of an account that has since been left paints nothing.
        onPartial: (emails) => {
          if (this.backend === backend) this.applyPartial(emails, initial);
        },
        onProgress: (progress) => {
          if (this.backend !== backend) return;
          // Progress arrives on the engine's schedule, so it is written to state
          // *without* notifying: a first sync of two thousand messages would otherwise
          // re-render two thousand times to move a percentage. A phase change is
          // notified, being a visible transition rather than a per-message increment.
          const phase = progress.phase === "idle" || progress.phase === "sending"
            ? this.state.syncPhase
            : progress.phase;
          const stage = progress.stage ?? null;
          const changed = this.state.syncPhase !== phase || this.state.syncStage !== stage;
          this.state = {
            ...this.state,
            syncing: true,
            syncPhase: phase,
            syncStage: stage,
            syncTotal: progress.total ?? null,
            syncFraction: progress.fraction,
            syncFetched: progress.fetched,
          };
          // The count on the status line ("Syncing inbox, 340 of 1,200") is worth a
          // re-render twice a second, not once per message.
          const now = Date.now();
          if (changed || now - lastProgressNotify >= PROGRESS_NOTIFY_MS) {
            lastProgressNotify = now;
            this.notify();
          }
        },
      });

      // Another account opened (or the app signed out) while this ran: its answer is
      // not this screen's.
      if (this.backend !== backend) return;
      const recent = new Set<number>();
      if (!initial) {
        for (const email of result.emails) {
          if (!known.has(email.gmailId)) recent.add(email.id);
        }
      }

      const { emails, bodies, checked } = partitionBodies(result.emails);
      // Replaced wholesale rather than merged: a sync is a fresh reading, and a body
      // resident for a message that has since left is memory nobody is using. Bodies
      // loaded *during* the sync are in the cache, so they are in `result.emails` too.
      this.bodies = bodies;
      this.bodyChecked = checked;
      this.bodyFailed = new Set();

      this.set({
        status: "ready",
        all: emails,
        syncing: false,
        syncPhase: null,
        syncStage: null,
        syncTotal: null,
        syncFraction: null,
        syncError: null,
        syncFailed: result.failed,
        lastSyncedAt: Date.now(),
        recentIds: recent,
        truncated: result.truncated,
        notice: syncNotice(result),
        storagePrompt: result.cacheUnpersisted
          ? this.storageDeclined
            ? null
            : this.state.storagePrompt === "failed"
              ? "failed"
              : "ask"
          : null,
        error: result.failed > 0 ? syncFailureSummary(result.failed) : null,
      });

      if (!initial) await this.notifyIfNew(recent);
      await this.applyPlatform();
      this.prefetchInbox();
    } catch (error) {
      if (this.backend !== backend) return;
      this.set({
        status: "error",
        syncing: false,
        syncPhase: null,
        syncStage: null,
        syncTotal: null,
        syncError: error instanceof Error ? error.message : "Could not reach Gmail.",
        error: error instanceof Error ? error.message : "Could not reach Gmail.",
      });
      throw error;
    }
  }

  /**
   * Show the mailbox a sync has so far, while it carries on.
   *
   * The inbox-first half of the sync: the engine publishes the inbox as soon as it has
   * a screenful, and this puts it on screen — leaving `syncing` set so the status line
   * still says the rest is coming. A first sign-in leaves `loading` here, which is the
   * whole point. Bodies already resident are kept (a partial is a subset of the truth,
   * not a replacement for it), and nothing is announced as new until the sync is done.
   */
  private applyPartial(emails: Email[], initial: boolean): void {
    if (!this.backend || !this.state.syncing) return;
    const partition = partitionBodies(emails);
    for (const [id, html] of partition.bodies) this.bodies.set(id, html);
    for (const id of partition.checked) this.bodyChecked.add(id);
    this.set({
      all: partition.emails,
      ...(initial && this.state.status === "loading" ? { status: "ready" as const } : {}),
    });
  }

  // ── Offline storage ───────────────────────────────────────────────────────

  /**
   * "Save": ask for persistent storage and write the cache again.
   *
   * On success the question goes away; on failure it becomes a one-line failure the
   * user can dismiss. Either way nothing about the mailbox in memory changes.
   */
  async saveMailboxOffline(): Promise<void> {
    if (this.state.storagePrompt === "saving") return;
    const backend = this.backend;
    this.set({ storagePrompt: "saving" });
    let saved = false;
    try {
      saved = (await backend?.persistCache?.()) ?? false;
    } catch {
      saved = false;
    }
    this.set({ storagePrompt: saved ? null : "failed" });
  }

  /** "Not now": stop asking for this session, and keep re-downloading on launch. */
  declineMailboxStorage(): void {
    this.storageDeclined = true;
    if (this.state.storagePrompt !== null) this.set({ storagePrompt: null });
  }

  /** Dismiss the failure line left by a "Save" that did not work. */
  dismissStoragePrompt(): void {
    if (this.state.storagePrompt === null) return;
    this.set({ storagePrompt: null });
  }

  /**
   * Retry the connection that failed.
   *
   * `connect` retains what it was connecting *to*, so retrying is one call — the call
   * the user wants, since "try again" is the only answer to a network that was down
   * thirty seconds ago.
   */
  async retryConnection(): Promise<void> {
    const pending = this.pendingConnect;
    if (!pending) return;
    this.set({ status: "signing_in", error: null });
    try {
      await this.runSync({ initial: true });
      this.pendingConnect = null;
    } catch {
      // Already on screen: `runSync` set `error` before re-throwing.
    }
  }

  /** Announce genuinely new mail, if the user asked for notifications. */
  private async notifyIfNew(recent: ReadonlySet<number>): Promise<void> {
    if (!this.state.preferences.notificationsEnabled || !this.platform) return;
    if (recent.size === 0) return;
    // A muted or hidden sender's mail arrives silently: that is what muting them means.
    // Mail already read (on another device, before this sync saw it) is not news, and
    // nor is mail a filter filed out of the inbox.
    const arrived = notifiable(
      this.state.all.filter((email) => recent.has(email.id)),
      this.state.preferences,
    );
    if (arrived.length === 0) return;
    await this.platform.notifyNewMail(arrived).catch(() => undefined);
  }

  /**
   * The reply header blocks for a notification batch (see `MailBackend.replyHeads`).
   * Never throws: a notification without inline reply beats no notification.
   */
  async notificationReplyHeads(emails: readonly Email[]): Promise<Record<string, string>> {
    if (!this.backend?.replyHeads || !this.state.preferences.notificationActions.reply) return {};
    try {
      return await this.backend.replyHeads(emails.map((email) => email.gmailId));
    } catch {
      return {};
    }
  }

  /**
   * Replies typed into a notification that the phone could neither send nor save
   * (offline, signed out, or the app not running), saved to Gmail's Drafts now.
   * Returns how many were saved; any that fail are handed back so nothing typed is lost.
   */
  async saveKeptReplies(kept: readonly KeptReply[]): Promise<{ saved: number; failed: KeptReply[] }> {
    const drafts = this.backend?.drafts;
    if (!drafts) return { saved: 0, failed: [...kept] };
    let saved = 0;
    const failed: KeptReply[] = [];
    for (const reply of kept) {
      const original = this.state.all.find((email) => email.gmailId === reply.gmailId);
      const draft = draftForKeptReply(reply, original);
      if (!draft) {
        failed.push(reply);
        continue;
      }
      try {
        await drafts.create(draft, original ? original.gmailId : undefined);
        saved += 1;
      } catch {
        failed.push(reply);
      }
    }
    if (saved > 0) void this.refreshDrafts().catch(() => undefined);
    return { saved, failed };
  }

  /** The OS badge: the mailbox's unread count, less mail from muted senders. */
  badgeCount(): number {
    const muted = this.state.preferences.mutedSenders;
    if (muted.length === 0) return this.view.unreadCount;
    const keys = new Set(muted.map((s) => s.toLowerCase()));
    const blocked = new Set(this.state.preferences.blockedSenders.map((s) => s.toLowerCase()));
    const mutedUnread = this.state.all.filter((email) => {
      const sender = email.sender.toLowerCase();
      return email.unread && this.isListed(email) && keys.has(sender) && !blocked.has(sender);
    }).length;
    return Math.max(0, this.view.unreadCount - mutedUnread);
  }

  /** Push badge count and sync cadence to the OS. */
  private async applyPlatform(): Promise<void> {
    if (!this.platform) return;
    const { preferences } = this.state;
    await this.platform.setUnreadBadge(this.badgeCount()).catch(() => undefined);
    // The cadence is only meaningful on the desktop; on the web the platform no-ops.
    await this.platform
      .setBackgroundSync(
        preferences.backgroundSync && this.state.status === "ready"
          ? preferences.backgroundSyncInterval
          : null,
      )
      .catch(() => undefined);
  }

  // ── Selection and navigation ──────────────────────────────────────────────

  setMailbox(mailbox: Mailbox): void {
    if (this.state.mailbox === mailbox) return;
    // Switching mailbox drops the reader and the cursor: a selection from the inbox
    // means nothing in the bin. Filters go too — a bucket pinned in the inbox means
    // nothing in the archive — and both are persisted together, since "which mailbox
    // am I in" and "what is narrowed inside it" are one decision.
    //
    // The undo offer goes with them: its label names a mailbox, and it is about to stop
    // being true. Letting it go is what a draft discard waits for, so that runs now.
    this.settleUndo();
    this.set({ mailbox, selectedId: null, cursorIndex: NO_CURSOR, activeFilters: [], undo: null }, {
      mailbox,
      activeFilters: [],
    });
    if (mailbox === "drafts") void this.refreshDrafts();
  }

  /** The messages the list draws from (before filters and search). */
  private listedIn(visible: readonly Email[]): Email[] {
    const state = this.state;
    if (state.mailbox === "drafts") return this.listedDrafts();
    if (state.mailbox === "scheduled") return this.scheduledRows();
    if (state.mailbox === "snoozed") return this.snoozedRows(visible);
    // Snoozed mail is archived in Gmail, but it is away, not filed: it lists in Snoozed only.
    const snoozed = state.mailbox === "archive" ? this.snoozedMap() : null;
    if (snoozed && snoozed.size > 0) {
      return visible.filter((email) => email.mailbox === "archive" && !snoozed.has(email.gmailId));
    }
    return visible.filter((email) => email.mailbox === state.mailbox);
  }

  /** Whether a message (not a draft) is in what the list draws from. */
  private isListed(email: Email): boolean {
    if (this.state.mailbox === "snoozed") return email.mailbox === "archive" && this.snoozedMap().has(email.gmailId);
    if (this.state.mailbox === "archive" && email.mailbox === "archive") return !this.snoozedMap().has(email.gmailId);
    return email.mailbox === this.state.mailbox;
  }

  select(id: number | null): void {
    this.set({ selectedId: id });
  }

  /** The visible row message `id` is read on, or `-1`; see `rowIndexOf`. */
  private rowIndex(id: number): number {
    const mailboxEmails = this.listedIn(this.state.all);
    return rowIndexOf(this.view.threads, id, mailboxEmails);
  }

  /** Open the message at the cursor. */
  openCursor(): void {
    // Guarded explicitly, since `threads[-1]` is `undefined` with no cursor.
    if (this.state.cursorIndex === NO_CURSOR) {
      this.moveCursor(1);
      return;
    }
    const row = this.view.threads[this.state.cursorIndex];
    if (!row) return;
    this.set({ selectedId: row.representative.id });
    this.markOpenedRead();
  }

  /**
   * The message that has just been opened, read — with the rest of its conversation.
   *
   * Every route into the reader calls this after it sets `selectedId`: a click, `Enter`,
   * `j`/`k`, a deep link, and the next row taking over after the open one leaves. Only
   * those: a checked row in select mode or a search match is not an open, and nothing
   * here watches `selectedId` generically, so they cannot trip it.
   *
   * Through `setReadMany`, so it is optimistic, queued offline and rolled back on a
   * failure exactly as the read toggle is — and, like the toggle, it offers no undo.
   * Marking the open message unread moves the reader on (`markUnreadAndMoveOn`), so the
   * unread flag is not undone here; re-opening the message later is a new open and
   * marks it read again.
   */
  private markOpenedRead(): void {
    if (!this.state.preferences.markReadOnOpen) return;
    const id = this.state.selectedId;
    if (id === null) return;
    const opened = this.state.all.find((email) => email.id === id);
    if (!opened) return;
    // The whole thread, as Gmail does: the row's unread weight is "any message unread",
    // so marking only the newest would leave the row looking untouched.
    const key = opened.threadId ?? `single-${opened.gmailId}`;
    const ids = this.state.all
      .filter((email) => email.unread && (email.threadId ?? `single-${email.gmailId}`) === key)
      .map((email) => email.id);
    if (ids.length > 0) this.setReadMany(ids, true);
  }

  /**
   * Close the reader.
   *
   * `dropCursor` is for the phone, where the list and the reader are never on screen
   * together: Back returns to a list with no current row, so the cursor goes with the
   * message rather than lingering as "4 of 39" over a list nobody is moving through. The
   * desktop keeps it, because there the cursor is where `j` carries on from.
   */
  closeReader({ dropCursor = false }: { dropCursor?: boolean } = {}): void {
    this.set(dropCursor ? { selectedId: null, cursorIndex: NO_CURSOR } : { selectedId: null });
  }

  /**
   * Move the cursor, and take the reader with it.
   *
   * `j` and `k` open as they move, rather than moving a highlight and needing a
   * second keypress: in a two-pane client the reader is already on screen, so making
   * the user press `o` to fill it is two keystrokes to see what they asked for.
   */
  moveCursor(delta: number): void {
    const next = this.stepTarget(delta);
    if (next === null) return;
    const threads = this.view.threads;
    this.set({
      cursorIndex: next,
      selectedId: threads[next]?.representative.id ?? null,
      revealSeq: this.state.revealSeq + 1,
    });
    this.markOpenedRead();
  }

  /**
   * The row `moveCursor(delta)` would land on, or `null` on an empty list.
   *
   * Steps from the *open message's* row whenever it is a row — not from the cursor,
   * which is only a fallback for when nothing is open or the open message is not shown.
   * `followOpenMessage` keeps the two equal; reading the reader's row here as well means
   * a step can never start from a stale index even if that invariant were broken.
   */
  stepTarget(delta: number): number | null {
    const threads = this.view.threads;
    const length = threads.length;
    if (length === 0) return null;

    const open = this.state.selectedId !== null ? this.view.selectedIndex : -1;
    if (open >= 0) return clampIndex(open + delta, length);

    // With no cursor, "next" starts at the top and "previous" at the bottom, which is
    // what `j` or `k` on a fresh list expects.
    const cursor = this.state.cursorIndex;
    if (cursor === NO_CURSOR) return delta > 0 ? 0 : length - 1;
    const base = Math.min(cursor, length - 1);

    // The open message is not a row any more (opening it read it, under the Unread
    // filter) and the next row slid up under the cursor, so that row already *is*
    // "next": stepping past it would skip a message.
    if (this.state.selectedId !== null && cursor < length) {
      return clampIndex(base + (delta > 0 ? delta - 1 : delta), length);
    }
    return clampIndex(base + delta, length);
  }

  /**
   * Whether prev (`-1`) or next (`1`) would go anywhere: false on an empty list, and at
   * either end, where the step would land on the row already being shown.
   *
   * Asked of the same `stepTarget` the move itself uses, so a chevron is enabled exactly
   * when pressing it does something.
   */
  canStep(delta: number): boolean {
    const target = this.stepTarget(delta);
    return target !== null && target !== readoutIndex(this.state, this.view);
  }

  /** Select and open in one step, for a click on a row. */
  openRow(index: number): void {
    const row = this.view.threads[index];
    if (!row) return;
    this.set({ cursorIndex: index, selectedId: row.representative.id });
    this.markOpenedRead();
  }

  /**
   * Open a message by id, wherever it is.
   *
   * A deep link, a notification click and the tab title all need this, and none can
   * know the message's row index, which depends on the mailbox, search and filters.
   * So the lookup is done here, against the list the user is actually looking at.
   *
   * Two cases where the message is not in the current view, both normal and both
   * handled:
   *
   *   - It is in a *different* mailbox: the filter is dropped so the row becomes
   *     visible, since doing nothing would look like the link is broken.
   *   - Filters or a search are hiding it: transient view state, so they are cleared
   *     for the jump and the cursor lands on the row.
   */
  focusMessage(id: number): boolean {
    // Its conversation's row, not only a row it represents: an earlier message of a
    // visible thread (clicked in the reader) is read on that row, and clearing the
    // filters to "reveal" it would throw away the user's view for nothing.
    const visibleAt = this.rowIndex(id);
    if (visibleAt >= 0) {
      this.set({ cursorIndex: visibleAt, selectedId: id, overlay: "none", revealSeq: this.state.revealSeq + 1 });
      this.markOpenedRead();
      return true;
    }

    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email) return false;

    // Clear what is hiding it, but keep the mailbox if the message is in it — switching
    // to where it lives is the point of following a link.
    if (!this.isListed(email)) this.set({ mailbox: email.mailbox });
    this.set({
      activeFilters: [],
      searchQuery: "",
      selectedId: id,
      overlay: "none",
    });

    // The row index is only known after `set` re-derives the list, so the cursor is
    // placed by looking the id up again.
    const nowAt = this.rowIndex(id);
    this.set({ cursorIndex: nowAt >= 0 ? nowAt : NO_CURSOR, revealSeq: this.state.revealSeq + 1 });
    this.markOpenedRead();
    return true;
  }

  setOverlay(overlay: StoreState["overlay"]): void {
    this.set({
      overlay,
      // The palette opens on the row for the mailbox already on screen, so opening it
      // from Spam highlights Spam; otherwise it always opened on Inbox.
      navigationIndex:
        overlay === "navigation" ? navigationIndexFor(this.state.mailbox) : this.state.navigationIndex,
    });
  }

  moveNavigation(delta: number): void {
    // The count comes from the palette's own list rather than a literal `4`, which had
    // drifted from `NAVIGATION_ITEMS` — a row added there would be unreachable by
    // keyboard with nothing to say so.
    this.set({
      navigationIndex: clampIndex(this.state.navigationIndex + delta, NAVIGATION_ITEMS.length),
    });
  }

  /**
   * Act on the highlighted palette row.
   *
   * The mailbox is read off `NAVIGATION_ITEMS` rather than matched per-id, so a row
   * added to the palette is reachable without touching this function. A row with no
   * mailbox (settings) is a view rather than a destination, which is why `mailbox` is
   * optional on the item.
   */
  activateNavigation(item: NavigationItem): void {
    const entry = NAVIGATION_ITEMS.find((candidate) => candidate.id === item);
    this.set({ overlay: "none" });
    if (!entry) return;
    if (entry.mailbox) this.setMailbox(entry.mailbox);
    else this.setOverlay("settings");
  }

  // ── Filters ───────────────────────────────────────────────────────────────

  /**
   * Toggle a bucket.
   *
   * `unsafe` is exclusive: "show me what you think is junk" combined with
   * "Important" would produce an empty list every time.
   */
  toggleFilter(filter: FilterId): void {
    const key = filterKey(filter);
    const active = this.state.activeFilters;
    const isActive = active.some((existing) => filterKey(existing) === key);

    if (isActive) {
      this.setFilters(active.filter((f) => filterKey(f) !== key));
      return;
    }

    if (filter.kind === "builtin" && filter.id === "unsafe") {
      this.setFilters([filter]);
      return;
    }

    this.setFilters([...active, filter]);
  }

  /**
   * Replace the active set and persist it.
   *
   * One method, because the persisted form must be computed from the set being
   * installed: passing a patch alongside the new value had the two built at different
   * moments, since `set` evaluates its arguments first. `filterPatch()` read the
   * *previous* state, so turning a bucket on persisted "off" and the persisted set
   * stayed one click behind.
   */
  private setFilters(activeFilters: FilterId[]): void {
    this.set({ activeFilters }, { activeFilters: activeFilters.map(filterKey) });
  }

  clearFilters(): void {
    if (this.state.activeFilters.length === 0) return;
    this.setFilters([]);
  }

  /** Hide every message from a sender, everywhere. */
  blockSender(sender: string): void {
    const blocked = this.state.preferences.blockedSenders;
    if (blocked.includes(sender)) return;
    this.set(
      { preferences: { ...this.state.preferences, blockedSenders: [...blocked, sender] } },
      { preferences: { blockedSenders: [...blocked, sender] } },
    );
  }

  unblockSender(sender: string): void {
    const blocked = this.state.preferences.blockedSenders.filter((s) => s !== sender);
    this.set(
      { preferences: { ...this.state.preferences, blockedSenders: blocked } },
      { preferences: { blockedSenders: blocked } },
    );
  }

  // ── Message actions ───────────────────────────────────────────────────────

  /**
   * Star or unstar.
   *
   * The learning event is recorded *before* the flip, so it sees the pre-feedback
   * classification; recording it afterwards would let the model learn from the star's
   * own contribution to the importance score — the model grading its own homework.
   */
  toggleStar(id: number): void {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email) return;

    const starred = !email.starred;
    const signals = this.rawSignalsFor(email);
    const learning = this.state.learning.recordStar(email, signals, starred, this.now());

    this.mutate(id, () => ({ ...email, starred }), async () => {
      await this.backend?.toggleStar(id, starred);
    });

    this.setLearning(learning);
  }

  /**
   * The title of the list, for the header and the window title.
   *
   * "Inbox", "From ada@example.com", the single bucket's own name, or "Filtered" when
   * several are combined — the honest answer, since no single label describes the
   * intersection.
   */
  listTitle(): string {
    const filters = this.state.activeFilters;
    if (filters.length === 0) return MAILBOX_LABEL[this.state.mailbox];
    if (filters.length === 1) {
      const only = filters[0];
      return only.kind === "sender" ? `From ${only.sender}` : FILTER_LABELS[only.id];
    }
    return "Filtered";
  }

  /**
   * Move a message to another mailbox.
   *
   * Context-sensitive for the keyboard: the same key archives from the inbox,
   * unarchives from the archive, restores from the bin and marks not-spam from spam.
   * One action means the optimistic update, the undo and the server call cannot
   * disagree about what "archive" means.
   */
  archive(id: number): void {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email) return;
    let destination: Mailbox;
    if (email.mailbox === "inbox") destination = "archive";
    else if (email.mailbox === "archive") destination = "inbox";
    // Mail the user wrote cannot leave Sent: Gmail owns the SENT label and the API
    // refuses to remove it, so any move here would snap back on the next sync. `e`
    // does nothing in Sent rather than pretending to file it.
    else if (email.mailbox === "sent") return;
    else destination = "inbox";
    this.move(id, destination);
  }

  /**
   * Move a message to another mailbox.
   *
   * The discard is recorded here rather than by the caller, because the move itself is
   * the signal: the profile's trash bias is a statement about how often the user bins
   * each sender, and the only place that number can be observed is the instant they do
   * it. Recording it in the UI would miss every keyboard-driven filing, which is most
   * of them.
   *
   * Moving marks read: a message you have filed away is one you have dealt with, and
   * leaving it bold in the next mailbox is noise.
   */
  move(id: number, mailbox: Mailbox): void {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email || email.mailbox === mailbox) return;

    // Moving a snoozed message anywhere ends its snooze: it is filed now. Back to the
    // Inbox takes the label off too (`setSnoozed`); elsewhere the label stays on it.
    if (this.snoozedMap().has(email.gmailId)) {
      this.forgetSnoozed([email.gmailId]);
      const backend = this.backend;
      if (mailbox === "inbox" && backend?.setSnoozed) {
        this.mutate(
          id,
          () => ({ ...email, mailbox, unread: false }),
          async () => {
            await backend.setSnoozed!(email.gmailId, false).catch(() => backend.moveToMailbox(id, mailbox));
          },
          { previousMailbox: email.mailbox, previousUnread: email.unread },
        );
        return;
      }
    }

    const previousMailbox = email.mailbox;
    const previousUnread = email.unread;

    if (mailbox === "trash" && !this.trashSenders.includes(email.sender)) {
      this.trashSenders = [...this.trashSenders, email.sender];
    }

    this.mutate(id, () => ({ ...email, mailbox, unread: false }), async () => {
      await this.backend?.moveToMailbox(id, mailbox);
    }, { previousMailbox, previousUnread });
  }

  trash(id: number): void {
    // In Drafts, delete means discard the draft.
    if (this.state.mailbox === "drafts" && this.draftRow(id)) {
      void this.discardDrafts([id]);
      return;
    }
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email) return;
    // In the bin, "delete" means delete; anywhere else it means move to the bin — the
    // destructive action is only reachable where the user has said this is rubbish.
    if (email.mailbox === "trash") {
      this.deletePermanently(id);
      return;
    }
    this.move(id, "trash");
  }

  deletePermanently(id: number): void {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email) return;
    this.mutateRemove(id, async () => {
      await this.backend?.deletePermanently(id);
    });
  }

  toggleRead(id: number): void {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email) return;
    const unread = !email.unread;
    this.mutate(id, () => ({ ...email, unread }), async () => {
      await this.backend?.setRead(id, !unread);
    });
  }

  /** Set the read state outright, rather than flipping it. A no-op when it already holds. */
  setRead(id: number, read: boolean): void {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email || email.unread === !read) return;
    this.mutate(id, () => ({ ...email, unread: !read }), async () => {
      await this.backend?.setRead(id, read);
    });
  }

  /**
   * Mark the open message unread and get out of its way.
   *
   * Marking something unread is saying "not now", so the reader leaving is the point:
   *
   *   - **Desktop** advances to the next row in the list, the way Gmail's auto-advance
   *     does; with no next row the reader closes onto the empty pane.
   *   - **Phone** goes back to the list, with no current row, at the scroll position it
   *     was left at — the same exit as Back.
   *
   * Moving on is also what keeps "mark as read when opened" from undoing the flag: the
   * reader leaves the message rather than re-opening it, and the next row it lands on is
   * an open like any other. The tests pin both.
   *
   * A message that is not the open one is simply marked unread.
   */
  markUnreadAndMoveOn(id: number, { phone = false }: { phone?: boolean } = {}): void {
    const threads = this.view.threads;
    const index = this.rowIndex(id);
    const wasOpen = this.state.selectedId === id;
    this.setRead(id, false);
    if (!wasOpen) return;
    if (phone) {
      this.closeReader({ dropCursor: true });
      return;
    }
    // The list is unchanged by an unread flag, so the next row is the one after it.
    const next = index >= 0 ? threads[index + 1] : undefined;
    if (next) {
      this.set({
        cursorIndex: index + 1,
        selectedId: next.representative.id,
        revealSeq: this.state.revealSeq + 1,
      });
      this.markOpenedRead();
    } else {
      this.set({ selectedId: null });
    }
  }

  // ── Batch actions, for a multi-row selection ──────────────────────────────

  /**
   * Archive every id, each through `archive` so the per-mailbox meaning holds (archive
   * from the inbox, back to the inbox from the archive, nothing from Sent).
   */
  archiveMany(ids: Iterable<number>): void {
    for (const id of [...ids]) this.archive(id);
  }

  /** Move every id to the bin, or delete permanently from the bin. */
  trashMany(ids: Iterable<number>): void {
    if (this.state.mailbox === "drafts") {
      void this.discardDrafts(ids);
      return;
    }
    for (const id of [...ids]) this.trash(id);
  }

  moveMany(ids: Iterable<number>, mailbox: Mailbox): void {
    for (const id of [...ids]) this.move(id, mailbox);
  }

  setReadMany(ids: Iterable<number>, read: boolean): void {
    for (const id of [...ids]) this.setRead(id, read);
  }

  // ── Senders ───────────────────────────────────────────────────────────────

  /**
   * Mute a sender: their mail stays in the list but never notifies and is not counted
   * in the unread badge. Stored lowercased-insensitive like `blockedSenders`.
   */
  muteSender(sender: string): void {
    const muted = this.state.preferences.mutedSenders;
    if (muted.some((s) => s.toLowerCase() === sender.toLowerCase())) return;
    const next = [...muted, sender];
    this.set(
      { preferences: { ...this.state.preferences, mutedSenders: next } },
      { preferences: { mutedSenders: next } },
    );
    void this.applyPlatform();
  }

  unmuteSender(sender: string): void {
    const next = this.state.preferences.mutedSenders.filter(
      (s) => s.toLowerCase() !== sender.toLowerCase(),
    );
    this.set(
      { preferences: { ...this.state.preferences, mutedSenders: next } },
      { preferences: { mutedSenders: next } },
    );
    void this.applyPlatform();
  }

  isSenderMuted(sender: string): boolean {
    const key = sender.toLowerCase();
    return this.state.preferences.mutedSenders.some((s) => s.toLowerCase() === key);
  }

  /**
   * Show every message from one sender: the sender filter, alone, with the search
   * cleared — "all mail from" should not be narrowed by whatever was typed before.
   */
  showSender(sender: string): void {
    this.set({ searchQuery: "", selectedId: null, cursorIndex: NO_CURSOR });
    this.setFilters([senderFilter(sender)]);
  }

  /** Search for a subject, with any "Re:"/"Fwd:" prefixes taken off first. */
  searchSubject(subject: string): void {
    const bare = subject.replace(/^\s*((re|fwd?|aw|sv|tr)\s*:\s*)+/i, "").trim();
    this.setFilters([]);
    this.setSearchQuery(bare);
  }

  /** Take back the offered undo, if there is one. */
  undoLast(): void {
    const action = this.undoAction;
    if (!action) return;
    this.dropUndo();
    this.set({ undo: null });
    action();
  }

  /**
   * Offer one undo, letting the previous offer go (and running its commit). `commit`
   * runs when this offer is let go, and at the latest after `commitAfterMs`.
   */
  private offerUndo(
    label: string,
    action: () => void,
    { commit, commitAfterMs }: { commit?: () => void; commitAfterMs?: number } = {},
  ): void {
    this.settleUndo();
    this.undoAction = action;
    this.undoCommit = commit ?? null;
    if (commit && commitAfterMs !== undefined) {
      this.undoCommitTimer = setTimeout(() => {
        if (this.undoAction !== action) return;
        this.settleUndo();
        this.set({ undo: null });
      }, commitAfterMs);
    }
    this.set({ undo: { label, at: Date.now() } });
  }

  /** Let the offered undo go: its commit (if any) runs. The strip is the caller's. */
  private settleUndo(): void {
    const commit = this.undoCommit;
    this.dropUndo();
    commit?.();
  }

  /** Forget the offered undo and its commit without running either. */
  private dropUndo(): void {
    this.undoAction = null;
    this.undoCommit = null;
    if (this.undoCommitTimer) clearTimeout(this.undoCommitTimer);
    this.undoCommitTimer = null;
  }

  /**
   * Move a message, with Undo on the strip: the swipe's Trash, and its Restore from the
   * Trash. A plain `move` underneath, so the optimistic update, the rollback on failure
   * and the trash bias are the ordinary ones; Undo puts the mailbox and the unread flag
   * back as they were and takes the sender's trash mark back if this move added it.
   *
   * Sent mail is restored by taking the Trash label off (Gmail keeps SENT itself and
   * refuses it in a modify), so its undo files to "archive" at the API and to Sent here.
   */
  moveWithUndo(id: number, mailbox: Mailbox): void {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email || email.mailbox === mailbox) return;
    if (email.mailbox === "sent" && mailbox !== "trash") return;
    this.movesWithUndo([{ id, to: mailbox }]);
  }

  /**
   * Archive with Undo: `e`, the reader's and the selection bar's Archive, the row menu.
   * Each message goes where `archive` sends it (out of the inbox, back from the archive,
   * nothing from Sent), and one offer takes back every one of them.
   */
  archiveWithUndo(ids: Iterable<number>): void {
    // In Snoozed, `e` and the bars' first button are Unsnooze: back to the Inbox now.
    if (this.state.mailbox === "snoozed") {
      this.unsnooze(ids);
      return;
    }
    const moves: { id: number; to: Mailbox }[] = [];
    for (const id of new Set(ids)) {
      const email = this.state.all.find((candidate) => candidate.id === id);
      if (!email || email.mailbox === "sent") continue;
      moves.push({ id, to: email.mailbox === "inbox" ? "archive" : "inbox" });
    }
    this.movesWithUndo(moves);
  }

  /**
   * Trash with Undo: `#`/Delete, the reader's and the selection bar's Trash, the row
   * menu. What `trash` means is kept: in Drafts it discards (one draft with Undo, as the
   * swipe does; several at once as before, without), and in the Trash it deletes for
   * good, which nothing can take back, so it offers nothing.
   */
  trashWithUndo(ids: Iterable<number>): void {
    const list = [...new Set(ids)];
    if (this.state.mailbox === "drafts") {
      if (list.length === 1 && this.draftRow(list[0])) this.discardDraftWithUndo(list[0]);
      else void this.discardDrafts(list);
      return;
    }
    const moves: { id: number; to: Mailbox }[] = [];
    for (const id of list) {
      const email = this.state.all.find((candidate) => candidate.id === id);
      if (!email) continue;
      if (email.mailbox === "trash") this.deletePermanently(id);
      else moves.push({ id, to: "trash" });
    }
    this.movesWithUndo(moves);
  }

  /** Move to a chosen mailbox with Undo: the selection bar's and row menu's Move, Not spam. */
  moveManyWithUndo(ids: Iterable<number>, mailbox: Mailbox): void {
    this.movesWithUndo([...new Set(ids)].map((id) => ({ id, to: mailbox })));
  }

  /**
   * Make a set of moves and offer one Undo for all of them. Each goes through `move`;
   * Undo puts back, per message, the mailbox and unread flag it had, and only for a
   * message still where this action put it (one moved on since is left alone), and
   * takes back the trash marks this action added. A newer offer lets this one go, as
   * ever, so each Undo takes back its own action and nothing else.
   */
  private movesWithUndo(moves: readonly { id: number; to: Mailbox }[]): void {
    const done: { id: number; to: Mailbox; from: Mailbox; unread: boolean }[] = [];
    const markedSenders = new Set<string>();
    for (const { id, to } of moves) {
      const email = this.state.all.find((candidate) => candidate.id === id);
      if (!email || email.mailbox === to) continue;
      if (to === "trash" && !this.trashSenders.includes(email.sender)) markedSenders.add(email.sender);
      done.push({ id, to, from: email.mailbox, unread: email.unread });
      this.move(id, to);
    }
    if (done.length === 0) return;
    const backend = this.backend;
    this.offerUndo(undoLabel(done.map((move) => move.to)), () => {
      if (this.backend !== backend) return;
      if (markedSenders.size > 0) this.trashSenders = this.trashSenders.filter((sender) => !markedSenders.has(sender));
      for (const move of done) {
        const now = this.state.all.find((candidate) => candidate.id === move.id);
        if (!now || now.mailbox !== move.to) continue;
        this.mutate(
          move.id,
          () => ({ ...now, mailbox: move.from, unread: move.unread }),
          async () => {
            await this.backend?.moveToMailbox(move.id, move.from === "sent" ? "archive" : move.from);
          },
          { previousMailbox: move.to, previousUnread: now.unread },
        );
      }
    });
  }

  /**
   * Discard one draft with Undo: the row goes now, and Gmail's copy is deleted only when
   * the offer is let go (dismissed, replaced, a mailbox change) or after
   * `DRAFT_DISCARD_UNDO_MS`. Undo just puts the row back. Closing the app first keeps
   * the draft, which is the safe way round.
   */
  discardDraftWithUndo(id: number): void {
    const row = this.draftRow(id);
    const draftId = row?.gmailDraft?.id;
    if (!row || !draftId) return;
    const generation = this.draftsGeneration;
    this.pendingDiscards.add(draftId);
    this.set({
      drafts: this.state.drafts.filter((email) => email.id !== id),
      ...(this.state.selectedId === id ? { selectedId: null } : {}),
    });
    const restore = () => {
      if (generation !== this.draftsGeneration) return;
      if (this.state.drafts.some((email) => email.gmailDraft?.id === draftId)) return;
      this.set({ drafts: [row, ...this.state.drafts].sort((a, b) => b.receivedAt - a.receivedAt) });
    };
    this.offerUndo(
      "Draft discarded.",
      () => {
        this.pendingDiscards.delete(draftId);
        restore();
      },
      {
        commit: () => {
          if (generation !== this.draftsGeneration) {
            this.pendingDiscards.delete(draftId);
            return;
          }
          const api = this.backend?.drafts;
          if (!api) {
            this.pendingDiscards.delete(draftId);
            return;
          }
          api
            .delete(draftId)
            .catch(() => {
              restore();
              this.set({ notice: "Couldn't discard that draft." });
            })
            .finally(() => this.pendingDiscards.delete(draftId));
        },
        commitAfterMs: DRAFT_DISCARD_UNDO_MS,
      },
    );
  }

  /** Drop the offered undo without taking it. */
  dismissUndo(): void {
    if (!this.undoAction) return;
    this.settleUndo();
    this.set({ undo: null });
  }

  /**
   * Apply a change to one message optimistically, with a real undo.
   *
   * The undo is registered *before* the server call and cleared on success; a failure
   * runs it, restoring the message's mailbox, read state and position — the three
   * things a user would notice if they were wrong.
   */
  private mutate(
    id: number,
    optimistic: () => Email,
    call: () => Promise<void>,
    context?: { previousMailbox: Mailbox; previousUnread: boolean },
  ): void {
    const before = this.state.all.find((email) => email.id === id);
    if (!before) return;

    const undo: Undo = () => {
      // The rollback reads the *current* array rather than a captured one, so it restores
      // this message into the latest state instead of clobbering what changed in between.
      this.set({
        all: this.state.all.map((email) => {
          if (email.id !== id) return email;
          // `context` is only supplied for a move; a star or read toggle rolls back to
          // the exact prior object.
          if (!context) return before;
          return { ...email, mailbox: context.previousMailbox, unread: context.previousUnread };
        }),
      });
    };

    this.pending.set(id, undo);
    this.set({ all: this.state.all.map((email) => (email.id === id ? optimistic() : email)) });

    // A cursor that pointed at the moved row now points at whatever slid into its place,
    // which is the message the user most likely wants next.
    this.reconcileCursor();
    void this.applyPlatform();

    call()
      .then(() => {
        if (this.pending.get(id) === undo) this.pending.delete(id);
      })
      .catch((error: unknown) => {
        undo();
        this.set({ error: error instanceof Error ? error.message : "That change did not save." });
      });
  }

  /** Apply a removal optimistically. */
  private mutateRemove(id: number, call: () => Promise<void>): void {
    const before = this.state.all;
    const undo: Undo = () => this.set({ all: before });

    this.pending.set(id, undo);
    this.set({ all: before.filter((email) => email.id !== id) });
    this.reconcileCursor();

    call()
      .then(() => {
        if (this.pending.get(id) === undo) this.pending.delete(id);
      })
      .catch((error: unknown) => {
        undo();
        this.set({ error: error instanceof Error ? error.message : "That change did not save." });
      });
  }

  /**
   * Keep the cursor pointing at a row that exists.
   *
   * Two cases, deliberately different:
   *
   *   - The list shrank and the cursor pointed at the last row: clamp to the new last
   *     row, the *next* message — what a user filing the bottom of the list expects.
   *   - There was no cursor to begin with: still no cursor. Opening whatever slid into
   *     row 0 would move the reader under the user's hands.
   */
  private reconcileCursor(): void {
    const threads = this.view.threads;

    /*
     * Is the open message still somewhere in this mailbox?
     *
     * The distinction is between a message that has *left* and one merely *not being
     * shown*: filters, search and the sort decide the second; only a move between
     * folders, a block or a sync decides the first. Everything below is written in
     * terms of this question, because either wrong answer is a bug — "is it in the
     * filtered rows" closes the reader on every filter toggle, "is it in `all`" never
     * closes it.
     */
    const id = this.state.selectedId;
    const openMessageSurvives = (): boolean => {
      if (id === null) return false;
      if (this.state.mailbox === "drafts") {
        return this.state.drafts.some((email) => email.id === id);
      }
      return this.state.all.some((email) => email.id === id && this.isListed(email));
    };

    // No cursor, so nothing to reconcile. A message can still have been selected by a
    // click, and the reader closes only if it has actually gone — a filter hiding it is
    // not that.
    if (this.state.cursorIndex === NO_CURSOR) {
      if (id === null) return;
      if (!openMessageSurvives()) this.set({ selectedId: null });
      return;
    }

    if (threads.length === 0) {
      // An empty list is not an empty mailbox: usually a filter that matched nothing,
      // with the reader still open on the message it excluded — so the cursor is dropped
      // and the reader left alone.
      if (id !== null && !openMessageSurvives()) {
        this.set({ selectedId: null, cursorIndex: NO_CURSOR });
      } else {
        this.set({ cursorIndex: NO_CURSOR });
      }
      return;
    }

    if (this.state.cursorIndex >= threads.length) {
      this.set({ cursorIndex: threads.length - 1 });
      return;
    }

    /*
     * The message under the cursor is gone. Follow the row that took its place — but
     * only if the reader was not showing something that still exists.
     *
     * This branch used to steal the reader: a filter change re-derives the rows, the row
     * at the cursor is now a different message, and the reader — showing something
     * perfectly valid — was reassigned to it. The user asked to change the list and got
     * a different email instead.
     */
    const at = threads[this.state.cursorIndex];
    if (id !== null && at && at.representative.id !== id) {
      const stillVisible = this.rowIndex(id) >= 0;
      if (!stillVisible && !openMessageSurvives()) {
        this.set({ selectedId: at.representative.id });
        // The row that took the reader's place is now being read.
        this.markOpenedRead();
      }
    }
  }

  /**
   * The classifier's own signals for a message, with no smart-filter correction in them:
   * what star learning reads, so it learns from the score's real inputs and never from a
   * filter the user corrected.
   */
  private rawSignalsFor(email: Email): EmailSignals {
    if (email.mailbox === "inbox") {
      this.inboxAnalysis();
      const base = this.inboxCache?.baseSignals.get(email.id);
      if (base) return base;
    }
    const { filterOverrides: _corrections, ...raw } = this.signalsFor(email);
    void _corrections;
    return raw;
  }

  /** Signals for a message, classifying it if the view has not yet. */
  private signalsFor(email: Email): EmailSignals {
    const cached = this.view.signals.get(email.id);
    if (cached) return cached;
    // Fall back to classifying against the current profile rather than `NEUTRAL`:
    // learning from a neutral classification would teach the model nothing about why
    // the user starred the message.
    return classifyAll([email], this.view.profile, this.state.learning.weights).get(email.id)!;
  }

  // ── Learning ──────────────────────────────────────────────────────────────

  /**
   * Adopt a new learning model and reclassify.
   *
   * The reclassify is debounced: a weight slider fires many times a second, and
   * reclassifying the inbox on each tick would make dragging one visibly slow. 80ms
   * coalesces a drag and still feels immediate.
   */
  private setLearning(learning: LearningModel): void {
    // The model goes on state immediately: the settings panel reads it synchronously as
    // a slider is dragged, and a debounce would make the numbers lag the thumb.
    // Persistence and reclassification are the expensive parts, and those wait.
    this.state = { ...this.state, learning };
    this.onPersist?.({ learning: learning.toSnapshot() });
    this.scheduleReclassify();
  }

  /** "Reset sorting": back to the shipped weights. The feedback log is kept. */
  resetLearning(): void {
    this.setLearning(this.state.learning.resetAdjustments());
  }

  // ── Preferences ───────────────────────────────────────────────────────────

  setPreferences(patch: Partial<Preferences>): void {
    const preferences = { ...this.state.preferences, ...patch };
    this.set({ preferences }, { preferences: patch });
    void this.applyPlatform();
  }

  /**
   * Send a reply, reporting failure through `error` rather than throwing.
   *
   * The composer is a sheet, and a bare throw would leave the user staring at a
   * composer that no longer works with no explanation. So the failure lands in the
   * same channel as every other optimistic-action rollback, and the sheet renders it.
   */
  async sendReply(draft: unknown, inReplyTo: string, draftId?: string): Promise<void> {
    /*
      A demo session has nowhere to send to.

      Thrown rather than reported through `state.error`: it used to both set the app-wide
      strip *and* throw, so one failed send produced two banners — a demo notice above
      the app and "Cannot send: not signed in." in the composer. The composer owns this
      error: it is this button's failure, and it renders it in place beside the Send
      button that caused it.

      The wording is the user-facing sentence, not an internal reason: "Cannot send: not
      signed in" is a fact about the code, the sentence a fact about the user's options.
    */
    if (!this.backend) {
      throw new Error(
        "Signing in to Gmail is required to send. The demo inbox is read-only.",
      );
    }
    try {
      if (draftId) await this.backend.sendReply(draft, inReplyTo, draftId);
      else await this.backend.sendReply(draft, inReplyTo);
      this.set({ error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't send that reply.";
      // Also surfaced app-wide, because this one *is* the app's problem rather than the
      // composer's: a network failure while sending is not the user's doing and will
      // recur on the next message.
      this.set({ error: message });
      throw error instanceof Error ? error : new Error(message);
    }
  }

  /**
   * Send a new message.
   *
   * Live: through the backend, then a refresh, so the message shows in Sent as soon as
   * Gmail has filed it rather than at the next scheduled sync.
   *
   * Demo: simulated, and said so by the return value. Composing is a whole feature the
   * demo would otherwise be unable to show, and unlike a reply nothing about a new
   * message depends on a server-side thread — so the demo files it into Sent locally,
   * where it can be opened like any other sent message, and nothing leaves the device.
   */
  async sendNew(draft: Draft, draftId?: string): Promise<{ simulated: boolean }> {
    if (!this.backend) {
      const now = Math.max(this.state.now, Date.now());
      const gmailId = `local-sent-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const contacts = (addresses: readonly string[]) => addresses.map((address) => ({ address }));
      const sent: Email = withCode({
        id: hashId(gmailId),
        gmailId,
        sender: DEMO_ACCOUNT.email,
        address: DEMO_ACCOUNT.email,
        name: DEMO_ACCOUNT.name,
        to: contacts(draft.to),
        cc: contacts(draft.cc),
        bcc: contacts(draft.bcc),
        mailbox: "sent",
        receivedAt: now,
        subject: draft.subject,
        body: draft.body,
        category: "primary",
        starred: false,
        unread: false,
        urgent: false,
        attachments: [],
      });
      this.set({ all: [sent, ...this.state.all] });
      return { simulated: true };
    }
    if (!this.backend.sendNew) {
      throw new Error("This build cannot send new messages.");
    }
    try {
      if (draftId) await this.backend.sendNew(draft, draftId);
      else await this.backend.sendNew(draft);
      this.set({ error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't send that message.";
      // As with a reply: surfaced app-wide too, because a failed send is the network's
      // problem and will recur on the next message.
      this.set({ error: message });
      throw error instanceof Error ? error : new Error(message);
    }
    void this.refresh().catch(() => {
      // The send succeeded; a failed refresh is reported by the sync itself, and the
      // message reaches Sent at the next one.
    });
    return { simulated: false };
  }

  /** Gmail drafts for the composer, or `null` in the demo (which keeps drafts on the device). */
  draftsApi(): DraftsApi | null {
    return this.backend?.drafts ?? null;
  }

  setSortBy(sortBy: SortBy): void {
    this.setPreferences({ sortBy });
  }

  setSearchQuery(searchQuery: string): void {
    this.set({ searchQuery });
  }

  /**
   * Coalesce a burst of weight changes into one reclassification.
   *
   * A weight slider fires many times a second, and reclassifying the inbox on each
   * tick would make dragging one visibly slow. 80ms coalesces a drag into a single
   * pass and still feels immediate.
   */
  scheduleReclassify(): void {
    if (this.classifyTimer) clearTimeout(this.classifyTimer);
    this.classifyTimer = setTimeout(() => {
      this.classifyTimer = null;
      // Notified once: the whole derived tree is recomputed from the new weights, and
      // every consumer sees the same new world.
      this.notify();
      this.onWeightsChanged?.(this.state.learning);
    }, 80);
  }

  /**
   * Fetch the HTML body of one message the reader has opened.
   *
   * Three details are load-bearing:
   *
   * - **In-flight is keyed by id.** A reader effect re-running on every render, or a
   *   cursor held down the list, would otherwise fire the request repeatedly; the map
   *   holds the promise, so a second caller awaits the first.
   * - **"No HTML part" is remembered as an answer.** Plain-text mail has none, and
   *   `undefined` as "not loaded yet" would refetch it on every render, forever.
   * - **`state.all` is not touched.** The body goes into `bodies` and the view is
   *   re-derived, leaving the classification memo intact — see `partitionBodies`.
   */
  loadBody(id: number, priority: Priority = "high"): Promise<void> {
    const existing = this.bodyInFlight.get(id);
    if (existing) return existing;
    if (this.bodyChecked.has(id)) {
      if (priority === "high") this.prefetchAround(id);
      return Promise.resolve();
    }

    const backend = this.backend;
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!backend || !email) return Promise.resolve();

    // A metadata-only row needs its whole body, not just its HTML: the plain text is a
    // snippet stand-in and the attachment list is empty until it lands.
    const whole = !isBodyLoaded(email) && backend.loadMessage !== undefined;

    this.bodyFailed.delete(id);
    const request = (async () => {
      try {
        if (whole) {
          const loaded = await this.bodyQueue.push(() => backend.loadMessage!(email.gmailId), priority);
          // Signed out (or switched account) while it was on the wire: not ours to keep.
          if (this.backend !== backend) return;
          this.bodyChecked.add(id);
          if (loaded.bodyHtml !== undefined) this.bodies.set(id, loaded.bodyHtml);
          this.applyLoadedBody(id, loaded, priority === "high");
        } else {
          const bodyHtml = await this.bodyQueue.push(() => backend.fetchBody(email.gmailId), priority);
          if (this.backend !== backend) return;
          this.bodyChecked.add(id);
          if (bodyHtml !== undefined) this.bodies.set(id, bodyHtml);
        }
      } catch (error) {
        // A dropped prefetch (sign-out, demo) is not a failure of anything.
        if (error instanceof TaskCancelled) return;
        // A body that will not load is not a sync failure or an error banner: the message
        // still opens, showing the plain text it has. Left out of `bodyChecked` so opening
        // it again can retry. Remembered as failed so the reader stops promising a
        // formatted version that is not coming.
        this.bodyFailed.add(id);
        this.notify();
        return;
      } finally {
        this.bodyInFlight.delete(id);
      }
      this.notify();
    })();

    this.bodyInFlight.set(id, request);
    if (priority === "high") this.prefetchAround(id);
    return request;
  }

  /**
   * Put a loaded body into `state.all`.
   *
   * Unlike the HTML side-map this does change `all` — the plain text is what the
   * classifier and search read, so a body that stayed out of `all` would leave the
   * message classified on its snippet forever. The opened message is applied at once
   * (the reader is waiting on it); background bodies are gathered for
   * `BODY_APPLY_DELAY_MS` and applied together, so a prefetch burst costs one
   * reclassification rather than one per message.
   */
  private applyLoadedBody(id: number, loaded: LoadedBody, now: boolean): void {
    this.pendingBodies.set(id, loaded);
    if (now) {
      this.flushLoadedBodies();
      return;
    }
    if (this.bodyApplyTimer !== null) return;
    this.bodyApplyTimer = setTimeout(() => {
      this.bodyApplyTimer = null;
      this.flushLoadedBodies();
    }, BODY_APPLY_DELAY_MS);
  }

  private flushLoadedBodies(): void {
    if (this.bodyApplyTimer !== null) {
      clearTimeout(this.bodyApplyTimer);
      this.bodyApplyTimer = null;
    }
    if (this.pendingBodies.size === 0) return;
    const pending = this.pendingBodies;
    this.pendingBodies = new Map();
    let changed = false;
    const all = this.state.all.map((email) => {
      const loaded = pending.get(email.id);
      if (!loaded) return email;
      changed = true;
      // `bodyHtml` stays in the side-map; see `partitionBodies`.
      return { ...withLoadedBody(email, loaded), bodyHtml: undefined };
    });
    if (changed) this.set({ all });
  }

  /**
   * Queue background body loads, lowest priority, for messages that need one.
   *
   * Anything already loaded, settled, in flight or failed this session is skipped, so
   * calling this freely (after every sync, on every open) costs nothing extra.
   */
  prefetchBodies(ids: readonly number[]): void {
    if (!this.backend?.loadMessage) return;
    const byId = new Map(this.state.all.map((email) => [email.id, email]));
    for (const id of ids) {
      const email = byId.get(id);
      if (!email || isBodyLoaded(email)) continue;
      if (this.bodyChecked.has(id) || this.bodyInFlight.has(id) || this.bodyFailed.has(id)) continue;
      void this.loadBody(id, "low");
    }
  }

  /** Forget queued body work: the account it was for is gone. */
  private dropBodyWork(): void {
    this.bodyQueue.clear();
    this.pendingBodies.clear();
    if (this.bodyApplyTimer !== null) clearTimeout(this.bodyApplyTimer);
    this.bodyApplyTimer = null;
  }

  /** After a sync: unread mail among the newest `PREFETCH_UNREAD_TOP_N` in the inbox. */
  private prefetchInbox(): void {
    const top = this.state.all
      .filter((email) => email.mailbox === "inbox")
      .sort((a, b) => b.receivedAt - a.receivedAt)
      .slice(0, PREFETCH_UNREAD_TOP_N)
      .filter((email) => email.unread);
    this.prefetchBodies(top.map((email) => email.id));
  }

  /**
   * After an open: the rows either side in the list, and the rest of the conversation —
   * the next things `j`/`k` or a click in the reader will want.
   */
  private prefetchAround(id: number): void {
    if (!this.backend?.loadMessage) return;
    const view = this.view;
    const rows = view.threads.map((row) => row.representative.id);
    const at = rows.indexOf(id);
    const ids: number[] = [];
    if (at >= 0) {
      for (let step = 1; step <= PREFETCH_NEIGHBOURS; step += 1) {
        if (rows[at + step] !== undefined) ids.push(rows[at + step]);
        if (rows[at - step] !== undefined) ids.push(rows[at - step]);
      }
    }
    const opened = this.state.all.find((email) => email.id === id);
    if (opened?.threadId) {
      for (const email of this.state.all) {
        if (email.threadId === opened.threadId && email.id !== id) ids.push(email.id);
      }
    }
    this.prefetchBodies(ids);
  }

  /**
   * True once a body has been fetched, or found not to exist. Drives the reader's wait.
   *
   * "Loaded" also covers every case where no fetch is coming: no backend (the demo
   * mailbox, whose messages carry their HTML already, or a signed-out store), a message
   * that already holds its HTML, and a fetch that failed. Each of those used to leave
   * "Loading the formatted version…" on screen forever.
   */
  hasLoadedBody(id: number): boolean {
    if (this.bodyChecked.has(id)) return true;
    if (!this.backend) return true;
    if (this.bodyInFlight.has(id)) return false;
    if (this.bodyFailed.has(id)) return true;
    const email = this.state.all.find((candidate) => candidate.id === id);
    return email?.bodyHtml !== undefined;
  }

  /** The body-bearing copy of a message, for the parts of the view that render one. */
  private withBody(email: Email): Email {
    const bodyHtml = this.bodies.get(email.id);
    return bodyHtml === undefined ? email : { ...email, bodyHtml };
  }

  dismissError(): void {
    this.set({ error: null });
  }

  /** Dismiss the non-blocking sync notice, e.g. after the user has read it. */
  dismissNotice(): void {
    if (this.state.notice === null) return;
    this.set({ notice: null });
  }

  /** Show a non-blocking notice — something worth saying that is not a failure. */
  setNotice(message: string | null): void {
    this.set({ notice: message });
  }

  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Say, for `ms`, what the user's last action did ("Draft saved."): the status pill
   * shows it and it goes by itself. A newer flash replaces it, with its own time.
   */
  flash(text: string, ms: number): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    const flash = { text, at: Date.now() };
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      if (this.state.flash === flash) this.set({ flash: null });
    }, ms);
    this.set({ flash });
  }

  /** Take the flash down before its time. */
  dismissFlash(): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = null;
    if (this.state.flash !== null) this.set({ flash: null });
  }

  setError(message: string | null): void {
    this.set({ error: message });
  }

  /** Replace the whole message set, e.g. after a demo reload. */
  replaceAll(emails: readonly Email[]): void {
    this.set({ all: emails.slice(), selectedId: null, cursorIndex: NO_CURSOR });
  }

  /**
   * Switch to the demo mailbox.
   *
   * Separate from `replaceAll` because the demo is a *mode*, not a dataset: it has no
   * backend, so every action is local and nothing can be sent or synced. Marking it
   * explicitly means "signed in" is never inferred from the presence of messages.
   */
  markDemoMode(now: number = DEMO_NOW, drafts?: readonly Email[]): void {
    this.backend = undefined;
    this.pendingConnect = null;
    this.dropUndo();
    this.dropBodyWork();
    this.draftsGeneration += 1;
    this.set({
      status: "ready",
      account: null,
      accountId: null,
      drafts: drafts ? drafts.slice() : this.state.drafts,
      draftsLoading: false,
      googleContacts: this.seedContacts,
      contactsAccess: "demo",
      selectedId: null,
      cursorIndex: NO_CURSOR,
      activeFilters: [],
      searchQuery: "",
      overlay: "none",
      syncing: false,
      undo: null,
      flash: null,
      syncPhase: null,
      syncFraction: null,
      syncStage: null,
      syncTotal: null,
      syncError: null,
      syncFailed: 0,
      truncated: false,
      error: null,
      notice: null,
      storagePrompt: null,
      lastSyncedAt: null,
      // The seed's reference instant (by default the fixed one; the app passes it moved
      // onto the real clock). The live wall clock would put the seed in "Earlier".
      now,
    });
  }

  // ── Accounts (1.4.0) ──────────────────────────────────────────────────────

  /** The registry as the switcher shows it; the session bridge keeps it current. */
  setAccounts(accounts: readonly AccountSummary[]): void {
    this.set({ accounts });
  }

  /** The open account's namespace, or `null` (demo, signed out). What persistence keys by. */
  currentAccountId(): string | null {
    return this.state.accountId;
  }

  /**
   * Leave the open account for another (or for none, `id` null), without erasing
   * anything: the mail on screen goes (the next account's cached copy, `cached`, shows at
   * once), and what the store keeps per account — the sorting weights, the smart-filter
   * corrections, the active filters, the mailbox — is replaced by the next account's.
   * Preferences, blocked and muted senders stay: they are the person's.
   *
   * `connect` follows, with the next account's backend. The old account's work in flight
   * is dropped (its backend is let go first), so a sync landing late cannot paint one
   * account's mail into another's view.
   */
  enterAccount(id: string | null, saved: AccountState, cached: readonly Email[] = []): void {
    this.backend = undefined;
    this.pendingConnect = null;
    this.dropUndo();
    this.dropBodyWork();
    this.bodies = new Map();
    this.bodyChecked = new Set();
    this.bodyFailed = new Set();
    this.bodyInFlight = new Map();
    this.draftsGeneration += 1;
    const filters = (saved.activeFilters ?? [])
      .map(parseFilterKey)
      .filter((filter): filter is FilterId => filter !== null);
    this.state = {
      ...this.state,
      accountId: id,
      account: null,
      status: id ? "loading" : this.state.status,
      all: cached.slice(),
      drafts: [],
      draftsLoading: false,
      googleContacts: [],
      contactsAccess: "unavailable",
      selectedId: null,
      cursorIndex: NO_CURSOR,
      activeFilters: filters,
      searchQuery: "",
      mailbox: MAILBOX_ORDER.includes(saved.mailbox as Mailbox) ? (saved.mailbox as Mailbox) : "inbox",
      overlay: "none",
      syncing: false,
      undo: null,
      flash: null,
      syncPhase: null,
      syncFraction: null,
      syncStage: null,
      syncTotal: null,
      syncError: null,
      syncFailed: 0,
      truncated: false,
      error: null,
      notice: null,
      storagePrompt: null,
      recentIds: new Set(),
      lastSyncedAt: null,
      learning: saved.learning ? LearningModel.fromSnapshot(saved.learning) : LearningModel.initial(),
      filterLearning: saved.filterLearning ? FilterLearning.fromSnapshot(saved.filterLearning) : FilterLearning.empty(),
    };
    this.notify();
  }

  /**
   * Open a message a notification named: the cached copy if there is one, or else fetch
   * it (`fetchMessage`) and add it to the mailbox first. Opens its conversation in the
   * reader (on a phone, full screen; Back returns to its mailbox, the Inbox for new mail).
   * `false` when it cannot be found.
   */
  async openMessage(gmailId: string, id?: number): Promise<boolean> {
    const email = await this.ensureMessage(gmailId, id);
    return email ? this.focusMessage(email.id) : false;
  }

  /**
   * The message a notification named, cached or fetched (and added to the mailbox), or
   * `null`. What `openMessage` opens, and what a desktop notification's Mark read and
   * Delete act on when the light sync announced mail the cache has not seen.
   */
  async ensureMessage(gmailId: string, id?: number): Promise<Email | null> {
    const cached =
      (gmailId ? this.state.all.find((email) => email.gmailId === gmailId) : undefined) ??
      (id !== undefined ? this.state.all.find((email) => email.id === id) : undefined);
    if (cached) return cached;
    const backend = this.backend;
    if (!backend?.fetchMessage || !gmailId) return null;
    let fetched: Email | null = null;
    try {
      fetched = await backend.fetchMessage(gmailId);
    } catch (error) {
      if (this.backend === backend) {
        this.set({ notice: error instanceof Error ? `Couldn't open that message: ${error.message}` : "Couldn't open that message." });
      }
      return null;
    }
    // Another account opened meanwhile: this message is not its to show.
    if (!fetched || this.backend !== backend) return null;
    const email = fetched;
    const already = this.state.all.find((candidate) => candidate.gmailId === email.gmailId);
    if (already) return already;
    this.set({ all: [email, ...this.state.all] });
    return email;
  }

  /** The summary of several new messages: the Inbox, unfiltered, with no message open. */
  openInbox(): void {
    this.setMailbox("inbox");
    this.set({ selectedId: null, cursorIndex: NO_CURSOR, overlay: "none", searchQuery: "" });
    if (this.state.activeFilters.length > 0) this.clearFilters();
  }

  /**
   * Sign out: clear the session but keep the things that describe the user.
   *
   * The line is "what is about this account" versus "what is about this person". Mail,
   * the account, the unread state and the active filters are the account's;
   * preferences, blocked senders, muted senders and what Winnow learned are the person's.
   * Keeping the second group is why a user can sign back in and find the app tuned.
   */
  async signOut(device?: AccountState): Promise<void> {
    // Snoozes and scheduled sends name this account's mail, so they go with it (the
    // snoozed mail stays archived under its label in Gmail; a scheduled message stays a
    // draft there). The demo's are the demo's and stay.
    const leaving = this.backend ? this.accountKey() : null;
    if (leaving) {
      const snoozes: SnoozeState = {
        snoozed: this.state.snoozes.snoozed.filter((r) => r.account !== leaving),
        woke: this.state.snoozes.woke.filter((r) => r.account !== leaving),
      };
      this.snoozeSlot.write(snoozes);
      const scheduled = this.state.scheduled.filter((send) => send.account !== leaving);
      this.scheduleSlot.write(serializeSchedules(scheduled));
      this.state = { ...this.state, snoozes, scheduled };
    }
    // Kept across the boundary rather than spread back afterwards, since `this.state` is
    // replaced wholesale below and anything not in `keep` is gone.
    //
    // 1.4.0: the learning is per account, so when the bridge hands over the device's own
    // (`device`, what the demo learns into) that replaces the account's, which went with
    // the account. Without it (tests, 1.3.5's callers) the old rule holds and it stays.
    const keep = {
      preferences: this.state.preferences,
      learning: device ? (device.learning ? LearningModel.fromSnapshot(device.learning) : LearningModel.initial()) : this.state.learning,
      accountId: null,
    };
    this.backend = undefined;
    this.pendingConnect = null;
    this.dropUndo();
    this.dropBodyWork();
    // The resident bodies are the account's mail in memory. A sync would replace them on
    // the next sign-in, but until then they would sit in the heap of a signed-out app.
    this.bodies = new Map();
    this.bodyChecked = new Set();
    this.bodyFailed = new Set();
    this.bodyInFlight = new Map();
    this.draftsGeneration += 1;

    // Park the background ticker *before* dropping the backend: on the desktop it is a
    // Rust thread that would otherwise keep firing every minute, calling `refresh` with
    // no backend, so a signed-out app would keep making requests it cannot authenticate.
    await this.platform?.setBackgroundSync(null).catch(() => undefined);
    // And clear the badge for the same reason: "12 unread" on the dock of a signed-out
    // app is a lie the user has to look at.
    await this.platform?.setUnreadBadge(0).catch(() => undefined);

    this.state = {
      ...this.state,
      status: "signed_out",
      account: null,
      googleContacts: [],
      contactsAccess: "unavailable",
      all: [],
      drafts: [],
      draftsLoading: false,
      selectedId: null,
      cursorIndex: NO_CURSOR,
      activeFilters: [],
      searchQuery: "",
      mailbox: "inbox",
      overlay: "none",
      syncing: false,
      undo: null,
      flash: null,
      syncPhase: null,
      syncFraction: null,
      syncStage: null,
      syncTotal: null,
      syncError: null,
      syncFailed: 0,
      truncated: false,
      error: null,
      notice: null,
      storagePrompt: null,
      recentIds: new Set(),
      lastSyncedAt: null,
      // Unlike the sorting weights, what the smart filters learned names this account's
      // senders, so it goes with the account.
      filterLearning: FilterLearning.empty(),
      ...keep,
    };
    this.onPersist?.({ filterLearning: this.state.filterLearning.toSnapshot() });
    this.notify();
  }

  // ── Smart filters that learn ──────────────────────────────────────────────

  /**
   * Hand the corrections to the account that just connected, or drop them if they were
   * another account's (or the demo's). Corrections made before any account owned them
   * belong to whoever connects first.
   */
  private claimFilterLearning(email: string): void {
    const model = this.state.filterLearning;
    const owner = email.toLowerCase();
    if (model.owner === owner) return;
    const next = model.owner !== null ? FilterLearning.empty(owner) : model.withOwner(owner);
    this.setFilterLearning(next);
  }

  private setFilterLearning(model: FilterLearning): void {
    this.state = { ...this.state, filterLearning: model };
    this.onPersist?.({ filterLearning: model.toSnapshot() });
    this.notify();
  }

  /** The inbox message with this id, if the inbox has it. */
  private inboxEmail(id: number): Email | undefined {
    return this.state.all.find((email) => email.id === id && email.mailbox === "inbox");
  }

  /**
   * For each learnable filter, whether all, some or none of these messages are in it
   * now — what the picker opens with.
   */
  smartFilterMembership(ids: readonly number[]): Map<LearnableFilter, "all" | "some" | "none"> {
    const { profile, signals } = this.inboxAnalysis();
    const emails = ids.map((id) => this.inboxEmail(id)).filter((email): email is Email => email !== undefined);
    const out = new Map<LearnableFilter, "all" | "some" | "none">();
    for (const filter of LEARNABLE_FILTERS) {
      let hits = 0;
      for (const email of emails) {
        const signal = signals.get(email.id);
        if (signal && matchesBuiltin(filter, email, signal, profile)) hits += 1;
      }
      out.set(filter, hits === 0 ? "none" : hits === emails.length ? "all" : "some");
    }
    return out;
  }

  /**
   * "Change smart filters…": record one correction per message whose membership the
   * change actually alters — a message already where it was asked to be teaches nothing.
   * The corrections share one batch, so the action counts once per sender. Those messages
   * move at once, because a correction for a message decides that message.
   *
   * Returns, per change, how many messages moved and how many could not because they
   * look unsafe (learning never puts unsafe mail into a filter), for the picker's status.
   */
  changeSmartFilters(
    ids: readonly number[],
    changes: readonly { filter: LearnableFilter; into: boolean }[],
  ): SmartFilterChange[] {
    if (changes.length === 0) return [];
    const { profile, signals } = this.inboxAnalysis();
    let model = this.state.filterLearning;
    if (model.owner === null) model = model.withOwner(this.state.account?.email.toLowerCase() ?? "demo");
    const at = this.now();
    const batch = (this.smartFilterBatch = Math.max(this.smartFilterBatch + 1, at));
    const results: SmartFilterChange[] = [];
    for (const { filter, into } of changes) {
      const result: SmartFilterChange = { filter, into, moved: 0, unsafe: 0, already: 0 };
      for (const id of ids) {
        const email = this.inboxEmail(id);
        const signal = email ? signals.get(email.id) : undefined;
        if (!email || !signal) continue;
        if (matchesBuiltin(filter, email, signal, profile) === into) {
          result.already += 1;
          continue;
        }
        if (into && isUnsafe(signal)) {
          result.unsafe += 1;
          continue;
        }
        model = model.record(email, filter, into, at, batch);
        result.moved += 1;
      }
      results.push(result);
    }
    if (model !== this.state.filterLearning) this.setFilterLearning(model);
    return results;
  }

  /** Increases with every "Change smart filters…" action, so each action is one batch. */
  private smartFilterBatch = 0;

  /** "Why it's here" for one inbox message: one line per filter it is in. */
  explainSmartFilters(id: number): FilterReason[] {
    const email = this.inboxEmail(id);
    if (!email) return this.explainInMailbox(id);
    this.inboxAnalysis();
    const cache = this.inboxCache;
    const base = cache?.baseSignals.get(id);
    const learned = cache?.signals.get(id);
    if (!cache || !base || !learned) return [];
    return explainFilters(email, base, learned, cache.profile, this.state.filterLearning, {
      background: cache.background,
      weights: cache.weights,
    });
  }

  /**
   * "Why it's here" for a message in another mailbox (1.3.3): the same explanation, from
   * the classification that mailbox's smart filters use (`mailboxSignals`). Drafts have
   * none.
   */
  private explainInMailbox(id: number): FilterReason[] {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email || email.mailbox === "inbox") return [];
    const { profile } = this.inboxAnalysis();
    const cache = this.inboxCache;
    const weights = this.state.learning.weights;
    const base = classifyEmail(email, profile, weights);
    const learned = this.mailboxSignals([email], profile).get(id) ?? base;
    return explainFilters(email, base, learned, profile, this.state.filterLearning, {
      background: cache?.background ?? EMPTY_BACKGROUND,
      weights: cache?.weights ?? weights,
    });
  }

  /** Whether the built-in rules alone would put this message in a filter. For tests and Settings. */
  builtInFilter(id: number, filter: LearnableFilter): boolean {
    const email = this.inboxEmail(id);
    this.inboxAnalysis();
    const base = this.inboxCache?.baseSignals.get(id);
    return email && base ? builtInSays(filter, email, base) : false;
  }

  removeFilterSenderRule(filter: LearnableFilter, key: string): void {
    this.setFilterLearning(this.state.filterLearning.removeSenderRule(filter, key));
  }

  /** "Reset what's learnt", for one filter or all of them. */
  resetFilterLearning(filter?: LearnableFilter): void {
    this.setFilterLearning(this.state.filterLearning.reset(filter));
  }
}

/** What one "Change smart filters…" change did, for the picker's status line. */
export type SmartFilterChange = {
  filter: LearnableFilter;
  into: boolean;
  /** Messages whose membership changed. */
  moved: number;
  /** Messages that could not be put in, because they look unsafe. */
  unsafe: number;
  /** Messages already where the change asked for. */
  already: number;
};

/**
 * A signal map for mail that is deliberately not classified.
 *
 * `NEUTRAL_SIGNALS` is frozen by convention, so it is handed out as-is rather than
 * copied per message: it has no mutable fields, and a map of a few thousand identical
 * references costs nothing next to a few thousand copies.
 */
/** Field-by-field equality of two classifications. */
function sameSignals(a: EmailSignals, b: EmailSignals): boolean {
  const keys = Object.keys(a) as (keyof EmailSignals)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** When a row of Snoozed or Scheduled happens: the list's order. */
function timedAt(email: Email): number {
  return email.snoozedUntil ?? email.scheduled?.sendAt ?? email.receivedAt;
}

function neutralSignalsFor(emails: readonly Email[]): SignalMap {
  const map = new Map<number, EmailSignals>();
  for (const email of emails) map.set(email.id, NEUTRAL_SIGNALS);
  return map;
}

/** The message shown when a sync could not download everything. */
export function syncFailureSummary(count: number): string {
  return `${count} message${count === 1 ? "" : "s"} failed to download this sync — refresh to retry.`;
}

/**
 * The non-blocking half of a sync's outcome.
 *
 * A truncated view is not an error: the sync worked, the user just has more mail than
 * Winnow will walk. It went into `error` before, the wrong channel — an error banner is
 * dismissible and alarming, and "only some of your archive is here" is a permanent
 * property of the account, not something retry resolves.
 *
 * A cache that could not be persisted used to be a note here too. It is now a
 * question (`storagePrompt`), because the user's answer changes what happens next.
 */
export function syncNotice(result: { truncated: boolean; cacheUnpersisted?: boolean }): string | null {
  const notes: string[] = [];
  if (result.truncated) {
    notes.push("Some mailboxes hold more than Winnow will walk, so older messages are not listed.");
  }
  // `cacheUnpersisted` is not a note any more: it is a question with two answers, and
  // lives in `storagePrompt` (see `STORAGE_PROMPT`).
  return notes.length > 0 ? notes.join(" ") : null;
}

/** A message's conversation key, the same one `groupThreads` files it under. */
function threadKeyOf(email: Email): string {
  return email.threadId ?? `single-${email.gmailId}`;
}

/**
 * The row in `threads` that shows message `id`, or `-1`.
 *
 * The row whose representative it is first, and otherwise the row of its conversation —
 * but only for a message of the mailbox on screen (`mailboxEmails`): a thread's sent
 * reply shares the inbox row's key, and is not read *on* that row.
 */
export function rowIndexOf(
  threads: readonly ThreadRow[],
  id: number | null,
  mailboxEmails: readonly Email[],
): number {
  if (id === null) return -1;
  const direct = threads.findIndex((row) => row.representative.id === id);
  if (direct >= 0) return direct;
  const email = mailboxEmails.find((candidate) => candidate.id === id);
  if (!email) return -1;
  const key = threadKeyOf(email);
  return threads.findIndex((row) => row.key === key);
}

/**
 * The 0-based row the position readout ("4 of 39") names, or `NO_CURSOR` for none.
 *
 * With a message open it is that message's row and nothing else — never the cursor,
 * which is a separate piece of state and has drifted from the reader before (a sync, an
 * archive above, an undo, a filter, a re-sort). An open message that is not a visible
 * row gets no number at all: the neutral readout is honest, a neighbour's number is not.
 * With nothing open it is the cursor, if that is on a row.
 */
export function readoutIndex(
  state: Pick<StoreState, "selectedId" | "cursorIndex">,
  view: Pick<MailboxView, "threads" | "selectedIndex">,
): number {
  if (state.selectedId !== null) return view.selectedIndex >= 0 ? view.selectedIndex : NO_CURSOR;
  return state.cursorIndex >= 0 && state.cursorIndex < view.threads.length ? state.cursorIndex : NO_CURSOR;
}
