/**
 * The list pipeline: search, filter, sort.
 *
 * Everything the list shows passes through here, which makes this the hottest
 * function in the app — it runs on every keystroke over every message. Three
 * properties keep it fast, and all three are about *not doing work that is not
 * needed*:
 *
 *   1. Search bags are built once and passed in, rather than re-concatenating
 *      sender + subject + body per row per keystroke.
 *   2. Signals come from a map the caller built; the classifier never runs
 *      inside the filter path.
 *   3. The Smart Score is computed *after* filtering, only when sorting by it.
 *      Computing it first — as an earlier version did — cost a regex pass over
 *      every message for a sort the user may not have selected.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Classification/InboxPipeline.swift`.
 */

import type { Email } from "../model/email";
import {
  isUnsafe,
  NEUTRAL_SIGNALS,
  type BuiltinSmartFilter,
  type EmailSignals,
  type FilterId,
} from "../model/signals";
import type { UserProfile } from "../model/profile";
import { matchesBuiltin, matchesFilter } from "./filters";
import { inboxSearchBag } from "./classify";
import { calculateWinnowScore, recencyWindow, type SortBy } from "./scoring";

/** Lowercased haystacks, keyed by email id. Pass to avoid rebuilding them. */
export type SearchBags = ReadonlyMap<number, string>;

export function buildSearchBags(emails: readonly Email[]): SearchBags {
  const bags = new Map<number, string>();
  for (const email of emails) bags.set(email.id, inboxSearchBag(email));
  return bags;
}

/**
 * Why the list is empty — drives which empty state the UI shows.
 *
 * Five reasons rather than three because "there is nothing here" has three quite
 * different causes with three quite different remedies, and conflating them either
 * blames the user for a filter they did not set or leaves them with an empty screen and
 * no button.
 *
 *   - `mailbox` — there genuinely is no mail here. The remedy is to sync.
 *   - `search` — the query is too narrow. The remedy is to clear it.
 *   - `filters` — the buckets are too narrow. The remedy is to clear them.
 *   - `hidden` — the mailbox has mail and *buckets the user muted* are hiding all of
 *     it. The remedy is the same (stop narrowing) but the explanation is different, and
 *     saying "nothing matches those filters" when the user set no filters is the kind of
 *     small lie that makes an app untrustworthy.
 *   - `noSignal` — the mailbox has mail and the default inbox's own spam rule is hiding
 *     all of it.
 *
 * The old `unsafe` reason meant "a bucket you have hidden" and was only reachable when
 * `removed.size > 0`, which is exactly `hidden`.
 */
export type EmptyReason =
  | "mailbox"
  | "search"
  | "filters"
  | "hidden"
  | "noSignal"
  | null;

export type InboxQuery = {
  emails: readonly Email[];
  profile: UserProfile;
  signals: ReadonlyMap<number, EmailSignals>;
  filters: readonly FilterId[];
  searchQuery: string;
  sortBy: SortBy;
  searchBags?: SearchBags;
  /**
   * Buckets the user has silenced. Applies only to the *unfiltered* inbox:
   * explicitly activating a filter is a deliberate act and overrides a mute.
   */
  removedFilters?: ReadonlySet<BuiltinSmartFilter>;
};

export type InboxResult = {
  emails: Email[];
  /** Per-message smart score, present only when sorting by score. */
  scores: ReadonlyMap<number, number> | null;
  emptyReason: EmptyReason;
  /** Messages the active filters would match, ignoring the search box. */
  matchCount: number;
};

function signalFor(
  signals: ReadonlyMap<number, EmailSignals>,
  email: Email,
): EmailSignals {
  return signals.get(email.id) ?? NEUTRAL_SIGNALS;
}

/**
 * Run the pipeline.
 *
 * Search is AND across whitespace-separated tokens. A substring search on the
 * whole query — the previous behaviour — meant "invoice march" found nothing
 * at all, because no single message contains that exact run of characters.
 */
export function runInboxQuery(query: InboxQuery): InboxResult {
  const { emails, profile, signals, filters, searchQuery, sortBy } = query;
  const removed = query.removedFilters ?? new Set<BuiltinSmartFilter>();
  const bags = query.searchBags;

  const tokens = searchQuery
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  // 1. Search. `hay` is only read when a query is active, so an unfiltered
  //    inbox never builds a single bag.
  let rows = emails;
  if (tokens.length > 0) {
    rows = rows.filter((email) => {
      const hay = bags?.get(email.id) ?? inboxSearchBag(email);
      return tokens.every((token) => hay.includes(token));
    });
  }

  // 2. Filters. Several active buckets narrow the list, so AND.
  const filtering = filters.length > 0;
  if (filtering) {
    rows = rows.filter((email) => {
      const signal = signalFor(signals, email);
      return filters.every((filter) => matchesFilter(filter, email, signal, profile));
    });
  } else {
    // No filter: hide spam and anything in a bucket the user muted, so the
    // default inbox stays clean.
    rows = rows.filter((email) => {
      const signal = signalFor(signals, email);
      if (isUnsafe(signal)) return false;
      if (removed.size === 0) return true;
      for (const id of removed) {
        if (matchesBuiltin(id, email, signal, profile)) return false;
      }
      return true;
    });
  }

  // 3. Sort.
  let scores: Map<number, number> | null = null;
  if (sortBy === "date") {
    rows = [...rows].sort((a, b) => b.receivedAt - a.receivedAt);
  } else if (sortBy === "sender") {
    rows = [...rows].sort((a, b) => a.sender.localeCompare(b.sender));
  } else {
    // Scored only now, and only over what survived the filter. The recency
    // window is that same set, so "new" means new relative to the mail it is
    // actually ranked among.
    scores = new Map();
    const recency = recencyWindow(rows.map((email) => email.receivedAt));
    for (const email of rows) {
      scores.set(email.id, calculateWinnowScore(email, signalFor(signals, email), profile, recency));
    }
    rows = [...rows].sort((a, b) => (scores!.get(b.id) ?? 0) - (scores!.get(a.id) ?? 0));
  }

  const out = [...rows];

  // How many messages the filters alone would admit — the UI shows this next to
  // the search box so an empty result can be explained rather than just
  // reported.
  const matchCount =
    filtering || tokens.length > 0
      ? emails.filter((email) => {
          const signal = signalFor(signals, email);
          if (filtering && !filters.every((f) => matchesFilter(f, email, signal, profile))) {
            return false;
          }
          if (tokens.length > 0) {
            const hay = bags?.get(email.id) ?? inboxSearchBag(email);
            if (!tokens.every((token) => hay.includes(token))) return false;
          }
          return true;
        }).length
      : out.length;

  /**
   * Why the list is empty, in the order a user would want to be told.
   *
   * The `hidden` case is the one that was missing, and it is the most confusing of the
   * four: the mailbox has mail, the user asked for no filter, and the list is empty
   * anyway. That happens when every message in the mailbox is in a bucket they muted —
   * archive everything in "Newsletters", and Archive goes quiet. The empty state used
   * to say "This mailbox is empty", which is a statement about their mail that is
   * plainly false, and offered no way out.
   *
   * `noSignal` is the mirror case: the mailbox has messages and they are all unsafe, so
   * the default inbox hides them. That reads as an empty bin from inside the bin. (The
   * store now leaves non-inbox mail unclassified, so in practice this fires for an inbox
   * of nothing but spam — but the pipeline is shared, and a caller that *does* classify
   * a spam folder needs the honest answer.)
   */
  let emptyReason: EmptyReason = null;
  if (out.length === 0) {
    if (tokens.length > 0) emptyReason = "search";
    else if (filtering) emptyReason = "filters";
    else if (emails.length === 0) emptyReason = "mailbox";
    else if (removed.size > 0) emptyReason = "hidden";
    else emptyReason = "noSignal";
  }

  return { emails: out, scores, emptyReason, matchCount };
}

/** A conversation: the messages sharing a thread, oldest first. */
export type Thread = {
  key: string;
  /** Oldest to newest. The newest is the one the list shows. */
  messages: Email[];
};

/** The list row for a conversation. */
export type ThreadRow = {
  key: string;
  /** The newest message — the representative, and the one that is opened. */
  representative: Email;
  messageCount: number;
  /** True when any message in the thread is still unread. */
  unread: boolean;
};

/**
 * Collapse a list of messages into conversations, preserving list order.
 *
 * Gmail files a thread's messages across mailboxes, so grouping happens after
 * the filter: the user sees one row per thread, and the reader can show the
 * whole exchange.
 */
export function groupThreads(emails: readonly Email[]): ThreadRow[] {
  const order: string[] = [];
  const grouped = new Map<string, Email[]>();

  for (const email of emails) {
    const key = email.threadId ?? `single-${email.gmailId}`;
    const existing = grouped.get(key);
    if (existing) existing.push(email);
    else {
      grouped.set(key, [email]);
      order.push(key);
    }
  }

  return order.map((key) => {
    const messages = grouped.get(key)!.slice().sort((a, b) => a.receivedAt - b.receivedAt);
    return {
      key,
      representative: messages[messages.length - 1],
      messageCount: messages.length,
      unread: messages.some((message) => message.unread),
    };
  });
}

/**
 * Every message in a conversation, across all mailboxes.
 *
 * The list only holds the currently visible mailbox, so the reader needs the
 * rest of the exchange from the full store. Deduplicated by id and sorted
 * oldest-first, because a reply that appears above the message it answers is
 * unreadable.
 */
export function conversationFor(
  all: readonly Email[],
  threadId: string | undefined,
  gmailId: string,
): Email[] {
  const wanted = threadId ?? `single-${gmailId}`;
  return all
    .filter((email) => (email.threadId ?? `single-${email.gmailId}`) === wanted)
    .sort((a, b) => a.receivedAt - b.receivedAt);
}
