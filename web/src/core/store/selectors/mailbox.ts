/**
 * Everything derived from the messages, in dependency order.
 *
 * The profile and signals are memoised on the only inputs that can change them; the
 * contacts index and the rail follow the same rule. `WinnowStore.derive()` is the one
 * door: no consumer can see a half-updated world because the whole view is built here
 * in profile → signals → visible list → rail order.
 */

import { summarizeAttention, type AttentionSummary } from "../../classify/attention";
import {
  isUnsafe,
  NEUTRAL_SIGNALS,
  PERMANENT_FILTERS,
  catalogIndex,
  type BuiltinSmartFilter,
  type EmailSignals,
} from "../../model/signals";
import {
  profileFromStats,
  profileStats,
  sameProfile,
  sendersReclassifiedBy,
  updateProfileStats,
  type ProfileStats,
  type UserProfile,
} from "../../model/profile";
import { classifyAll, classifyEmail, type SignalMap } from "../../classify/classify";
import { countAllFilters, rankFilters } from "../../classify/filters";
import { buildSearchBags, conversationFor, groupThreads, runInboxQuery } from "../../classify/pipeline";
import { buildContactIndex, type ContactIndex } from "../../contacts/index";
import type { GoogleContact } from "../../contacts/google";
import { EMPTY_BACKGROUND, applyFilterLearning, clueBackground, type ClueBackground, type FilterLearning } from "../../learn/filterLearning";
import type { SignalWeights } from "../../classify/weights";
import type { Email } from "../../model/email";
import { threadKey } from "../../model/ids";
import type { WinnowStore } from "../store";
import type { MailboxView } from "../state";
import type { SearchFacets } from "./search";
import { rowIndexOf } from "./threads";

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

export class MailboxSelectors {
  constructor(private readonly facets: SearchFacets) {}

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

  contacts(store: WinnowStore): ContactIndex {
    const all = store.state.all;
    const self = store.state.account?.email ?? null;
    const google = store.state.googleContacts;
    const hit = this.contactCache;
    if (hit && hit.all === all && hit.self === self && hit.google === google) return hit.index;
    const index = buildContactIndex(all, { selfAddress: self, googleContacts: store.state.googleContacts });
    this.contactCache = { all, self, google, index };
    return index;
  }

  inboxAnalysis(store: WinnowStore): { profile: UserProfile; signals: SignalMap } {
    const state = store.state;
    const { all, learning, preferences } = state;
    const weights = learning.weights;
    const trash = store.trashSenders;
    const blocked = preferences.blockedSenders;

    const hit = this.inboxCache;
    if (
      hit &&
      hit.all === all &&
      hit.weights === weights &&
      hit.trash === trash &&
      hit.blocked === blocked &&
      hit.filterLearning === store.learningModel()
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
      stats = updateProfileStats(hit.stats, removed, added, store.trashRecords());
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
      stats = profileStats(inboxForProfile, store.trashRecords());
      profile = profileFromStats(stats);
      baseSignals = classifyAll(inboxForProfile, profile, weights);
      for (const email of inboxForProfile) byEmail.set(email, baseSignals.get(email.id)!);
    }
    const filterLearning = store.learningModel();
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
  private readonly mailboxBase = new WeakMap<Email, { profile: UserProfile; weights: SignalWeights; signal: EmailSignals }>();

  /**
   * A non-inbox mailbox, classified for smart filters with the inbox's profile and
   * weights, then what has been learned applied over it. Memoised per message object
   * and profile, so switching back and forth, or one message changing, reclassifies only
   * what changed.
   */
  mailboxSignals(store: WinnowStore, emails: readonly Email[], profile: UserProfile): SignalMap {
    const weights = store.state.learning.weights;
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
    const learning = store.learningModel();
    if (learning.isEmpty) return base;
    const background = this.inboxCache?.background ?? EMPTY_BACKGROUND;
    return applyFilterLearning(emails, base, learning, background);
  }

  derive(store: WinnowStore): MailboxView {
    const state = store.state;
    const blocked = new Set(state.preferences.blockedSenders.map((s) => s.toLowerCase()));

    // Blocked senders are hidden from every view, and before the profile is built, or
    // their volume would still push them up the engagement ranking.
    const visible = state.all.filter((email) => !blocked.has(email.sender.toLowerCase()));
    // Drafts are their own list (see `StoreState.drafts`), never filtered by sender: the
    // sender of every draft is the user.
    const mailboxEmails = store.listedIn(visible);

    // The profile is built from the *inbox*, not the current mailbox: learning "who you
    // read" from an archive or a bin would teach it the wrong thing. Memoised; see
    // `inboxAnalysis`.
    const { profile, signals: inboxSignals } = this.inboxAnalysis(store);
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
          : this.mailboxSignals(store, mailboxEmails, profile);

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
    // filters (the numbers shown facet on both, `railFacets` below): a pill's number is how many conversations (list rows) in this mailbox it would show, so
    // the count, the list a filter gives and "Why it's here" all agree. The permanent
    // pair stays pinned wherever you are.
    const railEmails = state.mailbox === "drafts" || state.mailbox === "scheduled" ? [] : mailboxEmails;
    const rail = rankFilters(railEmails, signals, profile, this.filterHits);
    const railWithActive = this.orderedRail(store, rail);
    // Conversations, like the list's rows and the masthead's readout (`threads`).
    const railCounts =
      state.mailbox === "inbox"
        ? countAllFilters(inboxForProfile, inboxSignals, profile, this.filterHits, "conversations")
        : countAllFilters(railEmails, signals, profile, this.filterHits, "conversations");
    // Conversations, like every other pill number (`countAllFilters`).
    const railSenderThreads = new Map<string, Set<string>>();
    for (const email of railEmails) {
      const seen = railSenderThreads.get(email.sender);
      if (seen) seen.add(threadKey(email));
      else railSenderThreads.set(email.sender, new Set([threadKey(email)]));
    }
    const railSenderCounts = new Map<string, number>();
    for (const [sender, keys] of railSenderThreads) railSenderCounts.set(sender, keys.size);
    // Faceted on the active filters and, while a search runs (1.4.0), on the search: a
    // chip's number is then what tapping it lists under that query. Which chips stay is
    // still `rail` / `railCounts` (the plain mailbox ranking), so typing never reshuffles
    // the rail; a chip the search empties dims in place. `inboxCounts` stay plain.
    const railFacets = this.facets.facetsFor(
      state.activeFilters,
      state.searchQuery,
      railEmails,
      signals,
      profile,
      searchBags,
    );

    // Over the inbox whatever is open: the drawer's and the triage line's claims.
    const inboxCounts =
      state.mailbox === "inbox" ? railCounts : countAllFilters(inboxForProfile, inboxSignals, profile, this.filterHits, "conversations");

    const attention: AttentionSummary = summarizeAttention(inboxForProfile, inboxSignals, state.now);

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
    const selected = selectedEmail ? store.withBody(selectedEmail) : null;
    // From `visible`, not `state.all`: finding a blocked sender's mail quoted in an open
    // thread is not blocking them. Body-bearing copies, because this is where a message
    // is actually *read*; everything above works on the body-free messages `state.all`
    // holds.
    const conversation = selected
      ? conversationFor(visible, selected.threadId, selected.gmailId).map((m) => store.withBody(m))
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
      railFacets,
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
      contacts: this.contacts(store),
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
  private orderedRail(store: WinnowStore, ranked: BuiltinSmartFilter[]): BuiltinSmartFilter[] {
    const activeBuiltins = store.state.activeFilters
      .filter((filter): filter is Extract<typeof filter, { kind: "builtin" }> => filter.kind === "builtin")
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

  /**
   * The classifier's own signals for a message, with no smart-filter correction in them:
   * what star learning reads, so it learns from the score's real inputs and never from a
   * filter the user corrected.
   */
  rawSignalsFor(store: WinnowStore, email: Email): EmailSignals {
    if (email.mailbox === "inbox") {
      this.inboxAnalysis(store);
      const base = this.inboxCache?.baseSignals.get(email.id);
      if (base) return base;
    }
    const { filterOverrides: _corrections, ...raw } = this.signalsFor(store, email);
    void _corrections;
    return raw;
  }

  /** Signals for a message, classifying it if the view has not yet. */
  signalsFor(store: WinnowStore, email: Email): EmailSignals {
    const cached = store.view.signals.get(email.id);
    if (cached) return cached;
    // Fall back to classifying against the current profile rather than `NEUTRAL`:
    // learning from a neutral classification would teach the model nothing about why
    // the user starred the message.
    return classifyAll([email], store.view.profile, store.state.learning.weights).get(email.id)!;
  }

  /** The classifier's own signals for an inbox message, before any learned corrections. */
  baseSignal(store: WinnowStore, id: number): EmailSignals | undefined {
    this.inboxAnalysis(store);
    return this.inboxCache?.baseSignals.get(id);
  }

  /** The "Why it's here" inputs for one message: base signals, learned signals and profile. */
  explanationFor(
    store: WinnowStore,
    email: Email,
  ): {
    base: EmailSignals;
    learned: EmailSignals;
    profile: UserProfile;
    background: ClueBackground;
    weights: SignalWeights;
  } | null {
    this.inboxAnalysis(store);
    const cache = this.inboxCache;
    const base = cache?.baseSignals.get(email.id);
    const learned = cache?.signals.get(email.id);
    if (!cache || !base || !learned) return null;
    return { base, learned, profile: cache.profile, background: cache.background, weights: cache.weights };
  }

  /** The background signals the learned model was applied over, for mailbox explanations. */
  background(store: WinnowStore): { background: ClueBackground; weights: SignalWeights } {
    this.inboxAnalysis(store);
    const cache = this.inboxCache;
    return {
      background: cache?.background ?? EMPTY_BACKGROUND,
      weights: cache?.weights ?? store.state.learning.weights,
    };
  }
}
