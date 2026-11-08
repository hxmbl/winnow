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
import {
  MAILBOX_LABEL,
  isMailboxOrView,
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
  type EmailSignals,
  type FilterId,
  type NavigationItem,
} from "../model/signals";
import { type TrashRecord } from "../model/profile";
import { type SortBy } from "../classify/scoring";
import { LearningModel } from "../learn/learning";
import type { GoogleContact } from "../contacts/google";
import type { DraftsApi } from "../mail/drafts";
import type { KeptReply } from "../notify/notifications";
import {
  FilterLearning,
  type LearnableFilter,
} from "../learn/filterLearning";
import { type FilterReason } from "../learn/filterExplain";
import { DEMO_ACCOUNT, DEMO_NOW } from "../data/demo";
import { TaskQueue, type Priority } from "../gmail/pool";
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
  forgetAccountSnoozes,
  parseSnoozes,
  type SnoozeRecord,
  type SnoozeState,
} from "../mail/snooze";
import {
  forgetAccountSchedules,
  parseSchedules,
  type ScheduledSend,
} from "../mail/scheduledSend";

import {
  DEFAULT_PREFERENCES,
  NO_CURSOR,
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
import { MailboxSelectors } from "./selectors/mailbox";
import { SearchFacets } from "./selectors/search";
import { readoutIndex, rowIndexOf } from "./selectors/threads";
import {
  builtInFilter,
  changeSmartFilters,
  claimFilterLearning,
  explainSmartFilters,
  learningModel,
  removeFilterSenderRule,
  resetFilterLearning,
  smartFilterMembership,
  type SmartFilterChange,
} from "./features/smart-filters";
import {
  resetLearning,
  scheduleReclassify,
  setLearning,
  setPreferences,
  setSortBy,
} from "./features/preferences";
import * as snoozeFeature from "./features/snooze";
import * as scheduledSendFeature from "./features/scheduled-send";
import * as notificationsFeature from "./features/notifications";
import * as draftsFeature from "./features/drafts";
import * as syncFeature from "./features/sync";
import * as bodiesFeature from "./features/bodies";
import * as undoFeature from "./features/undo";

export * from "./state";
export * from "./types";
export { readoutIndex, rowIndexOf };
export type { SmartFilterChange };

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

/** How long background-loaded bodies wait to be applied together, so a burst reclassifies once. */

/** A subscriber notified after any change. */
type Listener = () => void;

/** How a mutation can be undone. */
type Undo = () => void;

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
  /** Increases with every "Change smart filters…" action, so each action is one batch. */
  smartFilterBatch = 0;

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

  /** @internal Shared with feature modules that coordinate backend actions. */
  backend: MailBackend | undefined;
  /** @internal Shared with notification and account features. */
  platform: PlatformBridge | undefined;
  /**
   * Messages whose new-mail notifications may be up, by account (`""` for none): the ones
   * this app announced, and the ones the platform says are up (`adoptNotifications`).
   * Every change to the mailbox checks them (`reconcileNotices`), so a notification goes
   * the moment its mail is read, archived, deleted, snoozed or moved, here or elsewhere.
   */
  /** @internal Notifications currently owned by this app instance. */
  noticeWatch = new Map<string, Set<string>>();
  /** The demo's address book, restored whenever the demo is. */
  private readonly seedContacts: readonly GoogleContact[];

  /**
   * Resident HTML bodies, by message id. Bounded by `BODY_RETENTION`, and held apart
   * from `state.all` so attaching one cannot change `all`'s identity — see
   * `partitionBodies`.
   */
  /** @internal Resident HTML bodies, managed by sync and body features. */
  bodies = new Map<number, string>();

  /**
   * Messages whose body has been resolved either way.
   *
   * Separate from `bodies` because "fetched, no HTML part" and "not fetched yet" both
   * mean `bodies.has(id) === false`, and only the second should hit the network —
   * otherwise plain-text mail is refetched on every render.
   */
  /** @internal Body fetches settled without HTML. */
  bodyChecked = new Set<number>();

  /** In-flight body fetches, so opening the same message twice asks once. */
  /** @internal Coalesces duplicate body requests and lets offline storage await them. */
  bodyInFlight = new Map<number, Promise<void>>();
  /** Bodies whose last fetch failed. Not an answer (opening again retries), but the reader stops saying "Loading". */
  /** @internal Body fetches that may be retried on the next open. */
  bodyFailed = new Set<number>();

  /** Body fetches, opened-message first. See `BODY_CONCURRENCY`. */
  /** @internal Body downloads share a priority queue with offline storage. */
  bodyQueue = new TaskQueue(BODY_CONCURRENCY);

  /** Background-loaded bodies waiting to be applied to `state.all` in one pass. */
  /** @internal Background bodies waiting for a batched state update. */
  pendingBodies = new Map<number, LoadedBody>();
  /** @internal Batch timer for downloaded bodies. */
  bodyApplyTimer: ReturnType<typeof setTimeout> | null = null;

  /** "Not now" on the storage question, for the rest of this session. */
  /** @internal The user declined persistent offline storage for this session. */
  storageDeclined = false;

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
  /** @internal Optimistic mutation rollback handles. */
  pending = new Map<number, Undo>();

  /** Reclassify after a debounce, so a slider drag is not a reclassify per tick. */
  /** @internal */
  classifyTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * The offered undo's handler. On the instance rather than in `StoreState`, because a
   * function in the public snapshot would make the whole state object unserialisable.
   */
  /** @internal Current undo action managed by the undo feature. */
  undoAction: (() => void) | null = null;
  /**
   * What happens when the offered undo is let go rather than taken, for an action that
   * waits for that before it reaches Gmail (discarding a draft). Run when the offer is
   * dismissed, replaced, or left behind by a mailbox change; dropped, never run, by
   * sign-out and the demo, where keeping the draft is the safe side.
   */
  /** @internal Deferred commit managed by the undo feature. */
  undoCommit: (() => void) | null = null;
  /** The commit's deadline, so a forgotten strip does not hold a draft back for ever. */
  /** @internal Expiry timer managed by the undo feature. */
  undoCommitTimer: ReturnType<typeof setTimeout> | null = null;
  /** Drafts discarded with Undo still on offer: a listing landing meanwhile keeps them out. */
  /** @internal Drafts excluded from an in-flight listing until Undo settles. */
  pendingDiscards = new Set<string>();

  /** `winnow.snooze.v1` and `winnow.scheduledSend.v1`. */
  /** @internal Storage slots used by the extracted record features. */
  readonly snoozeSlot: KeyedStorage;
  /** @internal Storage slots used by the extracted record features. */
  readonly scheduleSlot: KeyedStorage;
  /** Lays the snoozes over every reading of the mailbox; see `set`. */
  private readonly snoozeOverlay = new SnoozeOverlay();
  /**
   * The snoozes and sends as this window last read or wrote them: the `base` each save
   * merges against, so another window's entries written meanwhile are kept (STRM-290).
   */
  /** @internal Shared with snooze and scheduled-send features. */
  snoozeBase: SnoozeState;
  /** @internal Shared with snooze and scheduled-send features. */
  scheduleBase: readonly ScheduledSend[];

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
  /** @internal Shared with the feature modules this class delegates to. */
  readonly selectors = new MailboxSelectors(this.facets);

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
      notificationsFeature.reconcileNotices(this);
    }
    this.notify();
    if (persist) this.onPersist?.(persist);
  }

  // ── Notifications that dismiss themselves ─────────────────────────────────

  private watchKey(account: string | null = this.state.accountId): string {
    return account ?? "";
  }

  async adoptNotifications(): Promise<void> {
    return notificationsFeature.adoptNotifications(this);
  }

  /**
   * Tell every subscriber the world moved.
   *
   * Split out of `set` because the sync engine's progress callback needs to advance
   * state without notifying on every message it downloads.
   */
  /** @internal */
  notify(): void {
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
  /** @internal */
  onPersist: ((patch: PersistPatch) => void) | undefined;
  /** @internal */
  onWeightsChanged: ((model: LearningModel) => void) | undefined;

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
  /** @internal Connection retained for Retry. */
  pendingConnect: { backend: MailBackend; account: { email: string } } | null = null;

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

  /** @internal Cache owned by the snooze feature. */
  snoozedCache: { snoozes: SnoozeState; account: string; map: Map<string, SnoozeRecord> } | null = null;

  /** This account's snoozes, by Gmail id. */
  private snoozedMap(): Map<string, SnoozeRecord> {
    return snoozeFeature.snoozedMap(this);
  }

  /** A Snoozed row's copy of each message, stable per message object. */
  /** @internal Cache owned by the snooze feature. */
  readonly snoozedRowCache = new WeakMap<Email, Email>();

  /** The Snoozed view: the archived messages this device is holding, each with its wake time. */
  private snoozedRows(visible: readonly Email[]): Email[] {
    return snoozeFeature.snoozedRows(this, visible);
  }

  /** @internal Cache owned by the scheduled-send feature. */
  scheduledCache: { sends: readonly ScheduledSend[]; account: string; self: string; rows: Email[] } | null = null;

  /** The Scheduled view's rows, one per send of this account. */
  private scheduledRows(): Email[] {
    return scheduledSendFeature.scheduledRows(this);
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
    snoozeFeature.saveSnoozes(this, snoozes, extra);
  }

  private writeSnoozes(snoozes: SnoozeState): SnoozeState {
    return snoozeFeature.writeSnoozes(this, snoozes);
  }

  private writeSchedules(scheduled: readonly ScheduledSend[]): { kept: ScheduledSend[]; stored: boolean } {
    return scheduledSendFeature.writeSchedules(this, scheduled);
  }

  /**
   * Take in what another window of the app wrote to the snooze and send-later records
   * (the platform calls this on a `storage` event for either key, and on focus), so this
   * window shows, wakes and sends what the other one added, and stops holding what it
   * removed. Changes of this window's own that storage has not taken are kept.
   */
  syncDeviceRecords(): void {
    snoozeFeature.syncSnoozesFromStorage(this);
    scheduledSendFeature.syncSchedulesFromStorage(this);
  }

  /** Whether a message is snoozed on this device for the current account. */
  isSnoozed(gmailId: string): boolean {
    return snoozeFeature.isSnoozed(this, gmailId);
  }

  /** The snooze holding a message, for the reader's "Snoozed until …". */
  snoozeFor(gmailId: string): SnoozeRecord | null {
    return snoozeFeature.snoozeFor(this, gmailId);
  }

  /**
   * Snooze the conversations of `ids` until `wakeAt`: each conversation's Inbox messages
   * leave the Inbox now (archived, with the `Winnow/Snoozed` label) and come back at the
   * time, unread, at the top. From the Inbox, the Archive, or Snoozed (a new time). One
   * Undo for all of them, in the status pill. Returns how many conversations it snoozed.
   */
  snooze(ids: Iterable<number>, wakeAt: number, { undo = true }: { undo?: boolean } = {}): number {
    return snoozeFeature.snooze(this, ids, wakeAt, { undo });
  }

  private forgetSnoozed(gmailIds: readonly string[]): void {
    snoozeFeature.forgetSnoozed(this, gmailIds);
  }

  unsnooze(ids: Iterable<number>): number {
    return snoozeFeature.unsnooze(this, ids);
  }

  wakeDue(): number {
    return snoozeFeature.wakeDue(this);
  }

  /** This account's scheduled sends, soonest first. */
  scheduledSends(): ScheduledSend[] {
    return scheduledSendFeature.scheduledSends(this);
  }

  scheduledSend(idOrRow: string | number): ScheduledSend | null {
    return scheduledSendFeature.scheduledSend(this, idOrRow);
  }

  private saveSchedules(scheduled: ScheduledSend[]): boolean {
    return scheduledSendFeature.saveSchedules(this, scheduled);
  }

  scheduleSend(send: ScheduledSend): boolean {
    return scheduledSendFeature.scheduleSend(this, send);
  }

  cancelSchedule(id: string): ScheduledSend | null {
    return scheduledSendFeature.cancelSchedule(this, id);
  }

  updateScheduled(id: string, patch: Partial<Pick<ScheduledSend, "claimedAt" | "problem" | "sendAt" | "draftId">>): void {
    scheduledSendFeature.updateScheduled(this, id, patch);
  }

  permitScheduled(id: string): ScheduledSend | null {
    return scheduledSendFeature.permitScheduled(this, id);
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
    return scheduledSendFeature.claimScheduled(this, id, now);
  }

  // ── Drafts ────────────────────────────────────────────────────────────────

  /** Drafts listings, one at a time; a second request while one runs waits for it. */
  /** @internal Shared with the drafts feature. */
  draftsInFlight: Promise<void> | null = null;
  /** Bumped by sign-out and the demo, so a listing landing afterwards is dropped. */
  /** @internal Invalidates draft listings when the open account changes. */
  draftsGeneration = 0;

  /**
   * List the user's Gmail drafts into the Drafts mailbox. A no-op in the demo, whose
   * drafts are seeded and edited locally. A failure is a notice, not an error state:
   * the rows already listed stay.
   */
  refreshDrafts(): Promise<void> {
    return draftsFeature.refreshDrafts(this);
  }

  draftRow(id: number): Email | null {
    return draftsFeature.draftRow(this, id);
  }

  putDraftRow(row: Email): void {
    draftsFeature.putDraftRow(this, row);
  }

  removeDraftRow(draftId: string): void {
    draftsFeature.removeDraftRow(this, draftId);
  }

  discardDrafts(ids: Iterable<number>): Promise<void> {
    return draftsFeature.discardDrafts(this, ids);
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
  /** @internal Whether this account has an on-screen mailbox to keep after a transient sync failure. */
  accountMail = false;

  private runSync({ initial }: { initial: boolean }): Promise<void> {
    return syncFeature.runSync(this, { initial });
  }

  /** @internal Publishes the inbox-first partial result from a sync. */
  applyPartial(emails: Email[], initial: boolean): void {
    syncFeature.applyPartial(this, emails, initial);
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

  /** @internal Stops offline body work when the account leaves. */
  stopOffline(): void {
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
  /** @internal Applies the offline-cache policy after sync. */
  afterSyncOffline(backend: MailBackend, unpersisted: boolean): void {
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
  /** @internal Called when a sync finds new mail. */
  async notifyIfNew(recent: ReadonlySet<number>): Promise<void> {
    return notificationsFeature.notifyIfNew(this, recent);
  }

  async notificationReplyHeads(emails: readonly Email[]): Promise<Record<string, string>> {
    return notificationsFeature.notificationReplyHeads(this, emails);
  }

  async saveKeptReplies(kept: readonly KeptReply[]): Promise<{ saved: number; failed: KeptReply[] }> {
    return notificationsFeature.saveKeptReplies(this, kept);
  }

  badgeCount(): number {
    return notificationsFeature.badgeCount(this);
  }

  /** Push badge count and sync cadence to the OS. */
  /** @internal */
  async applyPlatform(): Promise<void> {
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
  /** @internal Shared with badge notification calculations. */
  isListed(email: Email): boolean {
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
    undoFeature.undoLast(this);
  }

  offerUndo(
    label: string,
    action: () => void,
    options: { commit?: () => void; commitAfterMs?: number } = {},
  ): void {
    undoFeature.offerUndo(this, label, action, options);
  }

  private settleUndo(): void {
    undoFeature.settleUndo(this);
  }

  private dropUndo(): void {
    undoFeature.dropUndo(this);
  }

  moveWithUndo(id: number, mailbox: Mailbox): void {
    undoFeature.moveWithUndo(this, id, mailbox);
  }

  archiveWithUndo(ids: Iterable<number>): void {
    undoFeature.archiveWithUndo(this, ids);
  }

  trashWithUndo(ids: Iterable<number>): void {
    undoFeature.trashWithUndo(this, ids);
  }

  moveManyWithUndo(ids: Iterable<number>, mailbox: Mailbox): void {
    undoFeature.moveManyWithUndo(this, ids, mailbox);
  }

  discardDraftWithUndo(id: number): void {
    undoFeature.discardDraftWithUndo(this, id);
  }

  dismissUndo(): void {
    undoFeature.dismissUndo(this);
  }

  /**
   * Apply a change to one message optimistically, with a real undo.
   *
   * The undo is registered *before* the server call and cleared on success; a failure
   * runs it, restoring the message's mailbox, read state and position — the three
   * things a user would notice if they were wrong.
   */
  /** @internal Shared with message and snooze feature modules. */
  mutate(
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

  /** Adopt a new learning model and reclassify (debounced). */
  /** @internal */
  setLearning(learning: LearningModel): void {
    setLearning(this, learning);
  }

  /** "Reset sorting": back to the shipped weights. The feedback log is kept. */
  resetLearning(): void {
    resetLearning(this);
  }

  // ── Preferences ───────────────────────────────────────────────────────────

  setPreferences(patch: Partial<Preferences>): void {
    setPreferences(this, patch);
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
    setSortBy(this, sortBy);
  }

  setSearchQuery(searchQuery: string): void {
    this.set({ searchQuery });
  }

  /** Coalesce a burst of weight changes into one reclassification. */
  scheduleReclassify(): void {
    scheduleReclassify(this);
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
    return bodiesFeature.loadBody(this, id, priority);
  }

  prefetchBodies(ids: readonly number[]): void {
    bodiesFeature.prefetchBodies(this, ids);
  }

  private dropBodyWork(): void {
    bodiesFeature.dropBodyWork(this);
  }

  prefetchInbox(): void {
    bodiesFeature.prefetchInbox(this);
  }

  async loadRawSource(id: number): Promise<{ raw: string; demo: boolean }> {
    return bodiesFeature.loadRawSource(this, id);
  }

  hasLoadedBody(id: number): boolean {
    return bodiesFeature.hasLoadedBody(this, id);
  }

  withBody(email: Email): Email {
    return bodiesFeature.withBody(this, email);
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

  /** @internal Called when an account connects, so its corrections are its own. */
  private claimFilterLearning(email: string): void {
    claimFilterLearning(this, email);
  }

  /** @internal Shared with the selectors and features. */
  learningModel(): FilterLearning {
    return learningModel(this);
  }

  smartFilterMembership(ids: readonly number[]): Map<LearnableFilter, "all" | "some" | "none"> {
    return smartFilterMembership(this, ids);
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
    return changeSmartFilters(this, ids, changes);
  }

  /**
   * "Why it's here" for one inbox message: one line per filter it is in. `scores` is
   * Dev Options → Show filter scores: each line also carries its numbers.
   */
  explainSmartFilters(id: number, { scores = false }: { scores?: boolean } = {}): FilterReason[] {
    return explainSmartFilters(this, id, { scores });
  }

  /** Whether the built-in rules alone would put this message in a filter. For tests and Settings. */
  builtInFilter(id: number, filter: LearnableFilter): boolean {
    return builtInFilter(this, id, filter);
  }

  removeFilterSenderRule(filter: LearnableFilter, key: string): void {
    removeFilterSenderRule(this, filter, key);
  }

  /** "Reset what's learnt", for one filter or all of them. */
  resetFilterLearning(filter?: LearnableFilter): void {
    resetFilterLearning(this, filter);
  }
}

export { accountProblem, syncFailureSummary, syncNotice } from "./features/sync";

export { undoLabel } from "./features/undo";
