/**
 * The per-sender engagement profile.
 *
 * Winnow has no account to learn from, so it infers one: who you actually
 * read, who you keep, and who you bin. Everything here is a *rule* over counts
 * — no model, no training set. That is a deliberate constraint, because the
 * alternative (learning from feedback alone) needs hundreds of events before
 * it beats "you starred six things from this person".
 *
 * Ported from `legacy/swift-native/Sources/winnow/Classification/ProfileBuilder.swift`
 * and `Models/UserProfile.swift`.
 */

import type { Email } from "./email";

/**
 * Cap on how much trash bias can influence anything.
 *
 * A sender you bin fifty times out of fifty-one is not a rounding error; but
 * without a cap, that one sender would drag the whole ranking. 0.35 keeps the
 * signal real and bounded, and `trashBiasFor` is the only way to read it, so
 * the cap cannot be forgotten at a call site.
 */
export const MAX_TRASH_BIAS = 0.35;

export type UserProfile = {
  /** How often each sender is discarded, relative to how often they arrive. */
  trashBiasBySender: Readonly<Record<string, number>>;
  /** Highest-engagement senders: volume, doubled for stars, minus trashing. */
  topSenders: readonly string[];
  /** Rare senders still in the inbox — the cold tail of the habit curve. */
  quietSenders: readonly string[];
  /** One message, never binned: cold outreach rather than a faded contact. */
  firstTimeSenders: readonly string[];
};

/** An empty profile, for an inbox that has not loaded yet. */
export const EMPTY_PROFILE: UserProfile = {
  trashBiasBySender: {},
  topSenders: [],
  quietSenders: [],
  firstTimeSenders: [],
};

/** A sender's discard rate, capped. The only way to read `trashBiasBySender`. */
export function trashBiasFor(profile: UserProfile, sender: string): number {
  return Math.min(profile.trashBiasBySender[sender] ?? 0, MAX_TRASH_BIAS);
}

/**
 * Engagement tier, matching the bonus ladder in `classify.ts`:
 * 0 = the most-engaged sender, 1 = ranks 1–2, 2 = ranks 3–5, 3 = unranked.
 */
export function tierFor(profile: UserProfile, sender: string): number {
  const rank = profile.topSenders.indexOf(sender);
  if (rank === 0) return 0;
  if (rank >= 1 && rank <= 2) return 1;
  if (rank >= 3 && rank < 6) return 2;
  return 3;
}

/** The three profile inputs that feed classification for one sender. */
export type Standing = {
  tier: number;
  isQuiet: boolean;
  trashBias: number;
};

export function standingFor(profile: UserProfile, sender: string): Standing {
  return {
    tier: tierFor(profile, sender),
    isQuiet: profile.quietSenders.includes(sender),
    trashBias: trashBiasFor(profile, sender),
  };
}

/**
 * A trashed message's contribution to the profile.
 *
 * Only the sender matters. Winnow does not keep the body of something the user
 * binned — the discard *is* the signal, and retaining the mail to learn from
 * it would be both a privacy problem and a distraction.
 */
export type TrashRecord = { sender: string };

/**
 * Build the profile from the current inbox and trash.
 *
 * Recomputed whenever the inbox changes, which is why it takes the whole array
 * rather than an event: the ranking depends on the *set*, so an incremental
 * update would need the inverse operation too. The pass is O(inbox + trash).
 */
export function buildUserProfile(inbox: readonly Email[], trash: readonly TrashRecord[]): UserProfile {
  const inboxStats = new Map<string, { count: number; starred: number }>();
  for (const email of inbox) {
    const current = inboxStats.get(email.sender) ?? { count: 0, starred: 0 };
    current.count += 1;
    if (email.starred) current.starred += 1;
    inboxStats.set(email.sender, current);
  }

  const trashStats = new Map<string, number>();
  for (const row of trash) {
    trashStats.set(row.sender, (trashStats.get(row.sender) ?? 0) + 1);
  }

  const trashBiasBySender: Record<string, number> = {};
  const engagement: { sender: string; score: number; inbox: number }[] = [];

  for (const [sender, stats] of inboxStats) {
    const trashed = trashStats.get(sender) ?? 0;
    // Ratio of discarded to received, with +1 smoothing so a sender with one
    // binned message out of one is 0.5 rather than an infinite certainty.
    trashBiasBySender[sender] = trashed / (trashed + stats.count + 1);

    // Volume earns trust, a star earns more, and trashing costs. The 0.35
    // weight means six binned messages offset a sender entirely — strong
    // enough to demote a spammer, not enough to erase an active contact.
    engagement.push({
      sender,
      score: stats.count + stats.starred * 2 - trashed * 0.35,
      inbox: stats.count,
    });
  }

  // Trash-only senders still get a bias, just no engagement.
  for (const [sender, count] of trashStats) {
    if (inboxStats.has(sender)) continue;
    trashBiasBySender[sender] = count / (count + 1);
  }

  engagement.sort((a, b) => b.score - a.score);
  const topSenders = engagement.slice(0, 6).map((row) => row.sender);

  // "Quiet" is the rarest third, but only senders genuinely rare (≤ 2
  // messages) count — otherwise a large inbox would call its long tail quiet.
  const byVolume = [...engagement].sort((a, b) => a.inbox - b.inbox);
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
