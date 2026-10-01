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

import type { Email, EmailCategory } from "./email";

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
/**
 * How much one message from this category counts towards "a person you
 * correspond with".
 *
 * This exists because ranking on volume alone is wrong in a way a user notices
 * immediately: a retailer sending four promotions outranks two colleagues
 * writing three messages each, and the "Top contacts" bucket then shows
 * `deals@shop.example`. The Swift reference had the same defect — it ranked on
 * `count + starred * 2 - trashed * 0.35` and nothing else — and the port
 * faithfully reproduced it before this was added.
 *
 * The weights are deliberately lopsided. The failure mode to avoid is a colleague
 * dropping *out* of the top contacts because they write less often than a
 * newsletter, so `primary` is 1 and everything else is a discount rather than a
 * gate. `updates` sits at 0.5 rather than lower because Gmail files account
 * security notices there, and a sender whose mail is all security alerts should
 * not outrank a colleague — but should not vanish either.
 *
 * Gmail's category is used rather than the classifier's bulk verdict, because the
 * classifier needs this profile to run. Depending on it here would be circular.
 */
const CATEGORY_WEIGHT: Record<EmailCategory, number> = {
  primary: 1,
  // Real people, but through a platform: a mention is engagement, but a weaker
  // signal than a direct message.
  social: 0.6,
  // Where Gmail puts transactional and account mail. Neither bulk nor personal.
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
    trashStats.set(row.sender, (trashStats.get(row.sender) ?? 0) + 1);
  }

  const trashBiasBySender: Record<string, number> = {};
  const engagement: { sender: string; score: number; inbox: number }[] = [];

  for (const [sender, stats] of inboxStats) {
    const trashed = trashStats.get(sender) ?? 0;
    // Ratio of discarded to received, with +1 smoothing so a sender with one
    // binned message out of one is 0.5 rather than an infinite certainty.
    trashBiasBySender[sender] = trashed / (trashed + stats.count + 1);

    // Corresponded volume earns trust, a star earns more, trashing costs, and bulk
    // mail earns much less than its raw volume suggests. The 0.35 weight on
    // trashing means six binned messages offset a sender entirely — strong
    // enough to demote a spammer, not enough to erase an active contact.
    //
    // The discount is per message rather than a flat penalty on the sender,
    // because the two cases are genuinely different. A colleague who forwards
    // one newsletter among six replies is overwhelmingly a contact; a sender
    // whose entire output is promotions is not, and only a per-message
    // calculation can tell those apart.
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

  // Tied on score, ordered by sender name, for the same reason as the quiet tail
  // below: a contact ranking that varies between runs of the same inbox is not a
  // ranking, it is a shuffle.
  engagement.sort((a, b) => b.score - a.score || a.sender.localeCompare(b.sender));
  const topSenders = engagement.slice(0, 6).map((row) => row.sender);

  // "Quiet" is the rarest third, but only senders genuinely rare (≤ 2
  // messages) count — otherwise a large inbox would call its long tail quiet.
  //
  // Tied on volume, ordered by sender name. Without the tie-break this is
  // nondeterministic: a typical mailbox has a dozen senders with exactly one
  // message each, the cut falls somewhere among them, and which ones it fell
  // between depended on `Map` iteration order. The same mailbox then produced a
  // different "Quiet contacts" list on a different run, and the demo failed its
  // own fixture contract intermittently. A ranking that decides a user's mail is
  // hidden should not depend on insertion order.
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
