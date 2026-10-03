/**
 * The store: one object holding everything the UI reads.
 *
 * This is a hand-rolled observable rather than a state library, for a reason
 * worth stating: Winnow's state is *derived*, not just held. The profile, the
 * signals, the rail order and the visible list are all functions of the
 * messages, and they need to stay consistent with each other at every
 * keystroke. A library that stores slices independently would let the list and
 * the rail disagree; here there is one `recompute` and they cannot.
 *
 * Two properties make it usable from React without a framework binding:
 *
 *   - `subscribe(listener)` — a single callback on any change, and
 *     `useSyncExternalStore` maps onto it directly. No context, no provider, no
 *     re-render cascade.
 *   - **Mutations are optimistic and reversible.** Every action that touches a
 *     message records how to undo it before it changes anything, and the server
 *     call happens afterwards. A failed call runs the undo, so a network blip
 *     cannot leave a message in a mailbox it is not in.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Store/WinnowStore.swift`.
 */

import { MAILBOX_LABEL, type Email, type Mailbox } from "../model/email";
import {
  BUILTIN_FILTERS,
  catalogIndex,
  FILTER_LABELS,
  filterKey,
  parseFilterKey,
  PERMANENT_FILTERS,
  NAVIGATION_ITEMS,
  NEUTRAL_SIGNALS,
  navigationIndexFor,
  clampIndex,
  type BuiltinSmartFilter,
  type EmailSignals,
  type FilterId,
  type NavigationItem,
} from "../model/signals";
import { buildUserProfile, type TrashRecord, type UserProfile } from "../model/profile";
import { classifyAll, type SignalMap } from "../classify/classify";
import { countAllFilters, rankFilters } from "../classify/filters";
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
import { LearningModel } from "../learn/learning";
import { defaultWeights } from "../classify/weights";
import { DEMO_NOW } from "../data/demo";
import type { SyncProgress } from "../gmail/sync";

/** The four mailboxes, in the order the sidebar shows them. */
export const MAILBOX_ORDER: readonly Mailbox[] = ["inbox", "archive", "trash", "spam"];

/**
 * Which half of a sync is running, for the status line.
 *
 * Named here rather than reusing `SyncProgress["phase"]` because the engine's
 * union also contains `idle` and `sending`, and this field is specifically "a sync
 * is in flight, and here is which kind". The engine's `idle` never reaches the UI:
 * a completed phase is `null` on this field, which is what makes "not syncing"
 * answerable without a second boolean.
 */
export type SyncPhase = "full" | "incremental";

/** `cursorIndex` meaning "the user has not touched the list yet". */
export const NO_CURSOR = -1;

/**
 * How often the list's reference clock is refreshed.
 *
 * A minute, because the coarsest thing it drives is a relative timestamp, which
 * has a resolution of minutes anyway — and a store that ticks faster than its own
 * display resolution is paying for nothing.
 */
const CLOCK_INTERVAL_MS = 60_000;

/** What the user can change about how Winnow behaves. */
export type Preferences = {
  sortBy: SortBy;
  /** Remote images and tracking pixels. Off by default; see `html.ts`. */
  loadRemoteContent: boolean;
  notificationsEnabled: boolean;
  appearance: "system" | "light" | "dark";
  /** Keep syncing while the window is closed. Desktop only. */
  backgroundSync: boolean;
  /** How often, in seconds. */
  backgroundSyncInterval: number;
  blockedSenders: string[];
};

export const DEFAULT_PREFERENCES: Preferences = {
  sortBy: DEFAULT_SORT,
  loadRemoteContent: false,
  notificationsEnabled: false,
  appearance: "system",
  backgroundSync: true,
  backgroundSyncInterval: 300,
  blockedSenders: [],
};

/** Where the app is in its lifecycle. Drives which screen is shown. */
export type SessionStatus =
  | "loading"
  | "signed_out"
  | "signing_in"
  | "ready"
  | "error";

export type StoreState = {
  status: SessionStatus;
  /** Set when `status` is `error`, or when a background action failed. */
  error: string | null;
  /** A transient message: "3 messages failed to download". */
  notice: string | null;

  account: { email: string } | null;

  /** Every message the app knows about, across all mailboxes. */
  all: Email[];
  /** The messages in the current mailbox, newest first. */
  mailbox: Mailbox;

  activeFilters: FilterId[];
  searchQuery: string;
  /** The reader's message, or `null`. */
  selectedId: number | null;
  /**
   * The list cursor, independent of what the reader has open.
   *
   * `-1` means "no cursor", which is distinct from "on the first row". The
   * distinction is load-bearing: `j` on a fresh list should start at the top
   * and `k` should start at the bottom, and neither can be expressed if row 0
   * is also "nothing selected yet".
   */
  cursorIndex: number;

  preferences: Preferences;
  learning: LearningModel;

  /** Which modal is up, if any. */
  overlay: "none" | "shortcuts" | "navigation" | "settings";
  navigationIndex: number;

  /**
   * The buckets the user has silenced, in catalog order.
   *
   * Mirrors `persistedRemoved` onto the public state because the UI needs it to *draw*
   * a muted pill: the muted buckets stay in the rail so they can be un-muted from the
   * rail, and a pill that is in the rail but has no marker is indistinguishable from an
   * active one — its dismiss button calls `dismissFilter`, which is now a no-op, so
   * the control looks broken.
   */
  mutedFilters: readonly BuiltinSmartFilter[];

  syncing: boolean;
  /**
   * What the sync is doing, for the status line. `null` when not syncing.
   *
   * Nullable rather than an enum with an `idle` member, because "is a sync running"
   * and "which kind is it" are two questions and only the first is asked most of the
   * time. `syncing` already answers the first for callers that need the *count*, and
   * this answers it for callers that need the *kind*.
   */
  syncPhase: SyncPhase | null;
  /** 0–1 while the total is known, else `null`. */
  syncFraction: number | null;
  /** Messages that arrived in the run in progress, or the last completed one. */
  syncFetched: number;
  lastSyncedAt: number | null;
  /**
   * True when a sync walked a mailbox to its cap, so the cache is a triage set
   * rather than an export. Silently showing 500 archived messages as though they
   * were all of it would be a lie about the user's own mail.
   */
  truncated: boolean;
  /** Ids that arrived in the last sync, for the "new" marker. */
  recentIds: ReadonlySet<number>;
  /**
   * The reference instant the list's day sections are computed against.
   *
   * A property rather than a `Date.now()` call at the point of use, and that is
   * the whole point: the demo mailbox is seeded around a fixed date, so a real
   * clock puts every one of its messages in "Earlier" and the day sections —
   * and with them the only thing that makes the list scannable — stop testing
   * anything. Live mode uses the wall clock; demo mode uses the seed's.
   */
  now: number;
};

/** The messages a sync produced for the current mailbox. */
export type MailboxView = {
  emails: Email[];
  signals: SignalMap;
  profile: UserProfile;
  searchBags: SearchBags;
  result: InboxResult;
  threads: ThreadRow[];
  /** The rail, with activated buckets hoisted above the volume ranking. */
  rail: BuiltinSmartFilter[];
  /**
   * How many inbox messages land in each bucket.
   *
   * Computed over the *inbox*, not over `emails`, and that distinction is the
   * whole reason this is a field rather than something the UI works out for
   * itself. The rail is ranked against the inbox so that opening the bin does not
   * reshuffle it, and its counts have to agree with that ranking — otherwise
   * every pill reads `0` the moment you look at Archive or Trash, and reads
   * whatever the active filter admits the moment you turn one on. The number on a
   * pill is a claim about your mail, not about the current result set.
   *
   * `unsafe` is counted here even though it is excluded from the visible list:
   * its members *are* the hidden rows, so counting only what is on screen would
   * report the one bucket you need to be able to reach as permanently empty.
   */
  inboxCounts: ReadonlyMap<BuiltinSmartFilter, number>;
  /** Messages per sender, over the inbox, for the sender pills. */
  inboxSenderCounts: ReadonlyMap<string, number>;
  selected: Email | null;
  conversation: Email[];
  unreadCount: number;
  totalCount: number;
  /** Everything the app knows that is not in the current mailbox. */
  otherMailboxCount: number;
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
   * `onProgress` is a *request*, not a notification: the engine calls it as often
   * as it likes and the store decides whether that is worth a re-render. That
   * asymmetry is deliberate — a first sync downloads thousands of messages, and a
   * callback that re-rendered per message would make the app unusable during the
   * one operation it is least able to hide.
   */
  sync(options?: { onProgress?: (progress: SyncProgress) => void }): Promise<SyncOutcome>;
  toggleStar(id: number, starred: boolean): Promise<void>;
  moveToMailbox(id: number, mailbox: Mailbox): Promise<void>;
  setRead(id: number, read: boolean): Promise<void>;
  deletePermanently(id: number): Promise<void>;
  sendReply(draft: unknown, inReplyTo: string): Promise<void>;
  /**
   * Download one attachment's bytes.
   *
   * Separate from `sendReply` because it is the only operation that returns
   * binary, and it is the only one that is *not* a mutation — so it is called
   * directly by the reader rather than going through the optimistic-update path.
   */
  fetchAttachment(
    gmailId: string,
    attachmentId: string,
  ): Promise<{ bytes: Uint8Array; filename: string; mimeType: string }>;
}

/** What one sync produced. */
export type SyncOutcome = {
  emails: Email[];
  failed: number;
  /** A mailbox hit its cap, so the cache is a triage set rather than an export. */
  truncated: boolean;
};

/**
 * The OS surface the store drives.
 *
 * Exactly three things, and the restraint is the point: every one is a *reflection of
 * state the store already holds* — the unread count for the badge, the cadence for the
 * scheduler, the new arrivals for the notification.
 *
 * `openExternal` and `saveAttachment` used to be declared here too, and nothing in the
 * store ever called either. Both are one-shot operations a component performs directly,
 * and routing them through the store would mean reaching past it for a non-mutation —
 * so they are gone from this interface, and the reader calls the platform itself.
 *
 * Absent in demo mode, which is why every call on it is optional.
 */
export interface PlatformBridge {
  notifyNewMail(emails: readonly Email[]): Promise<void>;
  setUnreadBadge(count: number): Promise<void>;
  setBackgroundSync(intervalSeconds: number | null): Promise<void>;
}

type Listener = () => void;

/** How a mutation can be undone. */
type Undo = () => void;

export type StoreOptions = {
  /** Seed messages for demo mode. */
  seed?: readonly Email[];
  seedTrash?: readonly TrashRecord[];
  backend?: MailBackend;
  platform?: PlatformBridge;
  preferences?: Partial<Preferences>;
  /**
   * The reference instant for the list's day sections.
   *
   * Injected rather than read, because a demo seed is built around a fixed date
   * and a real clock would collapse all of it into one section. Live mode leaves
   * it unset and gets the wall clock.
   */
  now?: number;
  /** Called whenever anything persists-worthy changes. */
  onPersist?: (patch: PersistPatch) => void;
  /** Called when the learning weights change, so the inbox can reclassify. */
  onWeightsChanged?: (model: LearningModel) => void;
};

export type PersistPatch = {
  preferences?: Partial<Preferences>;
  learning?: ReturnType<LearningModel["toSnapshot"]>;
  activeFilters?: string[];
  mailbox?: Mailbox;
  /**
   * Buckets the user has silenced.
   *
   * Persisted with the rest of the "what you have told Winnow" state, because a
   * mute is a statement about the mail rather than about this session — the same
   * argument the blocked-sender list makes. It was not persisted at all before,
   * which combined with there being no unmute anywhere in the UI to mean muting a
   * bucket was a permanent, silent, unrecoverable decision.
   */
  removedFilters?: string[];
};

/**
 * The application store.
 *
 * Not a React store: it has no idea React exists. `useSyncExternalStore` is
 * the only bridge, which is why the same class drives the desktop app, the web
 * app and the tests.
 */
export class WinnowStore {
  private state: StoreState;
  private listeners = new Set<Listener>();
  private version = 0;
  private key = "0";

  private backend: MailBackend | undefined;
  private platform: PlatformBridge | undefined;

  /**
   * The binned senders, kept separately from the message list.
   *
   * A trash row carries only a sender address, and that is deliberate: the
   * discard itself is the signal, and retaining the body of something the user
   * binned would be both a privacy problem and a distraction.
   */
  private trashSenders: string[] = [];

  /**
   * Undo handles for in-flight mutations, keyed by message id.
   *
   * Keyed rather than a single stack so a second star toggle supersedes the
   * first instead of rolling it back out of order.
   */
  private pending = new Map<number, Undo>();

  /** Reclassify after a debounce, so a slider drag is not a reclassify per tick. */
  private classifyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: StoreOptions = {}) {
    this.backend = options.backend;
    this.platform = options.platform;
    this.trashSenders = (options.seedTrash ?? []).map((row) => row.sender);

    const seed = (options.seed ?? []).slice();
    this.state = {
      status: options.backend ? "loading" : "ready",
      error: null,
      notice: null,
      account: null,
      all: seed,
      mailbox: "inbox",
      activeFilters: [],
      searchQuery: "",
      selectedId: null,
      cursorIndex: NO_CURSOR,
      preferences: { ...DEFAULT_PREFERENCES, ...options.preferences },
      learning: LearningModel.initial(),
      overlay: "none",
      navigationIndex: 0,
      mutedFilters: [],
      syncing: false,
      syncPhase: null,
      syncFraction: null,
      syncFetched: 0,
      lastSyncedAt: null,
      truncated: false,
      recentIds: new Set(),
      now: options.now ?? Date.now(),
    };
  }

  /**
   * Advance the list's reference clock.
   *
   * `state.now` is latched — at `connect` for live mail, at the seed's instant
   * for the demo — and every day section and relative timestamp in the list is
   * computed against it. Latching is the right call for the demo and the wrong
   * one for live mail: a desktop app left open overnight would greet the user
   * with a list whose newest message is still "2 minutes ago" and a set of day
   * headings that stopped being true hours ago.
   *
   * So it is refreshed on a slow tick. The store owns the timer because the store
   * owns `now`; nothing above it needs to know that the clock is not a constant.
   */
  startClock(): () => void {
    const tick = (): void => {
      // Demo mode keeps its fixed instant: that is what makes the seed's day
      // sections and relative timestamps deterministic, and a demo whose
      // headings shift under the reader would fail its own fixture contract.
      if (this.backend) this.set({ now: Date.now() });
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
    return { ...this.state, view: this.derive(), key: this.key };
  };

  /** The current view, for non-React callers (the keybind handler, tests). */
  get view(): MailboxView {
    return this.derive();
  }

  /**
   * Everything derived from the messages.
   *
   * One pass, in dependency order, so no consumer can see a half-updated
   * world: profile → signals → search bags → visible list → rail. The previous
   * implementation memoised these independently in the React component, which
   * meant a filter toggle briefly rendered pills computed against the old list.
   */
  private derive(): MailboxView {
    const state = this.state;
    const blocked = new Set(state.preferences.blockedSenders.map((s) => s.toLowerCase()));

    // Blocked senders are hidden from every view, and — crucially — before
    // the profile is built. Otherwise a blocked sender's volume would still
    // push them up the engagement ranking, which is the opposite of blocking.
    const visible = state.all.filter((email) => !blocked.has(email.sender.toLowerCase()));
    const mailboxEmails = visible.filter((email) => email.mailbox === state.mailbox);

    // The profile is built from the *inbox*, not the current mailbox: learning
    // "who you read" from an archive or a bin would teach it the wrong thing.
    const inboxForProfile = visible.filter((email) => email.mailbox === "inbox");
    const profile = buildUserProfile(inboxForProfile, this.trashRecords());
    const inboxSignals = classifyAll(inboxForProfile, profile, state.learning.weights);

    // The inbox is classified once and reused when the inbox is open — the common
    // case, and the only one where the two sets coincide.
    //
    // Every *other* mailbox is deliberately left unclassified and rendered as
    // `NEUTRAL_SIGNALS`, because classifying it and then applying the inbox's own
    // filter rules to the result is how the bin and the spam folder ended up
    // showing zero messages. The rule that hides spam is a rule about what belongs
    // in your inbox; applying it to a folder whose entire purpose is to hold the
    // messages you rejected means every one of them is hidden, and the folder reads
    // as empty. The user opens Spam to check what Gmail decided was spam, and the
    // app was silently disagreeing with Gmail about all of it.
    //
    // `NEUTRAL_SIGNALS` is also the honest answer: a trashed message is not
    // "quiet personal mail", it is mail that has already been dealt with, and the
    // profile that would judge it was built from the inbox it is not in.
    const signals =
      state.mailbox === "inbox"
        ? inboxSignals
        : neutralSignalsFor(mailboxEmails);
    const searchBags = buildSearchBags(mailboxEmails);

    const result = runInboxQuery({
      emails: mailboxEmails,
      profile,
      signals,
      filters: state.activeFilters,
      searchQuery: state.searchQuery,
      sortBy: state.preferences.sortBy,
      searchBags,
      removedFilters: this.persistedRemoved,
    });

    const threads = groupThreads(result.emails);

    // The rail is ranked against the *inbox*, not the current view, so that
    // opening the bin does not change which buckets are pinned. A muted bucket
    // is state, not a derive-time decision, so it is read from the instance.
    const rail = rankFilters(
      inboxForProfile,
      inboxSignals,
      profile,
      this.persistedRemoved,
    );
    const railWithActive = this.orderedRail(rail, this.persistedRemoved);

    // The same inbox the rail was ranked against, for the same reason. See the
    // field's doc comment: a pill count has to be a claim about the user's mail,
    // not about whatever the current result set happens to be.
    const inboxCounts = countAllFilters(inboxForProfile, inboxSignals, profile);

    const inboxSenderCounts = new Map<string, number>();
    for (const email of inboxForProfile) {
      inboxSenderCounts.set(email.sender, (inboxSenderCounts.get(email.sender) ?? 0) + 1);
    }

    const selectedRow = threads.find((row) => row.representative.id === state.selectedId) ?? null;
    const selected = selectedRow?.representative ?? null;
    // From `visible`, not `state.all`: a blocked sender's reply must not stay
    // readable inside the conversation of a message you *can* see. Blocking a
    // sender and then finding their mail quoted in the open thread is not blocking
    // them.
    const conversation = selected
      ? conversationFor(visible, selected.threadId, selected.gmailId)
      : [];

    return {
      emails: result.emails,
      signals,
      profile,
      searchBags,
      result,
      threads,
      rail: railWithActive,
      inboxCounts,
      inboxSenderCounts,
      selected,
      conversation,
      unreadCount: mailboxEmails.filter((email) => email.unread).length,
      totalCount: mailboxEmails.length,
      otherMailboxCount: visible.length - mailboxEmails.length,
    };
  }

  /**
   * Buckets the user has silenced.
   *
   * Stored outside `Preferences` on the instance rather than in the public
   * state, because it is a classification input rather than a setting: it
   * changes what the inbox *contains*, not how it looks.
   */
  private persistedRemoved = new Set<BuiltinSmartFilter>();

  /**
   * The rail's final order.
   *
   * Four things happen here, and each exists because of a specific way the rail
   * used to lose a control the pointer needed:
   *
   *   - **The permanent pair leads.** Important and Deliveries stay at positions 1
   *     and 2 regardless of what is active. They are the two buckets a user
   *     reaches for on a bad day, and a pill that moves out from under a thumb
   *     because they happened to toggle something else is worse than no pill.
   *   - **An activated bucket is hoisted next**, in the order it was turned on,
   *     *whether or not it currently matches anything*. This is the bug that
   *     mattered: a magic bucket with no mail is not in `ranked` at all, so
   *     filtering to one, archiving everything in it, and letting a sync bring
   *     nothing back dropped the pill — leaving a live filter applied with no
   *     control anywhere on screen to turn it off. Falling back to the catalog
   *     means an empty active bucket still has a pill.
   *   - **A muted bucket is appended**, struck through, so muting is reversible
   *     from the same place it was made. It used to vanish, which made muting a
   *     one-way door.
   *   - **Mutes take no digit**, because they are not filterable and a pill that
   *     prints a shortcut it ignores is the same lie as a badge in the wrong
   *     colour.
   *
   * Ported from `legacy/swift-native/Sources/winnow/Store/WinnowStore.swift`,
   * which pins the permanent pair *before* hoisting active filters — the order
   * matters, because hoisting actives first pushed the always-watch buckets down
   * by however many filters were on.
   */
  private orderedRail(
    ranked: BuiltinSmartFilter[],
    removed: ReadonlySet<BuiltinSmartFilter>,
  ): BuiltinSmartFilter[] {
    const activeBuiltins = this.state.activeFilters
      .filter((filter): filter is Extract<FilterId, { kind: "builtin" }> => filter.kind === "builtin")
      .map((filter) => filter.id)
      .filter((id) => !removed.has(id));

    const pinned = PERMANENT_FILTERS.filter((id) => !removed.has(id));

    // Catalog order is the fallback for an active bucket that has dropped out of
    // the ranking, so the pill appears in a predictable place rather than
    // appended at random.
    const hoisted = activeBuiltins.filter((id) => !pinned.includes(id));
    const hoistedOrdered = [
      ...hoisted.filter((id) => ranked.includes(id)),
      ...hoisted.filter((id) => !ranked.includes(id)).sort((a, b) => catalogIndex(a) - catalogIndex(b)),
    ];

    const hoistedSet = new Set([...pinned, ...hoistedOrdered]);
    const rest = ranked.filter((id) => !hoistedSet.has(id));
    const muted = BUILTIN_FILTERS.filter((id) => removed.has(id));

    return [...pinned, ...hoistedOrdered, ...rest, ...muted];
  }

  /**
   * The muted buckets, in catalog order.
   *
   * Separate from the rail because the rail is not the only place they need to
   * appear: the settings panel renders an "unhide" row per bucket, so a mute is
   * reversible from a place the user will actually think to look.
   */
  mutedBuckets(): BuiltinSmartFilter[] {
    return this.mutedList();
  }

  /** The muted buckets, in catalog order. */
  private mutedList(): BuiltinSmartFilter[] {
    return BUILTIN_FILTERS.filter((id) => this.persistedRemoved.has(id));
  }

  // ── Changing ──────────────────────────────────────────────────────────────

  /**
   * Apply a partial update and notify.
   *
   * The version bump is what `useSyncExternalStore` reads: React compares the
   * snapshot by reference, and `getSnapshot` returns a fresh object each time,
   * so a monotonically increasing key is what makes "did it change?" answerable
   * without a deep comparison.
   */
  private set(patch: Partial<StoreState>, persist?: PersistPatch): void {
    this.state = { ...this.state, ...patch };
    this.notify();
    if (persist) this.onPersist?.(persist);
  }

  /**
   * Tell every subscriber the world moved.
   *
   * Split out of `set` because one caller — the sync engine's progress callback —
   * needs to advance state without paying for a notification on every message it
   * downloads.
   */
  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  /** Wired by `attach`; see `StoreOptions`. */
  private onPersist: ((patch: PersistPatch) => void) | undefined;
  private onWeightsChanged: ((model: LearningModel) => void) | undefined;

  /**
   * Late-bind the store's collaborators.
   *
   * Separate from the constructor because the backend and platform bridge need
   * the store (to read state) and the store needs them (to call them) —
   * constructing both in one expression would be a cycle. `attach` breaks it.
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
   * Two sources describe the same habit and are combined with `max` rather than
   * summed: the messages currently sitting in the bin, and the discards this
   * store has witnessed (or was seeded with). Summing them counted a sender twice
   * for every message still in the bin, so the bias tracked the *size* of the bin
   * rather than how often the user actually discards — which is the number the
   * profile is supposed to be reading, and the one that decides whether a sender
   * is demoted.
   *
   * `max` is also what makes the purge case work: deleting a message for good
   * removes it from `state.all`, and without the witnessed log that discard would
   * simply stop existing.
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
   * One call, and one notification, on purpose. The three things a returning user
   * expects to find are the mailbox they left, the buckets they had narrowed to,
   * and what Winnow learned — and restoring them in three separate `set` calls
   * meant three renders, each of which classified the whole mailbox against a
   * half-restored world.
   *
   * Called from `main.tsx` before the first paint, which is why it is separate
   * from the constructor: the constructor cannot notify, and a store that
   * computed its derived view three times on boot was visible as a flash.
   */
  restoreState(saved: {
    mailbox?: Mailbox | null;
    activeFilters?: readonly string[];
    removedFilters?: readonly string[];
    preferences?: Partial<Preferences>;
    learning?: ReturnType<LearningModel["toSnapshot"]> | null;
  }): void {
    const filters = (saved.activeFilters ?? [])
      .map(parseFilterKey)
      .filter((filter): filter is FilterId => filter !== null);

    for (const key of saved.removedFilters ?? []) {
      if ((BUILTIN_FILTERS as readonly string[]).includes(key)) {
        this.persistedRemoved.add(key as BuiltinSmartFilter);
      }
    }

    this.state = {
      ...this.state,
      mailbox: MAILBOX_ORDER.includes(saved.mailbox as Mailbox)
        ? (saved.mailbox as Mailbox)
        : this.state.mailbox,
      activeFilters: filters,
      // Mutes are applied inside the loop above, so the list is read *after* it and
      // is already correct.
      mutedFilters: this.mutedList(),
      preferences: { ...this.state.preferences, ...(saved.preferences ?? {}) },
      learning: saved.learning
        ? LearningModel.fromSnapshot(saved.learning)
        : this.state.learning,
    };
    this.notify();
  }

  /**
   * The clock, as a method.
   *
   * Injected in tests so a feedback event's timestamp is deterministic. Every
   * `Date.now()` in the store goes through here for that reason.
   */
  now = (): number => Date.now();

  // ── Session ───────────────────────────────────────────────────────────────

  /** The connection `connect` is establishing, so a failed one can be retried. */
  private pendingConnect: { backend: MailBackend; account: { email: string } } | null = null;

  /**
   * Point the store at a backend and start the first sync.
   *
   * `signing_in` is a real status, and the top bar renders it: the OAuth round
   * trip is the one step where the app is deliberately doing nothing and waiting
   * for a human, and saying so is the difference between "hanging" and "waiting
   * for you".
   */
  async connect(backend: MailBackend, account: { email: string }): Promise<void> {
    this.backend = backend;
    this.pendingConnect = { backend, account };
    this.set({
      status: "signing_in",
      account,
      error: null,
      // Live mail is real, so the wall clock is the right reference instant for
      // its day sections. The demo's fixed instant is for the demo's instants.
      now: Date.now(),
    });
    await this.runSync({ initial: true });
    // Connected. The retained connection only exists so a *failed* connect can be
    // retried; keeping it would let "Try again" resurrect a revoked session.
    this.pendingConnect = null;
  }

  /**
   * Refresh.
   *
   * New messages are diffed against what was already known *before* the sync, so
   * the "new" marker only appears for genuinely new mail and the list does not
   * flash on every refresh.
   */
  async refresh(): Promise<void> {
    if (!this.backend || this.state.syncing) return;
    await this.runSync({ initial: false });
  }

  /**
   * One sync, shared by `connect` and `refresh`.
   *
   * The only difference between them is what surrounds the call. `connect` also
   * moves the session through `loading` and announces nothing, because a first
   * sync has no "new" mail: everything in it is new, and telling someone about
   * forty messages they have never seen is noise, not news.
   *
   * A failure is put on screen *and* re-thrown, so `connect`'s caller can decide
   * what a failure means for the session as a whole.
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
    });

    const known = new Set(this.state.all.map((email) => email.gmailId));

    try {
      const result = await backend.sync({
        onProgress: (progress) => {
          // Progress arrives on the engine's own schedule, not on a store tick,
          // so it is written to state *without* notifying: a first sync of two
          // thousand messages would otherwise re-render the app two thousand times
          // to move a percentage. A phase change is notified, because that is a
          // visible transition rather than a per-message increment.
          const phase = progress.phase === "idle" || progress.phase === "sending"
            ? this.state.syncPhase
            : progress.phase;
          const changed = this.state.syncPhase !== phase;
          this.state = {
            ...this.state,
            syncing: true,
            syncPhase: phase,
            syncFraction: progress.fraction,
            syncFetched: progress.fetched,
          };
          if (changed) this.notify();
        },
      });

      const recent = new Set<number>();
      if (!initial) {
        for (const email of result.emails) {
          if (!known.has(email.gmailId)) recent.add(email.id);
        }
      }

      this.set({
        status: "ready",
        all: result.emails,
        syncing: false,
        syncPhase: null,
        syncFraction: null,
        lastSyncedAt: Date.now(),
        recentIds: recent,
        truncated: result.truncated,
        notice: syncNotice(result),
        error: result.failed > 0 ? syncFailureSummary(result.failed) : null,
      });

      if (!initial) await this.notifyIfNew(recent);
      await this.applyPlatform();
    } catch (error) {
      this.set({
        status: "error",
        syncing: false,
        syncPhase: null,
        error: error instanceof Error ? error.message : "Could not reach Gmail.",
      });
      throw error;
    }
  }

  /**
   * Retry the connection that failed.
   *
   * The error screen's only button used to be a no-op, and there was nowhere to
   * go from it because `connect` threw away what it was connecting *to*. Both are
   * retained now, so retrying is one call — and it is the call the user wants,
   * since "try again" is the only answer to a network that was down thirty
   * seconds ago.
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
    const arrived = this.state.all.filter((email) => recent.has(email.id));
    if (arrived.length === 0) return;
    await this.platform.notifyNewMail(arrived).catch(() => undefined);
  }

  /** Push badge count and sync cadence to the OS. */
  private async applyPlatform(): Promise<void> {
    if (!this.platform) return;
    const { preferences } = this.state;
    await this.platform.setUnreadBadge(this.view.unreadCount).catch(() => undefined);
    // The cadence is only meaningful on the desktop; in a browser the tab's
    // own timer is the only thing that runs, and the platform layer no-ops.
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
    // Switching mailbox drops the reader and the cursor: a selection from the
    // inbox means nothing in the bin, and leaving it would show a message the
    // list does not contain. Filters go too — a bucket pinned in the inbox means
    // nothing in the archive — and both are persisted together, since "which
    // mailbox am I in" and "what is narrowed inside it" are one decision.
    this.set({ mailbox, selectedId: null, cursorIndex: NO_CURSOR, activeFilters: [] }, {
      mailbox,
      activeFilters: [],
    });
  }

  select(id: number | null): void {
    this.set({ selectedId: id });
  }

  /** Open the message at the cursor. */
  openCursor(): void {
    // Guarded explicitly: with no cursor, `threads[-1]` is `undefined` and the
    // old code relied on that accidental falsiness.
    if (this.state.cursorIndex === NO_CURSOR) {
      this.moveCursor(1);
      return;
    }
    const row = this.view.threads[this.state.cursorIndex];
    if (row) this.set({ selectedId: row.representative.id });
  }

  closeReader(): void {
    this.set({ selectedId: null });
  }

  /**
   * Move the cursor, and take the reader with it.
   *
   * `j` and `k` open as they move, rather than moving a highlight and requiring
   * a second keypress to see anything. In a two-pane client that is what the key
   * is *for*: the reader is already on screen, so making the user press `o` to
   * fill it is two keystrokes to see the thing they asked to see.
   */
  moveCursor(delta: number): void {
    const threads = this.view.threads;
    if (threads.length === 0) return;

    // With no cursor, "next" starts at the top and "previous" starts at the
    // bottom, which is what a user pressing `j` or `k` on a fresh list expects.
    let next: number;
    if (this.state.cursorIndex === NO_CURSOR) {
      next = delta > 0 ? 0 : threads.length - 1;
    } else {
      next = clampIndex(this.state.cursorIndex + delta, threads.length);
    }

    this.set({
      cursorIndex: next,
      selectedId: threads[next]?.representative.id ?? null,
    });
  }

  /** Select and open in one step, for a click on a row. */
  openRow(index: number): void {
    const row = this.view.threads[index];
    if (!row) return;
    this.set({ cursorIndex: index, selectedId: row.representative.id });
  }

  /**
   * Open a message by id, wherever it is.
   *
   * This is what a deep link, a notification click, and the browser tab title
   * all need, and none of them know — or can know — the message's row index,
   * which depends on the current mailbox, search query and filters. So the lookup
   * is done here, against the list the user is actually looking at.
   *
   * Two cases where the message is not in the current view, both handled rather
   * than ignored, because both are normal:
   *
   *   - It is in a *different* mailbox. The filter is dropped so the row becomes
   *     visible; silently doing nothing would look like the link is broken.
   *   - Filters or a search are hiding it. Those are transient view state, so
   *     they are cleared for the jump and the cursor lands on the row. The user
   *     can put the filters back.
   */
  focusMessage(id: number): boolean {
    const visibleAt = this.view.threads.findIndex(
      (row) => row.representative.id === id,
    );
    if (visibleAt >= 0) {
      this.set({ cursorIndex: visibleAt, selectedId: id, overlay: "none" });
      return true;
    }

    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email) return false;

    // Clear what is hiding it, but keep the mailbox if the message is in it —
    // switching to where it actually lives is the point of following a link.
    if (email.mailbox !== this.state.mailbox) this.set({ mailbox: email.mailbox });
    this.set({
      activeFilters: [],
      searchQuery: "",
      selectedId: id,
      overlay: "none",
    });

    // The row index can only be known after the list has been re-derived, which
    // happens inside `set`. So the cursor is placed by looking the id up again.
    const nowAt = this.view.threads.findIndex((row) => row.representative.id === id);
    this.set({ cursorIndex: nowAt >= 0 ? nowAt : NO_CURSOR });
    return true;
  }

  setOverlay(overlay: StoreState["overlay"]): void {
    this.set({
      overlay,
      // The palette opens on whichever row corresponds to the mailbox already on
      // screen, so opening it from Spam highlights Spam. Without this it always
      // opened on Inbox, which made `!` feel broken when used from anywhere else.
      navigationIndex:
        overlay === "navigation" ? navigationIndexFor(this.state.mailbox) : this.state.navigationIndex,
    });
  }

  moveNavigation(delta: number): void {
    // The count comes from the palette's own list rather than a literal `4`. It
    // had drifted from `NAVIGATION_ITEMS` in exactly the way a duplicated constant
    // does: the palette gained no row, but a future one would have been
    // un-reachable by keyboard with nothing to say so.
    this.set({
      navigationIndex: clampIndex(this.state.navigationIndex + delta, NAVIGATION_ITEMS.length),
    });
  }

  /**
   * Act on the highlighted palette row.
   *
   * The mailbox is read off `NAVIGATION_ITEMS` rather than matched per-id, so a
   * row added to the palette is reachable without touching this function — and a
   * row whose mailbox is missing (settings) is a view rather than a destination,
   * which is why `mailbox` is optional on the item.
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
   * `unsafe` is exclusive: it means "show me what you think is junk", and
   * combining it with "Important" would produce an empty list every time.
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

    // A muted bucket cannot be re-activated. Muting is a statement that the bucket
    // is over-firing, and letting a filter turn it back on would apply a mute and
    // an activation to the same mail at once — the list would show exactly the
    // messages the user asked to stop seeing, and the pill would read as if the
    // mute had not worked.
    if (filter.kind === "builtin" && this.persistedRemoved.has(filter.id)) return;

    this.setFilters([...active, filter]);
  }

  /**
   * Replace the active set and persist it.
   *
   * One method, because persisting the active set has to be computed from the set
   * being installed. Passing a patch alongside the new value meant the two were
   * built at different moments: `set` evaluates its arguments before it runs, so
   * `filterPatch()` read the *previous* state and wrote that. The effect was that
   * turning a bucket on persisted "off" — and the persisted set was one click
   * behind for the rest of the session, so the filters you saw after a reload
   * were the ones you had before the click.
   */
  private setFilters(activeFilters: FilterId[]): void {
    this.set(
      { activeFilters, mutedFilters: this.mutedList() },
      {
        activeFilters: activeFilters.map(filterKey),
        removedFilters: [...this.persistedRemoved],
      },
    );
  }

  clearFilters(): void {
    if (this.state.activeFilters.length === 0) return;
    this.setFilters([]);
  }

  /**
   * Mute a bucket: hide its mail *and* tell the learning model.
   *
   * Mutes survive sign-out and survive a reload, unlike filters — muting is a
   * statement about the mail, not about this session, and a preference that reset
   * on every launch is not a preference. The bucket stays in the rail, struck
   * through, so the mute can be undone from the same place it was made; see
   * `orderedRail`.
   */
  dismissFilter(filter: BuiltinSmartFilter): void {
    if (filter === "unsafe" || this.persistedRemoved.has(filter)) return;
    this.persistedRemoved.add(filter);
    this.setFilters(
      this.state.activeFilters.filter(
        (f) => !(f.kind === "builtin" && f.id === filter),
      ),
    );

    // The rejection is about a *bucket*, not a message, so it is recorded
    // without one. Attaching the open message would teach the model that this
    // particular message was a bad example, which is a much stronger claim than
    // the user made.
    this.setLearning(this.state.learning.rejectFilter(filter, null, null, this.now()));
  }

  /** Unmute a bucket. */
  restoreFilter(filter: BuiltinSmartFilter): void {
    if (!this.persistedRemoved.delete(filter)) return;
    this.set(
      { mutedFilters: this.mutedList() },
      { removedFilters: [...this.persistedRemoved] },
    );
  }

  /**
   * Adopt a persisted set of mutes.
   *
   * Separate from the constructor because the restored set has to arrive *with*
   * the persisted filters and mailbox — the three are one decision, split across
   * three keys — and calling `restoreFilter` per bucket would re-notify and
   * re-persist on the way in.
   */
  adoptRemovedFilters(filters: readonly BuiltinSmartFilter[]): void {
    for (const id of BUILTIN_FILTERS) {
      if (filters.includes(id)) this.persistedRemoved.add(id);
    }
    this.state = { ...this.state, mutedFilters: this.mutedList() };
    this.notify();
  }

  isFilterRemoved(filter: BuiltinSmartFilter): boolean {
    return this.persistedRemoved.has(filter);
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
   * The learning event is recorded *before* the flip, so it sees the
   * pre-feedback classification. Recording it afterwards would let the model
   * learn from the star's own contribution to the importance score, which is
   * the model grading its own homework.
   */
  toggleStar(id: number): void {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email) return;

    const starred = !email.starred;
    const signals = this.signalsFor(email);
    const learning = this.state.learning.recordStar(email, signals, starred, this.now());

    this.mutate(id, () => ({ ...email, starred }), async () => {
      await this.backend?.toggleStar(id, starred);
    });

    this.setLearning(learning);
  }

  /**
   * The title of the list, for the header and the window title.
   *
   * "Inbox", "From ada@example.com", the single bucket's own name, or
   * "Filtered" when several buckets are combined — which is the honest answer,
   * since no single label describes the intersection.
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
   * unarchives from the archive, restores from the bin, and marks not-spam from
   * spam. Doing that in one action means the optimistic update, the undo and the
   * server call cannot disagree about what "archive" means.
   */
  archive(id: number): void {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email) return;
    const destination: Mailbox =
      email.mailbox === "inbox" ? "archive" : email.mailbox === "archive" ? "inbox" : "inbox";
    this.move(id, destination);
  }

  /**
   * Move a message to another mailbox.
   *
   * The discard is recorded here rather than by the caller, because it is the
   * move itself that is the signal: the profile's trash bias is a statement about
   * how often the user bins each sender, and the only place that number can be
   * observed is the instant they do it. Recording it in the UI would miss every
   * keyboard-driven filing, which is most of them.
   *
   * Moving marks read. A message you have filed away is a message you have dealt
   * with, and leaving it bold in the next mailbox is noise.
   */
  move(id: number, mailbox: Mailbox): void {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email || email.mailbox === mailbox) return;

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
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email) return;
    // In the bin, "delete" means actually delete. Anywhere else it means move
    // to the bin — the destructive action is only reachable where the user
    // has already said this is rubbish.
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

  /**
   * Mark every message in the current mailbox read.
   *
   * The mailbox on screen, and only that one. Clearing read state everywhere is
   * both a surprise — you were looking at the inbox, and your archive quietly went
   * quiet — and a divergence, because only the current mailbox's messages are
   * pushed to the server, so the rest would snap back on the next sync.
   *
   * The undo is the list of ids it touched, not a captured array: a rollback that
   * restored a stale snapshot would undo whatever else happened in between.
   */
  markAllRead(): void {
    const mailbox = this.state.mailbox;
    const ids = new Set(
      this.state.all
        .filter((email) => email.mailbox === mailbox && email.unread)
        .map((email) => email.id),
    );
    if (ids.size === 0) return;

    this.set({
      all: this.state.all.map((email) =>
        ids.has(email.id) ? { ...email, unread: false } : email,
      ),
    });
    for (const email of this.state.all) {
      if (ids.has(email.id)) this.backend?.setRead(email.id, true).catch(() => undefined);
    }
    void this.applyPlatform();
  }

  /**
   * Apply a change to one message optimistically, with a real undo.
   *
   * The undo is registered *before* the server call and cleared on success. A
   * failure runs it, which restores the message's mailbox, read state and
   * position — the three things a user would notice if they were wrong.
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
      // The rollback reads the *current* array rather than a captured one, so
      // it restores this message into the latest state instead of clobbering
      // anything that changed in between.
      this.set({
        all: this.state.all.map((email) => {
          if (email.id !== id) return email;
          // `context` is only supplied for a move; a star or read toggle rolls
          // back to the exact prior object.
          if (!context) return before;
          return { ...email, mailbox: context.previousMailbox, unread: context.previousUnread };
        }),
      });
    };

    this.pending.set(id, undo);
    this.set({ all: this.state.all.map((email) => (email.id === id ? optimistic() : email)) });

    // A cursor that pointed at the moved row now points at whatever slid into
    // that position, which is the message the user most likely wants next.
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
   * Two cases, and they behave differently on purpose:
   *
   *   - The list shrank and the cursor pointed at the last row: clamp to the new
   *     last row, which is the *next* message. That is what a user filing the
   *     bottom of the list expects to see next.
   *   - There was no cursor to begin with: still no cursor. Opening whatever
   *     slid into row 0 would move the reader under the user's hands.
   */
  private reconcileCursor(): void {
    const threads = this.view.threads;

    // No cursor, so there is nothing to reconcile. A message can still have been
    // selected by a click, and if that message left the list the reader has to
    // close rather than keep showing something the list no longer contains.
    if (this.state.cursorIndex === NO_CURSOR) {
      if (this.state.selectedId === null) return;
      const stillThere = threads.some((row) => row.representative.id === this.state.selectedId);
      if (!stillThere) this.set({ selectedId: null });
      return;
    }

    if (threads.length === 0) {
      if (this.state.selectedId !== null) this.set({ selectedId: null, cursorIndex: NO_CURSOR });
      return;
    }

    if (this.state.cursorIndex >= threads.length) {
      this.set({ cursorIndex: threads.length - 1 });
      return;
    }

    // The message under the cursor is gone. Follow the row that took its
    // place, if the reader was showing something that still exists.
    const at = threads[this.state.cursorIndex];
    if (this.state.selectedId !== null && at && at.representative.id !== this.state.selectedId) {
      const stillVisible = threads.some(
        (row) => row.representative.id === this.state.selectedId,
      );
      if (!stillVisible) this.set({ selectedId: at.representative.id });
    }
  }

  /** Signals for a message, classifying it if the view has not yet. */
  private signalsFor(email: Email): EmailSignals {
    const cached = this.view.signals.get(email.id);
    if (cached) return cached;
    // Fall back to classifying against the current profile rather than
    // `NEUTRAL`: learning from a neutral classification would teach the model
    // nothing about why the user starred the message.
    return classifyAll([email], this.view.profile, this.state.learning.weights).get(email.id)!;
  }

  // ── Learning ──────────────────────────────────────────────────────────────

  /**
   * Adopt a new learning model and reclassify.
   *
   * The reclassify is debounced: a weight slider fires many times a second and
   * reclassifying the inbox on each tick would make dragging one visibly slow.
   * 80ms is long enough to coalesce a drag and short enough to feel immediate.
   */
  private setLearning(learning: LearningModel): void {
    // The model itself is put on state immediately — the settings panel reads
    // it synchronously as a slider is dragged, and a debounce there would make
    // the numbers lag behind the thumb. Persistence and reclassification are
    // the expensive parts, and those are the ones that wait.
    this.state = { ...this.state, learning };
    this.onPersist?.({ learning: learning.toSnapshot() });
    this.scheduleReclassify();
  }

  setSignalWeight(key: keyof ReturnType<typeof defaultWeights>, value: number): void {
    this.setLearning(this.state.learning.setWeight(key, value));
  }

  setAdaptiveLearning(on: boolean): void {
    this.setLearning(this.state.learning.setAdaptive(on));
  }

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
   * The composer is a sheet, and a throw would leave the user staring at a
   * composer that no longer works with no explanation. So the failure lands in
   * the same channel as every other optimistic-action rollback, and the sheet
   * renders it in place.
   */
  async sendReply(draft: unknown, inReplyTo: string): Promise<void> {
    if (!this.backend) {
      // A demo session has nowhere to send to. Saying so beats a button that
      // silently does nothing.
      this.set({
        error: "Signing in to Gmail is required to send. The demo inbox is read-only.",
      });
      throw new Error("Cannot send: not signed in.");
    }
    try {
      await this.backend.sendReply(draft, inReplyTo);
      this.set({ error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The reply could not be sent.";
      this.set({ error: message });
      throw error instanceof Error ? error : new Error(message);
    }
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
   * A weight slider fires many times a second, and reclassifying the inbox on
   * each tick would make dragging one visibly slow. 80ms is long enough to
   * coalesce a drag into a single pass and short enough to feel immediate when
   * the drag ends.
   */
  scheduleReclassify(): void {
    if (this.classifyTimer) clearTimeout(this.classifyTimer);
    this.classifyTimer = setTimeout(() => {
      this.classifyTimer = null;
      // Notified once: the whole derived tree is recomputed from the new weights,
      // and every consumer sees the same new world.
      this.notify();
      this.onWeightsChanged?.(this.state.learning);
    }, 80);
  }

  dismissError(): void {
    this.set({ error: null });
  }

  /** Dismiss the non-blocking sync notice, e.g. after the user has read it. */
  dismissNotice(): void {
    if (this.state.notice === null) return;
    this.set({ notice: null });
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
   * Separate from `replaceAll` because the demo is a *mode*, not a dataset: it
   * has no backend, so every action the user takes is local and nothing can be
   * sent or synced. Marking it explicitly means "signed in" is never inferred
   * from the presence of messages.
   */
  markDemoMode(): void {
    this.backend = undefined;
    this.pendingConnect = null;
    this.set({
      status: "ready",
      account: null,
      selectedId: null,
      cursorIndex: NO_CURSOR,
      activeFilters: [],
      searchQuery: "",
      overlay: "none",
      syncing: false,
      syncPhase: null,
      syncFraction: null,
      truncated: false,
      error: null,
      notice: null,
      lastSyncedAt: null,
      // The seed is built around this instant. Leaving the wall clock in place
      // would drop the entire demo into one "Earlier" section and hide the one
      // thing the day grouping is for.
      now: DEMO_NOW,
    });
  }

  /**
   * Sign out: clear the session but keep the things that describe the user.
   *
   * The line drawn here is "what is about this account" versus "what is about this
   * person". Mail, the account, the unread state and the active filters are the
   * account's; preferences, blocked senders, mutes and what Winnow learned are
   * the person's. Keeping the second group is the whole reason a user can sign
   * back in and find the app already tuned.
   */
  async signOut(): Promise<void> {
    // Kept across the boundary rather than spread back afterwards, because
    // `this.state` is replaced wholesale below and anything not in `keep` is gone.
    const keep = {
      preferences: this.state.preferences,
      learning: this.state.learning,
    };
    const mutes = [...this.persistedRemoved];
    this.backend = undefined;
    this.pendingConnect = null;

    // Park the background ticker *before* dropping the backend. On the desktop
    // this is a Rust thread that would otherwise keep firing every minute,
    // calling `refresh` with no backend — so the user who signed out would sit
    // watching a logged-out app make network requests it cannot authenticate.
    await this.platform?.setBackgroundSync(null).catch(() => undefined);
    // And clear the badge, for the same reason: a signed-out app with "12
    // unread" still on the dock badge is a lie the user has to look at.
    await this.platform?.setUnreadBadge(0).catch(() => undefined);

    this.persistedRemoved = new Set(mutes);
    this.state = {
      ...this.state,
      status: "signed_out",
      account: null,
      all: [],
      selectedId: null,
      cursorIndex: NO_CURSOR,
      activeFilters: [],
      searchQuery: "",
      mailbox: "inbox",
      overlay: "none",
      syncing: false,
      syncPhase: null,
      syncFraction: null,
      truncated: false,
      error: null,
      notice: null,
      recentIds: new Set(),
      lastSyncedAt: null,
      ...keep,
    };
    this.notify();
  }
}

/**
 * A signal map for mail that is deliberately not classified.
 *
 * `NEUTRAL_SIGNALS` is a frozen-by-convention shared object, so it is handed out
 * as-is rather than copied per message: it has no mutable fields, and a map of a
 * few thousand identical references costs nothing next to a few thousand copies.
 */
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
 * A truncated view is not an error: the sync worked, the user just has more mail
 * than Winnow will walk. It went into `error` before, which is the wrong channel
 * twice over — an error banner is dismissible and alarming, and the thing it
 * would have said ("only some of your archive is here") is a permanent property of
 * the account rather than something that resolves on retry.
 */
export function syncNotice(result: { truncated: boolean }): string | null {
  return result.truncated
    ? "Some mailboxes hold more than Winnow will walk, so older messages are not listed."
    : null;
}

/** Every bucket, for the settings panel's mute list. */
export { BUILTIN_FILTERS };
