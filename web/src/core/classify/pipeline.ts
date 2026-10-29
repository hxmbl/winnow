/**
 * The list pipeline: search, filter, sort.
 *
 * The hottest function in the app — it runs on every keystroke over every message.
 * Three properties keep it fast, all about not doing unneeded work:
 *
 *   1. Search bags are built once and passed in, not re-concatenated per row.
 *   2. Signals come from a map the caller built; the classifier never runs here.
 *   3. The Smart Score is computed *after* filtering, only when sorting by it.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Classification/InboxPipeline.swift`.
 */

import type { Email } from "../model/email";
import {
  isUnsafe,
  NEUTRAL_SIGNALS,
  type EmailSignals,
  type FilterId,
} from "../model/signals";
import type { UserProfile } from "../model/profile";
import { threadKey } from "../model/ids";
import { matchesFilter } from "./filters";
import { inboxSearchBag } from "./classify";
import { calculateWinnowScore, recencyWindow, type SortBy } from "./scoring";

/** Lowercased haystacks, keyed by email id. Pass to avoid rebuilding them. */
export type SearchBags = ReadonlyMap<number, string>;

/**
 * Each message object's bag, built once. Messages are never mutated in place (a change
 * is a new object, which is what the store's other per-message memos rely on too), so
 * the bag of an object cannot go stale. Without it every derive while a search was
 * running lowercased the sender, subject and body of every message in the mailbox
 * again, keystroke or not.
 */
const bagMemo = new WeakMap<Email, string>();

function bagOf(email: Email): string {
  let bag = bagMemo.get(email);
  if (bag === undefined) {
    bag = inboxSearchBag(email);
    bagMemo.set(email, bag);
  }
  return bag;
}

export function buildSearchBags(emails: readonly Email[]): SearchBags {
  const bags = new Map<number, string>();
  for (const email of emails) bags.set(email.id, bagOf(email));
  return bags;
}

/**
 * The search's tokens: the query trimmed, lowercased and split on whitespace. Empty
 * means no search is running. Shared with the rail's faceted counts (`countFacets`
 * via the store), so a chip's number searches exactly as the list does.
 */
export function searchTokens(searchQuery: string): string[] {
  return searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** The list's search test: every token is in the message's bag (AND across tokens). */
export function matchesSearch(email: Email, tokens: readonly string[], bags?: SearchBags): boolean {
  if (tokens.length === 0) return true;
  const hay = bags?.get(email.id) ?? bagOf(email);
  return tokens.every((token) => hay.includes(token));
}

/**
 * Why the list is empty — drives which empty state the UI shows.
 *
 *   - `mailbox` — no mail here. The remedy is to sync.
 *   - `search` — the query is too narrow. Clear it.
 *   - `filters` — the buckets are too narrow. Clear them.
 *   - `noSignal` — the mailbox has mail and the default inbox's own spam rule is
 *     hiding all of it.
 */
export type EmptyReason =
  | "mailbox"
  | "search"
  | "filters"
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
   * With no filter on, hold back unsafe mail. The inbox's rule (true, the default): in
   * the spam folder or the bin, mail that looks unsafe is what the folder is *for*, and
   * hiding it there is how those lists once showed nothing.
   */
  hideUnsafe?: boolean;
};

export type InboxResult = {
  emails: Email[];
  /** Per-message smart score, present only when sorting by score. */
  scores: ReadonlyMap<number, number> | null;
  emptyReason: EmptyReason;
  /**
   * How many of the mailbox's messages this query admitted: plain `emails.length`.
   *
   * It was a second full pass over the mailbox that ANDed the search into the same
   * pass — so with a search active it returned exactly `emails.length` while
   * re-filtering everything on every keystroke, and nothing ever rendered it. The
   * count of results *is* `emails.length`; what the filters alone would have admitted
   * is a separate question that belongs to the caller.
   */
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
 * Search is AND across whitespace-separated tokens: a whole-query substring search
 * meant "invoice march" found nothing, since no message contains that exact run.
 */
export function runInboxQuery(query: InboxQuery): InboxResult {
  const { emails, profile, signals, filters, searchQuery, sortBy } = query;
  const hideUnsafe = query.hideUnsafe ?? true;
  const bags = query.searchBags;

  const tokens = searchTokens(searchQuery);

  // 1. Search. `hay` is only read when a query is active, so an unfiltered
  //    inbox never builds a single bag.
  let rows = emails;
  if (tokens.length > 0) {
    rows = rows.filter((email) => matchesSearch(email, tokens, bags));
  }

  // 2. Filters. Several active buckets narrow the list, so AND.
  const filtering = filters.length > 0;
  if (filtering) {
    rows = rows.filter((email) => {
      const signal = signalFor(signals, email);
      return filters.every((filter) => matchesFilter(filter, email, signal, profile));
    });
  } else if (hideUnsafe) {
    // No filter: hide spam, so the default inbox stays clean.
    rows = rows.filter((email) => !isUnsafe(signalFor(signals, email)));
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

  // The count is the length of the list, with no second pass over the mailbox.
  const matchCount = out.length;

  /**
   * Why the list is empty, in the order a user would want to be told.
   *
   * `noSignal` is the subtlest: the mailbox has mail, the user asked for no filter,
   * and the list is empty because the mail is all unsafe and the default inbox hides it.
   */
  let emptyReason: EmptyReason = null;
  if (out.length === 0) {
    if (tokens.length > 0) emptyReason = "search";
    else if (filtering) emptyReason = "filters";
    else if (emails.length === 0) emptyReason = "mailbox";
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
    // The rail counts by the same key (`countFacets`), so a pill's number is this list's row count.
    const key = threadKey(email);
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
