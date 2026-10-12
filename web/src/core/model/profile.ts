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

export function buildUserProfile(inbox: readonly Email[], trash: readonly TrashRecord[]): UserProfile {
  const inboxStats = new Map<
    string,
    { count: number; starred: number; correspondence: number }
  >();
  for (const email of inbox) {
    const current = inboxStats.get(email.sender) ?? {
      count: 0,
      starred: 0,
      correspondence: 0,
    };
    current.count += 1;
    current.correspondence += CATEGORY_WEIGHT[email.category];
    if (email.starred) current.starred += 1;
    inboxStats.set(email.sender, current);
  }

  const trashStats = new Map<string, number>();
  for (const row of trash) {
    trashStats.set(row.sender, (trashStats.get(row.sender) ?? 0) + (row.count ?? 1));
  }

  const trashBiasBySender: Record<string, number> = {};
  const engagement: { sender: string; score: number; inbox: number }[] = [];

  for (const [sender, stats] of inboxStats) {
    const trashed = trashStats.get(sender) ?? 0;
    trashBiasBySender[sender] = trashed / (trashed + stats.count + 1);
    engagement.push({
      sender,
      score: stats.correspondence + stats.starred * 2 - trashed * 0.35,
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
