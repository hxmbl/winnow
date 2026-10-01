/**
 * The per-sender engagement profile.
 *
 * This is the layer that decides who "Top contacts" means and who "Quiet
 * contacts" means, and both of those were subtly wrong when this file was
 * written. The tests below are the record of that.
 */

import { describe, expect, it } from "vitest";
import {
  buildUserProfile,
  EMPTY_PROFILE,
  MAX_TRASH_BIAS,
  trashBiasFor,
} from "./profile";
import type { Email, EmailCategory } from "./email";

/** A minimal message from `sender`, `count` times over. */
function mail(
  sender: string,
  count: number,
  options: { category?: EmailCategory; starred?: boolean } = {},
): Email[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    gmailId: `${sender}-${index}`,
    sender,
    address: sender,
    name: sender.split("@")[0],
    subject: "a message",
    body: "a message body",
    receivedAt: 1_700_000_000_000 + index,
    mailbox: "inbox" as const,
    urgent: false,
    unread: false,
    starred: options.starred ?? false,
    category: options.category ?? "primary",
    attachments: [],
  }));
}

describe("buildUserProfile", () => {
  it("ranks a correspondent above a retailer sending the same volume", () => {
    // The defect this whole layer had. Ranking on volume alone put
    // `deals@shop.example` — four promotions — level with a colleague writing
    // four messages, and the demo's "Top contacts" bucket showed the retailer.
    // A user who sees that once stops trusting the bucket.
    // Six other correspondents, so the top-6 slice is actually a ranking rather
    // than the whole population. With only two senders both fit whatever their
    // scores, and the assertion would pass even with the discount removed.
    const profile = buildUserProfile(
      [
        ...mail("deals@shop.example", 4, { category: "promotions" }),
        ...mail("dana@northwind.example", 3),
        ...mail("marcus@northwind.example", 3),
        ...mail("priya@northwind.example", 3),
        ...mail("ana@northwind.example", 2),
        ...mail("sam@northwind.example", 2),
        ...mail("helena@quarrylane.example", 2),
      ],
      [],
    );

    expect(profile.topSenders[0]).toBe("dana@northwind.example");
    expect(profile.topSenders).not.toContain("deals@shop.example");
  });

  it("still counts bulk mail towards the quiet tail", () => {
    // The discount is on the *engagement score* only. "Quiet" is about how often
    // mail arrives, regardless of who it is from — a retailer sending one mail a
    // month is a quiet correspondent in the only sense that matters to a user
    // who never promoted it.
    const profile = buildUserProfile([...mail("deals@shop.example", 1)], []);
    expect(profile.quietSenders).toContain("deals@shop.example");
  });

  it("counts a promotion in the first-time list like any other message", () => {
    // Same reason: "new sender" is about novelty, not tone. Filtering bulk out
    // of this list would mean a user is never told about the newsletters that
    // just started arriving — which is precisely when they want to know.
    const profile = buildUserProfile(
      mail("deals@shop.example", 1, { category: "promotions" }),
      [],
    );
    expect(profile.firstTimeSenders).toContain("deals@shop.example");
  });

  it("keeps a colleague who forwards the occasional newsletter", () => {
    // The per-message discount has to be per *message*. A flat penalty on a
    // sender would push someone who forwards one digest among six real replies
    // out of their own top contacts, which is the failure the weight of 1.0 for
    // `primary` exists to prevent.
    const profile = buildUserProfile(
      [
        ...mail("dana@northwind.example", 6),
        ...mail("dana@northwind.example", 1, { category: "newsletter" }),
        ...mail("deals@shop.example", 7, { category: "promotions" }),
      ],
      [],
    );

    expect(profile.topSenders[0]).toBe("dana@northwind.example");
  });

  it("demotes a sender the user keeps binning", () => {
    const profile = buildUserProfile(
      [
        ...mail("deals@shop.example", 6, { category: "promotions" }),
        ...mail("marcus@northwind.example", 4),
        ...mail("priya@northwind.example", 4),
        ...mail("ana@northwind.example", 3),
        ...mail("sam@northwind.example", 3),
        ...mail("helena@quarrylane.example", 2),
        ...mail("tomas@fieldnotes.example", 2),
      ],
      [{ sender: "deals@shop.example" }, { sender: "deals@shop.example" }],
    );
    expect(profile.topSenders).not.toContain("deals@shop.example");
  });

  it("gives a binned-only sender a bias even with no inbox mail", () => {
    const profile = buildUserProfile([...mail("dana@northwind.example", 4)], [
      { sender: "nobody@example.com" },
    ]);
    expect(profile.trashBiasBySender["nobody@example.com"]).toBeGreaterThan(0);
  });

  it("keeps the bias unbounded in the profile but clamped where it is used", () => {
    // Two different things, easy to conflate. `trashBiasBySender` is a raw ratio
    // and is *meant* to approach 1 — it is the honest description of a sender
    // whose every message gets binned. `MAX_TRASH_BIAS` is where the classifier
    // clamps it, because a confidence that drives a score cannot also drive a
    // certainty. Asserting the clamp here would demand that the profile lie
    // about the ratio in order to satisfy a limit that belongs downstream.
    const profile = buildUserProfile(
      [],
      Array.from({ length: 50 }, () => ({ sender: "spam@x.example" })),
    );
    const raw = profile.trashBiasBySender["spam@x.example"];

    expect(raw).toBeGreaterThan(0.9);
    expect(trashBiasFor(profile, "spam@x.example")).toBeLessThanOrEqual(MAX_TRASH_BIAS);
    expect(trashBiasFor(profile, "spam@x.example")).toBeCloseTo(MAX_TRASH_BIAS, 5);
  });

  it("produces the same ranking every time", () => {
    // The quiet tail sorts by volume, and a typical mailbox has a dozen senders
    // with exactly one message each. Without a tie-break the cut falls among
    // them according to `Map` iteration order, so the same inbox produced a
    // different "Quiet contacts" list on a different run — and the demo failed
    // its own fixture intermittently. A ranking that decides what is hidden
    // cannot be a shuffle.
    const inbox = [
      ...mail("zeta@example.com", 1),
      ...mail("alpha@example.com", 1),
      ...mail("mike@example.com", 1),
      ...mail("bob@example.com", 1),
      ...mail("carol@example.com", 1),
      ...mail("dave@example.com", 1),
      ...mail("erin@example.com", 1),
      ...mail("frank@example.com", 1),
      ...mail("grace@example.com", 1),
    ];

    const first = buildUserProfile(inbox, []);
    for (let i = 0; i < 20; i += 1) {
      const again = buildUserProfile(inbox, []);
      expect(again.topSenders).toEqual(first.topSenders);
      expect(again.quietSenders).toEqual(first.quietSenders);
      expect(again.firstTimeSenders).toEqual(first.firstTimeSenders);
    }
  });

  it("does not reorder top contacts when the input is shuffled", () => {
    // The same property, from the other direction: the profile is a function of
    // the *set* of mail, not of the order it arrived in. Gmail's history order
    // is not stable across syncs, and a ranking that moved when nothing had
    // would show the user a different rail for no reason.
    const inbox = [
      ...mail("dana@northwind.example", 4),
      ...mail("marcus@northwind.example", 4),
      ...mail("priya@northwind.example", 3),
      ...mail("deals@shop.example", 4, { category: "promotions" }),
      ...mail("hello@newsupplier.example", 1),
    ];

    const ordered = buildUserProfile(inbox, []).topSenders;
    const shuffled = buildUserProfile([...inbox].reverse(), []).topSenders;
    expect(shuffled).toEqual(ordered);
  });

  it("handles an empty inbox without inventing anyone", () => {
    const profile = buildUserProfile([], []);
    expect(profile.topSenders).toEqual([]);
    expect(profile.quietSenders).toEqual([]);
    expect(profile.firstTimeSenders).toEqual([]);
    expect(profile.trashBiasBySender).toEqual({});
  });

  it("treats the empty profile as usable everywhere", () => {
    // `EMPTY_PROFILE` is what the classifier is given before any mail has been
    // seen, so it has to satisfy the same shape as a built one.
    expect(EMPTY_PROFILE.topSenders).toEqual([]);
    expect(EMPTY_PROFILE.quietSenders).toEqual([]);
  });
});