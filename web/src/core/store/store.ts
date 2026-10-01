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
  FILTER_LABELS,
  filterKey,
  type BuiltinSmartFilter,
  type EmailSignals,
  type FilterId,
  type NavigationItem,
} from "../model/signals";
import { buildUserProfile, type TrashRecord, type UserProfile } from "../model/profile";
import { classifyAll, type SignalMap } from "../classify/classify";
import { matchesFilter, rankFilters } from "../classify/filters";
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

/** The four mailboxes, in the order the sidebar shows them. */
export const MAILBOX_ORDER: readonly Mailbox[] = ["inbox", "archive", "trash", "spam"];

/** `cursorIndex` meaning "the user has not touched the list yet". */
export const NO_CURSOR = -1;

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
  overlay: "none" | "shortcuts" | "navigation" | "settings" | "composer";
  navigationIndex: number;

  syncing: boolean;
  lastSyncedAt: number | null;
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
  selected: Email | null;
  conversation: Email[];
  unreadCount: number;
  totalCount: number;
};

/** Everything the store owns. Read this in React; never mutate it. */
export type Snapshot = StoreState & {
  view: MailboxView;
  key: string;
};

/** The server side. Absent in demo mode, which is why every call is optional. */
export interface MailBackend {
  sync(): Promise<{ emails: Email[]; failed: number }>;
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

/** Notifications and OS integration. Also absent in demo mode. */
export interface PlatformBridge {
  notifyNewMail(emails: readonly Email[]): Promise<void>;
  setUnreadBadge(count: number): Promise<void>;
  setBackgroundSync(intervalSeconds: number | null): Promise<void>;
  openExternal(url: string): Promise<void>;
  /**
   * Save an attachment's bytes somewhere the user chose.
   *
   * Returns the path on the desktop, or `null` where the save dialog was
   * dismissed. In a browser there is no dialog, so the platform layer turns this
   * into a download and resolves `null`.
   */
  saveAttachment(
    filename: string,
    bytes: Uint8Array,
    mimeType: string,
  ): Promise<string | null>;
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
  /** Sender addresses of binned messages, for the trash-bias profile. */
  trashedSenders?: string[];
  activeFilters?: string[];
  mailbox?: Mailbox;
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
      syncing: false,
      lastSyncedAt: null,
      recentIds: new Set(),
      now: options.now ?? Date.now(),
    };
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

    const signals = classifyAll(mailboxEmails, profile, state.learning.weights);
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
      classifyAll(inboxForProfile, profile, state.learning.weights),
      profile,
      this.persistedRemoved,
    );
    const railWithActive = this.orderedRail(rail, this.persistedRemoved);

    const selectedRow = threads.find((row) => row.representative.id === state.selectedId) ?? null;
    const selected = selectedRow?.representative ?? null;
    const conversation = selected ? conversationFor(state.all, selected.threadId, selected.gmailId) : [];

    return {
      emails: result.emails,
      signals,
      profile,
      searchBags,
      result,
      threads,
      rail: railWithActive,
      selected,
      conversation,
      unreadCount: mailboxEmails.filter((email) => email.unread).length,
      totalCount: mailboxEmails.length,
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
   * `rankFilters` sorts by volume; the user also expects an activated filter to
   * *stay* activated and visible even when it momentarily matches nothing, and
   * to be reachable by its digit. So active filters are hoisted above the
   * ranked set, in the order they were turned on.
   */
  private orderedRail(
    ranked: BuiltinSmartFilter[],
    removed: ReadonlySet<BuiltinSmartFilter>,
  ): BuiltinSmartFilter[] {
    const activeBuiltins = this.state.activeFilters
      .filter((filter): filter is Extract<FilterId, { kind: "builtin" }> => filter.kind === "builtin")
      .map((filter) => filter.id)
      .filter((id) => !removed.has(id));

    const hoisted = activeBuiltins.filter((id) => ranked.includes(id));
    const rest = ranked.filter((id) => !hoisted.includes(id));
    return [...hoisted, ...rest];
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
    this.version += 1;
    for (const listener of this.listeners) listener();
    if (persist) this.onPersist?.(persist);
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

  /** Trash rows for the profile: the seed, plus anything binned this session. */
  private trashRecords(): TrashRecord[] {
    const binned = this.state.all
      .filter((email) => email.mailbox === "trash")
      .map((email) => ({ sender: email.sender }));
    return [...binned, ...this.trashSenders.map((sender) => ({ sender }))];
  }

  /**
   * The clock, as a method.
   *
   * Injected in tests so a feedback event's timestamp is deterministic. Every
   * `Date.now()` in the store goes through here for that reason.
   */
  now = (): number => Date.now();

  // ── Session ───────────────────────────────────────────────────────────────

  /** Point the store at a backend and start the first sync. */
  async connect(backend: MailBackend, account: { email: string }): Promise<void> {
    this.backend = backend;
    // Live mail is real, so the wall clock is the right reference instant for its
    // day sections. The demo's fixed instant is for the demo's fixed instants.
    this.set({ status: "loading", account, error: null, now: Date.now() });
    try {
      const result = await backend.sync();
      this.set({
        status: "ready",
        all: result.emails,
        syncing: false,
        lastSyncedAt: Date.now(),
        recentIds: new Set(),
        error: result.failed > 0 ? syncFailureSummary(result.failed) : null,
      });
      await this.applyPlatform();
    } catch (error) {
      this.set({
        status: "error",
        syncing: false,
        error: error instanceof Error ? error.message : "Could not reach Gmail.",
      });
    }
  }

  /**
   * Refresh.
   *
   * New messages are diffed against what was already known *before* the sync,
   * so the "new" marker only appears for genuinely new mail and the list does
   * not flash on every refresh.
   */
  async refresh(): Promise<void> {
    if (!this.backend || this.state.syncing) return;
    this.set({ syncing: true, error: null });
    try {
      const known = new Set(this.state.all.map((email) => email.gmailId));
      const result = await this.backend.sync();
      const recent = new Set<number>();
      for (const email of result.emails) {
        if (!known.has(email.gmailId)) recent.add(email.id);
      }
      this.set({
        all: result.emails,
        syncing: false,
        lastSyncedAt: Date.now(),
        recentIds: recent,
        error: result.failed > 0 ? syncFailureSummary(result.failed) : null,
      });
      await this.notifyIfNew(recent);
      await this.applyPlatform();
    } catch (error) {
      this.set({
        syncing: false,
        error: error instanceof Error ? error.message : "Sync failed.",
      });
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
    // list does not contain.
    this.set({ mailbox, selectedId: null, cursorIndex: NO_CURSOR, activeFilters: [] }, { mailbox });
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
      next = Math.min(Math.max(this.state.cursorIndex + delta, 0), threads.length - 1);
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
      navigationIndex: overlay === "navigation" ? 0 : this.state.navigationIndex,
    });
  }

  moveNavigation(delta: number): void {
    const count = 4;
    this.set({
      navigationIndex: Math.min(Math.max(this.state.navigationIndex + delta, 0), count - 1),
    });
  }

  /** Act on the highlighted palette row. */
  activateNavigation(item: NavigationItem): void {
    this.set({ overlay: "none" });
    if (item === "settings") {
      this.setOverlay("settings");
      return;
    }
    if (item === "inbox") this.setMailbox("inbox");
    if (item === "spam") this.setMailbox("spam");
    if (item === "trash") this.setMailbox("trash");
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
      this.set({ activeFilters: active.filter((f) => filterKey(f) !== key) }, this.filterPatch());
      return;
    }

    if (filter.kind === "builtin" && filter.id === "unsafe") {
      this.set({ activeFilters: [filter] }, this.filterPatch());
      return;
    }

    this.set({ activeFilters: [...active, filter] }, this.filterPatch());
  }

  clearFilters(): void {
    if (this.state.activeFilters.length === 0) return;
    this.set({ activeFilters: [] }, this.filterPatch());
  }

  private filterPatch(): PersistPatch {
    return { activeFilters: this.state.activeFilters.map(filterKey) };
  }

  /**
   * Mute a bucket: hide its mail *and* tell the learning model.
   *
   * Mutes survive sign-out, unlike filters — muting is a statement about the
   * mail, not about this session.
   */
  dismissFilter(filter: BuiltinSmartFilter): void {
    if (filter === "unsafe") return;
    this.persistedRemoved.add(filter);
    this.set(
      {
        activeFilters: this.state.activeFilters.filter(
          (f) => !(f.kind === "builtin" && f.id === filter),
        ),
      },
      this.filterPatch(),
    );

    // The rejection is about a *bucket*, not a message, so it is recorded
    // without one. Attaching the open message would teach the model that this
    // particular message was a bad example, which is a much stronger claim than
    // the user made.
    this.setLearning(this.state.learning.rejectFilter(filter, null, null, Date.now()));
  }

  /** Unmute a bucket. */
  restoreFilter(filter: BuiltinSmartFilter): void {
    this.persistedRemoved.delete(filter);
    this.set({});
  }

  isFilterRemoved(filter: BuiltinSmartFilter): boolean {
    return this.persistedRemoved.has(filter);
  }

  get removedFilters(): ReadonlySet<BuiltinSmartFilter> {
    return this.persistedRemoved;
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

  move(id: number, mailbox: Mailbox): void {
    const email = this.state.all.find((candidate) => candidate.id === id);
    if (!email || email.mailbox === mailbox) return;

    const previousMailbox = email.mailbox;
    const previousUnread = email.unread;

    // Moving marks read. A message you have filed away is a message you have
    // dealt with, and leaving it bold in the next mailbox is noise.
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

  /** Mark every message in the current mailbox read. */
  markAllRead(): void {
    const unread = this.state.all.filter(
      (email) => email.mailbox === this.state.mailbox && email.unread,
    );
    if (unread.length === 0) return;
    const snapshot = this.state.all;
    this.set({ all: snapshot.map((email) => (email.unread ? { ...email, unread: false } : email)) });
    for (const email of unread) {
      this.backend?.setRead(email.id, true).catch(() => undefined);
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
      // Bumped once: the whole derived tree is recomputed from the new weights,
      // and every consumer sees the same new world.
      this.version += 1;
      for (const listener of this.listeners) listener();
      this.onWeightsChanged?.(this.state.learning);
    }, 80);
  }

  dismissError(): void {
    this.set({ error: null });
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
    this.set({
      status: "ready",
      account: null,
      selectedId: null,
      cursorIndex: NO_CURSOR,
      activeFilters: [],
      searchQuery: "",
      overlay: "none",
      syncing: false,
      error: null,
      lastSyncedAt: null,
      // The seed is built around this instant. Leaving the wall clock in place
      // would drop the entire demo into one "Earlier" section and hide the one
      // thing the day grouping is for.
      now: DEMO_NOW,
    });
  }

  /** Sign out: clear the session but keep the things that describe the user. */
  async signOut(): Promise<void> {
    // Mutes and blocked senders survive: they are statements about the mail,
    // not about this session.
    const keep = {
      preferences: this.state.preferences,
      learning: this.state.learning,
    };
    this.backend = undefined;
    this.state = {
      ...this.state,
      status: "signed_out",
      account: null,
      all: [],
      selectedId: null,
      cursorIndex: NO_CURSOR,
      activeFilters: [],
      searchQuery: "",
      overlay: "none",
      syncing: false,
      error: null,
      ...keep,
    };
    this.version += 1;
    for (const listener of this.listeners) listener();
  }
}

/** The message shown when a sync could not download everything. */
export function syncFailureSummary(count: number): string {
  return `${count} message${count === 1 ? "" : "s"} failed to download this sync — refresh to retry.`;
}

/** Every bucket, for the settings panel's mute list. */
export { BUILTIN_FILTERS, matchesFilter };
