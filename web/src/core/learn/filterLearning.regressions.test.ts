/**
 * Regression tests for the learning audit's confirmed failures (R1–R7), run on the demo
 * inbox: every case the audit reproduced has a test here that fails on the old rules.
 */

import { describe, expect, it } from "vitest";
import type { Email } from "../model/email";
import { BUILTIN_FILTERS, badgeFilters, isImportant, isUnsafe, type EmailSignals } from "../model/signals";
import { buildUserProfile } from "../model/profile";
import { classifyAll } from "../classify/classify";
import { matchesBuiltin } from "../classify/filters";
import { DEMO_EMAILS, DEMO_TRASH } from "../data/demo";
import { LearningModel } from "./learning";
import {
  FilterLearning,
  LEARNABLE_FILTERS,
  applyFilterLearning,
  clueBackground,
  clueWeight,
  type LearnableFilter,
} from "./filterLearning";
import { explainFilters } from "./filterExplain";
import { WinnowStore } from "../store/store";

const inbox = DEMO_EMAILS.filter((email) => email.mailbox === "inbox");
const profile = buildUserProfile(inbox, DEMO_TRASH);
const base = classifyAll(inbox, profile);
const background = clueBackground(inbox);
const sig = (email: Email, map: ReadonlyMap<number, EmailSignals> = base) => map.get(email.id)!;
const find = (subject: string, from?: string): Email => {
  const hit = inbox.find((email) => email.subject.startsWith(subject) && (!from || email.sender.startsWith(from)));
  if (!hit) throw new Error(`no demo message "${subject}"`);
  return hit;
};
const learnedWith = (model: FilterLearning) => applyFilterLearning(inbox, base, model, background);
const member = (filter: LearnableFilter, email: Email, map: ReadonlyMap<number, EmailSignals>) =>
  matchesBuiltin(filter, email, sig(email, map), profile);
const colleagues = inbox.filter((email) => email.sender.endsWith("@northwind.example"));

/** Every single-correction flip on the demo: 47 messages × 12 filters. */
function* everySingleFlip(): Generator<{ email: Email; filter: LearnableFilter; into: boolean; model: FilterLearning }> {
  for (const email of inbox) {
    for (const filter of LEARNABLE_FILTERS) {
      const into = !member(filter, email, base);
      yield { email, filter, into, model: FilterLearning.empty("demo").record(email, filter, into, 1) };
    }
  }
}

describe("R1 + R7: a correction takes effect, and touches nothing else", () => {
  it("moves the corrected message in every safe case, and changes no other membership at all", () => {
    let flips = 0;
    let unsafeNoOps = 0;
    for (const { email, filter, into, model } of everySingleFlip()) {
      flips += 1;
      const learned = learnedWith(model);
      if (isUnsafe(sig(email)) && into) {
        // Learning never puts unsafe mail into a filter; the picker says so instead.
        expect(member(filter, email, learned)).toBe(false);
        unsafeNoOps += 1;
      } else {
        expect(member(filter, email, learned), `${filter} ${into} "${email.subject}"`).toBe(into);
      }
      // No other filter changes for this message (the old cross-filter leak changed up to
      // 19 memberships for "into Newsletters" on a colleague).
      for (const other of BUILTIN_FILTERS) {
        if (other === filter) continue;
        expect(matchesBuiltin(other, email, sig(email, learned), profile), `${filter}→${other} "${email.subject}"`).toBe(
          matchesBuiltin(other, email, sig(email), profile),
        );
      }
    }
    expect(flips).toBe(inbox.length * LEARNABLE_FILTERS.length);
    // The old rules had 18 silent no-ops (9 of them gates such as Urgent's promo rule).
    // The only ones left are unsafe mail asked into a filter, which the picker now
    // explains: the compromised-account message, for the 11 filters it is not in.
    expect(unsafeNoOps).toBe(11);
  });

  it("no longer silently ignores 'into Urgent' on a promo or 'into Action needed' on a newsletter", () => {
    const promo = find("Last chance: 60% off");
    const weekly = find("The Weekly");
    const model = FilterLearning.empty("demo").record(promo, "urgent", true, 1).record(weekly, "needs_action", true, 2);
    const learned = learnedWith(model);
    expect(member("urgent", promo, learned)).toBe(true);
    expect(member("needs_action", weekly, learned)).toBe(true);
    expect(badgeFilters(promo, sig(promo, learned))).toContain("urgent");
  });

  it("keeps the classifier's flags as they were: only the override changes", () => {
    const tomas = find("that book you mentioned");
    const learned = learnedWith(FilterLearning.empty("demo").record(tomas, "newsletters", true, 1));
    const { filterOverrides, ...flags } = sig(tomas, learned);
    expect(filterOverrides).toEqual({ newsletters: true });
    expect(flags).toEqual(sig(tomas));
  });

  it("'into Newsletters' on a colleague leaks into no other filter (19 memberships before)", () => {
    const sam = find("Re: the migration plan", "sam@");
    const learned = learnedWith(FilterLearning.empty("demo").record(sam, "newsletters", true, 1));
    let changed = 0;
    for (const email of inbox) {
      for (const filter of BUILTIN_FILTERS) {
        if (filter === "newsletters") continue;
        if (matchesBuiltin(filter, email, sig(email, learned), profile) !== matchesBuiltin(filter, email, sig(email), profile)) changed += 1;
      }
    }
    expect(changed).toBe(0);
  });

  it("badges agree with the filters, corrections included (no Urgent badge on promos)", () => {
    const badgeable = ["important", "urgent", "needs_action", "security", "receipts", "codes", "shipping", "travel", "events", "newsletters", "promotional"] as const;
    const model = FilterLearning.empty("demo")
      .record(find("Your Evri delivery"), "shipping", true, 1)
      .record(find("Re: staging plan"), "important", false, 2);
    for (const map of [base, learnedWith(model)]) {
      for (const email of inbox) {
        const badges = badgeFilters(email, sig(email, map));
        for (const filter of badgeable) {
          expect(badges.includes(filter), `${filter} "${email.subject}" ${map === base ? "base" : "learned"}`).toBe(matchesBuiltin(filter, email, sig(email, map), profile));
        }
      }
    }
    const urgentPromos = inbox.filter((email) => sig(email).urgentText && sig(email).promotional && !email.urgent);
    expect(urgentPromos.map((email) => email.subject)).toContain("Last chance: 60% off");
    for (const promo of urgentPromos) expect(badgeFilters(promo, sig(promo))).not.toContain("urgent");
  });
});

describe("R2: star learning reads the classifier's own output", () => {
  it("starring a message taught as a newsletter does not touch the newsletter penalty", () => {
    const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
    const tomas = find("that book you mentioned");
    store.changeSmartFilters([tomas.id], [{ filter: "newsletters", into: true }]);
    expect(store.smartFilterMembership([tomas.id]).get("newsletters")).toBe("all");
    const before = store.getSnapshot().learning.weights.newsletterPenalty;
    store.toggleStar(tomas.id);
    const after = store.getSnapshot().learning;
    expect(after.weights.newsletterPenalty).toBe(before);
    expect(after.events.at(-1)?.activeSignals ?? []).not.toContain("newsletterPenalty");
  });

  it("the learned signals hand star learning the same flags as the base ones", () => {
    const tomas = find("that book you mentioned");
    const learned = learnedWith(FilterLearning.empty("demo").record(tomas, "newsletters", true, 1));
    const fromBase = LearningModel.initial().recordStar(tomas, sig(tomas), true, 1);
    const fromLearned = LearningModel.initial().recordStar(tomas, sig(tomas, learned), true, 1);
    expect(fromLearned.weights).toEqual(fromBase.weights);
  });
});

describe("R3: no single correction moves a whole domain", () => {
  it("one correction on a colleague moves no other colleague (13 moved before)", () => {
    for (const email of colleagues) {
      for (const filter of LEARNABLE_FILTERS) {
        const into = !member(filter, email, base);
        const learned = learnedWith(FilterLearning.empty("demo").record(email, filter, into, 1));
        for (const other of colleagues) {
          if (other.sender === email.sender) continue;
          expect(member(filter, other, learned), `${filter} via ${email.sender} moved ${other.sender}`).toBe(member(filter, other, base));
        }
      }
    }
  });

  it("'not Important' on Sam's thread keeps every other colleague in Important", () => {
    const sam = find("Re: the migration plan", "sam@");
    const learned = learnedWith(FilterLearning.empty("demo").record(sam, "important", false, 1));
    const others = colleagues.filter((email) => email.sender !== sam.sender);
    expect(others.filter((email) => member("important", email, learned) !== member("important", email, base))).toEqual([]);
  });

  it("corrections from several colleagues never make a rule for the account's own domain", () => {
    let model = FilterLearning.empty("demo");
    const senders = [...new Set(colleagues.map((email) => email.sender))].slice(0, 4);
    senders.forEach((sender, i) => {
      model = model.record(colleagues.find((email) => email.sender === sender)!, "urgent", true, i);
    });
    expect(model.senderRules().some((rule) => rule.kind === "domain")).toBe(false);
  });

  it("alternating corrections on one domain never oscillate a third message (it flipped every step)", () => {
    const kettle = find("the kettle is broken");
    const seq = colleagues.filter((email) => email.id !== kettle.id).slice(0, 6);
    let model = FilterLearning.empty("demo");
    const seen = new Set<boolean>();
    const bystanders = colleagues.filter((email) => !seq.some((s) => s.sender === email.sender));
    seq.forEach((email, i) => {
      model = model.record(email, "urgent", i % 2 === 0, i);
      const learned = learnedWith(model);
      seen.add(member("urgent", kettle, learned));
      for (const other of bystanders) expect(member("urgent", other, learned)).toBe(member("urgent", other, base));
    });
    expect([...seen]).toEqual([member("urgent", kettle, base)]);
  });

  it("alternating corrections on an outside company's domain never make a domain rule", () => {
    const mk = (n: number, local: string): Email => ({
      ...find("Your Evri delivery"),
      id: 9_100_000 + n,
      gmailId: `alt-${n}`,
      sender: `${local}@parcels.example`,
      subject: `Update ${n}`,
    });
    let model = FilterLearning.empty("demo");
    const third = mk(99, "third");
    const decisions = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      model = model.record(mk(i, i % 2 === 0 ? "alpha" : "beta"), "urgent", i % 2 === 0, i);
      if (i >= 1) expect(model.senderRuleFor(third, "urgent")).toBeNull();
      decisions.add(JSON.stringify(model.decide(third, "urgent", sig(find("Your Evri delivery")), background)));
    }
    // Contradictory evidence ends in one stable answer, never a swing per step.
    expect(decisions.size).toBeLessThanOrEqual(2);
    expect(model.senderRules().every((rule) => rule.kind === "address")).toBe(true);
  });
});

describe("R4: similar mail is conservative", () => {
  it("no single correction moves any other sender's message by similarity (141 of 564 did)", () => {
    let spills = 0;
    for (const { email, filter, model } of everySingleFlip()) {
      for (const other of inbox) {
        if (other.id === email.id) continue;
        const decision = model.decide(other, filter, sig(other), background);
        if (decision.by === "similar") spills += 1;
      }
    }
    expect(spills).toBe(0);
  });

  it("'Security, out' on Stripe never takes Dropbox's new-device alert out of Security", () => {
    const stripe = find("Security alert: unusual sign-in");
    const dropbox = find("We noticed a new device");
    const okta = find("Your verification code");
    expect(member("security", dropbox, base)).toBe(true);
    const once = FilterLearning.empty("demo").record(stripe, "security", false, 1);
    expect(member("security", dropbox, learnedWith(once))).toBe(true);
    // Not even with more corrections: similarity alone never removes Security mail.
    const many = once.record(okta, "security", false, 2).record(find("Sign-in code"), "security", false, 3);
    expect(member("security", dropbox, learnedWith(many))).toBe(true);
    expect(many.decide(dropbox, "security", sig(dropbox), background).by).toBe("built-in");
  });

  it("'into Security' on Okta never puts Twilio's code in Security too", () => {
    const okta = find("Your verification code");
    const twilio = find("Sign-in code");
    const learned = learnedWith(FilterLearning.empty("demo").record(okta, "security", true, 1));
    expect(member("security", twilio, learned)).toBe(false);
    expect(member("codes", twilio, learned)).toBe(true);
  });

  it("one correction sharing every clue cannot overrule the built-in answer (P≈0.99 before)", () => {
    const evri = find("Your Evri delivery");
    const twin: Email = { ...evri, id: 9_200_000, gmailId: "twin", sender: "someone@elsewhere.example" };
    const model = FilterLearning.empty("demo").record(evri, "urgent", true, 1);
    expect(model.decide(twin, "urgent", sig(evri), clueBackground([...inbox, twin]))).toEqual({ by: "built-in", into: false });
  });

  it("never lets a clue seen only in 'into' corrections vote out (the sign bug)", () => {
    // in 1 of 5 "into" corrections, 0 of 1 "out": the old smoothing gave −0.154.
    expect(clueWeight({ in: 1, out: 0 }, { in: 5, out: 1 }, 0.5)).toBeGreaterThanOrEqual(0);
    expect(clueWeight({ in: 1, out: 0 }, { in: 5, out: 1 }, 0.02)).toBeGreaterThan(0);
    expect(clueWeight({ in: 0, out: 1 }, { in: 1, out: 5 }, 0.5)).toBeLessThanOrEqual(0);
    // Evenly split evidence says nothing.
    expect(clueWeight({ in: 1, out: 1 }, { in: 1, out: 1 }, 0.1)).toBe(0);
    for (const rate of [0.01, 0.1, 0.5, 0.9]) {
      for (let inN = 1; inN <= 6; inN += 1) {
        for (let outN = 1; outN <= 6; outN += 1) {
          for (let tin = 0; tin <= inN; tin += 1) {
            for (let tout = 0; tout <= outN; tout += 1) {
              if (tin + tout === 0) continue;
              const weight = clueWeight({ in: tin, out: tout }, { in: inN, out: outN }, rate);
              const direction = Math.sign(tin / inN - tout / outN);
              expect(weight === 0 || Math.sign(weight) === direction).toBe(true);
            }
          }
        }
      }
    }
  });

  it("generic clues alone never decide: two corrections sharing only category, header and words", () => {
    const a = find("Your bill is ready");
    const b = find("Invoice 2026-0412");
    const model = FilterLearning.empty("demo").record(a, "travel", true, 1).record(b, "travel", true, 2);
    const learned = learnedWith(model);
    const moved = inbox.filter((email) => email.id !== a.id && email.id !== b.id && member("travel", email, learned) !== member("travel", email, base));
    for (const email of moved) {
      const decision = model.decide(email, "travel", sig(email), background);
      expect(decision.by).toBe("similar");
      if (decision.by === "similar") expect(decision.clues.every((clue) => !clue.startsWith("c:") && clue !== "h:no-reply")).toBe(true);
    }
  });

  it("still generalises from two deliveries to a third courier's mail", () => {
    const evri = find("Your Evri delivery");
    const evriTwin: Email = { ...find("We've got it"), id: 9_300_001, gmailId: "evri-twin", sender: "hello@evri-parcels.example" };
    const dpd: Email = {
      ...evri,
      id: 9_300_002,
      gmailId: "dpd",
      sender: "info@dpd.co.uk",
      subject: "Your DPD delivery is coming today",
      body: "Your driver Sam will deliver between 10:15 and 11:15. Your DPD reference is 15501234567890.",
    };
    const all = [...inbox, evriTwin, dpd];
    const bg = clueBackground(all);
    const signals = classifyAll(all, profile);
    expect(signals.get(dpd.id)!.shipping).toBe(false);
    const model = FilterLearning.empty("demo").record(evri, "shipping", true, 1).record(evriTwin, "shipping", true, 2);
    expect(model.decide(dpd, "shipping", signals.get(dpd.id)!, bg)).toMatchObject({ by: "similar", into: true, similar: 2 });
  });
});

describe("R5: one action counts once per sender", () => {
  const promo = find("48% off everything");
  const clones = (n: number): Email[] =>
    Array.from({ length: n }, (_, i) => ({ ...promo, id: 9_400_000 + i, gmailId: `promo-${i}`, subject: `${promo.subject} ${i}` }));

  it("thirty messages from one sender in one action are one decision", () => {
    const thirty = clones(30);
    let batched = FilterLearning.empty("demo");
    for (const email of thirty) batched = batched.record(email, "urgent", true, 1, 7);
    const single = FilterLearning.empty("demo").record(thirty[0], "urgent", true, 1, 7);
    expect(batched.correctionCount("urgent")).toBe(30);
    expect(batched.senderRules()).toEqual([{ ...single.senderRules()[0], count: 1 }]);
    // And as evidence about similar mail from other senders, no stronger than one.
    const bg = clueBackground([...inbox, ...thirty]);
    for (const email of inbox) {
      if (email.sender === promo.sender) continue;
      expect(batched.decide(email, "urgent", sig(email), bg)).toEqual(single.decide(email, "urgent", sig(email), bg));
    }
  });

  it("the store records only messages that change, all in one batch", () => {
    const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
    const inShipping = inbox.filter((email) => member("shipping", email, base)).map((email) => email.id);
    const outside = find("Your Evri delivery").id;
    const [result] = store.changeSmartFilters([...inShipping, outside], [{ filter: "shipping", into: true }]);
    expect(result).toMatchObject({ moved: 1, already: inShipping.length, unsafe: 0 });
    const corrections = store.getSnapshot().filterLearning.corrections;
    expect(corrections).toHaveLength(1);
    expect(corrections[0].message).toBe("demo-missed-delivery-1");
  });

  it("unsafe mail asked into a filter is not recorded, and is reported as unsafe", () => {
    const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
    const compromised = find("Your account has been compromised");
    expect(isUnsafe(sig(compromised))).toBe(true);
    const [result] = store.changeSmartFilters([compromised.id], [{ filter: "important", into: true }]);
    expect(result).toMatchObject({ moved: 0, unsafe: 1 });
    expect(store.getSnapshot().filterLearning.isEmpty).toBe(true);
    expect(store.smartFilterMembership([compromised.id]).get("important")).toBe("none");
  });
});

describe("unsafe mail never becomes Important through learning", () => {
  it("not by its own correction, a sender rule or similar mail", () => {
    const compromised = find("Your account has been compromised");
    const sameSender: Email = { ...compromised, id: 9_500_000, gmailId: "same-sender", subject: "hello" };
    let model = FilterLearning.empty("demo").record(compromised, "important", true, 1).record(sameSender, "important", true, 2);
    for (const email of inbox.filter((e) => !isUnsafe(sig(e))).slice(0, 3)) model = model.record(email, "important", true, 3);
    const learned = learnedWith(model);
    for (const email of inbox.filter((e) => isUnsafe(sig(e)))) {
      expect(isImportant(email, sig(email, learned))).toBe(false);
      expect(member("important", email, learned)).toBe(false);
    }
  });
});

describe("R6: Why it's here names the path that decided", () => {
  const evri = find("Your Evri delivery");
  const sam = find("Re: the migration plan", "sam@");
  const stripe = find("Security alert: unusual sign-in");
  const helena = find("Fwd: photos from the weekend");
  const promo = find("Last chance: 60% off");
  const bill = find("Your bill is ready");
  const receipt = find("Receipt: order");
  const correctionSets: [string, FilterLearning][] = [
    ["none", FilterLearning.empty("demo")],
    ["one each", FilterLearning.empty("demo")
      .record(evri, "shipping", true, 1)
      .record(sam, "important", false, 2)
      .record(stripe, "security", false, 3)
      .record(helena, "needs_action", true, 4)
      .record(promo, "urgent", true, 5)],
    ["similar", FilterLearning.empty("demo")
      .record(bill, "travel", true, 1)
      .record(receipt, "travel", true, 2)
      .record(find("Your package has shipped"), "urgent", true, 3)
      .record(find("Out for delivery"), "urgent", true, 4)],
    ["mixed", FilterLearning.empty("demo")
      .record(evri, "shipping", true, 1)
      .record(find("We've got it"), "shipping", false, 2)
      .record(find("The Weekly"), "newsletters", false, 3)
      .record(find("This week in engineering"), "newsletters", false, 4)],
  ];

  for (const [name, model] of correctionSets) {
    it(`every demo message × every filter, corrections: ${name}`, () => {
      const learned = learnedWith(model);
      let lines = 0;
      const sources = new Set<string>();
      for (const email of inbox) {
        const reasons = explainFilters(email, sig(email), sig(email, learned), profile, model, { background });
        const unsafe = isUnsafe(sig(email, learned));
        for (const filter of BUILTIN_FILTERS) {
          const line = reasons.find((reason) => reason.filter === filter);
          const expected = filter !== "unread" && (!unsafe || filter === "unsafe") && matchesBuiltin(filter, email, sig(email, learned), profile);
          expect(Boolean(line), `${filter} "${email.subject}"`).toBe(expected);
          if (!line) continue;
          lines += 1;
          sources.add(line.source);
          const text = line.reasons.join(" | ");
          const isLearnable = (LEARNABLE_FILTERS as readonly string[]).includes(filter);
          const decision = isLearnable ? model.decide(email, filter as LearnableFilter, sig(email), background) : { by: "built-in" as const };
          expect(line.source, `${filter} "${email.subject}"`).toBe(decision.by);
          switch (decision.by) {
            case "message":
              expect(line.reasons).toEqual(["you put it here"]);
              break;
            case "sender":
              expect(line.reasons[0]).toBe(`from ${decision.rule.key}`);
              break;
            case "similar":
              expect(line.reasons.at(-1)).toMatch(/^you moved \d+ similar emails? here$/);
              break;
            case "built-in":
              expect(text).not.toMatch(/you moved|you put it here/);
              break;
          }
          // A learned path never gives a generic clue as a reason, and there are no scores.
          if (decision.by !== "built-in") expect(text).not.toMatch(/Gmail files it under|no-reply address|List-Unsubscribe|mentions a date/);
          // Counts of your own corrections are fine; any other number would be a score.
          expect(line.line.replace(/“[^”]*”/g, "").replace(/you moved \d+ /g, "")).not.toMatch(/\d|score/i);
          if (filter === "important" && decision.by === "built-in") {
            const s = sig(email);
            if (text.includes("it is a security notice")) expect(s.security).toBe(true);
            if (text.includes("it reads as urgent")) expect(s.urgentText).toBe(true);
            if (text.includes("it asks you to do something")) expect(s.needsAction).toBe(true);
            if (text.includes("it is about money")) expect(s.finance).toBe(true);
            if (text.includes("you hear from this sender often")) {
              expect(profile.topSenders.slice(0, 6)).toContain(email.sender);
              expect(profile.quietSenders).not.toContain(email.sender);
            }
          }
        }
      }
      expect(lines).toBeGreaterThan(inbox.length);
      // Each correction set exercises the paths it is meant to.
      const wanted: Record<string, string[]> = {
        none: ["built-in"],
        "one each": ["built-in", "message", "sender"],
        similar: ["built-in", "message", "similar"],
        mixed: ["built-in", "message"],
      };
      for (const source of wanted[name]) expect(sources, name).toContain(source);
    });
  }

  it("Helena: 'into Action needed' leaves Important alone, and nothing claims a reason that did not count", () => {
    const model = FilterLearning.empty("demo").record(helena, "needs_action", true, 1);
    const learned = learnedWith(model);
    expect(isImportant(helena, sig(helena))).toBe(false);
    expect(isImportant(helena, sig(helena, learned))).toBe(false);
    const lines = explainFilters(helena, sig(helena), sig(helena, learned), profile, model, { background });
    expect(lines.find((line) => line.filter === "needs_action")?.line).toBe("In Action needed because: you put it here");
    expect(lines.find((line) => line.filter === "important")).toBeUndefined();
    expect(lines.some((line) => line.line.includes("you hear from this sender often"))).toBe(false);
  });

  it("Important on the built-in rules lists only what pushed it over the line", () => {
    for (const email of inbox) {
      if (!member("important", email, base)) continue;
      const line = explainFilters(email, sig(email), sig(email), profile, FilterLearning.empty("demo")).find((l) => l.filter === "important")!;
      if (sig(email).importanceScore < 56) expect(line.reasons).toEqual(["it asks you to do something"]);
      if (profile.quietSenders.includes(email.sender)) expect(line.line).not.toContain("you hear from this sender often");
    }
  });
});

describe("stored snapshots from before these rules", () => {
  // A snapshot as the first learning release wrote it: one correction, the domain set,
  // no batch. It must load, keep the corrected message where it was put, and no longer
  // move the rest of the domain.
  const legacy = {
    version: 1,
    owner: "demo",
    corrections: [
      {
        message: "demo-missed-delivery-1",
        filter: "shipping",
        into: true,
        address: "noreply@evri.com",
        domain: "evri.com",
        clues: ["p:tracking", "p:evri", "p:date", "h:no-reply", "c:updates", "w:evri", "w:delivery", "w:coming"],
        at: 1_760_000_000_000,
      },
      {
        message: "demo-thread-sam-1",
        filter: "important",
        into: false,
        address: "sam@northwind.example",
        domain: "northwind.example",
        clues: ["c:primary", "w:migration", "w:plan"],
        at: 1_760_000_000_001,
      },
    ],
  };

  it("load unchanged and are read by the new rules", () => {
    const model = FilterLearning.fromSnapshot(JSON.parse(JSON.stringify(legacy)));
    expect(model.corrections).toHaveLength(2);
    expect(model.toSnapshot()).toEqual(legacy);
    const other: Email = { ...find("Your Evri delivery"), id: 9_600_000, gmailId: "other", sender: "depot@evri.com" };
    expect(model.senderRuleFor(other, "shipping")).toBeNull();
    // The own-domain correction makes no domain rule either.
    const learned = learnedWith(model);
    for (const email of colleagues) {
      if (email.sender === "sam@northwind.example") continue;
      expect(member("important", email, learned)).toBe(member("important", email, base));
    }
    // The address rule still holds for the sender's own mail.
    const store = new WinnowStore({ seed: [...DEMO_EMAILS], seedTrash: DEMO_TRASH });
    store.restoreState({ filterLearning: legacy });
    expect(store.smartFilterMembership([find("Your Evri delivery").id]).get("shipping")).toBe("all");
    expect(store.smartFilterMembership([find("We've got it").id]).get("shipping")).toBe("all");
  });

  it("drop a malformed batch, keep the rest, and start fresh on an unknown version", () => {
    const bad = { ...legacy, corrections: [...legacy.corrections, { ...legacy.corrections[0], message: "x", batch: "one" }] };
    expect(FilterLearning.fromSnapshot(bad).corrections).toHaveLength(2);
    expect(FilterLearning.fromSnapshot({ ...legacy, version: 0 }).isEmpty).toBe(true);
  });
});
