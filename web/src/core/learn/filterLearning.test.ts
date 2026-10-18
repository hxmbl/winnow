import { describe, expect, it } from "vitest";
import type { Email } from "../model/email";
import { NEUTRAL_SIGNALS, isImportant, type EmailSignals } from "../model/signals";
import { buildUserProfile } from "../model/profile";
import { classifyEmail } from "../classify/classify";
import { matchesBuiltin } from "../classify/filters";
import { cluesOf, patternClues, registrableDomain, canRuleDomain, wordsOf } from "./filterClues";
import {
  BUILT_IN_ODDS,
  FilterLearning,
  LEARNABLE_FILTERS,
  MAX_CORRECTIONS,
  MIN_DOMAIN_ADDRESSES,
  MIN_SUPPORT,
  clueBackground,
  MAX_VOCABULARY,
  applyFilterLearning,
  capVocabulary,
  type FilterCorrection,
} from "./filterLearning";
import { explainFilters } from "./filterExplain";

let next = 1;
function mail(fields: Partial<Email> & { sender: string; subject: string; body?: string }): Email {
  const id = next++;
  return {
    id,
    gmailId: `g${id}`,
    mailbox: "inbox",
    receivedAt: 1_700_000_000_000 + id,
    body: "",
    category: "updates",
    starred: false,
    unread: true,
    attachments: [],
    urgent: false,
    ...fields,
  };
}

const profile = buildUserProfile([], []);
const signalsOf = (email: Email): EmailSignals => classifyEmail(email, profile);

/** The Evri email the built-in rules miss: no shipping phrase anywhere. */
const evri = (n = 1) =>
  mail({
    sender: "notifications@mail.evri.com",
    subject: "Your Evri delivery is coming today",
    body: `Good news, Sam is bringing it between 10:15 and 11:15 on Tuesday, 12 May. Tracking: H01HYA00123456${70 + n}.`,
  });

/** Unrelated everyday mail, so a test's clue background looks like an inbox. */
const FILLER: Email[] = [
  ["dana@acme.example", "Lunch on Friday?", "Are you free for lunch on Friday? The new place on Mill Road.", "primary"],
  ["news@weekly.example", "The Weekly, issue 12", "This week: compilers, gardens and a long read on trains.", "newsletter"],
  ["billing@power.example", "Your bill is ready", "Your bill of £42.10 is ready to view.", "updates"],
  ["team@club.example", "Committee minutes", "Minutes from the committee meeting are attached.", "primary"],
  ["deals@shop.example", "Spring sale", "Up to 40% off garden furniture this weekend only.", "promotions"],
  ["sam@friends.example", "photos", "Here are the photos from the walk last weekend.", "primary"],
  ["it@acme.example", "Laptop refresh", "Your new laptop is ready to collect from the IT desk.", "updates"],
  ["events@venue.example", "Your tickets", "Your tickets for the concert are in the app.", "updates"],
].map(([sender, subject, body, category]) => ({
  id: 0,
  gmailId: `filler-${subject}`,
  mailbox: "inbox" as const,
  receivedAt: 1_600_000_000_000,
  sender,
  subject,
  body,
  category: category as Email["category"],
  starred: false,
  unread: false,
  attachments: [],
  urgent: false,
}));
/** The clue background of an inbox holding these messages and the filler. */
const inboxOf = (...emails: Email[]) => clueBackground([...FILLER, ...emails]);

const dpd = () =>
  mail({
    sender: "info@dpd.co.uk",
    subject: "Your DPD delivery is coming today",
    body: "Your driver Sam will deliver between 10:15 and 11:15 on Tuesday, 12 May. Your DPD reference is 15501234567890.",
  });

describe("clues", () => {
  it("reads the courier formats, order numbers, amounts and dates", () => {
    expect(patternClues("Tracking number 1Z999AA10123456784")).toEqual(expect.arrayContaining(["p:tracking", "p:ups"]));
    expect(patternClues("Your item AB123456789GB is on its way")).toEqual(expect.arrayContaining(["p:tracking", "p:royal-mail"]));
    expect(patternClues("Evri parcel H01HYA0012345678")).toEqual(expect.arrayContaining(["p:tracking", "p:evri"]));
    expect(patternClues("DPD parcel 15501234567890")).toEqual(expect.arrayContaining(["p:tracking", "p:dpd"]));
    expect(patternClues("a 14 digit number 15501234567890 with no courier")).not.toContain("p:dpd");
    expect(patternClues("Order 203-1234567-1234567 placed")).toEqual(
      expect.arrayContaining(["p:amazon-order", "p:order-number"]),
    );
    expect(patternClues("Order number: A12345")).toContain("p:order-number");
    expect(patternClues("Order now and save")).not.toContain("p:order-number");
    expect(patternClues("Total £12.50")).toContain("p:amount");
    expect(patternClues("Arriving Tuesday, 12 May")).toContain("p:date");
    expect(patternClues("Hello there")).toEqual([]);
  });

  it("does not take a 16-letter word starting with H for an Evri number", () => {
    expect(patternClues("HYPERCONNECTIVITY")).not.toContain("p:evri");
  });

  it("reads headers, the category and a few words", () => {
    const clues = cluesOf(mail({ sender: "no-reply@shop.com", subject: "Parcel update", bulk: true, category: "promotions" }));
    expect(clues).toEqual(expect.arrayContaining(["h:list-unsubscribe", "h:no-reply", "c:promotions", "w:parcel", "w:update"]));
  });

  it("keeps words short, distinct and free of stop words", () => {
    expect(wordsOf("Your parcel, your PARCEL and the van")).toEqual(["parcel", "van"]);
  });

  it("finds the registrable domain and refuses shared ones", () => {
    expect(registrableDomain("a@mail.evri.com")).toBe("evri.com");
    expect(registrableDomain("a@track.dpd.co.uk")).toBe("dpd.co.uk");
    expect(canRuleDomain("evri.com")).toBe(true);
    expect(canRuleDomain("gmail.com")).toBe(false);
  });
});

describe("FilterLearning", () => {
  it("leaves everything alone with no corrections", () => {
    const email = evri();
    const model = FilterLearning.empty();
    const base = signalsOf(email);
    expect(model.apply(email, base)).toBe(base);
    const map = new Map([[email.id, base]]);
    expect(applyFilterLearning([email], map, model)).toBe(map);
  });

  it("starts from the miss the owner reported", () => {
    const email = evri();
    expect(signalsOf(email).shipping).toBe(false);
  });

  it("moves a corrected message at once", () => {
    const email = evri();
    const model = FilterLearning.empty().record(email, "shipping", true, 1);
    const learned = model.apply(email, signalsOf(email));
    // A per-filter override; the classifier's own flag is left as it was.
    expect(learned.filterOverrides).toEqual({ shipping: true });
    expect(learned.shipping).toBe(false);
    expect(matchesBuiltin("shipping", email, learned, profile)).toBe(true);
    expect(model.decide(email, "shipping", signalsOf(email))).toEqual({ by: "message", into: true });
  });

  // Owner decision (R3): one correction makes a rule for that exact address only. A rule
  // for the whole domain needs corrections from at least two distinct addresses there.
  it("makes an address rule from one correction, and a domain rule only from two addresses", () => {
    const fromA = evri(1); // notifications@mail.evri.com
    const fromB = mail({ sender: "tracking@evri.com", subject: "Your parcel is with your neighbour", body: "We left it at number 12." });
    const laterB = mail({ sender: "tracking@evri.com", subject: "Spring offers from Evri", body: "Send for less." });
    const laterA = evri(5);
    const fromC = mail({ sender: "depot@evri.com", subject: "Your parcel is at the depot", body: "Collect it any time after 2pm." });

    // (a) One correction from address A moves A's later mail, and nothing from B.
    const once = FilterLearning.empty().record(fromA, "shipping", true, 1);
    expect(once.decide(laterA, "shipping", signalsOf(laterA))).toMatchObject({ by: "sender", into: true });
    expect(once.senderRuleFor(laterB, "shipping")).toBeNull();
    expect(once.decide(laterB, "shipping", signalsOf(laterB))).toEqual({ by: "built-in", into: false });
    expect(once.senderRules()).toEqual([
      { filter: "shipping", key: "notifications@mail.evri.com", kind: "address", into: true, count: 1 },
    ]);

    // (b) Corrections from two distinct addresses make the domain rule, which then
    // covers a third address.
    expect(MIN_DOMAIN_ADDRESSES).toBe(2);
    const twice = once.record(fromB, "shipping", true, 2);
    expect(twice.decide(fromC, "shipping", signalsOf(fromC))).toMatchObject({
      by: "sender",
      into: true,
      rule: { key: "evri.com", kind: "domain", count: 2 },
    });
    expect(twice.senderRules()).toEqual([{ filter: "shipping", key: "evri.com", kind: "domain", into: true, count: 2 }]);
  });

  it("makes no domain rule when corrections on the domain conflict", () => {
    const fromA = evri(1);
    const fromB = mail({ sender: "tracking@evri.com", subject: "Your parcel is with your neighbour", body: "We left it at number 12." });
    const fromD = mail({ sender: "offers@evri.com", subject: "Spring offers from Evri", body: "Send for less." });
    const fromC = mail({ sender: "depot@evri.com", subject: "Your parcel is at the depot", body: "Collect it any time after 2pm." });
    const model = FilterLearning.empty()
      .record(fromA, "shipping", true, 1)
      .record(fromB, "shipping", true, 2)
      .record(fromD, "shipping", false, 3);
    // Two addresses in, one out: conflicting evidence never produces the broad rule.
    expect(model.senderRuleFor(fromC, "shipping")).toBeNull();
    expect(model.decide(fromC, "shipping", signalsOf(fromC)).by).not.toBe("sender");
    // Each address keeps its own, unmixed rule.
    expect(model.senderRules().map((rule) => [rule.key, rule.kind, rule.into])).toEqual([
      ["notifications@mail.evri.com", "address", true],
      ["offers@evri.com", "address", false],
      ["tracking@evri.com", "address", true],
    ]);
  });

  it("makes no rule for an address with corrections both ways", () => {
    const a = mail({ sender: "news@shop.example", subject: "Your order is on its way", body: "Order number: A12345." });
    const b = mail({ sender: "news@shop.example", subject: "Spring sale", body: "40% off." });
    const c = mail({ sender: "news@shop.example", subject: "Another one", body: "Hello." });
    const model = FilterLearning.empty().record(a, "shipping", true, 1).record(b, "shipping", false, 2);
    expect(model.senderRuleFor(c, "shipping")).toBeNull();
    expect(model.senderRules()).toEqual([]);
  });

  it("never makes a domain rule for the account's own domain", () => {
    const colleague = (name: string, subject: string) => mail({ sender: `${name}@acme.example`, subject, category: "primary" });
    const model = FilterLearning.empty("me@acme.example")
      .record(colleague("dana", "standup notes"), "urgent", true, 1)
      .record(colleague("priya", "the release"), "urgent", true, 2)
      .record(colleague("lee", "rota"), "urgent", true, 3);
    expect(model.ownDomain).toBe("acme.example");
    const other = colleague("sam", "lunch?");
    expect(model.senderRuleFor(other, "urgent")).toBeNull();
    expect(model.senderRules().every((rule) => rule.kind === "address")).toBe(true);
    // The demo's own domain is the demo account's.
    expect(FilterLearning.empty("demo").ownDomain).toBe("northwind.example");
  });

  it("never makes a rule for a shared domain, only the address", () => {
    const friend = mail({ sender: "sam@gmail.com", subject: "Your parcel", category: "primary" });
    const stranger = mail({ sender: "someone@gmail.com", subject: "Lunch?", category: "primary" });
    const model = FilterLearning.empty().record(friend, "shipping", false, 1);
    expect(model.senderRules()).toEqual([{ filter: "shipping", key: "sam@gmail.com", kind: "address", into: false, count: 1 }]);
    expect(model.senderRuleFor(stranger, "shipping")).toBeNull();
  });

  it("lets an exact address beat its domain", () => {
    const a = mail({ sender: "news@evri.com", subject: "Newsletter" });
    const b = mail({ sender: "news@evri.com", subject: "Newsletter 2" });
    const c = evri();
    const model = FilterLearning.empty()
      .record(c, "shipping", true, 1)
      .record(a, "shipping", false, 2);
    // news@ is out by its own rule; evri.com has corrections both ways, so no domain rule.
    expect(model.decide(b, "shipping", signalsOf(b))).toMatchObject({ by: "sender", into: false });
  });

  it("follows the balance of corrections for a sender", () => {
    const one = evri(1);
    const two = evri(2);
    const three = evri(3);
    let model = FilterLearning.empty().record(one, "shipping", true, 1).record(two, "shipping", true, 2);
    expect(model.senderRuleFor(three, "shipping")).toMatchObject({ into: true, count: 2 });
    model = model.record(two, "shipping", false, 3);
    // The second correction for the same message replaces the first.
    expect(model.correctionCount("shipping")).toBe(2);
    expect(model.senderRuleFor(three, "shipping")).toBeNull();
  });

  it("generalises to similar mail from another sender after two corrections, and not to unrelated mail", () => {
    const e1 = evri(1);
    const e2 = mail({ ...evri(2), sender: "hello@evri-parcels.example" });
    const other = dpd();
    const unrelated = mail({
      sender: "team@club.example",
      subject: "Quiz night",
      body: "Join us on Tuesday, 12 May for the quarterly quiz.",
    });
    expect(signalsOf(other).shipping).toBe(false);
    const background = inboxOf(e1, e2, other, unrelated);

    // One correction never generalises on its own (owner decision, R4).
    expect(MIN_SUPPORT).toBe(2);
    const once = FilterLearning.empty().record(e1, "shipping", true, 1);
    expect(once.decide(other, "shipping", signalsOf(other), background)).toEqual({ by: "built-in", into: false });
    const twice = once.record(e2, "shipping", true, 2);
    const decision = twice.decide(other, "shipping", signalsOf(other), background);
    expect(decision).toMatchObject({ by: "similar", into: true, similar: 2 });
    if (decision.by === "similar") expect(decision.clues[0]).toBe("p:tracking");
    // A date and the Updates category are not enough to make a quiz night a delivery.
    expect(twice.decide(unrelated, "shipping", signalsOf(unrelated), background).into).toBe(false);
  });

  it("can take a message out of a filter the built-in rules put it in", () => {
    const promoLike = (n: number) =>
      mail({
        sender: `deals${n}@shop${n}.example`,
        subject: "Your parcel of savings",
        body: `Your package of offers, ${n}, ends Friday, 3 June. Order number: ZX${n}2345.`,
        category: "promotions",
      });
    const a = promoLike(1);
    const b = promoLike(2);
    const c = promoLike(3);
    const target = promoLike(4);
    // "your package" makes it shipping by the built-in rules, unless promo gates it.
    const base = { ...signalsOf(target), shipping: true, promotional: false };
    let model = FilterLearning.empty();
    for (const [i, email] of [a, b, c].entries()) model = model.record(email, "shipping", false, i);
    const background = inboxOf(a, b, c, target);
    const decision = model.decide(target, "shipping", base, background);
    expect(decision).toMatchObject({ by: "similar", into: false });
    const learned = model.apply(target, base, background);
    expect(learned.filterOverrides?.shipping).toBe(false);
    expect(matchesBuiltin("shipping", target, learned, profile)).toBe(false);
  });

  it("can put mail in Important and take it out", () => {
    const email = mail({ sender: "boss@acme.example", subject: "hello", category: "primary" });
    const base = signalsOf(email);
    expect(isImportant(email, base)).toBe(false);
    const model = FilterLearning.empty().record(email, "important", true, 1);
    const learned = model.apply(email, base);
    expect(learned.filterOverrides?.important).toBe(true);
    expect(isImportant(email, learned)).toBe(true);
    const back = model.record(email, "important", false, 2).apply(email, base);
    expect(isImportant(email, back)).toBe(false);
  });

  it("never lets learning rescue unsafe mail into Important", () => {
    const email = mail({ sender: "x@y.example", subject: "hi" });
    const unsafe: EmailSignals = { ...NEUTRAL_SIGNALS, spamLikelihood: 0.9 };
    const learned = FilterLearning.empty().record(email, "important", true, 1).apply(email, unsafe);
    expect(isImportant(email, learned)).toBe(false);
  });

  it("removes a sender rule but keeps the moved messages in place", () => {
    const first = evri(1);
    const later = evri(2);
    let model = FilterLearning.empty().record(first, "shipping", true, 1);
    model = model.removeSenderRule("shipping", "evri.com");
    expect(model.senderRules()).toEqual([]);
    expect(model.senderRuleFor(later, "shipping")).toBeNull();
    expect(model.decide(first, "shipping", signalsOf(first))).toEqual({ by: "message", into: true });
  });

  it("resets one filter or everything", () => {
    const email = evri();
    const model = FilterLearning.empty("a@b.example")
      .record(email, "shipping", true, 1)
      .record(email, "receipts", false, 2);
    expect(model.reset("shipping").correctionCount("shipping")).toBe(0);
    expect(model.reset("shipping").correctionCount("receipts")).toBe(1);
    expect(model.reset().isEmpty).toBe(true);
    expect(model.reset().owner).toBe("a@b.example");
  });

  it("round-trips a snapshot and drops malformed or foreign-version ones", () => {
    const model = FilterLearning.empty("demo").record(evri(), "shipping", true, 5);
    const again = FilterLearning.fromSnapshot(JSON.parse(JSON.stringify(model.toSnapshot())));
    expect(again.toSnapshot()).toEqual(model.toSnapshot());
    expect(FilterLearning.fromSnapshot({ version: 99, owner: "x", corrections: [] }).owner).toBeNull();
    expect(FilterLearning.fromSnapshot("nope").isEmpty).toBe(true);
    const mixed = { ...model.toSnapshot(), corrections: [...model.toSnapshot().corrections, { message: 1 }, { filter: "starred" }] };
    expect(FilterLearning.fromSnapshot(mixed).corrections).toHaveLength(1);
  });

  it("caps corrections and the vocabulary", () => {
    let model = FilterLearning.empty();
    for (let i = 0; i < MAX_CORRECTIONS + 20; i += 1) {
      model = model.record(mail({ sender: `s${i}@x${i}.example`, subject: `word${i} other${i}` }), "receipts", true, i);
    }
    expect(model.corrections).toHaveLength(MAX_CORRECTIONS);
    const many: FilterCorrection[] = Array.from({ length: 200 }, (_, i) => ({
      message: `m${i}`,
      filter: "shipping",
      into: true,
      address: "",
      domain: "",
      clues: ["p:tracking", ...Array.from({ length: 10 }, (_, j) => `w:x${i}y${j}`)],
      at: i,
    }));
    const capped = capVocabulary(many);
    expect(new Set(capped.flatMap((c) => c.clues)).size).toBeLessThanOrEqual(MAX_VOCABULARY);
    expect(capped.every((c) => c.clues.includes("p:tracking"))).toBe(true);
  });

  it("states its tuning constants", () => {
    expect(BUILT_IN_ODDS).toBe(3);
    expect(LEARNABLE_FILTERS).not.toContain("unsafe");
    expect(LEARNABLE_FILTERS).not.toContain("starred");
  });
});

describe("Why it's here", () => {
  it("explains the built-in rules in words", () => {
    const email = mail({ sender: "orders@apple.com", subject: "Your package has shipped", body: "Tracking number: 1Z999AA10123456784" });
    const base = signalsOf(email);
    const lines = explainFilters(email, base, base, profile, FilterLearning.empty());
    const deliveries = lines.find((line) => line.filter === "shipping");
    expect(deliveries?.line).toBe("In Deliveries because: mentions “tracking number”");
    expect(lines.some((line) => line.filter === "unread")).toBe(false);
  });

  it("explains a sender rule the way the owner wrote it", () => {
    const first = evri(1);
    const second = evri(2);
    const third = evri(3);
    const model = FilterLearning.empty().record(first, "shipping", true, 1).record(second, "shipping", true, 2);
    const base = signalsOf(third);
    const learned = model.apply(third, base);
    const line = explainFilters(third, base, learned, profile, model).find((reason) => reason.filter === "shipping");
    // Both corrections came from one address, so the rule is that address's.
    expect(line?.line).toBe("In Deliveries because: from notifications@mail.evri.com, has an Evri tracking number, you moved 2 emails here");
  });

  it("explains a domain rule by its domain", () => {
    const first = evri(1);
    const second = mail({ ...evri(2), sender: "tracking@evri.com" });
    const third = mail({ ...evri(3), sender: "depot@evri.com" });
    const model = FilterLearning.empty().record(first, "shipping", true, 1).record(second, "shipping", true, 2);
    const base = signalsOf(third);
    const line = explainFilters(third, base, model.apply(third, base), profile, model).find((r) => r.filter === "shipping");
    expect(line?.line).toBe("In Deliveries because: from evri.com, has an Evri tracking number, you moved 2 emails here");
  });

  it("explains similar mail with its clues and a count", () => {
    const e1 = evri(1);
    const e2 = mail({ ...evri(2), sender: "hello@evri-parcels.example" });
    const other = dpd();
    const model = FilterLearning.empty().record(e1, "shipping", true, 1).record(e2, "shipping", true, 2);
    const base = signalsOf(other);
    const background = inboxOf(e1, e2, other);
    const learned = model.apply(other, base, background);
    const line = explainFilters(other, base, learned, profile, model, background).find((reason) => reason.filter === "shipping");
    expect(line?.line).toMatch(/^In Deliveries because: has a tracking number, .+, you moved 2 similar emails here$/);
    // Never a generic clue as a reason.
    expect(line?.line).not.toMatch(/Gmail files it|no-reply|List-Unsubscribe|mentions a date/);
  });

  it("says when you put the message there yourself", () => {
    const email = evri();
    const model = FilterLearning.empty().record(email, "shipping", true, 1);
    const base = signalsOf(email);
    const line = explainFilters(email, base, model.apply(email, base), profile, model).find((r) => r.filter === "shipping");
    expect(line?.line).toBe("In Deliveries because: you put it here");
  });

  it("never shows a number that is a score", () => {
    const email = mail({ sender: "boss@acme.example", subject: "Please review the invoice", body: "Could you approve it?", starred: true });
    const base = signalsOf(email);
    for (const reason of explainFilters(email, base, base, profile, FilterLearning.empty())) {
      expect(reason.line).not.toMatch(/\d/);
    }
  });
});
