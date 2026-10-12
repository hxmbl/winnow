/**
 * The contact index: what the mail in the store says about who the user knows.
 *
 * Every fixture address here is `example.com` or `.test`, so a test failure can never
 * reach a real person — and the corpus is built by hand rather than seeded from the demo,
 * because the demo has a profile and a rail attached to it and this is about the index.
 */

import { describe, expect, it } from "vitest";
import { buildContactIndex, matchKey, recency, SENT_WEIGHT } from "./index";
import type { Contact } from "../model/email";
import type { Email } from "../model/email";

const DAY = 24 * 60 * 60 * 1000;

/** The reference instant every fixture is measured back from. */
const NOW = Date.UTC(2026, 4, 9, 18, 0, 0);

let nextId = 1;

function mail(over: Partial<Email> = {}): Email {
  return {
    id: nextId++,
    gmailId: `m${nextId}`,
    sender: "someone@example.com",
    mailbox: "inbox",
    receivedAt: NOW,
    subject: "hello",
    body: "",
    category: "primary",
    starred: false,
    unread: false,
    attachments: [],
    urgent: false,
    ...over,
  };
}

function contact(address: string, name?: string): Contact {
  return { address, name };
}

describe("buildContactIndex — deduplication", () => {
  it("makes one row per address however many messages mention it", () => {
    const index = buildContactIndex([
      mail({ sender: "ada@example.com", name: "Ada Lovelace" }),
      mail({ sender: "ada@example.com", name: "Ada Lovelace", receivedAt: NOW - DAY }),
    ]);
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0].received).toBe(2);
  });

  it("counts a message once, even when somebody is on two of its header lines", () => {
    // A To/Cc pair is one interaction. Counting it twice lets a mailing list outrank a
    // colleague on the strength of a single mail.
    const index = buildContactIndex([
      mail({ sender: "boss@example.com", to: [contact("ada@example.com")], cc: [contact("ada@example.com")] }),
    ]);
    expect(index.byAddress.get("ada@example.com")?.received).toBe(1);
  });

  it("treats the same address at two cases as one contact", () => {
    const index = buildContactIndex([
      mail({ sender: "Ada@Example.com", name: "Ada" }),
      mail({ sender: "ada@example.com", name: "Ada", receivedAt: NOW - DAY }),
    ]);
    expect(index.entries).toHaveLength(1);
  });

  it("keeps two people at one domain apart", () => {
    const index = buildContactIndex([
      mail({ sender: "ada@example.com", name: "Ada" }),
      mail({ sender: "grace@example.com", name: "Grace" }),
    ]);
    expect(index.entries).toHaveLength(2);
  });

  it("reads every header: sender, To, Cc and Bcc", () => {
    const index = buildContactIndex([
      mail({
        mailbox: "sent",
        sender: "me@example.com",
        to: [contact("ada@example.com", "Ada Lovelace")],
        cc: [contact("grace@example.com", "Grace Hopper")],
        bcc: [contact("alan@example.com")],
        receivedAt: NOW - DAY,
      }),
      mail({ sender: "alan@example.com", name: "Alan Turing", receivedAt: NOW }),
    ]);

    expect([...index.byAddress.keys()].sort()).toEqual([
      "ada@example.com",
      "alan@example.com",
      "grace@example.com",
    ]);
    expect(index.byAddress.get("ada@example.com")?.name).toBe("Ada Lovelace");
    expect(index.byAddress.get("grace@example.com")?.name).toBe("Grace Hopper");
    // Bcc on one message and a message from the same person are two interactions.
    expect(index.byAddress.get("alan@example.com")?.received).toBe(1);
    expect(index.byAddress.get("alan@example.com")?.sent).toBe(1);
  });

  it("keeps a name that only some messages carried", () => {
    const index = buildContactIndex([
      mail({ sender: "ada@example.com" }),
      mail({ sender: "ada@example.com", name: "Ada Lovelace", receivedAt: NOW - DAY }),
    ]);
    expect(index.byAddress.get("ada@example.com")?.name).toBe("Ada Lovelace");
  });

  it("leaves the name undefined rather than inventing one", () => {
    const index = buildContactIndex([mail({ sender: "ada@example.com" })]);
    expect(index.byAddress.get("ada@example.com")?.name).toBeUndefined();
  });

  it("files a renamed address under its newest spelling", () => {
    // Two rows, because two addresses are two contact entries — but each carries the
    // name of the message that last used *it*, rather than the newer message's name
    // being stamped on the older address as well.
    const index = buildContactIndex([
      mail({ sender: "ada@old.example.com", name: "Ada", receivedAt: NOW - 10 * DAY }),
      mail({ sender: "ada@example.com", name: "Ada Lovelace", receivedAt: NOW - DAY }),
    ]);
    expect(index.byAddress.get("ada@example.com")?.name).toBe("Ada Lovelace");
    expect(index.byAddress.get("ada@example.com")?.address).toBe("ada@example.com");
    expect(index.byAddress.get("ada@old.example.com")?.name).toBe("Ada");
  });
});

describe("buildContactIndex — excluding the user", () => {
  it("excludes the address given for the account", () => {
    const index = buildContactIndex(
      [mail({ sender: "ada@example.com" }), mail({ sender: "me@example.com" })],
      { selfAddress: "me@example.com" },
    );
    expect(index.byAddress.has("me@example.com")).toBe(false);
    expect(index.byAddress.has("ada@example.com")).toBe(true);
  });

  it("excludes it whatever its case", () => {
    const index = buildContactIndex(
      [mail({ sender: "ME@Example.com" }), mail({ sender: "ada@example.com" })],
      { selfAddress: "me@example.com" },
    );
    expect(index.self.has("me@example.com")).toBe(true);
    expect([...index.byAddress.keys()]).toEqual(["ada@example.com"]);
  });

  it("infers the account from sent mail, which is what the demo has", () => {
    // `state.account` is null in the demo, and suggesting somebody to write to at
    // themselves is the one result that makes the feature look broken.
    const index = buildContactIndex([
      mail({ mailbox: "sent", sender: "me@example.com", to: [contact("ada@example.com")] }),
      mail({ sender: "me@example.com", to: [contact("grace@example.com")] }),
    ]);
    expect(index.self.has("me@example.com")).toBe(true);
    expect(index.byAddress.has("me@example.com")).toBe(false);
    expect([...index.byAddress.keys()].sort()).toEqual(["ada@example.com", "grace@example.com"]);
  });

  it("excludes the account from its own recipient lines as well", () => {
    const index = buildContactIndex([
      mail({
        mailbox: "sent",
        sender: "me@example.com",
        to: [contact("ada@example.com")],
        cc: [contact("me@example.com")],
      }),
    ]);
    expect(index.byAddress.has("me@example.com")).toBe(false);
  });
});

describe("buildContactIndex — ranking", () => {
  it("weights mail you wrote above mail you received", () => {
    // The whole point of having a Sent folder. Without this, a recipient list ranks
    // purely by who has written to you most recently and often, which is a newsletter.
    const index = buildContactIndex([
      mail({ mailbox: "sent", sender: "me@example.com", to: [contact("wrote@example.com")] }),
      mail({ sender: "heard@example.com" }),
    ]);
    expect(index.entries[0].address).toBe("wrote@example.com");
  });

  it("discounts received mail by category, so bulk cannot win on volume", () => {
    // Six promotions are six messages and a tenth of the weight of six personal ones.
    // The table is the engagement profile's, not a second one: the profile ranks senders
    // and this ranks recipients, and they must agree about who a contact is.
    const index = buildContactIndex([
      ...Array.from({ length: 6 }, (_, i) =>
        mail({ sender: "deals@shop.example", category: "promotions", receivedAt: NOW - i * DAY }),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        mail({ sender: "ada@example.com", category: "primary", receivedAt: NOW - i * DAY }),
      ),
    ]);
    expect(index.entries[0].address).toBe("ada@example.com");
    expect(index.byAddress.get("ada@example.com")!.received).toBe(6);
    expect(index.byAddress.get("deals@shop.example")!.received).toBeCloseTo(0.6, 5);
  });

  it("lets repeated mail beat a single message, even a sent one", () => {
    const index = buildContactIndex([
      mail({ sender: "me@example.com", mailbox: "sent", to: [contact("once@example.com")] }),
      mail({ sender: "me@example.com", mailbox: "sent", to: [contact("often@example.com")], receivedAt: NOW - DAY }),
      mail({ sender: "me@example.com", mailbox: "sent", to: [contact("often@example.com")], receivedAt: NOW - 2 * DAY }),
      mail({ sender: "me@example.com", mailbox: "sent", to: [contact("often@example.com")], receivedAt: NOW - 3 * DAY }),
    ]);
    expect(index.entries[0].address).toBe("often@example.com");
  });

  it("does not let an old pile of mail outrank recent contact", () => {
    const stale = Array.from({ length: 8 }, (_, i) =>
      mail({ sender: "stale@example.com", receivedAt: NOW - (300 + i) * DAY }),
    );
    const index = buildContactIndex([
      ...stale,
      mail({ sender: "fresh@example.com", receivedAt: NOW - DAY }),
      mail({ sender: "fresh@example.com", receivedAt: NOW - 2 * DAY }),
    ]);
    expect(index.entries[0].address).toBe("fresh@example.com");
  });

  it("decays against the newest message in the corpus, not the wall clock", () => {
    // An inbox that re-ranked itself overnight is impossible to reason about, and a
    // cached mailbox would otherwise flatten the first time it was opened.
    const old: Email[] = [
      mail({ sender: "recent@example.com", receivedAt: Date.UTC(2020, 0, 1) }),
      mail({ sender: "recent@example.com", receivedAt: Date.UTC(2020, 0, 2) }),
      mail({ sender: "recent@example.com", receivedAt: Date.UTC(2020, 0, 3) }),
      mail({ sender: "stale@example.com", receivedAt: Date.UTC(2019, 0, 1) }),
      mail({ sender: "stale@example.com", receivedAt: Date.UTC(2019, 0, 1) }),
      mail({ sender: "stale@example.com", receivedAt: Date.UTC(2019, 0, 1) }),
    ];
    const index = buildContactIndex(old);
    expect(index.reference).toBe(Date.UTC(2020, 0, 3));
    expect(index.entries[0].address).toBe("recent@example.com");
  });

  it("breaks a tie by address, so the same mail always ranks the same way", () => {
    const index = buildContactIndex([
      mail({ sender: "zoe@example.com", receivedAt: NOW - DAY }),
      mail({ sender: "adam@example.com", receivedAt: NOW - DAY }),
    ]);
    expect(index.entries.map((entry) => entry.address)).toEqual([
      "adam@example.com",
      "zoe@example.com",
    ]);
  });

  it("counts a message you wrote for twice one you received", () => {
    // Twice, not more: bulk is already discounted by category, so a large multiple would
    // be solving that problem twice and would let one message you happened to send
    // outrank a correspondence you have been having for months.
    expect(SENT_WEIGHT).toBe(2);
    const sent = buildContactIndex([
      mail({ mailbox: "sent", sender: "me@example.com", to: [contact("x@example.com")], receivedAt: NOW }),
    ]).byAddress.get("x@example.com")!;
    const received = buildContactIndex([
      mail({ sender: "x@example.com", category: "primary", receivedAt: NOW }),
    ]).byAddress.get("x@example.com")!;
    expect(sent.score).toBeCloseTo(received.score * SENT_WEIGHT, 10);
    expect(sent.sent).toBe(1);
    expect(received.sent).toBe(0);
    expect(received.received).toBe(1);
  });

  it("is empty for an empty mailbox rather than throwing", () => {
    const index = buildContactIndex([]);
    expect(index.entries).toEqual([]);
    expect(index.reference).toBe(0);
  });
});

describe("recency", () => {
  it("is full weight for the reference instant", () => {
    expect(recency(NOW, NOW)).toBe(1);
  });

  it("halves over the half-life", () => {
    expect(recency(NOW - 45 * DAY, NOW)).toBeCloseTo(0.5, 5);
  });

  it("never goes below zero, even for a message from the future", () => {
    // Clock skew between a sender and this machine must not produce a negative weight and
    // sort somebody to the bottom of their own mailbox.
    expect(recency(NOW + 10 * DAY, NOW)).toBeCloseTo(1, 5);
  });
});

describe("matchKey", () => {
  it("exposes folded local part, domain and name words", () => {
    const index = buildContactIndex([mail({ sender: "Tomás@Quarrylane.example", name: "Tomás Lindqvist" })]);
    const key = matchKey(index.entries[0]);
    expect(key.local).toBe("tomas");
    expect(key.domain).toBe("quarrylane.example");
    expect(key.words).toEqual(["tomas", "lindqvist"]);
  });

  it("splits a name on punctuation, so either half is findable", () => {
    const index = buildContactIndex([mail({ sender: "ada@example.com", name: "Ng, Alex" })]);
    expect(matchKey(index.entries[0]).words).toEqual(["ng", "alex"]);
  });

  it("has no words for a contact with no name", () => {
    const index = buildContactIndex([mail({ sender: "ada@example.com" })]);
    expect(matchKey(index.entries[0]).words).toEqual([]);
  });
});