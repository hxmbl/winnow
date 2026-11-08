/**
 * The state the store owns and the defaults it starts from.
 *
 * This is the shape every React consumer sees through `Snapshot`. Keeping it out of
 * the coordinator keeps the public contract visible without scrolling past thousands
 * of lines of behaviour.
 */

import type { CensorLevel } from "../mail/censor";
import type { Email, Mailbox } from "../model/email";
import type { SyncStage } from "../gmail/sync";
import type { SortBy } from "../classify/scoring";
import { DEFAULT_SORT } from "../classify/scoring";
import type { NotificationActions } from "../notify/notifications";
import { DEFAULT_NOTIFICATION_ACTIONS } from "../notify/notifications";
import type { UndoSendSeconds } from "../mail/undoSend";
import { DEFAULT_UNDO_SEND_SECONDS } from "../mail/undoSend";
import type { AccentPreference, Appearance } from "../model/appearance";
import {
  DEFAULT_ACCENT_CUSTOM,
  DEFAULT_ACCENT_THEME,
  DEFAULT_APPEARANCE,
} from "../model/appearance";
import type { LearningModel } from "../learn/learning";
import type { FilterLearning } from "../learn/filterLearning";
import type { SnoozeState } from "../mail/snooze";
import type { ScheduledSend } from "../mail/scheduledSend";
import type { OfflineView } from "../offline/offlineSave";
import type { ContactIndex } from "../contacts/index";
import type { GoogleContact } from "../contacts/google";
import type { BuiltinSmartFilter, FilterId } from "../model/signals";
import type { UserProfile } from "../model/profile";
import type { SignalMap } from "../classify/classify";
import type { FacetCounts } from "../classify/filters";
import type { InboxResult, SearchBags, ThreadRow } from "../classify/pipeline";
import type { AttentionSummary } from "../classify/attention";
import type { StoragePrompt, SyncPhase, AccountSummary } from "./types";

/** `cursorIndex` meaning "the user has not touched the list yet". */
export const NO_CURSOR = -1;

/**
 * How long a draft discarded with Undo waits before Gmail's copy is deleted, when the
 * offer is neither taken nor let go sooner.
 */
export const DRAFT_DISCARD_UNDO_MS = 10_000;
/**
 * How long an Undo offer (delete, archive, move, discard…) stays on the pill before it
 * goes by itself, taking its commit with it. Six seconds, not five: Hxmbl's call (1.4.x).
 * An offer with a shorter commit window of its own settles at that instead.
 */
export const UNDO_OFFER_MS = 6_000;

/** How long the pill says a snooze woke. */
export const WAKE_FLASH_MS = 6_000;
/** A wake later than this after its time happened because the app was closed then. */
export const LATE_WAKE_MS = 2 * 60 * 1000;
/** How long a window's claim on a due scheduled send holds (`claimScheduled`). */
export const CLAIM_HOLD_MS = 2 * 60 * 1000;

/**
 * Background body prefetch: how many of the newest inbox messages are scanned for
 * unread mail whose body has not been loaded yet. Unread mail is what gets opened
 * next, and its body is also what the classifier reads best.
 */
export const PREFETCH_UNREAD_TOP_N = 50;

/** How many rows either side of an opened message have their body prefetched. */
export const PREFETCH_NEIGHBOURS = 2;

/** The question asked when the offline cache could not be written. Wording is the owner's. */
export const STORAGE_PROMPT =
  "This is a large mailbox, Winnow requires them to be saved, are you sure you would like to save this?";

/** Shown when "Save" was tried and the cache still would not write. */
export const STORAGE_SAVE_FAILED =
  "Still couldn't save this mailbox offline. It will re-download next launch.";

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
   * Sender pictures: a sender's Gravatar when they are not in the user's contacts, and a
   * company's brand logo (BIMI). One switch since "Show brand logos" and "Gravatar
   * photos" were merged. Off by default.
   *
   * Its own switch rather than riding on `imagePolicy`: that policy is about one
   * message's content and defaults to *asking*, which an avatar in a list has no way to
   * do. Both lookups also leak something remote images do not, for every sender in the
   * list, opened or not: a hash of the address goes to Gravatar, and the sender's domain
   * to a DNS-over-HTTPS resolver. Paused while `imagePolicy` is `never`
   * (`ui/senderPictures.ts`). Contact photos and initials never depend on it.
   */
  senderPictures: boolean;
  /**
   * The inbox's "Sender pictures are off" notice was answered ("Keep off", "Turn on",
   * or the switch changed in Settings), so it does not come back. See
   * `ui/pictureNotice.ts`.
   */
  pictureNoticeDismissed: boolean;
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
   * Blur sensitive info (Settings → Privacy): what on screen is replaced by random
   * letters and blurred, for screenshots and screen sharing. Off by default; each step
   * adds to the last (emails, passwords, postal addresses, names). Display only: what is
   * sent to Gmail never changes. See `core/mail/censor.ts` and `ui/censorDom.ts`.
   */
  censorLevel: CensorLevel;
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
  /** The unread count on the app icon (dock badge, tray tooltip, tab title). Off shows none. */
  unreadBadge: boolean;
  /** Light, dark, true-black OLED, or whatever the OS says. See `core/model/appearance`. */
  appearance: Appearance;
  /** The accent theme, applied across every mode: a curated one, or `custom`. */
  accent: AccentPreference;
  /**
   * The picked colour behind `custom`, as `#RRGGBB` (1.4.0). Kept when another accent is
   * chosen, so going back to Custom brings the same colour back. Made safe per mode by
   * `ui/customAccent.ts`; the stored value is always what the user picked.
   */
  accentCustom: string;
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
  /**
   * Android: "Instant mail via the Gmail app" (STRM-442). Check the moment the Gmail
   * app posts a notification, with Notification access granted by the user. Off by
   * default: it needs a sensitive permission.
   */
  gmailListener: boolean;
  blockedSenders: string[];
  /**
   * Senders whose mail still arrives and is still listed, but never notifies and is not
   * counted in the unread badge. Gentler than `blockedSenders`, which hides the mail.
   * Local to Winnow: Gmail's API has no per-sender mute without a filter, and filters
   * need a settings scope Winnow does not ask for.
   */
  mutedSenders: string[];
  /**
   * The first-run tour (1.5) was finished or skipped on this device, so it does not open
   * by itself again. Settings › About › "Show the tour again" replays it. See `ui/tour.ts`
   * for when it opens at all: never for a device upgrading from an earlier version.
   */
  tourDone: boolean;
};

export const DEFAULT_PREFERENCES: Preferences = {
  sortBy: DEFAULT_SORT,
  imagePolicy: "ask",
  senderPictures: false,
  pictureNoticeDismissed: false,
  markReadOnOpen: true,
  swipeActions: true,
  leftHanded: false,
  censorLevel: "off",
  driveLinks: true,
  undoSendSeconds: DEFAULT_UNDO_SEND_SECONDS,
  notificationsEnabled: false,
  notificationActions: DEFAULT_NOTIFICATION_ACTIONS,
  notificationHidePreview: false,
  unreadBadge: true,
  appearance: DEFAULT_APPEARANCE,
  accent: DEFAULT_ACCENT_THEME,
  accentCustom: DEFAULT_ACCENT_CUSTOM,
  emailDarkMode: true,
  backgroundSync: true,
  backgroundSyncInterval: 300,
  gmailListener: false,
  blockedSenders: [],
  mutedSenders: [],
  tourDone: false,
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
  overlay: "none" | "shortcuts" | "navigation" | "settings" | "accounts";
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
   * The action just undone, ready to go back with `Shift+U`. A new action, a mailbox
   * change, sign-out or the demo drops it: redoing something into a mailbox the user
   * has left would be a surprise. The status pill does not show it; only the undo offer
   * has a button.
   */
  redo: { label: string; at: number } | null;
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
  /**
   * The last sync could not reach Gmail, and the mailbox on screen is the local copy.
   * A dropped connection is not a broken account: the cached mail stays usable, changes
   * wait in the offline queue, and a red bar says so. Cleared by the next sync that
   * gets through. A real problem (a revoked sign-in, a rejected client) still stops.
   */
  connectionLost: boolean;
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
   * Offline saving for the open account (`core/offline/offlineSave.ts`): the answer to
   * the storage question, and how far the background download has got.
   */
  offline: OfflineView;
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
   * The pills' numbers once a filter is on or a search is running (1.4.0), faceted on
   * the active set and the search: an off pill counts what the list would show with it
   * turned on too (search AND filters AND pill, see `countFacets`), an on pill the
   * current result. `null` with nothing active and no search, when the pills show
   * `railCounts` as before. `railCounts` still decides which pills the rail keeps, so
   * narrowing the list dims a pill to 0 rather than pulling it off the rail.
   */
  railFacets: FacetCounts | null;
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
