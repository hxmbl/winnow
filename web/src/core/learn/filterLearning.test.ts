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

  // Owner decision (R3), the Evri case: one correction makes a rule for that exact address
  // only. A rule for the whole domain needs corrections from at least two distinct
  // addresses there, all the same way; conflicting corrections make no domain rule.
  describe("Evri: a sender rule covers one address until two addresses agree", () => {
    // Every message here is a delivery the built-in rules miss (no shipping phrase), so
    // under the old one-correction domain rule each would have moved into Deliveries.
    const fromA = () => evri(1); // notifications@mail.evri.com
    const fromB = (n = 0) =>
      mail({
        sender: "tracking@evri.com",
        subject: `Your Evri delivery is coming tomorrow${n ? ` (${n})` : ""}`,
        body: `Good news, Priya is bringing it between 13:00 and 14:00 on Wednesday, 13 May. Tracking: H01HYA00987654${30 + n}.`,
      });
    const fromC = () =>
      mail({
        sender: "depot@evri.com",
        subject: "Your Evri delivery is coming on Friday",
        body: "Good news, Lee is bringing it between 09:00 and 10:00 on Friday, 15 May. Tracking: H01HYA0055555501.",
      });
    const shipping = (model: FilterLearning, email: Email) =>
      matchesBuiltin("shipping", email, model.apply(email, signalsOf(email), inboxOf(email)), profile);

    it("starts with every one of them outside Deliveries", () => {
      for (const email of [fromA(), fromB(), fromC()]) {
        expect(email.sender.endsWith("evri.com")).toBe(true);
        expect(matchesBuiltin("shipping", email, signalsOf(email), profile)).toBe(false);
      }
      expect(new Set([fromA().sender, fromB().sender, fromC().sender]).size).toBe(3);
    });

    it("(a) one correction from address A moves A's later mail, and nothing from address B", () => {
      const once = FilterLearning.empty().record(fromA(), "shipping", true, 1);
      const laterA = evri(5);
      const laterB = fromB(1);
      expect(once.decide(laterA, "shipping", signalsOf(laterA))).toMatchObject({ by: "sender", into: true });
      expect(shipping(once, laterA)).toBe(true);
      expect(once.senderRuleFor(laterB, "shipping")).toBeNull();
      expect(once.decide(laterB, "shipping", signalsOf(laterB), inboxOf(laterB))).toEqual({ by: "built-in", into: false });
      expect(shipping(once, laterB)).toBe(false);
      expect(once.senderRules()).toEqual([
        { filter: "shipping", key: "notifications@mail.evri.com", kind: "address", into: true, count: 1 },
      ]);
    });

    it("(b) corrections from two distinct addresses make the domain rule, which covers a third address", () => {
      expect(MIN_DOMAIN_ADDRESSES).toBe(2);
      const twice = FilterLearning.empty().record(fromA(), "shipping", true, 1).record(fromB(), "shipping", true, 2);
      const third = fromC();
      expect(twice.decide(third, "shipping", signalsOf(third))).toMatchObject({
        by: "sender",
        into: true,
        rule: { key: "evri.com", kind: "domain", count: 2 },
      });
      expect(shipping(twice, third)).toBe(true);
      expect(twice.senderRules()).toEqual([{ filter: "shipping", key: "evri.com", kind: "domain", into: true, count: 2 }]);
      // The domain rule reaches mail with nothing else in common with what was corrected.
      const plain = mail({ sender: "hello@evri.com", subject: "About your recent order", body: "Thanks for choosing us." });
      expect(twice.decide(plain, "shipping", signalsOf(plain), inboxOf(plain))).toMatchObject({ by: "sender", rule: { key: "evri.com" } });
      // Two corrections from the same address are still only that address: no domain rule.
      const sameAddress = FilterLearning.empty().record(fromB(), "shipping", true, 1).record(fromB(2), "shipping", true, 2);
      expect(sameAddress.senderRuleFor(third, "shipping")).toBeNull();
      expect(sameAddress.senderRuleFor(plain, "shipping")).toBeNull();
      expect(shipping(sameAddress, plain)).toBe(false);
    });

    it("(c) conflicting corrections on the domain block the domain rule", () => {
      const offers = mail({ sender: "offers@evri.com", subject: "Spring offers from Evri", body: "Send for less this spring." });
      const model = FilterLearning.empty()
        .record(fromA(), "shipping", true, 1)
        .record(fromB(), "shipping", true, 2)
        .record(offers, "shipping", false, 3);
      const third = fromC();
      // Two addresses in, one out: conflicting evidence never produces the broad rule.
      expect(model.senderRuleFor(third, "shipping")).toBeNull();
      expect(model.decide(third, "shipping", signalsOf(third), inboxOf(third)).by).not.toBe("sender");
      // So mail from a third address that shares nothing specific with the corrections
      // stays where the built-in rules put it. (A third delivery with an Evri tracking
      // number can still follow by similar mail, which "Why it's here" names as such.)
      const plain = mail({ sender: "hello@evri.com", subject: "About your recent order", body: "Thanks for choosing us." });
      expect(model.senderRuleFor(plain, "shipping")).toBeNull();
      expect(model.decide(plain, "shipping", signalsOf(plain), inboxOf(plain))).toEqual({ by: "built-in", into: false });
      expect(shipping(model, plain)).toBe(false);
      expect(model.senderRules().some((rule) => rule.kind === "domain")).toBe(false);
      // Each address keeps its own, unmixed rule.
      expect(model.senderRules().map((rule) => [rule.key, rule.kind, rule.into])).toEqual([
        ["notifications@mail.evri.com", "address", true],
        ["offers@evri.com", "address", false],
        ["tracking@evri.com", "address", true],
      ]);
      // And an address with corrections both ways has no rule of its own either.
      const mixed = FilterLearning.empty().record(fromB(), "shipping", true, 1).record(fromB(3), "shipping", false, 2);
      expect(mixed.senderRuleFor(fromB(4), "shipping")).toBeNull();
    });
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

  describe("support counts only corrections sharing a clue that pushes the flip's way", () => {
    // DPD's mail shares a tracking number and delivery words with Evri's. The volunteer
    // rota shares only "driver" with it, a word the licence reminder (moved the other way)
    // also carries, so in your corrections "driver" says nothing for Deliveries, or the
    // opposite. Both Evri and the rota were moved into Deliveries.
    const evriMail = () => evri(1);
    const rota = () =>
      mail({ sender: "rota@club.example", subject: "Volunteer driver rota", body: "Can you take the minibus for the club outing?" });
    const licence = () =>
      mail({ sender: "reminders@dvla.example", subject: "Driver licence renewal", body: "Renew your driving licence online before it expires." });
    const unrelatedOut = () =>
      mail({ sender: "news@garden.example", subject: "Seed swap", body: "Bring your spare seeds to the allotment on Saturday." });
    const shares = (email: Email, other: Email, clue: string) => cluesOf(email).includes(clue) && cluesOf(other).includes(clue);

    it.each([
      ["pushes the other way", false],
      ["has no weight", true],
    ])("a second correction whose only shared clue %s is not support: built-in stays", (_label, evenly) => {
      const target = dpd();
      const a = evriMail();
      const b = rota();
      const c = licence();
      const d = unrelatedOut();
      expect(signalsOf(target).shipping).toBe(false);
      // The rota shares exactly one specific clue with DPD's mail, and Evri several.
      const specific = (email: Email) => cluesOf(email).filter((clue) => !clue.startsWith("c:") && clue !== "p:date" && clue !== "h:no-reply");
      expect(specific(b).filter((clue) => cluesOf(target).includes(clue))).toEqual(["w:driver"]);
      expect(shares(target, a, "p:tracking")).toBe(true);
      expect(shares(b, c, "w:driver")).toBe(true);
      let model = FilterLearning.empty()
        .record(a, "shipping", true, 1)
        .record(b, "shipping", true, 2)
        .record(c, "shipping", false, 3);
      // With a second "out" correction, "driver" is one in two each way: weight exactly 0.
      if (evenly) model = model.record(d, "shipping", false, 4);
      const background = inboxOf(a, b, c, d, target);
      // Evri's clues alone do push DPD's mail toward Deliveries, but only one correction
      // (Evri) backs that, and one is never enough (MIN_SUPPORT = 2). Counting the rota,
      // which shares only "driver", would have made it two.
      const decision = model.decide(target, "shipping", signalsOf(target), background);
      expect(decision).toEqual({ by: "built-in", into: false });
      expect(model.apply(target, signalsOf(target), background).filterOverrides?.shipping).toBeUndefined();
      const line = explainFilters(target, signalsOf(target), model.apply(target, signalsOf(target), background), profile, model, { background }).find(
        (reason) => reason.filter === "shipping",
      );
      expect(line?.source).not.toBe("similar");
    });

    it("two corrections that both share a clue pushing that way do flip it, and say so with 2", () => {
      const target = dpd();
      const a = evriMail();
      const b = mail({ ...evri(2), sender: "hello@evri-parcels.example" });
      const c = licence();
      const model = FilterLearning.empty()
        .record(a, "shipping", true, 1)
        .record(b, "shipping", true, 2)
        .record(c, "shipping", false, 3);
      const background = inboxOf(a, b, c, target);
      const decision = model.decide(target, "shipping", signalsOf(target), background);
      expect(decision).toMatchObject({ by: "similar", into: true, similar: 2 });
      if (decision.by === "similar") {
        expect(decision.clues[0]).toBe("p:tracking");
        // "driver" pushed the other way, so it is never given as a reason.
        expect(decision.clues).not.toContain("w:driver");
      }
      const learned = model.apply(target, signalsOf(target), background);
      expect(matchesBuiltin("shipping", target, learned, profile)).toBe(true);
      const line = explainFilters(target, signalsOf(target), learned, profile, model, { background }).find((reason) => reason.filter === "shipping");
      expect(line?.source).toBe("similar");
      expect(line?.line).toMatch(/you moved 2 similar emails here$/);
    });
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
    expect(line?.source).toBe("sender");
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
    const line = explainFilters(other, base, learned, profile, model, { background }).find((reason) => reason.filter === "shipping");
    expect(line?.line).toMatch(/^In Deliveries because: has a tracking number, .+, you moved 2 similar emails here$/);
    expect(line?.source).toBe("similar");
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
