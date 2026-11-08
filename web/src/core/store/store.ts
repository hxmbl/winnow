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

import { debugLog } from "../debug/debugLog";
import { OfflineDownloader, type DownloadProgress } from "../offline/downloader";
import { OFFLINE_UNAVAILABLE, offlineNextStep, type OfflineBackend } from "../offline/offlineSave";
import { demoRawSource } from "../mail/rawSource";
import {
  MAILBOX_LABEL,
  isBodyLoaded,
  isMailboxOrView,
  withLoadedBody,
  withCode,
  type Draft,
  type Email,
  type LoadedBody,
  type Mailbox,
} from "../model/email";
import { hashId } from "../model/ids";
import {
  FILTER_LABELS,
  filterKey,
  parseFilterKey,
  senderFilter,
  NAVIGATION_ITEMS,
  navigationIndexFor,
  clampIndex,
  isUnsafe,
  type EmailSignals,
  type FilterId,
  type NavigationItem,
} from "../model/signals";
import { type TrashRecord } from "../model/profile";
import { classifyEmail } from "../classify/classify";
import { matchesBuiltin } from "../classify/filters";
import { type SortBy } from "../classify/scoring";
import { LearningModel } from "../learn/learning";
import type { GoogleContact } from "../contacts/google";
import type { DraftsApi } from "../mail/drafts";
import {
  draftForKeptReply,
  notifiable,
  staleNotices,
  type KeptReply,
} from "../notify/notifications";
import {
  FilterLearning,
  builtInSays,
  LEARNABLE_FILTERS,
  type LearnableFilter,
} from "../learn/filterLearning";
import { workDomainsFromSent } from "../learn/workDomains";
import { explainFilters, type FilterReason } from "../learn/filterExplain";
import { DEMO_ACCOUNT, DEMO_NOW } from "../data/demo";
import { TaskCancelled, TaskQueue, type Priority } from "../gmail/pool";
import { keyedStorage, type KeyedStorage } from "./keyedStorage";
import {
  getEmailNicknames,
  type EmailNicknames,
  normalizeAddress,
  setNickname,
  persistEmailNicknames,
} from "./emailNicknames";
import {
  SnoozeOverlay,
  abandonedSnoozes,
  addSnooze,
  dueSnoozes,
  forgetAccountSnoozes,
  mergeSnoozes,
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
  forgetAccountSchedules,
  mergeSchedules,
  parseSchedules,
  removeSchedule,
  scheduleVerdict,
  scheduledRow,
  serializeSchedules,
  updateSchedule,
  type ScheduledSend,
} from "../mail/scheduledSend";
import { formatWhen } from "../mail/when";

import {
  CLAIM_HOLD_MS,
  DEFAULT_PREFERENCES,
  DRAFT_DISCARD_UNDO_MS,
  LATE_WAKE_MS,
  NO_CURSOR,
  PREFETCH_NEIGHBOURS,
  PREFETCH_UNREAD_TOP_N,
  UNDO_OFFER_MS,
  WAKE_FLASH_MS,
  type ContactsAccessState,
  type MailboxView,
  type Preferences,
  type Snapshot,
  type StoreState,
} from "./state";
import type {
  AccountState,
  AccountSummary,
  MailBackend,
  PersistPatch,
  PlatformBridge,
  StoreOptions,
} from "./types";
import { partitionBodies } from "./helpers/bodies";
import { MailboxSelectors } from "./selectors/mailbox";
import { SearchFacets } from "./selectors/search";
import { readoutIndex, rowIndexOf } from "./selectors/threads";

export * from "./state";
export * from "./types";
export { readoutIndex, rowIndexOf };

/**
 * How often the list's reference clock is refreshed.
 *
 * A minute: the coarsest thing it drives is a relative timestamp, and a store that
 * ticks faster than its own display resolution pays for nothing.
 */
const CLOCK_INTERVAL_MS = 60_000;

/**
 * Bodies in flight at once. Small on purpose: prefetch shares the quota bucket with
 * sync, and an opened message (high priority) must never wait behind more than this.
 */
const BODY_CONCURRENCY = 2;

/** At most how often sync progress re-renders. */
const PROGRESS_NOTIFY_MS = 500;

/** How long background-loaded bodies wait to be applied together, so a burst reclassifies once. */
const BODY_APPLY_DELAY_MS = 400;

/** A subscriber notified after any change. */
type Listener = () => void;

/** How a mutation can be undone. */
type Undo = () => void;

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

/**
 * The application store.
 *
 * Not a React store: it has no idea React exists, and `useSyncExternalStore` is the
 * only bridge — which is why the same class drives the desktop app, the web app and
 * the tests.
 */
export class WinnowStore {
  /** @internal Shared with the feature modules this class delegates to. */
  state: StoreState;
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
  /**
   * Messages whose new-mail notifications may be up, by account (`""` for none): the ones
   * this app announced, and the ones the platform says are up (`adoptNotifications`).
   * Every change to the mailbox checks them (`reconcileNotices`), so a notification goes
   * the moment its mail is read, archived, deleted, snoozed or moved, here or elsewhere.
   */
  private noticeWatch = new Map<string, Set<string>>();
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

  /** The background offline download of the open account, and the backend it is for. */
  private downloader: { backend: MailBackend; offline: OfflineBackend; run: OfflineDownloader } | null = null;

  /**
   * The binned senders, kept separately from the message list.
   *
   * A trash row carries only a sender address, deliberately: the discard is the signal,
   * and retaining the body of something the user binned is a privacy problem.
   */
  /** @internal Shared with the selectors that build the profile's inbox. */
  trashSenders: string[] = [];

  /** Email nicknames for the current account. */
  private emailNicknames: EmailNicknames = {};

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
  /**
   * The snoozes and sends as this window last read or wrote them: the `base` each save
   * merges against, so another window's entries written meanwhile are kept (STRM-290).
   */
  private snoozeBase: SnoozeState;
  private scheduleBase: readonly ScheduledSend[];

  constructor(options: StoreOptions = {}) {
    this.snoozeSlot = keyedStorage("snooze", options.storage);
    this.scheduleSlot = keyedStorage("scheduledSend", options.storage);
    this.backend = options.backend;
    this.platform = options.platform;
    this.seedContacts = options.seedContacts ?? [];
    this.trashSenders = (options.seedTrash ?? []).map((row) => row.sender);

    const seed = (options.seed ?? []).slice();
    this.snoozeBase = parseSnoozes(this.snoozeSlot.read());
    this.scheduleBase = parseSchedules(this.scheduleSlot.read());
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
      snoozes: this.snoozeBase,
      scheduled: this.scheduleBase,
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
      connectionLost: false,
      syncFailed: 0,
      lastSyncedAt: null,
      truncated: false,
      recentIds: new Set(),
      storagePrompt: null,
      offline: OFFLINE_UNAVAILABLE,
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
    return { ...this.state, filterLearning: this.learningModel(), view: this.deriveCached(), key: this.key };
  };

  /** The current view, for non-React callers (the keybind handler, tests). */
  get view(): MailboxView {
    return this.deriveCached();
  }

  /** `derive()`, at most once per version. See `derived`. */
  private deriveCached(): MailboxView {
    const cached = this.derived;
    if (cached && cached.version === this.version) return cached.view;
    const view = this.selectors.derive(this);
    this.derived = { version: this.version, view };
    return view;
  }

  /**
   * The derived view's memoised passes, kept in their own modules so this class reads
   * as a coordinator rather than a thousand lines of selector logic.
   */
  private readonly facets = new SearchFacets();
  private readonly selectors = new MailboxSelectors(this.facets);

  /** Load email nicknames for the given account. */
  public loadEmailNicknames(accountId: string | null): void {
    this.emailNicknames = accountId ? getEmailNicknames(accountId) : {};
  }

  /** Get the current email nicknames for the open account. */
  public getEmailNicknames(): EmailNicknames {
    return { ...this.emailNicknames };
  }

  /** Get a nickname for a specific address, trying the current account first. */
  public getNicknameForAddress(address: string): string | undefined {
    // First try the current account's nicknames
    const nickname = getEmailNicknames(this.state.accountId ?? null);
    const normalized = nickname[normalizeAddress(address)] ?? nickname[address];

    if (normalized) return normalized;

    // Fall back to stored nicknames if the API key is not available
    return this.emailNicknames[address] ?? this.emailNicknames[normalizeAddress(address)];
  }

  /** Set or update a nickname for an address in the current account's storage. */
  public setNicknameForAddress(address: string, nickname: string | null): void {
    const accountNicknames = getEmailNicknames(this.state.accountId ?? null);
    const updated = setNickname(accountNicknames, address, nickname);
    try { persistEmailNicknames(globalThis.localStorage, this.state.accountId ?? null, updated); } catch { return; }

    // Also update the local cache
    this.emailNicknames = updated;
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

  // ── Changing ──────────────────────────────────────────────────────────────

  /**
   * Apply a partial update and notify.
   *
   * The version bump is what `useSyncExternalStore` reads: `getSnapshot` returns a fresh
   * object each time, so a monotonically increasing key answers "did it change?" without
   * a deep comparison.
   */
  /** @internal */
  set(patch: Partial<StoreState>, persist?: PersistPatch): void {
    this.state = { ...this.state, ...patch };
    // Every reading of the mailbox (a sync, a partial, an optimistic change, the demo)
    // has the snoozes laid over it here, the one door `all` comes in by, so a snoozed
    // message can never flash back into the Inbox between a sync and a wake.
    if (patch.all !== undefined || patch.snoozes !== undefined || patch.account !== undefined) {
      const all = this.overlaid(this.state.all);
      if (all !== this.state.all) this.state = { ...this.state, all };
      this.reconcileNotices();
    }
    this.notify();
    if (persist) this.onPersist?.(persist);
  }

  // ── Notifications that dismiss themselves ─────────────────────────────────

  private watchKey(account: string | null = this.state.accountId): string {
    return account ?? "";
  }

  /** Watch these messages' notifications in the open account. */
  private watchNotices(gmailIds: Iterable<string>, account: string | null = this.state.accountId): void {
    const key = this.watchKey(account);
    const set = this.noticeWatch.get(key) ?? new Set<string>();
    for (const id of gmailIds) set.add(id);
    // Bounded: the oldest go first; a notification that old has long been dealt with.
    while (set.size > 500) set.delete(set.values().next().value as string);
    this.noticeWatch.set(key, set);
  }

  /**
   * Take down the open account's notifications whose mail the mailbox now shows needs
   * no attention (read, out of the Inbox, snoozed). Runs on every change to the mailbox:
   * the user's own action (open, mark read, archive, delete, snooze, move) and a sync
   * bringing in what happened on Gmail elsewhere.
   */
  private reconcileNotices(): void {
    if (!this.backend || !this.platform?.withdrawNotifications) return;
    const watched = this.noticeWatch.get(this.watchKey());
    if (!watched || watched.size === 0) return;
    const stale = staleNotices(watched, this.state.all);
    if (stale.length === 0) return;
    for (const id of stale) watched.delete(id);
    debugLog("notify", "dismissed", { messages: stale.length });
    void this.platform.withdrawNotifications(stale).catch(() => undefined);
  }

  /**
   * Watch the notifications the platform says are up (Android's background service posts
   * them while the app is closed), then dismiss any whose mail is already dealt with.
   */
  async adoptNotifications(): Promise<void> {
    if (!this.platform?.activeNotifications) return;
    const active = await this.platform.activeNotifications().catch(() => []);
    for (const { account, gmailId } of active) this.watchNotices([gmailId], account);
    this.reconcileNotices();
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
  /** @internal */
  trashRecords(): TrashRecord[] {
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
      mailbox: isMailboxOrView(saved.mailbox) ? saved.mailbox : this.state.mailbox,
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
    this.set({ snoozes: this.writeSnoozes(snoozes), ...extra });
  }

  /**
   * Write snoozes, merged first with what storage holds now: another window of the app
   * may have saved its own since this one read (STRM-290). Returns what was kept. The base
   * moves only when the write took, so a change storage refused is still this window's
   * own (added, not removed) at the next save.
   */
  private writeSnoozes(snoozes: SnoozeState): SnoozeState {
    const raw = this.snoozeSlot.read();
    const merged = raw === null ? snoozes : mergeSnoozes(this.snoozeBase, snoozes, parseSnoozes(raw));
    if (this.snoozeSlot.write(merged)) this.snoozeBase = merged;
    return merged;
  }

  /** Sends, written the same way as `writeSnoozes`. */
  private writeSchedules(scheduled: readonly ScheduledSend[]): { kept: ScheduledSend[]; stored: boolean } {
    const raw = this.scheduleSlot.read();
    const kept = raw === null ? [...scheduled] : mergeSchedules(this.scheduleBase, scheduled, parseSchedules(raw));
    const stored = this.scheduleSlot.write(serializeSchedules(kept));
    if (stored) this.scheduleBase = parseSchedules(serializeSchedules(kept));
    return { kept, stored };
  }

  /**
   * Take in what another window of the app wrote to the snooze and send-later records
   * (the platform calls this on a `storage` event for either key, and on focus), so this
   * window shows, wakes and sends what the other one added, and stops holding what it
   * removed. Changes of this window's own that storage has not taken are kept.
   */
  syncDeviceRecords(): void {
    const rawSnoozes = this.snoozeSlot.read();
    if (rawSnoozes !== null) {
      const theirs = parseSnoozes(rawSnoozes);
      const snoozes = mergeSnoozes(this.snoozeBase, this.state.snoozes, theirs);
      this.snoozeBase = theirs;
      if (JSON.stringify(snoozes) !== JSON.stringify(this.state.snoozes)) this.set({ snoozes });
    }
    const rawSchedules = this.scheduleSlot.read();
    if (rawSchedules !== null) {
      const theirs = parseSchedules(rawSchedules);
      const scheduled = mergeSchedules(this.scheduleBase, this.state.scheduled, theirs);
      this.scheduleBase = theirs;
      const same =
        JSON.stringify(serializeSchedules(scheduled)) === JSON.stringify(serializeSchedules(this.state.scheduled));
      if (!same) this.showSchedules(scheduled);
    }
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

  /** `false` when storage refused the write: the change then holds for this run only. */
  private saveSchedules(scheduled: ScheduledSend[]): boolean {
    const { kept, stored } = this.writeSchedules(scheduled);
    this.showSchedules(kept);
    return stored;
  }

  /** Put sends in state, letting go of an open Scheduled row whose send is gone. */
  private showSchedules(scheduled: ScheduledSend[]): void {
    const selectedGone =
      this.state.mailbox === "scheduled" &&
      this.state.selectedId !== null &&
      !scheduled.some((send) => scheduledRow(send, { email: "" }).id === this.state.selectedId);
    this.set({ scheduled, ...(selectedGone ? { selectedId: null } : {}) });
  }

  /**
   * Record a message to send later (replacing an earlier time for the same draft).
   * `false` when storage refused it: it is scheduled for this run only, so the caller
   * keeps the draft's device copy rather than leave the message only in memory.
   */
  scheduleSend(send: ScheduledSend): boolean {
    return this.saveSchedules(addSchedule(this.state.scheduled, send));
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
   * The send `id`, if it may go out now, checked right before it is dispatched (the
   * Send-later runner and Send now both ask): only a send listed under the open account,
   * and only while every account it names is still signed in here. One whose account is
   * gone is dropped here, never sent from another (`scheduleVerdict`).
   */
  permitScheduled(id: string): ScheduledSend | null {
    const send = this.state.scheduled.find((candidate) => candidate.id === id);
    if (!send) return null;
    const verdict = scheduleVerdict(send, {
      account: this.accountKey(),
      openId: this.state.accountId,
      accounts: this.state.accounts.filter((account) => !account.demo),
    });
    if (verdict === "drop") this.saveSchedules(removeSchedule(this.state.scheduled, id));
    return verdict === "send" ? send : null;
  }

  /**
   * Forget everything one account left in the shared snooze and send-later records (its
   * address, and sends going out from it by `id`): as it is signed out or removed, so no
   * copy of its messages, recipients or drafts outlives it, and none can wake or go if
   * the address is added again.
   */
  forgetAccountRecords(address: string, id?: string): void {
    const snoozes = forgetAccountSnoozes(this.state.snoozes, address);
    const scheduled = forgetAccountSchedules(this.state.scheduled, address, id);
    if (snoozes !== this.state.snoozes) this.saveSnoozes(snoozes);
    if (scheduled.length !== this.state.scheduled.length) this.saveSchedules(scheduled);
  }

  /**
   * Keep only the records of accounts the registry has (and the demo's): what an account
   * removed in a run that could not write the purge left behind. Judged only when every
   * account's address is known (a migrated account's is filled in on its first open),
   * and only for records tagged with an address.
   */
  keepAccountRecords(accounts: readonly { id: string; email: string }[]): void {
    // No registry to judge by (none yet, or one that did not load): leave them be. The
    // last account's sign-out already took its own (`signOut`).
    if (accounts.length === 0 || accounts.some((account) => !account.email.trim())) return;
    const known = new Set(accounts.map((account) => account.email.trim().toLowerCase()));
    const ids = new Set(accounts.map((account) => account.id));
    const orphan = (tag: string) => tag.includes("@") && !known.has(tag.trim().toLowerCase());
    const snoozes: SnoozeState = {
      snoozed: this.state.snoozes.snoozed.filter((r) => !orphan(r.account)),
      woke: this.state.snoozes.woke.filter((r) => !orphan(r.account)),
    };
    const scheduled = this.state.scheduled.filter(
      (send) => !orphan(send.account) && (send.from === undefined || ids.has(send.from)),
    );
    if (snoozes.snoozed.length !== this.state.snoozes.snoozed.length || snoozes.woke.length !== this.state.snoozes.woke.length) {
      this.saveSnoozes(snoozes);
    }
    if (scheduled.length !== this.state.scheduled.length) this.saveSchedules(scheduled);
  }

  /**
   * Claim a due send for this window, so a second window of the app does not send it
   * too: read what storage says now (another window may have claimed it a moment ago),
   * and write the claim. `false` when someone else holds it.
   */
  claimScheduled(id: string, now: number = this.now()): boolean {
    const raw = this.scheduleSlot.read();
    const stored = raw === null ? undefined : parseSchedules(raw).find((send) => send.id === id);
    // Stored once and gone now: another window sent or cancelled it since this one read.
    if (raw !== null && !stored && this.scheduleBase.some((send) => send.id === id)) {
      this.syncDeviceRecords();
      return false;
    }
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
  /**
   * The mailbox on screen is this account's own (its offline copy or a sync's result),
   * not the demo seed: only then can a sync that fails keep it on screen.
   */
  private accountMail = false;

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
    const started = Date.now();
    debugLog("sync", "start", { initial, cached: this.state.all.length });

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
          if (changed) debugLog("sync", "phase", { phase, stage, fetched: progress.fetched, total: progress.total ?? null, ms: Date.now() - started });
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
        connectionLost: false,
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

      this.accountMail = true;
      debugLog("sync", "done", {
        initial,
        ms: Date.now() - started,
        messages: result.emails.length,
        new: recent.size,
        failed: result.failed,
        truncated: Boolean(result.truncated),
        cacheUnpersisted: Boolean(result.cacheUnpersisted),
      });
      if (!initial) await this.notifyIfNew(recent);
      // Notifications posted while the app was away (Android's background service) whose
      // mail this sync shows dealt with go now.
      void this.adoptNotifications();
      // Mail that was here and is gone (deleted on the server, found by history or the
      // daily reconciliation) takes its notification with it.
      const present = new Set(result.emails.map((email) => email.gmailId));
      const vanished = [...known].filter((gmailId) => !present.has(gmailId));
      if (vanished.length > 0) {
        debugLog("sync", "removed", { messages: vanished.length });
        void this.platform?.withdrawNotifications?.(vanished).catch(() => undefined);
      }
      await this.applyPlatform();
      this.prefetchInbox();
      this.afterSyncOffline(backend, Boolean(result.cacheUnpersisted));
    } catch (error) {
      if (this.backend !== backend) return;
      debugLog("sync", "failed", {
        initial,
        ms: Date.now() - started,
        kind: error instanceof Error ? ((error as { kind?: unknown }).kind as string | undefined) ?? error.name : typeof error,
        status: typeof (error as { status?: unknown } | null)?.status === "number" ? (error as { status: number }).status : undefined,
        online: globalThis.navigator?.onLine,
        reason: error instanceof Error ? error.message : "unknown",
      });
      const message = error instanceof Error ? error.message : "Could not reach Gmail.";
      if (this.accountMail && this.state.all.length > 0 && !accountProblem(error)) {
        // Mail is on screen and nothing is wrong with the account: keep the local copy
        // usable instead of swapping the whole inbox for an error screen. The poll tries
        // again on its own; the first sync that gets through clears the bar.
        this.set({
          status: "ready",
          syncing: false,
          syncPhase: null,
          syncStage: null,
          syncTotal: null,
          syncError: message,
          connectionLost: true,
          error: null,
        });
        this.pendingConnect = null;
        return;
      }
      this.set({
        status: "error",
        syncing: false,
        syncPhase: null,
        syncStage: null,
        syncTotal: null,
        syncError: message,
        error: message,
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
    let saved: boolean;
    try {
      saved = (await backend?.persistCache?.()) ?? false;
    } catch {
      saved = false;
    }
    this.set({ storagePrompt: saved ? null : "failed" });
    // Save means the whole mailbox: the answer is remembered for this account and the
    // background download starts (or carries on).
    if (saved && backend && backend === this.backend && backend.offline) {
      backend.offline.setDecision("on");
      this.runOffline(backend);
    }
  }

  // ── Offline saving (core/offline/) ────────────────────────────────────────

  /** The downloader for `backend`, made on first use; another backend's is stopped. */
  private offlineFor(backend: MailBackend): OfflineDownloader | null {
    const offline = backend.offline;
    if (!offline) return null;
    if (this.downloader?.backend === backend) return this.downloader.run;
    this.stopOffline();
    const run = new OfflineDownloader({
      store: offline.store,
      source: {
        targets: () =>
          this.backend === backend ? this.state.all.map((email) => ({ gmailId: email.gmailId, receivedAt: email.receivedAt })) : [],
        body: async (gmailId) => {
          // The reader or a prefetch is already loading it: wait, then take the cache's copy.
          const email = this.state.all.find((candidate) => candidate.gmailId === gmailId);
          const inFlight = email ? this.bodyInFlight.get(email.id) : undefined;
          if (inFlight) await inFlight.catch(() => undefined);
          return offline.body(gmailId);
        },
        attachment: (gmailId, attachmentId) => offline.attachment(gmailId, attachmentId),
        gone: async (gmailId) => {
          await offline.gone([gmailId]);
          if (this.backend === backend) this.forgetGone([gmailId]);
        },
      },
      // The bodies queue at its lowest priority: an opened message always goes first.
      schedule: (task) => this.bodyQueue.push(task, "low"),
      conditions: () => this.platform?.downloadConditions?.() ?? null,
      onProgress: (progress) => {
        if (this.backend === backend) this.publishOffline(offline, progress);
      },
      log: (event, data) => debugLog("offline", event, data as Record<string, number | string>),
    });
    this.downloader = { backend, offline, run };
    return run;
  }

  private publishOffline(offline: OfflineBackend, progress: DownloadProgress | null): void {
    this.set({ offline: { available: true, decision: offline.decision(), progress } });
  }

  private stopOffline(): void {
    this.downloader?.run.stop();
    this.downloader = null;
  }

  /** Start (or resume) the download when the answer is yes; otherwise just the counts. */
  private runOffline(backend: MailBackend): void {
    const run = this.offlineFor(backend);
    const offline = backend.offline;
    if (!run || !offline) return;
    this.publishOffline(offline, run.progress().total > 0 ? run.progress() : this.state.offline.progress);
    if (offline.decision() === "on") void run.start();
    else void run.refreshCounts().catch(() => undefined);
  }

  /** After each sync: ask, save without asking (a small mailbox), or carry on as answered. */
  private afterSyncOffline(backend: MailBackend, unpersisted: boolean): void {
    const offline = backend.offline;
    if (!offline) {
      if (this.state.offline.available) this.set({ offline: OFFLINE_UNAVAILABLE });
      return;
    }
    const step = offlineNextStep(offline.decision(), this.state.all.length, { declined: this.storageDeclined, unpersisted });
    if (step === "save") offline.setDecision("on");
    if (step === "ask" && this.state.storagePrompt === null) this.set({ storagePrompt: "ask" });
    this.runOffline(backend);
  }

  /**
   * Settings → Offline mail: the same answer the storage question records. Off stops the
   * download and keeps what is saved; on starts it again.
   */
  setOfflineSave(on: boolean): void {
    const backend = this.backend;
    if (!backend?.offline) return;
    backend.offline.setDecision(on ? "on" : "off");
    if (on && this.state.storagePrompt !== null) this.set({ storagePrompt: null });
    if (!on) this.downloader?.run.stop();
    if (!on) this.downloader = null;
    this.runOffline(backend);
  }

  /** Settings → Remove downloads: every saved body and attachment goes, and saving turns off. */
  async removeOfflineDownloads(): Promise<void> {
    const backend = this.backend;
    if (!backend?.offline) return;
    backend.offline.setDecision("off");
    this.stopOffline();
    await backend.offline.store.clearDownloads().catch(() => undefined);
    debugLog("offline", "removed", {});
    if (this.backend === backend) this.runOffline(backend);
  }

  /** Messages Gmail says no longer exist: off the screen, out of the bodies, notifications down. */
  private forgetGone(gmailIds: readonly string[]): void {
    const gone = new Set(gmailIds);
    const all = this.state.all.filter((email) => !gone.has(email.gmailId));
    if (all.length === this.state.all.length) return;
    for (const email of this.state.all) {
      if (!gone.has(email.gmailId)) continue;
      this.bodies.delete(email.id);
      this.bodyChecked.delete(email.id);
    }
    this.set({ all });
    void this.platform?.withdrawNotifications?.(gmailIds).catch(() => undefined);
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
    this.watchNotices(arrived.map((email) => email.gmailId));
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

  /** The OS badge: the mailbox's unread count, less mail from muted senders; 0 when turned off. */
  badgeCount(): number {
    if (!this.state.preferences.unreadBadge) return 0;
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
  /** @internal */
  listedIn(visible: readonly Email[]): Email[] {
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

    // A single j/k on a fresh list starts at the corresponding end. Large moves
    // are boundary jumps, so they land on the boundary they cross toward.
    const cursor = this.state.cursorIndex;
    if (cursor === NO_CURSOR) {
      if (delta > 0) return delta >= length ? length - 1 : 0;
      if (delta < 0) return -delta >= length ? 0 : length - 1;
      return null;
    }
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
    // Every offer goes by itself after `UNDO_OFFER_MS` (sooner when its commit window
    // is shorter); before, an offer with no commit stayed on the pill until dismissed.
    const expiresAfterMs = commit && commitAfterMs !== undefined ? Math.min(commitAfterMs, UNDO_OFFER_MS) : UNDO_OFFER_MS;
    this.undoCommitTimer = setTimeout(() => {
      if (this.undoAction !== action) return;
      this.settleUndo();
      this.set({ undo: null });
    }, expiresAfterMs);
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
    return this.selectors.rawSignalsFor(this, email);
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
    this.stopOffline();
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
  /**
   * Dev Options → View Original: a message's raw source, from the backend's
   * `format=raw`, or built from the message where there is no server (the demo).
   * Rejects when the request fails; the caller says so.
   */
  async loadRawSource(id: number): Promise<{ raw: string; demo: boolean }> {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email) throw new Error("No such message");
    const backend = this.backend;
    if (backend?.fetchRaw) return { raw: await backend.fetchRaw(email.gmailId), demo: false };
    return { raw: demoRawSource({ ...email, bodyHtml: this.bodies.get(id) ?? email.bodyHtml }), demo: true };
  }

  hasLoadedBody(id: number): boolean {
    if (this.bodyChecked.has(id)) return true;
    if (!this.backend) return true;
    if (this.bodyInFlight.has(id)) return false;
    if (this.bodyFailed.has(id)) return true;
    const email = this.state.all.find((candidate) => candidate.id === id);
    return email?.bodyHtml !== undefined;
  }

  /** The body-bearing copy of a message, for the parts of the view that render one. */
  /** @internal */
  withBody(email: Email): Email {
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
    this.accountMail = false;
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
      connectionLost: false,
      syncFailed: 0,
      truncated: false,
      error: null,
      notice: null,
      storagePrompt: null,
      offline: OFFLINE_UNAVAILABLE,
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
    this.emailNicknames = getEmailNicknames(id);
    this.accountMail = cached.length > 0;
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
      mailbox: isMailboxOrView(saved.mailbox) ? saved.mailbox : "inbox",
      overlay: "none",
      syncing: false,
      undo: null,
      flash: null,
      syncPhase: null,
      syncFraction: null,
      syncStage: null,
      syncTotal: null,
      syncError: null,
      connectionLost: false,
      syncFailed: 0,
      truncated: false,
      error: null,
      notice: null,
      storagePrompt: null,
      offline: OFFLINE_UNAVAILABLE,
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
    let fetched: Email | null;
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
    // Every notification of the account's mail goes with it.
    const leavingId = this.backend ? this.state.accountId : null;
    if (this.backend) {
      this.noticeWatch.delete(this.watchKey(leavingId));
      void this.platform?.clearNotifications?.(leavingId).catch(() => undefined);
    }
    // Snoozes and scheduled sends name this account's mail, so they go with it (the
    // snoozed mail stays archived under its label in Gmail; a scheduled message stays a
    // draft there). The demo's are the demo's and stay.
    const leaving = this.backend ? this.accountKey() : null;
    if (leaving) {
      const snoozes = this.writeSnoozes(forgetAccountSnoozes(this.state.snoozes, leaving));
      const scheduled = this.writeSchedules(
        forgetAccountSchedules(this.state.scheduled, leaving, this.state.accountId ?? undefined),
      ).kept;
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
      connectionLost: false,
      syncFailed: 0,
      truncated: false,
      error: null,
      notice: null,
      storagePrompt: null,
      offline: OFFLINE_UNAVAILABLE,
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

  /**
   * The corrections as they are applied: `state.filterLearning` with the domains your
   * Sent mail shows are yours (`workDomains.ts`), so colleagues at a work domain never
   * share a domain rule even when the account is a personal one. Memoised on the
   * mailbox and the model, so it keeps its identity until either changes.
   */
  /** @internal */
  learningModel(): FilterLearning {
    return this.state.filterLearning.withWorkDomains(workDomainsFromSent(this.state.all));
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
    const { profile, signals } = this.selectors.inboxAnalysis(this);
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
    const { profile, signals } = this.selectors.inboxAnalysis(this);
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

  /**
   * "Why it's here" for one inbox message: one line per filter it is in. `scores` is
   * Dev Options → Show filter scores: each line also carries its numbers.
   */
  explainSmartFilters(id: number, { scores = false }: { scores?: boolean } = {}): FilterReason[] {
    const email = this.inboxEmail(id);
    if (!email) return this.explainInMailbox(id, scores);
    const explanation = this.selectors.explanationFor(this, email);
    if (!explanation) return [];
    return explainFilters(email, explanation.base, explanation.learned, explanation.profile, this.learningModel(), {
      background: explanation.background,
      weights: explanation.weights,
      scores,
    });
  }

  /**
   * "Why it's here" for a message in another mailbox (1.3.3): the same explanation, from
   * the classification that mailbox's smart filters use (`mailboxSignals`). Drafts have
   * none.
   */
  private explainInMailbox(id: number, scores: boolean): FilterReason[] {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email || email.mailbox === "inbox") return [];
    const { profile } = this.selectors.inboxAnalysis(this);
    const { background, weights } = this.selectors.background(this);
    const base = classifyEmail(email, profile, weights);
    const learned = this.selectors.mailboxSignals(this, [email], profile).get(id) ?? base;
    return explainFilters(email, base, learned, profile, this.learningModel(), {
      background,
      weights,
      scores,
    });
  }

  /** Whether the built-in rules alone would put this message in a filter. For tests and Settings. */
  builtInFilter(id: number, filter: LearnableFilter): boolean {
    const email = this.inboxEmail(id);
    const base = this.selectors.baseSignal(this, id);
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

/**
 * A sync failure that means the account itself needs attention, as opposed to Gmail
 * being out of reach. Only these keep the blocking "Couldn't reach Gmail" screen when
 * there is cached mail to show: a session that has to be signed in again, a build or
 * client Google rejects, or a request Google answered with 401 or 403.
 */
export function accountProblem(error: unknown): boolean {
  const { kind, status } = (error ?? {}) as { kind?: unknown; status?: unknown };
  if (kind === "reauth_required" || kind === "config" || kind === "invalid_client") return true;
  return status === 401 || status === 403;
}
