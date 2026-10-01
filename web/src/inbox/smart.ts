import type { RelayEmail, TrashRow } from "./types";

/** Built-in semantic buckets — no hard-coded vendor names. */
export type BuiltinSmartFilter =
  | "starred"
  | "important"
  | "urgent"
  | "security"
  | "newsletters"
  | "promotional"
  | "low_priority"
  | "unsafe"
  | "top_contacts"
  | "quiet_contacts";

export type SmartFilterId = BuiltinSmartFilter | `sender:${string}` | null;

/** A filter ID that is never `null` — safe for arrays. */
export type FilterId = BuiltinSmartFilter | `sender:${string}`;

const SENDER_TAG = "sender:";

export function senderFilter(sender: string): FilterId {
  return `${SENDER_TAG}${sender}`;
}

/** Lightweight “digital profile”: frequencies + trash bias only — rules, not ML. */
export type UserProfile = {
  trashBiasBySender: Record<string, number>;
  /** Highest engagement in inbox (weighted). */
  topSenders: string[];
  /** Rare senders still present — “cold” side of the habit curve. */
  quietSenders: string[];
};

export type EmailSignals = {
  security: boolean;
  newsletter: boolean;
  promotional: boolean;
  urgentText: boolean;
  needsAction: boolean;
  spamLikelihood: number;
  importanceScore: number;
};

/** Pre-classified rows, keyed by email id — lets callers classify the inbox once. */
export type SignalMap = ReadonlyMap<number, EmailSignals>;

/** Reuse the caller's signals when supplied, otherwise classify on demand. */
function signalFor(
  signals: SignalMap | undefined,
  email: RelayEmail,
  profile: UserProfile,
): EmailSignals {
  return signals?.get(email.id) ?? classifyEmail(email, profile);
}

const KW = {
  security: [
    "verify your account",
    "security alert",
    "unauthorized",
    "suspicious activity",
    "breach",
    "reset your password",
    "reset password",
    "one-time passcode",
    "otp",
    "two-factor",
    "2fa",
    "oauth",
    "access control",
    "authentication",
    "login attempt",
  ],
  newsletter: [
    "unsubscribe",
    "newsletter",
    "mailing list",
    "weekly digest",
    "view in browser",
    "email preferences",
    "manage preferences",
  ],
  urgent: [
    "urgent",
    "asap",
    "immediately",
    "expires tonight",
    "last chance",
    "critical",
    "time sensitive",
    "action required",
    "deadline",
    "needs your approval",
  ],
  spam: [
    "claim your prize",
    "you have won",
    "free money",
    "congratulations",
    "act now",
    "exclusive deal",
    "buy now",
    "call now",
    "free gift",
    "earn money",
    "work from home",
    "cash bonus",
    "increase your",
    "unlimited",
    "no cost",
  ],
} as const;

function inboxWordBag(e: RelayEmail): string {
  return `${e.sender} ${e.subject} ${e.body}`.toLowerCase();
}

function hasAny(hay: string, needles: readonly string[]): boolean {
  return needles.some((n) => hay.includes(n));
}

function countAny(hay: string, needles: readonly string[]): number {
  return needles.filter((n) => hay.includes(n)).length;
}

function countInboxBySender(
  inbox: RelayEmail[],
): Record<string, { count: number; starred: number }> {
  const m: Record<string, { count: number; starred: number }> = {};
  for (const e of inbox) {
    const cur = m[e.sender] ?? { count: 0, starred: 0 };
    cur.count += 1;
    if (e.starred) cur.starred += 1;
    m[e.sender] = cur;
  }
  return m;
}

function countTrashBySender(trash: TrashRow[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const t of trash) {
    m[t.sender] = (m[t.sender] ?? 0) + 1;
  }
  return m;
}

/** Trash never removes inbox rows; it only nudges scores via trashBias. */
export function buildUserProfile(
  inbox: RelayEmail[],
  trash: TrashRow[],
): UserProfile {
  const inboxStats = countInboxBySender(inbox);
  const trashStats = countTrashBySender(trash);
  const senders = new Set([
    ...Object.keys(inboxStats),
    ...Object.keys(trashStats),
  ]);

  const trashBiasBySender: Record<string, number> = {};
  const engagement: { sender: string; score: number; inbox: number }[] = [];

  for (const sender of senders) {
    const i = inboxStats[sender]?.count ?? 0;
    const st = inboxStats[sender]?.starred ?? 0;
    const tr = trashStats[sender] ?? 0;
    trashBiasBySender[sender] = tr / (tr + i + 1);

    if (i > 0) {
      const score = i + st * 2 - tr * 0.35;
      engagement.push({ sender, score, inbox: i });
    }
  }

  engagement.sort((a, b) => b.score - a.score);
  const topSenders = engagement.slice(0, 6).map((x) => x.sender);

  const byVolume = [...engagement].sort((a, b) => a.inbox - b.inbox);
  const quietCut = Math.max(1, Math.ceil(byVolume.length / 3));
  const quietSenders = byVolume
    .slice(0, quietCut)
    .filter((x) => x.inbox <= 2)
    .map((x) => x.sender);

  return { trashBiasBySender, topSenders, quietSenders };
}

export function classifyEmail(
  email: RelayEmail,
  profile: UserProfile,
): EmailSignals {
  const text = inboxWordBag(email);
  const bias = profile.trashBiasBySender[email.sender] ?? 0;
  const actionText = `${email.subject} ${email.body}`;

  const security = hasAny(text, KW.security);
  const newsletterHits = countAny(text, KW.newsletter);
  const newsletter = email.type === "newsletter" || newsletterHits >= 2;
  const securityByType = email.type === "security";
  const securitySignal = security || securityByType;
  const promoType =
    email.type === "promotional" ||
    /\b\d+%\s*off\b|\bflash sale\b|\blimited time\b|\bfree shipping\b|\btoday only\b|\bpromo(?: code)?\b|\bprice drop\b|\bfree delivery\b|\boffer ends\b|\bdon't miss out\b/.test(
      text,
    );
  const promotional = promoType && !securitySignal;

  const urgentText =
    email.urgent ||
    hasAny(text, KW.urgent);

  const needsAction =
    /\b(verify|appointment|renew|check-?in|register|sign|approval)\b/i.test(actionText) ||
    /\b(bill|payment|invoice)\s+is\s+due\b/i.test(actionText);
  const phishingSignal =
    /\b(click here|account has been compromised|verify your password|suspended account|unusual sign-?in)\b/i.test(
      actionText,
    );

  let spamLikelihood = 0;
  if (!email.subject.trim() && !email.body.trim()) spamLikelihood += 0.55;
  else if (!email.subject.trim()) spamLikelihood += 0.2;

  const sender = email.sender.trim();
  if (sender && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sender)) {
    if (/^no-?reply\b/i.test(sender) && (newsletter || promotional))
      spamLikelihood += 0.05;
    if (/^(marketing|digest)\b/i.test(sender)) spamLikelihood += 0.05;

    const domain = sender.split("@")[1];
    if (/@example\.com$/i.test(sender)) spamLikelihood += 0.18;
    if (/\d/.test(domain)) spamLikelihood += 0.1;
  }

  if (phishingSignal) spamLikelihood += 0.3;
  if (hasAny(text, KW.spam)) spamLikelihood += 0.15;

  const subject = email.subject;
  const upper = subject.replace(/[^A-Z]/g, "").length;
  const alpha = subject.replace(/[^A-Za-z]/g, "").length;
  const shouty =
    alpha > 5 && upper / alpha > 0.55 && /!{2,}/.test(subject);
  if (shouty) spamLikelihood += 0.12;

  const boundedBias = Math.min(bias, 0.35);
  spamLikelihood += boundedBias * 0.22;
  if (newsletter && promotional) spamLikelihood += 0.08;
  spamLikelihood = Math.min(1, spamLikelihood);

  let importanceScore = 50;
  if (email.starred) importanceScore += 22;
  const rank = profile.topSenders.indexOf(email.sender);
  if (rank === 0) importanceScore += 18;
  else if (rank === 1 || rank === 2) importanceScore += 12;
  else if (rank >= 3 && rank < 6) importanceScore += 6;

  if (securitySignal) importanceScore += 16;
  if (urgentText) importanceScore += 18;
  if (needsAction) importanceScore += 12;
  if (newsletter) importanceScore -= 9;
  if (promotional) importanceScore -= 11;

  importanceScore -= spamLikelihood * 44;
  importanceScore -= boundedBias * 14;
  if (profile.quietSenders.includes(email.sender)) importanceScore -= 6;

  return {
    security: securitySignal,
    newsletter,
    promotional,
    urgentText,
    needsAction,
    spamLikelihood,
    importanceScore,
  };
}

const INTENT_WEIGHTS: [RegExp, number][] = [
  [/\b(?:security|password|2fa|breach|unauthorized|suspicious|login attempt)\b/i, 15],
  [/\b(?:urgent|asap|deadline|time sensitive|action required|critical)\b/i, 12],
  [/\b(?:invoice|receipt|payment|billing|statement)\b/i, 8],
  [/\b(?:confirm|verify|appointment|reminder)\b/i, 6],
  [/\b(?:sale|discount|offer|promo|deal|free)\b/i, -8],
  [/\b(?:unsubscribe|newsletter|weekly digest)\b/i, -10],
  [/\b(?:due|past due|overdue|late fee)\b/i, 10],
];

/** Single composite score — higher = more important. */
export type SortBy = "date" | "sender" | "score";

export function calculateRelayScore(
  email: RelayEmail,
  profile: UserProfile,
): number {
  let score = 50;

  const rank = profile.topSenders.indexOf(email.sender);
  if (rank === 0) score += 18;
  else if (rank <= 2) score += 12;
  else if (rank < 6) score += 6;

  const bias = Math.min(profile.trashBiasBySender[email.sender] ?? 0, 0.35);
  score -= bias * 40;

  if (email.starred) score += 15;

  const text = `${email.sender} ${email.subject} ${email.body}`;
  for (const [re, weight] of INTENT_WEIGHTS) {
    if (re.test(text)) score += weight;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}

function matchesBuiltin(
  filter: BuiltinSmartFilter,
  email: RelayEmail,
  sig: EmailSignals,
  profile: UserProfile,
): boolean {
  switch (filter) {
    case "starred":
      return email.starred;
    case "important":
      return (
        (sig.importanceScore >= 56 && sig.spamLikelihood < 0.52) ||
        (sig.needsAction && sig.spamLikelihood < 0.52)
      );
    case "urgent":
      return sig.urgentText;
    case "security":
      return sig.security;
    case "newsletters":
      return sig.newsletter;
    case "promotional":
      return sig.promotional;
    case "low_priority":
      return sig.promotional || sig.newsletter;
    case "unsafe":
      return sig.spamLikelihood >= 0.4;
    case "top_contacts": {
      const rank = profile.topSenders.indexOf(email.sender);
      return rank >= 0 && rank < 3;
    }
    case "quiet_contacts":
      return profile.quietSenders.includes(email.sender);
    default:
      return false;
  }
}

export function matchesSmartFilter(
  filter: SmartFilterId,
  email: RelayEmail,
  sig: EmailSignals,
  profile: UserProfile,
): boolean {
  if (filter === null) return true;
  if (filter.startsWith(SENDER_TAG)) {
    return email.sender === filter.slice(SENDER_TAG.length);
  }
  return matchesBuiltin(filter as BuiltinSmartFilter, email, sig, profile);
}

/** `signals` must have been built against `profile`, otherwise it is ignored by the caller. */
export function filterAndSortInbox(
  inbox: RelayEmail[],
  trash: TrashRow[],
  filters: readonly SmartFilterId[],
  searchQuery: string,
  sortBy: SortBy = "date",
  profile?: UserProfile,
  signals?: SignalMap,
): RelayEmail[] {
  const p = profile ?? buildUserProfile(inbox, trash);
  const q = searchQuery.trim().toLowerCase();

  // `hay` is only read when a query is active and `score` only when sorting by it,
  // so both stay unbuilt otherwise instead of costing a pass over every row.
  const rows = inbox.map((email) => ({
    email,
    sig: signalFor(signals, email, p),
    hay: q === "" ? "" : inboxWordBag(email),
    score: sortBy === "score" ? calculateRelayScore(email, p) : 0,
  }));

  let out = rows.filter(({ hay }) => q === "" || hay.includes(q));

  if (filters.length > 0) {
    out = out.filter(({ email, sig }) =>
      filters.every((f) => matchesSmartFilter(f, email, sig, p)),
    );
  } else {
    out = out.filter(({ sig }) => sig.spamLikelihood < 0.4);
  }

  if (sortBy === "date") {
    out.sort((a, b) => b.email.receivedAt - a.email.receivedAt);
  } else if (sortBy === "sender") {
    out.sort((a, b) => a.email.sender.localeCompare(b.email.sender));
  } else {
    out.sort((a, b) => b.score - a.score);
  }

  return out.map((r) => r.email);
}

/** Human label per built-in filter — shared by the strip and the reader's chips. */
export const FILTER_LABELS: Record<BuiltinSmartFilter, string> = {
  starred: "Starred",
  important: "Important",
  urgent: "Urgent",
  security: "Security",
  top_contacts: "Top contacts",
  quiet_contacts: "Quiet contacts",
  newsletters: "Newsletters",
  promotional: "Promos",
  low_priority: "Read later",
  unsafe: "Unsafe",
};

/** Strip order — `rankFilters` reorders within groups, so this only breaks ties. */
const FILTER_ORDER: BuiltinSmartFilter[] = [
  "starred",
  "important",
  "urgent",
  "security",
  "top_contacts",
  "quiet_contacts",
  "newsletters",
  "promotional",
  "low_priority",
  "unsafe",
];

/** Stable filter list for the strip — senders added separately from profile. */
export const BUILTIN_FILTERS: {
  id: BuiltinSmartFilter;
  label: string;
}[] = FILTER_ORDER.map((id) => ({ id, label: FILTER_LABELS[id] }));

/**
 * Static group ordering — Starred pins first because it is the one filter the
 * user curates by hand, then high-signal → engagement → noise → safety.
 * `rankFilters` sorts *within* each group by match count, so this number is
 * what guarantees position; `BUILTIN_FILTERS` order is only a tie-break.
 */
const FILTER_GROUP: Record<BuiltinSmartFilter, number> = {
  starred: 0,
  important: 1,
  urgent: 1,
  security: 1,
  top_contacts: 2,
  quiet_contacts: 2,
  newsletters: 3,
  promotional: 3,
  low_priority: 3,
  unsafe: 4,
};

/** Score each built-in filter by how many inbox emails it matches, then sort within its group. */
/** `signals` must have been built against `profile`, otherwise it is ignored by the caller. */
export function rankFilters(
  inbox: RelayEmail[],
  trash: TrashRow[],
  profile?: UserProfile,
  signals?: SignalMap,
): typeof BUILTIN_FILTERS {
  const p = profile ?? buildUserProfile(inbox, trash);
  const sigs = inbox.map((email) => signalFor(signals, email, p));

  const counts: Record<string, number> = {};
  for (const filter of BUILTIN_FILTERS) {
    let n = 0;
    for (let i = 0; i < inbox.length; i++) {
      // `unsafe` is the one bucket whose members *are* the spam-scored rows, so
      // the skip below would zero its count and pin it to last in its group.
      // Every other bucket excludes spam on purpose — the strip shouldn't
      // advertise a count it would then hide.
      if (filter.id !== "unsafe" && sigs[i].spamLikelihood >= 0.4) continue;
      if (matchesBuiltin(filter.id, inbox[i], sigs[i], p)) n++;
    }
    counts[filter.id] = n;
  }

  return [...BUILTIN_FILTERS].sort((a, b) => {
    const ga = FILTER_GROUP[a.id];
    const gb = FILTER_GROUP[b.id];
    if (ga !== gb) return ga - gb;
    return counts[b.id] - counts[a.id];
  });
}
