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
import { buildContactIndex, type ContactIndex } from "../contacts/index";
import type { GoogleContact } from "../contacts/google";
import { defaultWeights, type SignalWeights } from "../classify/weights";
import { DEMO_NOW } from "../data/demo";
import type { SyncProgress } from "../gmail/sync";

/** The five mailboxes, in the order the sidebar shows them. */
export const MAILBOX_ORDER: readonly Mailbox[] = ["inbox", "archive", "sent", "trash", "spam"];

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
    // Every message in the window counts as settled, not just the ones with HTML: the
    // sync already walked them all, so recording that stops the reader asking again
    // for a plain-text message it opens.
    checked.add(email.id);
    if (email.bodyHtml !== undefined) bodies.set(email.id, email.bodyHtml);
  }

  const stripped = emails.map((email) => {
    if (email.bodyHtml === undefined) return email;
    changed = true;
    return { ...email, bodyHtml: undefined };
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
  imagePolicy: "ask",
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

  account: { email: string } | null;

  /**
   * Google's address book, merged into the contact index. Empty until the user opts in.
   *
   * Replaced whole, never mutated, so the contact index can memoise on its identity.
   */
  googleContacts: readonly GoogleContact[];
  contactsAccess: ContactsAccessState;

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
   * `-1` means "no cursor", distinct from "on the first row": `j` on a fresh list
   * should start at the top and `k` at the bottom, which cannot be expressed if row 0
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
   * a muted pill: a muted bucket stays in the rail so it can be un-muted there, and a
   * pill with no marker is indistinguishable from an active one.
   */
  mutedFilters: readonly BuiltinSmartFilter[];

  syncing: boolean;
  /**
   * A single undo, offered by whatever can be taken back.
   *
   * `null` most of the time, and that is the point: an undo strip that is always on
   * screen is a banner, and a banner you cannot act on is noise. Only one action is
   * offered at a time, because the things that *do* have a natural inverse do not need
   * one — a star is a toggle, a move is answered by the message reappearing, a filter
   * has its own pill.
   *
   * Two things land here. "Mark everything in this mailbox read" is a single keystroke
   * (`⇧U`) with no window and no inverse, and on a mailbox with a thousand unread it is
   * the one mistake in triaging you cannot walk back. Muting a bucket is the other: the
   * muted pill is sorted to the *end* of the rail, so the pill the user just clicked
   * vanishes from a 27-pill strip they are unlikely to have scrolled. The mute is
   * reversible at the far end of the rail and in Settings, but neither is where someone
   * looks immediately after a click.
   */
  undo: { label: string } | null;
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
  /** The rail, with activated buckets hoisted above the volume ranking. */
  rail: BuiltinSmartFilter[];
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
  selected: Email | null;
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
  sync(options?: { onProgress?: (progress: SyncProgress) => void }): Promise<SyncOutcome>;
  toggleStar(id: number, starred: boolean): Promise<void>;
  moveToMailbox(id: number, mailbox: Mailbox): Promise<void>;
  setRead(id: number, read: boolean): Promise<void>;
  deletePermanently(id: number): Promise<void>;
  sendReply(draft: unknown, inReplyTo: string): Promise<void>;
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

/** How a mutation can be undone. */
type Undo = () => void;

export type StoreOptions = {
  /** Seed messages for demo mode. */
  seed?: readonly Email[];
  /** The demo's address book, so suggestions show the merge with no network. */
  seedContacts?: readonly GoogleContact[];
  seedTrash?: readonly TrashRecord[];
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

export type PersistPatch = {
  preferences?: Partial<Preferences>;
  learning?: ReturnType<LearningModel["toSnapshot"]>;
  activeFilters?: string[];
  mailbox?: Mailbox;
  /**
   * Buckets the user has silenced.
   *
   * Persisted with the rest of the "what you have told Winnow" state, because a mute is
   * a statement about the mail rather than about this session — the same argument the
   * blocked-sender list makes.
   */
  removedFilters?: string[];
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

  constructor(options: StoreOptions = {}) {
    this.backend = options.backend;
    this.platform = options.platform;
    this.seedContacts = options.seedContacts ?? [];
    this.trashSenders = (options.seedTrash ?? []).map((row) => row.sender);

    const seed = (options.seed ?? []).slice();
    this.state = {
      status: options.backend ? "loading" : "ready",
      error: null,
      notice: null,
      account: null,
      googleContacts: options.backend ? [] : this.seedContacts,
      contactsAccess: options.backend ? "unavailable" : "demo",
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
      undo: null,
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
   * `state.now` is latched, and every day section and relative timestamp is computed
   * against it. That is right for the demo and wrong for live mail: an app left open
   * overnight would still say its newest message arrived "2 minutes ago". So it is
   * refreshed on a slow tick; the store owns the timer because the store owns `now`.
   */
  startClock(): () => void {
    const tick = (): void => {
      // Demo mode keeps its fixed instant, which is what makes the seed's day sections
      // and timestamps deterministic.
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
    profile: UserProfile;
    signals: SignalMap;
  } | null = null;

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
      hit.blocked === blocked
    ) {
      return { profile: hit.profile, signals: hit.signals };
    }

    // Blocked senders excluded here for the same reason as `visible`: their volume must
    // not reach the engagement ranking.
    const blockedLower = new Set(blocked.map((s) => s.toLowerCase()));
    const inboxForProfile = all.filter(
      (email) => email.mailbox === "inbox" && !blockedLower.has(email.sender.toLowerCase()),
    );
    const profile = buildUserProfile(inboxForProfile, this.trashRecords());
    const signals = classifyAll(inboxForProfile, profile, weights);
    this.inboxCache = { all, weights, trash, blocked, profile, signals };
    return { profile, signals };
  }

  private derive(): MailboxView {
    const state = this.state;
    const blocked = new Set(state.preferences.blockedSenders.map((s) => s.toLowerCase()));

    // Blocked senders are hidden from every view, and before the profile is built, or
    // their volume would still push them up the engagement ranking.
    const visible = state.all.filter((email) => !blocked.has(email.sender.toLowerCase()));
    const mailboxEmails = visible.filter((email) => email.mailbox === state.mailbox);

    // The profile is built from the *inbox*, not the current mailbox: learning "who you
    // read" from an archive or a bin would teach it the wrong thing. Memoised; see
    // `inboxAnalysis`.
    const { profile, signals: inboxSignals } = this.inboxAnalysis();
    const inboxForProfile = visible.filter((email) => email.mailbox === "inbox");

    // The inbox is classified once and reused when the inbox is open — the common case.
    // Every *other* mailbox is left unclassified and rendered as `NEUTRAL_SIGNALS`:
    // classifying it and then applying the inbox's own filter rules is how the bin and
    // the spam folder ended up showing zero messages, since the rule that hides spam is
    // a rule about what belongs in your inbox. It is also the honest answer — a trashed
    // message is not "quiet personal mail", it is mail already dealt with.
    const signals =
      state.mailbox === "inbox"
        ? inboxSignals
        : neutralSignalsFor(mailboxEmails);

    // Only when a search is running. See `searchBags`: the pipeline builds a bag on
    // demand, so the unsearched case is a fast path, not a different code path.
    const searching = state.searchQuery.trim().length > 0;
    const searchBags = searching ? buildSearchBags(mailboxEmails) : new Map<number, string>();

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

    // The rail is ranked against the *inbox*, not the current view, so opening the bin
    // does not change which buckets are pinned. Mutes are read from the instance.
    const rail = rankFilters(
      inboxForProfile,
      inboxSignals,
      profile,
      this.persistedRemoved,
    );
    const railWithActive = this.orderedRail(rail, this.persistedRemoved);

    // The same inbox the rail was ranked against; see `inboxCounts`. A pill count is a
    // claim about the user's mail, not the current result set.
    const inboxCounts = countAllFilters(inboxForProfile, inboxSignals, profile);

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
      inboxCounts,
      inboxSenderCounts,
      selected,
      conversation,
      unreadCount: mailboxEmails.filter((email) => email.unread).length,
      totalCount: mailboxEmails.length,
      otherMailboxCount: visible.length - mailboxEmails.length,
      contacts: this.contacts(),
    };
  }

  /**
   * Buckets the user has silenced.
   *
   * On the instance rather than in `Preferences`: it is a classification input, not a
   * setting — it changes what the inbox *contains*, not how it looks.
   */
  private persistedRemoved = new Set<BuiltinSmartFilter>();

  /**
   * The rail's final order: the permanent pair leads, then activated buckets (in the
   * order they were turned on, *whether or not they match anything* — an empty active
   * bucket must keep its pill or a live filter is left with no control), then the
   * ranking, then muted buckets struck through so muting is reversible. Mutes take no
   * digit: a pill that prints a shortcut it ignores is the same lie as a badge in the
   * wrong colour.
   *
   * Ported from `legacy/swift-native/Sources/winnow/Store/WinnowStore.swift`, which
   * pins the permanent pair *before* hoisting actives; the order matters.
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

    // Catalog order is the fallback for an active bucket out of the ranking, so the pill
    // lands predictably rather than at random.
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
   * Separate from the rail because the settings panel also renders an "unhide" row per
   * bucket, so a mute is reversible from a place the user will look.
   */
  private mutedList(): BuiltinSmartFilter[] {
    return BUILTIN_FILTERS.filter((id) => this.persistedRemoved.has(id));
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
    for (const listener of this.listeners) listener();
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
      // Mutes are applied in the loop above, so the list is already correct.
      mutedFilters: this.mutedList(),
      preferences: { ...this.state.preferences, ...(saved.preferences ?? {}) },
      learning: saved.learning
        ? LearningModel.fromSnapshot(saved.learning)
        : this.state.learning,
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
    });
    await this.runSync({ initial: true });
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
    await this.runSync({ initial: false });
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
    });

    const known = new Set(this.state.all.map((email) => email.gmailId));

    try {
      const result = await backend.sync({
        onProgress: (progress) => {
          // Progress arrives on the engine's schedule, so it is written to state
          // *without* notifying: a first sync of two thousand messages would otherwise
          // re-render two thousand times to move a percentage. A phase change is
          // notified, being a visible transition rather than a per-message increment.
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

      const { emails, bodies, checked } = partitionBodies(result.emails);
      // Replaced wholesale rather than merged: a sync is a fresh reading, and a body
      // resident for a message that has since left is memory nobody is using.
      this.bodies = bodies;
      this.bodyChecked = checked;
      this.bodyFailed = new Set();

      this.set({
        status: "ready",
        all: emails,
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
    const arrived = this.state.all.filter((email) => recent.has(email.id));
    if (arrived.length === 0) return;
    await this.platform.notifyNewMail(arrived).catch(() => undefined);
  }

  /** Push badge count and sync cadence to the OS. */
  private async applyPlatform(): Promise<void> {
    if (!this.platform) return;
    const { preferences } = this.state;
    await this.platform.setUnreadBadge(this.view.unreadCount).catch(() => undefined);
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
    // being true.
    this.undoAction = null;
    this.set({ mailbox, selectedId: null, cursorIndex: NO_CURSOR, activeFilters: [], undo: null }, {
      mailbox,
      activeFilters: [],
    });
  }

  select(id: number | null): void {
    this.set({ selectedId: id });
  }

  /** Open the message at the cursor. */
  openCursor(): void {
    // Guarded explicitly, since `threads[-1]` is `undefined` with no cursor.
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
   * `j` and `k` open as they move, rather than moving a highlight and needing a
   * second keypress: in a two-pane client the reader is already on screen, so making
   * the user press `o` to fill it is two keystrokes to see what they asked for.
   */
  moveCursor(delta: number): void {
    const threads = this.view.threads;
    if (threads.length === 0) return;

    // With no cursor, "next" starts at the top and "previous" at the bottom, which is
    // what `j` or `k` on a fresh list expects.
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
    const visibleAt = this.view.threads.findIndex(
      (row) => row.representative.id === id,
    );
    if (visibleAt >= 0) {
      this.set({ cursorIndex: visibleAt, selectedId: id, overlay: "none" });
      return true;
    }

    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email) return false;

    // Clear what is hiding it, but keep the mailbox if the message is in it — switching
    // to where it lives is the point of following a link.
    if (email.mailbox !== this.state.mailbox) this.set({ mailbox: email.mailbox });
    this.set({
      activeFilters: [],
      searchQuery: "",
      selectedId: id,
      overlay: "none",
    });

    // The row index is only known after `set` re-derives the list, so the cursor is
    // placed by looking the id up again.
    const nowAt = this.view.threads.findIndex((row) => row.representative.id === id);
    this.set({ cursorIndex: nowAt >= 0 ? nowAt : NO_CURSOR });
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

    // A muted bucket cannot be re-activated by filtering: muting says the bucket is
    // over-firing, and letting a filter turn it back on would show exactly the messages
    // the user asked to stop seeing.
    //
    // `unsafe` is the deliberate exception — the one bucket the user goes to *on
    // purpose*, never filterable alongside anything else (see above). Muting it is
    // refused outright, so it can never be muted.
    if (filter.kind === "builtin" && this.persistedRemoved.has(filter.id)) return;

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
   * Mutes survive sign-out and reload, unlike filters: muting is a statement about the
   * mail, not the session, and a preference that resets on launch is not a preference.
   * The bucket stays in the rail, struck through, so the mute can be undone where it
   * was made; see `orderedRail`.
   *
   * The undo strip reads as redundant next to that until you watch the pill move:
   * `orderedRail` sorts muted buckets to the *end* — a muted pill is not filterable,
   * and leaving it in place would silently repoint every digit shortcut after it — so
   * the control the user clicked leaves a 27-pill strip they have probably not
   * scrolled, and the visible effect is that something disappeared. The strip says what
   * happened and puts the way back under the hand that did it.
   *
   * The undo is installed before anything changes, for the same reason `markAllRead`
   * does it: the strip must never render an offer with no handler. Taking it calls
   * `restoreFilter`, which is also what the pill's own ↺ calls, so there is one code
   * path back.
   */
  dismissFilter(filter: BuiltinSmartFilter): void {
    if (filter === "unsafe" || this.persistedRemoved.has(filter)) return;

    this.undoAction = () => this.restoreFilter(filter);
    this.persistedRemoved.add(filter);
    this.setFilters(
      this.state.activeFilters.filter(
        (f) => !(f.kind === "builtin" && f.id === filter),
      ),
    );

    // The rejection is about a *bucket*, not a message, so it is recorded without one:
    // attaching the open message would teach the model that this particular message was
    // a bad example, a much stronger claim than the user made.
    this.setLearning(this.state.learning.rejectFilter(filter, null, null, this.now()));
    // `FILTER_LABELS` rather than `filterLabel`: only a *builtin* can be muted, and
    // `filterLabel` takes a wider type, `FilterId`.
    //
    // No count, for the same reason "Marked everything in this mailbox as read" has
    // none: the pill the user just clicked was showing it a moment ago, and the strip's
    // job is to name what happened, not restate the rail.
    this.set({ undo: { label: `Hid ${FILTER_LABELS[filter]} from the inbox` } });
  }

  /**
   * Unmute a bucket.
   *
   * Also drops the undo offer, because this is what the offer's own handler calls:
   * leaving the strip up would leave a "Hid Newsletters" line with a button that does
   * nothing — the state the strip's field comment says must never happen. It is right
   * for the other caller too: someone who unmutes with the pill's own ↺ need not be
   * told how to unmute it again.
   */
  restoreFilter(filter: BuiltinSmartFilter): void {
    if (!this.persistedRemoved.delete(filter)) return;
    this.set(
      { mutedFilters: this.mutedList(), undo: null },
      { removedFilters: [...this.persistedRemoved] },
    );
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

  /**
   * Mark every message in the current mailbox read.
   *
   * The mailbox on screen, and only that one: clearing read state everywhere is both
   * a surprise — you were looking at the inbox while your archive went quiet — and a
   * divergence, because only the current mailbox's messages are pushed to the server,
   * so the rest would snap back on the next sync.
   *
   * The undo is the list of ids it touched, not a captured array: a rollback that
   * restored a stale snapshot would undo whatever else happened in between. It is
   * offered through `state.undo` rather than swallowed, because this is the only verb
   * in the app with no other way back.
   */
  markAllRead(): void {
    const mailbox = this.state.mailbox;
    const ids = new Set(
      this.state.all
        .filter((email) => email.mailbox === mailbox && email.unread)
        .map((email) => email.id),
    );
    if (ids.size === 0) return;

    // Captured before the state changes, so each id's *prior* flag is what comes back.
    // Only unread messages are in `ids`, so "prior" is uniformly `true` — recording it
    // per id keeps the rollback honest if this ever widens.
    const restore = new Map(this.state.all.filter((e) => ids.has(e.id)).map((e) => [e.id, e.unread]));

    // Installed before the state changes, so the strip can never render an offer with no
    // handler behind it.
    this.undoAction = () => {
      this.set({
        all: this.state.all.map((email) =>
          restore.has(email.id) ? { ...email, unread: restore.get(email.id)! } : email,
        ),
        undo: null,
      });
      for (const id of restore.keys()) {
        void this.backend?.setRead(id, true).catch(() => undefined);
      }
      void this.applyPlatform();
    };

    this.set({
      all: this.state.all.map((email) =>
        ids.has(email.id) ? { ...email, unread: false } : email,
      ),
      undo: { label: "Marked everything in this mailbox as read" },
    });

    for (const email of this.state.all) {
      if (ids.has(email.id)) this.backend?.setRead(email.id, true).catch(() => undefined);
    }
    void this.applyPlatform();
  }

  /** Take back the offered undo, if there is one. */
  undoLast(): void {
    const action = this.undoAction;
    if (!action) return;
    this.undoAction = null;
    action();
  }

  /** Drop the offered undo without taking it. */
  dismissUndo(): void {
    if (!this.undoAction) return;
    this.undoAction = null;
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
      return this.state.all.some(
        (email) => email.id === id && email.mailbox === this.state.mailbox,
      );
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
      const stillVisible = threads.some((row) => row.representative.id === id);
      if (!stillVisible && !openMessageSurvives()) this.set({ selectedId: at.representative.id });
    }
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
   * The composer is a sheet, and a bare throw would leave the user staring at a
   * composer that no longer works with no explanation. So the failure lands in the
   * same channel as every other optimistic-action rollback, and the sheet renders it.
   */
  async sendReply(draft: unknown, inReplyTo: string): Promise<void> {
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
      await this.backend.sendReply(draft, inReplyTo);
      this.set({ error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : "The reply could not be sent.";
      // Also surfaced app-wide, because this one *is* the app's problem rather than the
      // composer's: a network failure while sending is not the user's doing and will
      // recur on the next message.
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
  loadBody(id: number): Promise<void> {
    const existing = this.bodyInFlight.get(id);
    if (existing) return existing;
    if (this.bodyChecked.has(id)) return Promise.resolve();

    const backend = this.backend;
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!backend || !email) return Promise.resolve();

    this.bodyFailed.delete(id);
    const request = (async () => {
      try {
        const bodyHtml = await backend.fetchBody(email.gmailId);
        this.bodyChecked.add(id);
        if (bodyHtml !== undefined) this.bodies.set(id, bodyHtml);
      } catch {
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
    return request;
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
  markDemoMode(now: number = DEMO_NOW): void {
    this.backend = undefined;
    this.pendingConnect = null;
    this.undoAction = null;
    this.set({
      status: "ready",
      account: null,
      googleContacts: this.seedContacts,
      contactsAccess: "demo",
      selectedId: null,
      cursorIndex: NO_CURSOR,
      activeFilters: [],
      searchQuery: "",
      overlay: "none",
      syncing: false,
      undo: null,
      syncPhase: null,
      syncFraction: null,
      truncated: false,
      error: null,
      notice: null,
      lastSyncedAt: null,
      // The seed's reference instant (by default the fixed one; the app passes it moved
      // onto the real clock). The live wall clock would put the seed in "Earlier".
      now,
    });
  }

  /**
   * Sign out: clear the session but keep the things that describe the user.
   *
   * The line is "what is about this account" versus "what is about this person". Mail,
   * the account, the unread state and the active filters are the account's;
   * preferences, blocked senders, mutes and what Winnow learned are the person's.
   * Keeping the second group is why a user can sign back in and find the app tuned.
   */
  async signOut(): Promise<void> {
    // Kept across the boundary rather than spread back afterwards, since `this.state` is
    // replaced wholesale below and anything not in `keep` is gone.
    const keep = {
      preferences: this.state.preferences,
      learning: this.state.learning,
    };
    const mutes = [...this.persistedRemoved];
    this.backend = undefined;
    this.pendingConnect = null;
    this.undoAction = null;

    // Park the background ticker *before* dropping the backend: on the desktop it is a
    // Rust thread that would otherwise keep firing every minute, calling `refresh` with
    // no backend, so a signed-out app would keep making requests it cannot authenticate.
    await this.platform?.setBackgroundSync(null).catch(() => undefined);
    // And clear the badge for the same reason: "12 unread" on the dock of a signed-out
    // app is a lie the user has to look at.
    await this.platform?.setUnreadBadge(0).catch(() => undefined);

    this.persistedRemoved = new Set(mutes);
    this.state = {
      ...this.state,
      status: "signed_out",
      account: null,
      googleContacts: [],
      contactsAccess: "unavailable",
      all: [],
      selectedId: null,
      cursorIndex: NO_CURSOR,
      activeFilters: [],
      searchQuery: "",
      mailbox: "inbox",
      overlay: "none",
      syncing: false,
      undo: null,
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
 * `NEUTRAL_SIGNALS` is frozen by convention, so it is handed out as-is rather than
 * copied per message: it has no mutable fields, and a map of a few thousand identical
 * references costs nothing next to a few thousand copies.
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
 * A truncated view is not an error: the sync worked, the user just has more mail than
 * Winnow will walk. It went into `error` before, the wrong channel — an error banner is
 * dismissible and alarming, and "only some of your archive is here" is a permanent
 * property of the account, not something retry resolves.
 *
 * The cache notice is here for the same reason, and because silence was the
 * alternative that was tried: a mailbox too large for the origin's storage quota used
 * to discard the `QuotaExceededError` and carry on, so the app reported a healthy sync
 * while the offline cache had not been written once.
 */
export function syncNotice(result: { truncated: boolean; cacheUnpersisted?: boolean }): string | null {
  const notes: string[] = [];
  if (result.truncated) {
    notes.push("Some mailboxes hold more than Winnow will walk, so older messages are not listed.");
  }
  if (result.cacheUnpersisted) {
    notes.push("This mailbox is too large to save offline, so it will re-download next launch.");
  }
  return notes.length > 0 ? notes.join(" ") : null;
}

/** Every bucket, for the settings panel's mute list. */
export { BUILTIN_FILTERS };
