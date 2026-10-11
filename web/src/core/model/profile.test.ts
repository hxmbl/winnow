

import { describe, expect, it } from "vitest";
import {
  buildUserProfile,
  EMPTY_PROFILE,
  MAX_TRASH_BIAS,
  trashBiasFor,
} from "./profile";
import type { Email, EmailCategory } from "./email";

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
    const profile = buildUserProfile([...mail("deals@shop.example", 1)], []);
    expect(profile.quietSenders).toContain("deals@shop.example");
  });

  it("counts a promotion in the first-time list like any other message", () => {
    const profile = buildUserProfile(
      mail("deals@shop.example", 1, { category: "promotions" }),
      [],
    );
    expect(profile.firstTimeSenders).toContain("deals@shop.example");
  });

  it("keeps a colleague who forwards the occasional newsletter", () => {
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
    expect(EMPTY_PROFILE.topSenders).toEqual([]);
    expect(EMPTY_PROFILE.quietSenders).toEqual([]);
  });
});