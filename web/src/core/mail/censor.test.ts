import { describe, expect, it } from "vitest";
import { AddressScrambler, censorNotice, findAddresses, hasAddress, isAddressOnly } from "./censor";

/** A deterministic random source, so the letters are reproducible in a test. */
function seeded(seed = 1): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

describe("finding addresses", () => {
  it("finds addresses in running text", () => {
    expect(findAddresses("Write to ana.lopez+news@mail.example.co.uk or bob@x.io.")).toEqual([
      "ana.lopez+news@mail.example.co.uk",
      "bob@x.io",
    ]);
    expect(hasAddress("Okta <noreply@okta.com>")).toBe(true);
  });

  it("ignores an @ that is not an address", () => {
    expect(hasAddress("Meet @ 5pm")).toBe(false);
    expect(hasAddress("@hxmbl on GitHub")).toBe(false);
    expect(hasAddress("no at sign here")).toBe(false);
    expect(findAddresses("user@localhost")).toEqual([]);
  });

  it("knows when a text is nothing but an address", () => {
    expect(isAddressOnly("noreply@okta.com")).toBe(true);
    expect(isAddressOnly(" <noreply@okta.com> ")).toBe(true);
    expect(isAddressOnly("a@b.com, c@d.org")).toBe(true);
    expect(isAddressOnly("Okta <noreply@okta.com>")).toBe(false);
    expect(isAddressOnly("Okta")).toBe(false);
  });
});

describe("AddressScrambler", () => {
  it("replaces an address with random letters of the same length", () => {
    const s = new AddressScrambler(seeded());
    const out = s.scramble("example@example.com");
    expect(out).toHaveLength("example@example.com".length);
    expect(out).toMatch(/^[a-z]+$/);
    expect(out).not.toContain("example");
  });

  it("keeps an address's letters for the session, whatever its case", () => {
    const s = new AddressScrambler(seeded());
    const first = s.scramble("Ana@Example.com");
    expect(s.scramble("ana@example.com")).toBe(first);
    expect(s.scramble("bob@example.com")).not.toBe(first);
  });

  it("does not derive the letters from the address", () => {
    const a = new AddressScrambler(seeded(1)).scramble("ana@example.com");
    const b = new AddressScrambler(seeded(2)).scramble("ana@example.com");
    expect(a).not.toBe(b);
  });

  it("never produces something that is itself an address", () => {
    const s = new AddressScrambler(seeded());
    const text = s.censorText("From ana@example.com to bob@example.org");
    expect(hasAddress(text)).toBe(false);
    expect(text).not.toContain("@");
    // Censoring censored text changes nothing: the watcher cannot loop on its own writes.
    expect(s.censorText(text)).toBe(text);
  });

  it("censors text in place, leaving the words around it", () => {
    const s = new AddressScrambler(seeded());
    const out = s.censorText("Okta <noreply@okta.com>");
    expect(out.startsWith("Okta <")).toBe(true);
    expect(out.endsWith(">")).toBe(true);
    expect(out).toHaveLength("Okta <noreply@okta.com>".length);
    expect(out).not.toContain("noreply");
    expect(s.censorText("No address here")).toBe("No address here");
  });

  it("splits text into plain and censored parts for a renderer that blurs each address", () => {
    const s = new AddressScrambler(seeded());
    const parts = s.censorParts("Hi ana@x.com, cc bob@y.org.");
    expect(parts.map((p) => p.censored)).toEqual([false, true, false, true, false]);
    expect(parts[0].text).toBe("Hi ");
    expect(parts[1].text).toBe(s.scramble("ana@x.com"));
    expect(parts[2].text).toBe(", cc ");
    expect(parts[4].text).toBe(".");
    expect(parts.map((p) => p.text).join("")).toHaveLength("Hi ana@x.com, cc bob@y.org.".length);
    expect(s.censorParts("plain")).toEqual([{ text: "plain", censored: false }]);
  });
});

describe("censorNotice", () => {
  it("censors what a person reads and keeps everything else", () => {
    const s = new AddressScrambler(seeded());
    const notice = { title: "ana@example.com", subject: "From bob@x.org", preview: "Reply to c@d.com", replyHead: "To: ana@example.com", id: 7 };
    const out = censorNotice(notice, s);
    expect(out.title).toBe(s.scramble("ana@example.com"));
    expect(out.subject).not.toContain("bob@x.org");
    expect(out.preview).not.toContain("c@d.com");
    expect(out.replyHead).toBe("To: ana@example.com");
    expect(out.id).toBe(7);
    expect(notice.title).toBe("ana@example.com");
  });
});
