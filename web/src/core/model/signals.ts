/**
 * Classification vocabulary: the signals a message carries, and the buckets
 * those signals put it in.
 *
 * This file is the single source of truth for *thresholds and ordering*. The
 * classifier produces signals, the filter matcher and the badge renderer both
 * read them, and the learning loop tunes the weights that feed them. Anything
 * numeric that more than one of those cares about lives here, so a threshold
 * can be changed in one place instead of hunted across the app.
 *
 * Ported from `legacy/swift-native/Sources/winnow/Models/EmailSignals.swift`,
 * `Models/SmartFilter.swift` and `Classification/FilterCatalog.swift`.
 */

import type { Email, Mailbox } from "./email";

// ── Signals ─────────────────────────────────────────────────────────────────

/**
 * What the rule engine found in one message.
 *
 * Every field here is either a direct observation ("the body is long") or a
 * keyed judgement ("this looks like a receipt"). The distinction matters:
 * observations are re-derived from the message on every classification, while
 * judgements depend on the *tuned weights* and therefore change when the user
 * adjusts the learning model.
 */
export type EmailSignals = {
  /** Something is wrong with the account: an alert, a breach, a failed sign-in. */
  security: boolean;
  /** Bulk mail sent on a list. Fires at two distinct unsubscribe-style hits. */
  newsletter: boolean;
  /** Marketing: discounts, launches, "last chance". */
  promotional: boolean;
  /** Time-pressure language, or a sender-set urgent flag. */
  urgentText: boolean;
  /** A reply or a task is being asked of the reader. */
  needsAction: boolean;
  /** Transactional: invoices, receipts, billing, payouts. */
  finance: boolean;
  /** A one-time code the user is meant to copy. Distinct from `security`. */
  codes: boolean;
  /** Package tracking and delivery notices. */
  shipping: boolean;
  /** Flights, hotels, itineraries. */
  travel: boolean;
  /** Calendar invites, RSVPs, webinars. */
  events: boolean;
  /** Social-platform notifications. */
  social: boolean;
  /** Substantive long-form mail, by body word count. */
  longRead: boolean;

  /** 0–1 confidence the message is junk. */
  spamLikelihood: number;
  /** Weighted importance from a base of 50. Unclamped on purpose. */
  importanceScore: number;
};

/**
 * At or above this, a message is "unsafe": hidden from the default inbox and
 * excluded from the positive buckets.
 */
export const UNSAFE_THRESHOLD = 0.4;

/** At or above this, a message counts as Important. */
export const IMPORTANT_THRESHOLD = 56;

/** The one predicate for "this is spam", used everywhere. */
export function isUnsafe(signals: EmailSignals): boolean {
  return signals.spamLikelihood >= UNSAFE_THRESHOLD;
}

/**
 * The one predicate for "this is bulk mail", used everywhere.
 *
 * Bulk has its own buckets — `newsletters` and `promotional` — so a message that
 * is bulk must not also be badged Important, however well it scores. It can score
 * well: a promotion from a sender the profile ranks highly clears the Important
 * threshold on the sender boost alone, because nothing subtracts for bulk. Which is
 * exactly why the exclusion has to live inside the Important test in both places it
 * appears, rather than being left implicit in one and spelled out in the other.
 */
export function isBulk(signals: EmailSignals): boolean {
  return signals.newsletter || signals.promotional;
}

/**
 * Is this message Important?
 *
 * **One rule, two callers, and it used to be two rules.** `matchesBuiltin` asks this
 * of a message the user is filtering by; `badgeFilters` asks it of the message on
 * screen. They were written separately and they disagreed: the filter required
 * `safe &&` the threshold `&& !bulk`, while the badge required only the threshold.
 *
 * The disagreement was reachable, and on ordinary mail. Nothing subtracts for bulk
 * mail, so a promotion from a sender the profile ranks highly clears the bar on the
 * sender boost alone — 50 + 18 − 5 = 63, against a threshold of 56 — and it wore an
 * Important badge while the Important filter declined to list it. The row says one
 * thing about a message and the pill says another, and the reaction to an Important
 * badge on a retail promotion is to stop trusting the badges, which is the one thing
 * this product is asking to be trusted about.
 *
 * Lives here rather than in `filters.ts` because this is where the threshold and the
 * signal shape already are, and because `badgeFilters` must not have to import the
 * classifier to ask: `filters.ts` depends on this file, and the arrow only points
 * one way.
 *
 * Takes the message because a promotion that the *sender* flagged urgent is a
 * different proposition from one that merely says "act now", and that distinction
 * belongs to the message rather than to the signals.
 */
export function isImportant(email: Email, signals: EmailSignals): boolean {
  if (isUnsafe(signals)) return false;

  // Bulk mail is excluded up front, so both clauses below inherit it. Excluding it
  // per-clause is how the two copies came to disagree in the first place.
  if (signals.newsletter) return false;
  if (signals.promotional && !email.urgent) return false;

  return (
    signals.importanceScore >= IMPORTANT_THRESHOLD ||
    // `needsAction` gets in on its own strength: a message can be worth reading
    // without scoring well, which is most of what "needs a reply" means.
    signals.needsAction
  );
}

/**
 * The all-clear classification.
 *
 * Used wherever a signal is genuinely unknown — an archived message that was
 * never classified, or a cache miss. Same result a quiet, clean email would
 * get, so a missing classification degrades to "shows up normally" rather than
 * "gets hidden".
 */
export const NEUTRAL_SIGNALS: EmailSignals = {
  security: false,
  newsletter: false,
  promotional: false,
  urgentText: false,
  needsAction: false,
  finance: false,
  codes: false,
  shipping: false,
  travel: false,
  events: false,
  social: false,
  longRead: false,
  spamLikelihood: 0,
  importanceScore: 50,
};

// ── Filters ─────────────────────────────────────────────────────────────────

/**
 * The built-in buckets.
 *
 * No vendor names anywhere: a bucket is a *kind of mail*, so it keeps working
 * when the sender changes and stays meaningful across accounts.
 */
export const BUILTIN_FILTERS = [
  "important",
  "urgent",
  "needs_action",
  "security",
  "codes",
  "shipping",
  "travel",
  "events",
  "receipts",
  "starred",
  "unread",
  "attachments",
  "new_senders",
  "top_contacts",
  "quiet_contacts",
  "newsletters",
  "promotional",
  "low_priority",
  "long_reads",
  "social",
  "unsafe",
] as const;

export type BuiltinSmartFilter = (typeof BUILTIN_FILTERS)[number];

/** Human label per bucket. The pill, the badge and the rail all read this. */
export const FILTER_LABELS: Record<BuiltinSmartFilter, string> = {
  important: "Important",
  urgent: "Urgent",
  needs_action: "Action needed",
  security: "Security",
  codes: "Codes",
  shipping: "Deliveries",
  travel: "Travel",
  events: "Events",
  receipts: "Receipts",
  starred: "Starred",
  unread: "Unread",
  attachments: "Files",
  new_senders: "New contacts",
  top_contacts: "Top contacts",
  quiet_contacts: "Quiet contacts",
  newsletters: "Newsletters",
  promotional: "Promos",
  low_priority: "Read later",
  long_reads: "Long reads",
  social: "Social",
  unsafe: "Unsafe",
};

/**
 * A filter in the rail. Either a built-in bucket or a single sender.
 *
 * Modelled as a tagged union rather than a prefixed string because the prefix
 * scheme collides: a sender whose address literally starts with `sender:`
 * would produce an id that means something else entirely.
 */
export type FilterId =
  | { kind: "builtin"; id: BuiltinSmartFilter }
  | { kind: "sender"; sender: string };

/** A filter the user can toggle. Never "no filter" — see `FilterId | null`. */
export const builtinFilter = (id: BuiltinSmartFilter): FilterId => ({ kind: "builtin", id });

export const senderFilter = (sender: string): FilterId => ({ kind: "sender", sender });

/** Stable key for React and for persisting the active set. */
export function filterKey(filter: FilterId): string {
  return filter.kind === "builtin" ? filter.id : `sender:${filter.sender.toLowerCase()}`;
}

/** Inverse of `filterKey`, for restoring persisted filters. */
export function parseFilterKey(key: string): FilterId | null {
  if (key.startsWith("sender:")) return senderFilter(key.slice("sender:".length));
  return (BUILTIN_FILTERS as readonly string[]).includes(key)
    ? builtinFilter(key as BuiltinSmartFilter)
    : null;
}

/** The label a pill or badge shows. */
export function filterLabel(filter: FilterId): string {
  return filter.kind === "builtin" ? FILTER_LABELS[filter.id] : filter.sender;
}

/**
 * Buckets pinned to the front of the rail regardless of how much mail they
 * currently match — the "always watch" pair. Everything else ranks by volume
 * and hides when empty.
 */
export const PERMANENT_FILTERS: readonly BuiltinSmartFilter[] = ["important", "shipping"];

/** The catalog order, which is the tie-break inside a volume rank. */
export const FILTER_CATALOG: readonly BuiltinSmartFilter[] = BUILTIN_FILTERS;

/** Where a bucket sits in the catalog; used to break volume ties. */
export function catalogIndex(id: BuiltinSmartFilter): number {
  return FILTER_CATALOG.indexOf(id);
}

// ── Badges ──────────────────────────────────────────────────────────────────

/**
 * Every bucket a message belongs to, in badge order.
 *
 * Derived from the signals rather than re-encoding the thresholds, so the row
 * indicator and the pill can never disagree about which messages are
 * important. Excludes `starred`/`unread`/`attachments`, which are drawn from
 * the message's own state rather than from classification.
 */
export function badgeFilters(email: Email, signals: EmailSignals): BuiltinSmartFilter[] {
  const out: BuiltinSmartFilter[] = [];
  const safe = !isUnsafe(signals);

  // Delegated to the one `isImportant`, rather than re-testing the threshold here.
  // See `isImportant`: this clause and `matchesBuiltin`'s used to be two copies of one
  // rule, and they disagreed about bulk mail.
  if (isImportant(email, signals)) out.push("important");
  if (signals.urgentText) out.push("urgent");
  if (signals.needsAction && !signals.newsletter) out.push("needs_action");
  if (signals.security) out.push("security");
  if (signals.finance && safe) out.push("receipts");
  if (signals.codes && safe) out.push("codes");
  if (signals.shipping && safe) out.push("shipping");
  if (signals.travel && safe) out.push("travel");
  if (signals.events && safe) out.push("events");
  if (signals.newsletter) out.push("newsletters");
  if (signals.promotional) out.push("promotional");
  if (isUnsafe(signals)) out.push("unsafe");

  return out;
}

/**
 * The compact subset shown on a list row.
 *
 * The list is scanned, not read, so it gets the buckets that change how a row
 * is *judged* (important, urgent, unsafe) and drops the ones that are really
 * just categories. The reader shows the full set.
 */
const ROW_HIDDEN: ReadonlySet<BuiltinSmartFilter> = new Set([
  "needs_action",
  "receipts",
  "codes",
  "shipping",
  "travel",
  "events",
]);

export function rowIndicators(email: Email, signals: EmailSignals): BuiltinSmartFilter[] {
  return badgeFilters(email, signals).filter((id) => !ROW_HIDDEN.has(id));
}

// ── Mailbox navigation ──────────────────────────────────────────────────────

/**
 * The compact navigation palette. Archive is deliberately absent: it is a
 * destination you visit deliberately, not one you flip to while triaging.
 */
export type NavigationItem = "inbox" | "spam" | "trash" | "settings";

/**
 * The palette's destinations.
 *
 * No `label` here on purpose. The three mailboxes take their names from
 * `MAILBOX_LABEL`, which is what the mailbox tabs, the reader and the deep links
 * use — so there is exactly one name for a folder in the whole app. This list used
 * to carry its own, and the copy drifted the moment the two disagreed: the palette
 * said "Bin / Trash" for the folder every other surface called "Trash", and "Bin"
 * appears nowhere else in the product. A second spelling of a destination is a
 * second thing to keep correct.
 */
export const NAVIGATION_ITEMS: readonly { id: NavigationItem; mailbox?: Mailbox }[] = [
  { id: "inbox", mailbox: "inbox" },
  { id: "spam", mailbox: "spam" },
  { id: "trash", mailbox: "trash" },
  { id: "settings" },
] as const;

/**
 * Where the palette's selection should land for a given mailbox.
 *
 * Derived from `NAVIGATION_ITEMS` rather than hardcoded, because the previous
 * implementation returned `0` for every mailbox and threw its argument away — so
 * opening the palette from Spam or the bin always highlighted Inbox, and the
 * keyboard path through the palette (`!`, then Enter) jumped somewhere the user
 * was not. The `inbox` fallback is deliberate for Archive, which is not in the
 * palette: arriving there, the most useful jump is back to where the work is.
 */
export function navigationIndexFor(mailbox: Mailbox): number {
  const index = NAVIGATION_ITEMS.findIndex((item) => item.mailbox === mailbox);
  return index >= 0 ? index : 0;
}

/** Clamp an index into a list, or `0` for an empty one. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}
