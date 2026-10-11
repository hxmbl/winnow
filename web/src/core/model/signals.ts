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
};

export const UNSAFE_THRESHOLD = 0.4;
export const IMPORTANT_THRESHOLD = 56;
export function isUnsafe(signals: EmailSignals): boolean {
  return signals.spamLikelihood >= UNSAFE_THRESHOLD;
}

/**
 * Important predicate (shared). Excludes bulk except urgent promotions from sender.
 */
export function isImportant(email: Email, signals: EmailSignals): boolean {
  if (isUnsafe(signals)) return false;
  if (signals.newsletter) return false;
  if (signals.promotional && !email.urgent) return false;
  return signals.importanceScore >= IMPORTANT_THRESHOLD || signals.needsAction;
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
export function badgeFilters(email: Email, signals: EmailSignals): BuiltinSmartFilter[] {
  const out: BuiltinSmartFilter[] = [];
  const safe = !isUnsafe(signals);

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

export type NavigationItem = "inbox" | "spam" | "trash" | "settings";
export const NAVIGATION_ITEMS: readonly { id: NavigationItem; mailbox?: Mailbox }[] = [
  { id: "inbox", mailbox: "inbox" },
  { id: "spam", mailbox: "spam" },
  { id: "trash", mailbox: "trash" },
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
