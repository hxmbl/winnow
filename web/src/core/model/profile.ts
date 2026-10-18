/** Per-sender engagement profile inferred from inbox/trash counts. */

import type { Email, EmailCategory } from "./email";

/** Max trash bias influence (read only via `trashBiasFor`). */
export const MAX_TRASH_BIAS = 0.35;

export type UserProfile = {
  trashBiasBySender: Readonly<Record<string, number>>;
  topSenders: readonly string[];
  quietSenders: readonly string[];
  firstTimeSenders: readonly string[];
};

export const EMPTY_PROFILE: UserProfile = {
  trashBiasBySender: {},
  topSenders: [],
  quietSenders: [],
  firstTimeSenders: [],
};

/**
 * Whether two profiles say the same thing, field by field. The store uses it to keep a
 * classification across a change to `all` that did not move the profile (a message
 * read or archived), since classification is a pure function of message and profile.
 */
export function sameProfile(a: UserProfile, b: UserProfile): boolean {
  if (a === b) return true;
  const list = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  if (!list(a.topSenders, b.topSenders) || !list(a.quietSenders, b.quietSenders) || !list(a.firstTimeSenders, b.firstTimeSenders)) {
    return false;
  }
  const ka = Object.keys(a.trashBiasBySender);
  if (ka.length !== Object.keys(b.trashBiasBySender).length) return false;
  return ka.every((key) => a.trashBiasBySender[key] === b.trashBiasBySender[key]);
}

/** Sender discard rate, capped (only way to read trashBiasBySender). */
export function trashBiasFor(profile: UserProfile, sender: string): number {
  return Math.min(profile.trashBiasBySender[sender] ?? 0, MAX_TRASH_BIAS);
}

/** Engagement tier matching classify.ts bonus ladder: 0,1,2,3 (unranked). */
export function tierFor(profile: UserProfile, sender: string): number {
  const rank = profile.topSenders.indexOf(sender);
  if (rank === 0) return 0;
  if (rank >= 1 && rank <= 2) return 1;
  if (rank >= 3 && rank < 6) return 2;
  return 3;
}

/** Trashed sender contribution (count aggregated). */
export type TrashRecord = { sender: string; count?: number };

/**
 * Engagement weight by Gmail category (discounted relative to primary).
 * Primary=1; others discounted to avoid newsletters outranking contacts.
 *
 * Exported because the contact index discounts the same way, and two answers to "how much
 * is a message from this person worth" would drift — the profile ranks senders and the
 * recipient list ranks recipients, and they must agree about who a contact is.
 */
export const CATEGORY_WEIGHT: Record<EmailCategory, number> = {
  primary: 1,
  social: 0.6,
  updates: 0.5,
  reservations: 0.4,
  receipts: 0.4,
  forums: 0.3,
  newsletter: 0.15,
  promotions: 0.1,
};

/**
 * What the profile is built from, per sender: the inbox counted by category (integers, so
 * adding and removing a message is exact and lands where a fresh count would), and the
 * trash counts. `buildUserProfile` and the incremental path both go through it, so the
 * two cannot disagree.
 */
export type SenderStats = {
  count: number;
  starred: number;
  /** Messages per Gmail category, for the weighted correspondence score. */
  byCategory: Partial<Record<EmailCategory, number>>;
};

export type ProfileStats = {
  inbox: ReadonlyMap<string, SenderStats>;
  trash: ReadonlyMap<string, number>;
};

/** The category order the correspondence sum runs in: fixed, so it is reproducible. */
const CATEGORIES = Object.keys(CATEGORY_WEIGHT) as EmailCategory[];

function addTo(stats: Map<string, SenderStats>, email: Email, sign: 1 | -1): void {
  const current = stats.get(email.sender);
  const next: SenderStats = current
    ? { count: current.count, starred: current.starred, byCategory: { ...current.byCategory } }
    : { count: 0, starred: 0, byCategory: {} };
  next.count += sign;
  if (email.starred) next.starred += sign;
  next.byCategory[email.category] = (next.byCategory[email.category] ?? 0) + sign;
  if (next.count <= 0) stats.delete(email.sender);
  else stats.set(email.sender, next);
}

function trashMap(trash: readonly TrashRecord[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of trash) out.set(row.sender, (out.get(row.sender) ?? 0) + (row.count ?? 1));
  return out;
}

/** Count an inbox and a trash log from scratch. */
export function profileStats(inbox: readonly Email[], trash: readonly TrashRecord[]): ProfileStats {
  const stats = new Map<string, SenderStats>();
  for (const email of inbox) addTo(stats, email, 1);
  return { inbox: stats, trash: trashMap(trash) };
}

/**
 * The same counts after some messages left the inbox and some arrived (a changed message
 * is one of each), with a fresh trash log. Touches only the senders involved; `previous`
 * is not modified.
 */
export function updateProfileStats(
  previous: ProfileStats,
  removed: readonly Email[],
  added: readonly Email[],
  trash: readonly TrashRecord[],
): ProfileStats {
  const stats = new Map(previous.inbox);
  for (const email of removed) addTo(stats, email, -1);
  for (const email of added) addTo(stats, email, 1);
  return { inbox: stats, trash: trashMap(trash) };
}

/** The profile the counts describe: biases per sender, then the rankings over senders. */
export function profileFromStats({ inbox: inboxStats, trash: trashStats }: ProfileStats): UserProfile {
  const trashBiasBySender: Record<string, number> = {};
  const engagement: { sender: string; score: number; inbox: number }[] = [];

  for (const [sender, stats] of inboxStats) {
    const trashed = trashStats.get(sender) ?? 0;
    trashBiasBySender[sender] = trashed / (trashed + stats.count + 1);
    let correspondence = 0;
    for (const category of CATEGORIES) {
      const n = stats.byCategory[category];
      if (n) correspondence += n * CATEGORY_WEIGHT[category];
    }
    engagement.push({
      sender,
      score: correspondence + stats.starred * 2 - trashed * 0.35,
      inbox: stats.count,
    });
  }

  // Trash-only senders still get a bias, just no engagement.
  for (const [sender, count] of trashStats) {
    if (inboxStats.has(sender)) continue;
    trashBiasBySender[sender] = count / (count + 1);
  }

  engagement.sort((a, b) => b.score - a.score || a.sender.localeCompare(b.sender));
  const topSenders = engagement.slice(0, 6).map((row) => row.sender);
  const byVolume = [...engagement].sort(
    (a, b) => a.inbox - b.inbox || a.sender.localeCompare(b.sender),
  );
  const quietCut = Math.max(1, Math.ceil(byVolume.length / 3));
  const quietSenders = byVolume
    .slice(0, quietCut)
    .filter((row) => row.inbox <= 2)
    .map((row) => row.sender);

  const firstTimeSenders = engagement
    .filter((row) => row.inbox === 1 && (trashStats.get(row.sender) ?? 0) === 0)
    .map((row) => row.sender)
    .sort();

  return { trashBiasBySender, topSenders, quietSenders, firstTimeSenders };
}

export function buildUserProfile(inbox: readonly Email[], trash: readonly TrashRecord[]): UserProfile {
  return profileFromStats(profileStats(inbox, trash));
}

/**
 * The senders whose messages classify differently under `next` than under `previous`.
 *
 * The classifier reads the profile through exactly three per-sender questions: the capped
 * trash bias (`trashBiasFor`), the rank tier (`tierFor`, which `senderRankBonus` mirrors)
 * and whether the sender is quiet. A sender for whom all three answers are unchanged gets
 * the same signals for every message, so only the senders returned here need
 * reclassifying, including any whose top-sender or quiet status flipped because someone
 * else's counts moved. `firstTimeSenders` is not read by the classifier.
 */
export function sendersReclassifiedBy(previous: UserProfile, next: UserProfile): Set<string> {
  const candidates = new Set<string>([
    ...Object.keys(previous.trashBiasBySender),
    ...Object.keys(next.trashBiasBySender),
    ...previous.topSenders,
    ...next.topSenders,
    ...previous.quietSenders,
    ...next.quietSenders,
  ]);
  const quietBefore = new Set(previous.quietSenders);
  const quietAfter = new Set(next.quietSenders);
  const changed = new Set<string>();
  for (const sender of candidates) {
    if (
      trashBiasFor(previous, sender) !== trashBiasFor(next, sender) ||
      tierFor(previous, sender) !== tierFor(next, sender) ||
      quietBefore.has(sender) !== quietAfter.has(sender)
    ) {
      changed.add(sender);
    }
  }
  return changed;
}
