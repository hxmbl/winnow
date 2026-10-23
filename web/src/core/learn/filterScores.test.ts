/**
 * Dev Options → Show filter scores: "Why it's here" carries its numbers only when asked,
 * and asking changes no decision and no words.
 */

import { describe, expect, it } from "vitest";
import type { Email } from "../model/email";
import { buildUserProfile } from "../model/profile";
import { classifyEmail } from "../classify/classify";
import { BUILT_IN_ODDS, FilterLearning, MIN_SUPPORT, clueBackground } from "./filterLearning";
import { explainFilters, filterScoreLines } from "./filterExplain";

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
const signalsOf = (email: Email) => classifyEmail(email, profile);
const evri = (n: number, sender = "notifications@mail.evri.com") =>
  mail({
    sender,
    subject: "Your Evri delivery is coming today",
    body: `Good news, Sam is bringing it between 10:15 and 11:15 on Tuesday, 12 May. Tracking: H01HYA00123456${70 + n}.`,
  });
const dpd = () =>
  mail({
    sender: "info@dpd.co.uk",
    subject: "Your DPD delivery is coming today",
    body: "Your driver Sam will deliver between 10:15 and 11:15 on Tuesday, 12 May. Your DPD reference is 15501234567890.",
  });
const filler: Email[] = [
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
const unrelated = mail({ sender: "team@club.example", subject: "Quiz night", body: "Join us on Tuesday, 12 May for the quarterly quiz." });

describe("Show filter scores", () => {
  const e1 = evri(1);
  const e2 = evri(2, "hello@evri-parcels.example");
  const other = dpd();
  const background = clueBackground([...filler, e1, e2, other, unrelated]);
  const model = FilterLearning.empty().record(e1, "shipping", true, 1).record(e2, "shipping", true, 2);
  const learned = model.apply(other, signalsOf(other), background);

  const plain = explainFilters(other, signalsOf(other), learned, profile, model, { background });
  const scored = explainFilters(other, signalsOf(other), learned, profile, model, { background, scores: true });

  it("off: no line carries numbers", () => {
    expect(plain.length).toBeGreaterThan(0);
    for (const reason of plain) {
      expect(reason.scores).toBeUndefined();
      expect(reason.line).not.toMatch(/\d\.\d|%|log-odds/);
    }
  });

  it("on: the same lines and decisions, each with its numbers", () => {
    expect(scored.map((reason) => ({ ...reason, scores: undefined }))).toEqual(plain);
    for (const reason of scored) expect(reason.scores?.length).toBeGreaterThan(0);
  });

  it("on: similar-mail naive Bayes shows the prior, each clue's weight, the total and P(in)", () => {
    const shipping = scored.find((reason) => reason.filter === "shipping");
    expect(shipping?.source).toBe("similar");
    const lines = shipping!.scores!;
    expect(lines).toContain("built-in: out · after learning: in");
    expect(lines).toContain("decided by: similar → in");
    expect(lines).toContain(`naive Bayes prior (built-in answer): ${(-Math.log(BUILT_IN_ODDS)).toFixed(2)} log-odds`);
    expect(lines.some((line) => /^ {2}clue .+ \[pattern\]: \+\d+\.\d\d$/.test(line))).toBe(true);
    expect(lines.some((line) => /^ {2}total: \+\d+\.\d\d log-odds → P\(in\) = \d+\.\d%$/.test(line))).toBe(true);
    expect(lines).toContain(`  support: 2 of ${MIN_SUPPORT} needed to overturn the built-in answer`);
    expect(lines).toContain("sender rule hit: none");
  });

  it("on: a sender rule hit names the rule and its count", () => {
    const later = evri(5);
    const rule = filterScoreLines("shipping", later, signalsOf(later), model.apply(later, signalsOf(later)), profile, model);
    expect(rule).toContain("decided by: sender → in");
    expect(rule).toContain("sender rule hit: address notifications@mail.evri.com → in (1 decision)");
  });

  it("on: your own answer for a message is shown as such", () => {
    const lines = filterScoreLines("shipping", e1, signalsOf(e1), model.apply(e1, signalsOf(e1)), profile, model);
    expect(lines).toContain("decided by: message → in");
    expect(lines).toContain("your answer for this message: in");
  });

  it("on: Important shows its importance score against the threshold", () => {
    const urgent = mail({ sender: "boss@acme.example", subject: "Urgent: sign the contract today", body: "Please sign and return it today.", category: "primary", starred: true });
    const lines = filterScoreLines("important", urgent, signalsOf(urgent), signalsOf(urgent), profile, FilterLearning.empty());
    expect(lines.some((line) => /^importance score: \d+(\.\d)? \(threshold \d+\) · needs action: (yes|no)$/.test(line))).toBe(true);
    expect(lines).toContain("naive Bayes: no corrections for this filter yet");
  });

  it("does not change what the model decides", () => {
    expect(model.scoreDetail(other, "shipping", signalsOf(other), background).decision).toEqual(
      model.decide(other, "shipping", signalsOf(other), background),
    );
  });
});
