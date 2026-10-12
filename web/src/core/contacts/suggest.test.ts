/**
 * Matching a query, and choosing who to offer.
 *
 * The cap of eight and the exclusion rule are asserted as facts rather than left to the
 * implementation, because both are decisions: eight is what is readable in the composer
 * without scrolling, and somebody already on the To line is not a suggestion however
 * often they were written to.
 */

import { describe, expect, it } from "vitest";
import { buildContactIndex } from "./index";
import {
  chipLabel,
  isAlreadyOnMessage,
  MAX_SUGGESTIONS,
  matchScore,
  suggestContacts,
} from "./suggest";
import { matchKey } from "./index";
import { foldText } from "./addresses";
import type { Contact, Email } from "../model/email";

const DAY = 24 * 60 * 60 * 1000;
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

/** The address of the nth suggestion. */
function addresses(rows: ReturnType<typeof suggestContacts>): string[] {
  return rows.map((row) => row.address);
}

/**
 * Fit for a query against one address, or `null`.
 *
 * Folds first, the way `suggestContacts` does — `matchScore` takes an already-folded
 * query because it runs once per candidate and folding is not free.
 */
function fitFor(address: string, name: string | undefined, query: string): number | null {
  const index = buildContactIndex([mail({ sender: address, name })]);
  return matchScore(matchKey(index.entries[0]), foldText(query));
}

describe("matchScore", () => {
  it("matches everything on an empty query", () => {
    // What somebody reaching for the To field before they have decided who it is for
    // wants is the people they write to most.
    expect(fitFor("ada@example.com", "Ada", "")).toBe(1);
  });

  it("matches a name by prefix, by word, and inside it", () => {
    expect(fitFor("ada@example.com", "Ada Lovelace", "ada")).toBeGreaterThan(0);
    expect(fitFor("ada@example.com", "Ada Lovelace", "love")).toBeGreaterThan(0);
    expect(fitFor("ada@example.com", "Ada Lovelace", "lovela")).toBeGreaterThan(0);
  });

  it("matches the local part and the domain", () => {
    expect(fitFor("ada@example.com", undefined, "ada")).toBeGreaterThan(0);
    expect(fitFor("ada@example.com", undefined, "example")).toBeGreaterThan(0);
    expect(fitFor("ada@northwind.example", undefined, "northwind")).toBeGreaterThan(0);
  });

  it("prefers a prefix to a substring at the same level", () => {
    // `ada` starts the name; `ovel` is inside it. Same field, different evidence, and the
    // one that starts it is the better guess.
    expect(fitFor("ada@example.com", "Ada Lovelace", "ada")!).toBeGreaterThan(
      fitFor("ada@example.com", "Ada Lovelace", "ovel")!,
    );
    expect(fitFor("ada@example.com", undefined, "exa")!).toBeGreaterThan(
      fitFor("ada@example.com", undefined, "ample")!,
    );
  });

  it("prefers a name match to a local-part match", () => {
    expect(fitFor("grace@example.com", "Grace Hopper", "gra")!).toBeGreaterThan(
      fitFor("grace@example.com", undefined, "gra")!,
    );
  });

  it("prefers a local-part match to a domain match", () => {
    expect(fitFor("ada@example.com", undefined, "ada")!).toBeGreaterThan(
      fitFor("ada@example.com", undefined, "example")!,
    );
  });

  it("matches an address once there is an `@`, and ignores the name", () => {
    // `ada@` is a statement about the address. Offering a Grace because her *name*
    // starts with "ada" would be actively unhelpful.
    expect(fitFor("ada@example.com", "Ada", "ada@")).toBeGreaterThan(0);
    expect(fitFor("grace@example.com", "Ada Lovelace", "ada@")).toBeNull();
  });

  it("matches inside an address once there is an `@`", () => {
    expect(fitFor("ada@example.com", undefined, "da@ex")).toBeGreaterThan(0);
  });

  it("finds an accented name without the accent", () => {
    expect(fitFor("tomas@example.test", "Tomás Lindqvist", "tomas")).toBeGreaterThan(0);
    expect(fitFor("tomas@example.test", "Tomás Lindqvist", "lind")).toBeGreaterThan(0);
  });

  it("is case-insensitive throughout", () => {
    expect(fitFor("ada@example.com", "Ada Lovelace", "LOVELACE")!).toBeGreaterThan(0);
    expect(fitFor("ada@example.com", undefined, "EXAMPLE")!).toBeGreaterThan(0);
  });

  it("does not match something that is simply not there", () => {
    expect(fitFor("ada@example.com", "Ada Lovelace", "zebra")).toBeNull();
  });
});

describe("suggestContacts", () => {
  const index = buildContactIndex([
    mail({ sender: "ada@example.com", name: "Ada Lovelace", receivedAt: NOW - DAY }),
    mail({ sender: "ada@example.com", name: "Ada Lovelace", receivedAt: NOW - 2 * DAY }),
    mail({ sender: "grace@example.com", name: "Grace Hopper", receivedAt: NOW - DAY }),
    mail({
      mailbox: "sent",
      sender: "me@example.com",
      to: [contact("priya@example.com", "Priya Raman")],
      receivedAt: NOW - 3 * DAY,
    }),
  ]);

  it("offers the most likely first", () => {
    expect(addresses(suggestContacts(index, ""))[0]).toBe("ada@example.com");
  });

  it("puts somebody you have written to above somebody who wrote to you", () => {
    expect(addresses(suggestContacts(index, ""))).toEqual([
      "ada@example.com",
      "priya@example.com",
      "grace@example.com",
    ]);
  });

  it("returns nothing for a query nothing matches", () => {
    expect(suggestContacts(index, "zebra")).toEqual([]);
  });

  it("offers at most eight", () => {
    const many = buildContactIndex(
      Array.from({ length: 30 }, (_, i) =>
        mail({ sender: `person${i}@example.com`, receivedAt: NOW - i * 1000 }),
      ),
    );
    expect(suggestContacts(many, "")).toHaveLength(MAX_SUGGESTIONS);
    expect(MAX_SUGGESTIONS).toBe(8);
  });

  it("excludes an address already on the message", () => {
    expect(addresses(suggestContacts(index, "", { exclude: ["ada@example.com"] }))).toEqual([
      "priya@example.com",
      "grace@example.com",
    ]);
  });

  it("excludes however the address is cased", () => {
    expect(addresses(suggestContacts(index, "", { exclude: ["ADA@Example.com"] }))).not.toContain(
      "ada@example.com",
    );
  });

  it("excludes on a query as well as on an empty one", () => {
    expect(addresses(suggestContacts(index, "ada", { exclude: ["ada@example.com"] }))).toEqual([]);
  });

  it("carries the display name through to the suggestion", () => {
    expect(suggestContacts(index, "grace")).toEqual([
      { address: "grace@example.com", name: "Grace Hopper", reason: "name" },
    ]);
  });

  it("says why a row matched, so the list can explain itself", () => {
    expect(suggestContacts(index, "lovelace")[0].reason).toBe("name");
    expect(suggestContacts(index, "grace@")[0].reason).toBe("address");
    expect(suggestContacts(index, "north")[0]?.reason).toBeUndefined();
  });

  it("returns the same list for the same query, twice", () => {
    // A ranking that decides what is offered cannot be a shuffle; two identical
    // keystrokes must not produce two different lists under the user.
    expect(addresses(suggestContacts(index, "a"))).toEqual(addresses(suggestContacts(index, "a")));
  });

  it("offers the best name match above the best domain match", () => {
    const both = buildContactIndex([
      mail({ sender: "ada@other.example", name: "Ada Lovelace", receivedAt: NOW }),
      mail({ sender: "zed@ada.example", name: "Zed", receivedAt: NOW }),
    ]);
    expect(addresses(suggestContacts(both, "ada"))[0]).toBe("ada@other.example");
  });
});

describe("chipLabel", () => {
  const index = buildContactIndex([mail({ sender: "ada@example.com", name: "Ada Lovelace" })]);

  it("prefers a name the index has", () => {
    expect(chipLabel("ada@example.com", index)).toBe("Ada Lovelace");
  });

  it("falls back to the address for somebody not in it", () => {
    // Never blank, and never the string "undefined": a chip with nothing on it is a chip
    // the user cannot check before sending to it.
    expect(chipLabel("nobody@example.com", index)).toBe("nobody@example.com");
  });

  it("falls back to the address with no index at all", () => {
    expect(chipLabel("ada@example.com", null)).toBe("ada@example.com");
  });
});

describe("isAlreadyOnMessage", () => {
  it("is true for the same address at any case", () => {
    expect(isAlreadyOnMessage("ada@example.com", ["ADA@Example.com"])).toBe(true);
  });

  it("is false for somebody else", () => {
    expect(isAlreadyOnMessage("grace@example.com", ["ada@example.com"])).toBe(false);
  });

  it("is false when the message has no recipients yet", () => {
    expect(isAlreadyOnMessage("ada@example.com", [])).toBe(false);
  });
});