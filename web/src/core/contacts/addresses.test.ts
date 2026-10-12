/**
 * Addresses as text: folding, validity, and parsing what was typed.
 *
 * The failure this file is about is a list that offers the same person twice, or offers
 * somebody who cannot receive mail and says nothing. Neither shows up in a screenshot;
 * both are the difference between a recipient list somebody uses and one they retype.
 */

import { describe, expect, it } from "vitest";
import {
  domainPart,
  foldText,
  isValidAddress,
  localPart,
  normalizeAddress,
  parseRecipients,
  stripDisplayName,
} from "./addresses";

describe("foldText", () => {
  it("lowercases", () => {
    expect(foldText("ADA")).toBe("ada");
  });

  it("drops accents, so a name is findable without them", () => {
    expect(foldText("Tomás Lindqvist")).toBe("tomas lindqvist");
    expect(foldText("José")).toBe("jose");
    expect(foldText("Ångström")).toBe("angstrom");
  });

  it("folds a decomposed form to the same thing as a composed one", () => {
    // The same name arrives both ways depending on the sender's software, and a search
    // that only finds one of them is a search that looks broken.
    expect(foldText("Tomás")).toBe(foldText("Tomaś"));
    expect(foldText("é")).toBe(foldText("e"));
  });

  it("leaves a string with no marks alone", () => {
    expect(foldText("northwind.example")).toBe("northwind.example");
  });
});

describe("normalizeAddress", () => {
  it("is the same address however it is cased", () => {
    expect(normalizeAddress("Ada@Example.com")).toBe(normalizeAddress("ada@example.com"));
  });

  it("folds accents in the local part too", () => {
    expect(normalizeAddress("Tomás@Example.com")).toBe(normalizeAddress("tomas@example.com"));
  });

  it("discards a display name", () => {
    expect(normalizeAddress("Ada Lovelace <ada@example.com>")).toBe("ada@example.com");
  });

  it("keeps surrounding whitespace out of the identity", () => {
    expect(normalizeAddress("  ada@example.com  ")).toBe("ada@example.com");
  });

  it("still has an identity for something that is not an address", () => {
    // Two different mistakes must not collapse into one contact, or removing one of
    // them removes both.
    expect(normalizeAddress("not-an-address")).not.toBe(normalizeAddress("also bad"));
    expect(normalizeAddress("")).toBe("");
  });
});

describe("stripDisplayName", () => {
  it("takes the address out of the angle-bracket form", () => {
    expect(stripDisplayName('"Ng, Alex" <alex@example.com>')).toBe("alex@example.com");
  });

  it("leaves a bare address as it is", () => {
    expect(stripDisplayName("ada@example.com")).toBe("ada@example.com");
  });
});

describe("localPart / domainPart", () => {
  it("split at the last `@`", () => {
    expect(localPart("ada@example.com")).toBe("ada");
    expect(domainPart("ada@example.com")).toBe("example.com");
  });

  it("are empty rather than throwing when there is no `@`", () => {
    expect(localPart("nonsense")).toBe("nonsense");
    expect(domainPart("nonsense")).toBe("");
  });
});

describe("isValidAddress", () => {
  it("accepts an ordinary address", () => {
    expect(isValidAddress("ada@example.com")).toBe(true);
    expect(isValidAddress("ada.lovelace+tag@sub.example.co.uk")).toBe(true);
  });

  it("accepts an address written in the display-name form", () => {
    expect(isValidAddress("Ada Lovelace <ada@example.com>")).toBe(true);
  });

  it("rejects an address with no dot in the domain", () => {
    // The rule that matters in practice: `ada@localhost` passes every other check and is
    // undeliverable from anywhere but this machine.
    expect(isValidAddress("ada@localhost")).toBe(false);
  });

  it("rejects the things that actually arrive in a To field", () => {
    expect(isValidAddress("ada")).toBe(false);
    expect(isValidAddress("ada@")).toBe(false);
    expect(isValidAddress("@example.com")).toBe(false);
    expect(isValidAddress("ada@@example.com")).toBe(false);
    expect(isValidAddress("ada example@example.com")).toBe(false);
    expect(isValidAddress("ada@exa mple.com")).toBe(false);
    expect(isValidAddress("ada@example.com, grace@example.com")).toBe(false);
    expect(isValidAddress("")).toBe(false);
    expect(isValidAddress("   ")).toBe(false);
  });

  it("rejects a leading or trailing dot in the local part", () => {
    expect(isValidAddress(".ada@example.com")).toBe(false);
    expect(isValidAddress("ada.@example.com")).toBe(false);
  });

  it("rejects an address long enough that no server would accept it", () => {
    expect(isValidAddress(`${"a".repeat(65)}@example.com`)).toBe(false);
    expect(isValidAddress(`ada@${"a".repeat(250)}.com`)).toBe(false);
  });
});

describe("parseRecipients", () => {
  it("reads one address", () => {
    expect(parseRecipients("ada@example.com")).toEqual([
      { value: "ada@example.com", valid: true, name: undefined },
    ]);
  });

  it("splits a comma list", () => {
    expect(parseRecipients("ada@example.com, grace@example.com").map((t) => t.value)).toEqual([
      "ada@example.com",
      "grace@example.com",
    ]);
  });

  it("splits on semicolons and newlines, because a paste is not always commas", () => {
    expect(parseRecipients("ada@example.com; grace@example.com").map((t) => t.value)).toEqual([
      "ada@example.com",
      "grace@example.com",
    ]);
    expect(parseRecipients("ada@example.com\ngrace@example.com").map((t) => t.value)).toEqual([
      "ada@example.com",
      "grace@example.com",
    ]);
  });

  it("does not split on a comma inside a quoted name", () => {
    const tokens = parseRecipients('"Quarry Lane, lettings" <office@example.com>');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toEqual({
      value: "office@example.com",
      valid: true,
      name: "Quarry Lane, lettings",
    });
  });

  it("reads a pasted list of display-name forms, keeping the names", () => {
    expect(parseRecipients("Ada Lovelace <ada@example.com>, Grace <grace@example.com>")).toEqual([
      { value: "ada@example.com", valid: true, name: "Ada Lovelace" },
      { value: "grace@example.com", valid: true, name: "Grace" },
    ]);
  });

  it("keeps what does not parse rather than dropping it", () => {
    // The user typed it and can see it; silently deleting it is the one outcome that
    // teaches somebody not to trust the field.
    const tokens = parseRecipients("ada@example.com, nonsense");
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toEqual({ value: "nonsense", valid: false, name: undefined });
  });

  it("drops empty entries, so a trailing comma is not a recipient", () => {
    expect(parseRecipients("ada@example.com, ")).toHaveLength(1);
    expect(parseRecipients("")).toEqual([]);
    expect(parseRecipients("   ")).toEqual([]);
    expect(parseRecipients(",,,")).toEqual([]);
  });

  it("flags a bare name as not deliverable", () => {
    expect(parseRecipients("Ada Lovelace")).toEqual([
      { value: "Ada Lovelace", valid: false, name: undefined },
    ]);
  });
});