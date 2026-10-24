import { describe, expect, it } from "vitest";
import { CENSOR_LEVELS, STAND_IN_LENGTH, Scrambler, censorNotice, covers, isCensorLevel, nameTerms } from "./censor";

const emailsOnly = new Scrambler(() => 0.5);
const findAddresses = (text: string) => emailsOnly.find(text);
const hasAddress = (text: string) => emailsOnly.has(text);
const isAddressOnly = (text: string) => emailsOnly.isOnly(text);

function at(level: (typeof CENSOR_LEVELS)[number], names: string[] = [], seed = 1): Scrambler {
  const s = new Scrambler(seeded(seed));
  s.configure(level, names);
  return s;
}

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

describe("Scrambler", () => {
  it("replaces every value with random letters of one fixed length", () => {
    const s = new Scrambler(seeded());
    const out = s.scramble("example@example.com");
    expect(out).toHaveLength(STAND_IN_LENGTH);
    expect(s.scramble("a@b.co")).toHaveLength(STAND_IN_LENGTH);
    expect(s.scramble("a.very.long.address.indeed@subdomain.example.co.uk")).toHaveLength(STAND_IN_LENGTH);
    expect(out).toMatch(/^[a-z]+$/);
    expect(out).not.toContain("example");
  });

  it("keeps an address's letters for the session, whatever its case", () => {
    const s = new Scrambler(seeded());
    const first = s.scramble("Ana@Example.com");
    expect(s.scramble("ana@example.com")).toBe(first);
    expect(s.scramble("bob@example.com")).not.toBe(first);
  });

  it("does not derive the letters from the address", () => {
    const a = new Scrambler(seeded(1)).scramble("ana@example.com");
    const b = new Scrambler(seeded(2)).scramble("ana@example.com");
    expect(a).not.toBe(b);
  });

  it("never produces something that is itself an address", () => {
    const s = new Scrambler(seeded());
    const text = s.censorText("From ana@example.com to bob@example.org");
    expect(hasAddress(text)).toBe(false);
    expect(text).not.toContain("@");
    // Censoring censored text changes nothing: the watcher cannot loop on its own writes.
    expect(s.censorText(text)).toBe(text);
  });

  it("censors text in place, leaving the words around it", () => {
    const s = new Scrambler(seeded());
    const out = s.censorText("Okta <noreply@okta.com>");
    expect(out.startsWith("Okta <")).toBe(true);
    expect(out.endsWith(">")).toBe(true);
    expect(out).toHaveLength("Okta <>".length + STAND_IN_LENGTH);
    expect(out).not.toContain("noreply");
    expect(s.censorText("No address here")).toBe("No address here");
  });

  it("splits text into plain and censored parts for a renderer that blurs each address", () => {
    const s = new Scrambler(seeded());
    const parts = s.censorParts("Hi ana@x.com, cc bob@y.org.");
    expect(parts.map((p) => p.censored)).toEqual([false, true, false, true, false]);
    expect(parts[0].text).toBe("Hi ");
    expect(parts[1].text).toBe(s.scramble("ana@x.com"));
    expect(parts[2].text).toBe(", cc ");
    expect(parts[4].text).toBe(".");
    expect(parts.map((p) => p.text).join("")).toHaveLength("Hi , cc .".length + 2 * STAND_IN_LENGTH);
    expect(s.censorParts("plain")).toEqual([{ text: "plain", censored: false }]);
  });
});

describe("censorNotice", () => {
  it("censors what a person reads and keeps everything else", () => {
    const s = new Scrambler(seeded());
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

describe("the levels", () => {
  it("are cumulative steps", () => {
    expect(covers("emails", "emails")).toBe(true);
    expect(covers("emails", "passwords")).toBe(false);
    expect(covers("addresses", "passwords")).toBe(true);
    expect(covers("names", "addresses")).toBe(true);
    expect(covers("off", "emails")).toBe(false);
    expect(isCensorLevel("names")).toBe(true);
    expect(isCensorLevel("everything")).toBe(false);
  });

  it("hides nothing when off", () => {
    const s = at("off");
    expect(s.censorText("ana@example.com, Password: hunter22")).toBe("ana@example.com, Password: hunter22");
  });

  it("leaves passwords alone at emails only", () => {
    const s = at("emails");
    expect(s.censorText("Password: hunter22")).toBe("Password: hunter22");
  });
});

describe("passwords", () => {
  it("hides the value after a password label, and only the value", () => {
    const s = at("passwords");
    expect(s.find("Email: a@b.com\nPassword: Tr0ub4dor&3")).toEqual(["a@b.com", "Tr0ub4dor&3"]);
    expect(s.find("Your temporary password is xK9-22pq.")).toEqual(["xK9-22pq"]);
    expect(s.find("PIN = 482913")).toEqual(["482913"]);
    const out = s.censorText("Password: hunter22");
    expect(out.startsWith("Password: ")).toBe(true);
    expect(out).not.toContain("hunter22");
  });

  it("does not take ordinary words for a password", () => {
    const s = at("passwords");
    expect(s.find("Reset your password here")).toEqual([]);
    expect(s.find("Password reset requested")).toEqual([]);
    expect(s.find("Password: reset")).toEqual([]);
    expect(s.find("Pinned messages and spinning wheels")).toEqual([]);
  });

  it("takes the next text's first word when the label ends a text", () => {
    const s = at("passwords");
    expect(s.endsWithSecretLabel("Password: ")).toBe(true);
    expect(s.endsWithSecretLabel("Password")).toBe(false);
    expect(s.find("  s3cr3t-Pa55 then more", true)).toEqual(["s3cr3t-Pa55"]);
    expect(at("emails").endsWithSecretLabel("Password: ")).toBe(false);
  });
});

describe("postal addresses", () => {
  it("hides street lines, UK postcodes and US state and ZIP", () => {
    const s = at("addresses");
    expect(s.find("Deliver to 221B Baker Street, London NW1 6XE")).toEqual(["221B Baker Street", "NW1 6XE"]);
    expect(s.find("1600 Amphitheatre Pkwy, Mountain View, CA 94043")).toEqual(["CA 94043"]);
    expect(s.find("12 Acacia Avenue")).toEqual(["12 Acacia Avenue"]);
  });

  it("stays off at the passwords step", () => {
    expect(at("passwords").find("221B Baker Street")).toEqual([]);
  });
});

describe("names", () => {
  it("turns display names into whole names and capitalised parts", () => {
    expect(nameTerms(["Ada Lovelace", '"Grace Hopper"', "ops@x.com", "lowercase name", undefined, "O’Brien"]).sort()).toEqual(
      ["Ada", "Ada Lovelace", "Grace", "Grace Hopper", "Hopper", "Lovelace", "O’Brien"].sort(),
    );
  });

  it("hides known names as whole words only", () => {
    const s = at("names", nameTerms(["Ada Lovelace", "Bob"]));
    expect(s.find("Hi Ada Lovelace, Bob says hello")).toEqual(["Ada Lovelace", "Bob"]);
    expect(s.find("Bobby and Adam")).toEqual([]);
    expect(s.isOnly("Ada Lovelace")).toBe(true);
    expect(s.scramble("Ada Lovelace")).toHaveLength(STAND_IN_LENGTH);
  });

  it("hides no names below the names step", () => {
    const s = at("addresses", ["Ada"]);
    expect(s.find("Hi Ada")).toEqual([]);
  });

  it("never matches its own stand-ins", () => {
    const s = at("names", nameTerms(["Ada Lovelace"]));
    const out = s.censorText("Ada Lovelace <ada@x.com>, Password: zz9plural, 10 Downing Street SW1A 2AA");
    expect(s.censorText(out)).toBe(out);
    expect(out).not.toMatch(/Ada|ada@x|zz9plural|Downing|SW1A/);
  });
});
