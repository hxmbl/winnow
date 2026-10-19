/** Classification signals, thresholds and filter vocabulary. */

import type { Email, Mailbox } from "./email";

// ── Signals ─────────────────────────────────────────────────────────────────

/** Rule engine signals (observations vs judgements). */
export type EmailSignals = {
  security: boolean;
  newsletter: boolean;
  promotional: boolean;
  urgentText: boolean;
  needsAction: boolean;
  finance: boolean;
  codes: boolean;
  shipping: boolean;
  travel: boolean;
  events: boolean;
  social: boolean;
  longRead: boolean;
  spamLikelihood: number;
  importanceScore: number;
  /**
   * Set only by what the user taught "Change smart filters…" (`learn/filterLearning.ts`):
   * per filter, true puts the message in that filter and false takes it out, whatever
   * the built-in rules say. Only the named filter changes — the classifier's own flags
   * above are never rewritten, so a correction for one filter cannot leak into another,
   * into the importance score or into star learning. Unsafe mail stays out regardless.
   * Absent everywhere else.
   */
  filterOverrides?: Partial<Record<SignalFilter, boolean>>;
};

/**
 * The filters whose membership is read from the signals alone (no profile, no
 * star or read state), which is also the set a correction can change. Defined here,
 * beside the predicate, so the badge, the list and the learning all share one answer.
 */
export const SIGNAL_FILTERS = [
  "important",
  "urgent",
  "needs_action",
  "security",
  "codes",
  "shipping",
  "travel",
  "events",
  "receipts",
  "newsletters",
  "promotional",
  "social",
] as const;

export type SignalFilter = (typeof SIGNAL_FILTERS)[number];

export function isSignalFilter(filter: string): filter is SignalFilter {
  return (SIGNAL_FILTERS as readonly string[]).includes(filter);
}

export const UNSAFE_THRESHOLD = 0.4;
export const IMPORTANT_THRESHOLD = 56;
export function isUnsafe(signals: EmailSignals): boolean {
  return signals.spamLikelihood >= UNSAFE_THRESHOLD;
}

/**
 * Important predicate (shared). Excludes bulk except urgent promotions from sender.
 */
export function isImportant(email: Email, signals: EmailSignals): boolean {
  return inSignalFilter("important", email, signals);
}

/**
 * Is this message in one of the signal filters? The user's correction for that filter
 * (`filterOverrides`) decides first, but never for unsafe mail: learning can take
 * unsafe mail out of a filter, never put it into one.
 */
export function inSignalFilter(filter: SignalFilter, email: Email, signals: EmailSignals): boolean {
  const safe = !isUnsafe(signals);
  const override = signals.filterOverrides?.[filter];
  if (override !== undefined) return override && safe;
  return builtInSignalFilter(filter, email, signals, safe);
}

/** What the built-in rules alone say, ignoring any correction. */
export function builtInSignalFilter(
  filter: SignalFilter,
  email: Email,
  signals: EmailSignals,
  safe = !isUnsafe(signals),
): boolean {
  switch (filter) {
    case "important":
      // Excludes bulk, except a promotion the sender flagged urgent.
      if (!safe) return false;
      if (signals.newsletter) return false;
      if (signals.promotional && !email.urgent) return false;
      return signals.importanceScore >= IMPORTANT_THRESHOLD || signals.needsAction;
    case "urgent":
      // Marketing "last chance!" is promo pressure, not urgency — unless the
      // sender explicitly flagged it.
      return signals.urgentText && safe && !(signals.promotional && !email.urgent);
    case "security":
      return signals.security;
    case "needs_action":
      // Newsletters are excluded: every issue "needs" a click, and counting
      // that would bury real asks under the weekly digest.
      return signals.needsAction && safe && !signals.newsletter;
    case "receipts":
      return signals.finance && safe;
    case "codes":
      return signals.codes && safe;
    case "shipping":
      return signals.shipping && safe;
    case "travel":
      return signals.travel && safe;
    case "events":
      return signals.events && safe;
    case "social":
      return signals.social && safe;
    case "newsletters":
      return signals.newsletter;
    case "promotional":
      return signals.promotional;
  }
}

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

export type FilterId =
  | { kind: "builtin"; id: BuiltinSmartFilter }
  | { kind: "sender"; sender: string };

export const builtinFilter = (id: BuiltinSmartFilter): FilterId => ({ kind: "builtin", id });

export const senderFilter = (sender: string): FilterId => ({ kind: "sender", sender });

export function filterKey(filter: FilterId): string {
  return filter.kind === "builtin" ? filter.id : `sender:${filter.sender.toLowerCase()}`;
}

export function parseFilterKey(key: string): FilterId | null {
  if (key.startsWith("sender:")) return senderFilter(key.slice("sender:".length));
  return (BUILTIN_FILTERS as readonly string[]).includes(key)
    ? builtinFilter(key as BuiltinSmartFilter)
    : null;
}

export function filterLabel(filter: FilterId): string {
  return filter.kind === "builtin" ? FILTER_LABELS[filter.id] : filter.sender;
}

export const PERMANENT_FILTERS: readonly BuiltinSmartFilter[] = ["important", "shipping"];
export const FILTER_CATALOG: readonly BuiltinSmartFilter[] = BUILTIN_FILTERS;
export function catalogIndex(id: BuiltinSmartFilter): number {
  return FILTER_CATALOG.indexOf(id);
}

// ── Badges ──────────────────────────────────────────────────────────────────

/** All buckets for a message (badge order). */
/**
 * All buckets for a message (badge order). Each badge asks the same question the filter
 * does (`inSignalFilter`), so a badge can never claim a filter the message is not in —
 * a promo's "last chance" is no Urgent badge, because Urgent leaves it out.
 */
const BADGE_ORDER: readonly SignalFilter[] = [
  "important",
  "urgent",
  "needs_action",
  "security",
  "receipts",
  "codes",
  "shipping",
  "travel",
  "events",
  "newsletters",
  "promotional",
];

export function badgeFilters(email: Email, signals: EmailSignals): BuiltinSmartFilter[] {
  const out: BuiltinSmartFilter[] = BADGE_ORDER.filter((filter) => inSignalFilter(filter, email, signals));
  if (isUnsafe(signals)) out.push("unsafe");
  return out;
}

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

export type NavigationItem = "inbox" | "spam" | "trash" | "sent" | "drafts" | "settings";

/**
 * The `!` palette's rows.
 *
 * Sent sits after Trash rather than after Inbox on purpose: a row that moves silently
 * repoints the digit shortcut that went with it, and three of these four destinations
 * are places somebody triages from. Sent is somewhere you go on purpose — to find
 * something you wrote, or to see who you have been writing to — which is the same
 * category of destination Settings is in, and the same one Archive is absent for.
 */
export const NAVIGATION_ITEMS: readonly { id: NavigationItem; mailbox?: Mailbox }[] = [
  { id: "inbox", mailbox: "inbox" },
  { id: "spam", mailbox: "spam" },
  { id: "trash", mailbox: "trash" },
  { id: "sent", mailbox: "sent" },
  { id: "drafts", mailbox: "drafts" },
  { id: "settings" },
] as const;

export function navigationIndexFor(mailbox: Mailbox): number {
  const index = NAVIGATION_ITEMS.findIndex((item) => item.mailbox === mailbox);
  return index >= 0 ? index : 0;
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}
