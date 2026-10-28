/**
 * Work domains from Sent mail (STRM-235): a personal account that gets work mail still
 * protects colleagues from a company-wide domain rule.
 */

import { describe, expect, it } from "vitest";
import type { Contact, Email } from "../model/email";
import { FilterLearning } from "./filterLearning";
import { MIN_WORK_RECIPIENTS, workDomainsFromSent } from "./workDomains";
import { WinnowStore } from "../store/store";

let next = 1;
function mail(fields: Partial<Email> & { sender: string; subject: string }): Email {
  const id = next++;
  return {
    id,
    gmailId: `wd${id}`,
    mailbox: "inbox",
    receivedAt: 1_700_000_000_000 + id,
    body: "",
    category: "primary",
    starred: false,
    unread: true,
    attachments: [],
    urgent: false,
    ...fields,
  };
}

const to = (...addresses: string[]): Contact[] => addresses.map((address) => ({ address }));

/** A message the user sent from a personal Gmail. */
const sent = (fields: Partial<Email>) =>
  mail({ sender: "me@gmail.com", subject: "Re: plans", mailbox: "sent", unread: false, ...fields });

describe("workDomainsFromSent", () => {
  it("counts a domain once you have written to three different people there", () => {
    expect(MIN_WORK_RECIPIENTS).toBe(3);
    const two = [sent({ to: to("dana@acme.example") }), sent({ to: to("priya@acme.example") })];
    expect(workDomainsFromSent(two).size).toBe(0);
    const three = [...two, sent({ cc: to("lee@acme.example") })];
    expect([...workDomainsFromSent(three)]).toEqual(["acme.example"]);
  });

  it("reads To, Cc and Bcc, ignores case, and counts each person once", () => {
    const emails = [
      sent({ to: to("Dana@Acme.Example"), cc: to("dana@acme.example") }),
      sent({ to: to("dana@acme.example") }),
      sent({ bcc: to("priya@acme.example") }),
      sent({ cc: to("lee@mail.acme.example") }),
    ];
    // Subdomains count toward their registrable domain, like sender rules do.
    expect([...workDomainsFromSent(emails)]).toEqual(["acme.example"]);
    expect(workDomainsFromSent(emails.slice(0, 3)).size).toBe(0);
  });

  it("never counts a shared provider, however many people you write to there", () => {
    const emails = [
      sent({ to: to("a@gmail.com", "b@gmail.com", "c@gmail.com", "d@gmail.com") }),
      sent({ to: to("a@outlook.com", "b@outlook.com", "c@outlook.com") }),
      sent({ to: to("a@icloud.com", "b@icloud.com", "c@icloud.com") }),
    ];
    expect(workDomainsFromSent(emails).size).toBe(0);
  });

  it("reads only Sent mail: people who wrote to you, or were copied, don't count", () => {
    const emails = [
      mail({ sender: "dana@acme.example", subject: "hi", to: to("me@gmail.com", "priya@acme.example", "lee@acme.example") }),
      mail({ sender: "sam@acme.example", subject: "hi", cc: to("kim@acme.example") }),
      mail({ sender: "me@gmail.com", subject: "draft", mailbox: "drafts", to: to("a@acme.example", "b@acme.example", "c@acme.example") }),
    ];
    expect(workDomainsFromSent(emails).size).toBe(0);
  });

  it("copes with sent mail cached before recipients were stored", () => {
    expect(workDomainsFromSent([sent({}), sent({ to: [] })]).size).toBe(0);
  });

  it("returns the same set for the same mailbox", () => {
    const emails = [sent({ to: to("a@acme.example", "b@acme.example", "c@acme.example") })];
    expect(workDomainsFromSent(emails)).toBe(workDomainsFromSent(emails));
  });
});

describe("FilterLearning with work domains", () => {
  const colleague = (name: string, subject: string) => mail({ sender: `${name}@acme.example`, subject });
  const taught = () =>
    FilterLearning.empty("me@gmail.com")
      .record(colleague("dana", "standup notes"), "urgent", true, 1)
      .record(colleague("priya", "the release"), "urgent", true, 2);

  it("makes no domain rule for a work domain, only address rules", () => {
    // Without the work domain: two colleagues make a rule for everyone at acme.example.
    const sam = colleague("sam", "lunch?");
    expect(taught().senderRuleFor(sam, "urgent")).toMatchObject({ kind: "domain", key: "acme.example" });

    const model = taught().withWorkDomains(new Set(["acme.example"]));
    expect(model.isOwnDomain("acme.example")).toBe(true);
    expect(model.senderRuleFor(sam, "urgent")).toBeNull();
    expect(model.senderRules().map((rule) => [rule.kind, rule.key])).toEqual([
      ["address", "dana@acme.example"],
      ["address", "priya@acme.example"],
    ]);
    expect(model.senderRuleFor(colleague("dana", "more notes"), "urgent")).toMatchObject({ kind: "address" });
  });

  it("keeps the work domains through every change, and never stores them", () => {
    const domains = new Set(["acme.example"]);
    const model = taught().withWorkDomains(domains);
    const recorded = model.record(colleague("lee", "rota"), "urgent", true, 3);
    expect(recorded.workDomains).toBe(domains);
    expect(recorded.reset("urgent").workDomains).toBe(domains);
    expect(recorded.removeSenderRule("urgent", "lee@acme.example").workDomains).toBe(domains);
    expect(recorded.toSnapshot()).not.toHaveProperty("workDomains");
    expect(FilterLearning.fromSnapshot(recorded.toSnapshot()).workDomains.size).toBe(0);
  });

  it("keeps its identity for the same domains, so memos keep hitting", () => {
    const base = taught();
    expect(base.withWorkDomains(new Set())).toBe(base);
    const domains = new Set(["acme.example"]);
    const once = base.withWorkDomains(domains);
    expect(base.withWorkDomains(domains)).toBe(once);
    expect(once.withWorkDomains(new Set(["acme.example"]))).toBe(once);
  });

  it("still protects the account's own domain alongside work domains", () => {
    const model = FilterLearning.empty("me@northwind.example").withWorkDomains(new Set(["acme.example"]));
    expect(model.isOwnDomain("northwind.example")).toBe(true);
    expect(model.isOwnDomain("acme.example")).toBe(true);
    expect(model.isOwnDomain("evri.com")).toBe(false);
    expect(model.isOwnDomain("")).toBe(false);
  });
});

describe("the store protects a work domain read from Sent mail", () => {
  /** A personal inbox with mail from three colleagues at acme.example. */
  function store(withSentMail: boolean) {
    const dana = mail({ sender: "dana@acme.example", subject: "Quarterly figures" });
    const priya = mail({ sender: "priya@acme.example", subject: "Launch checklist" });
    const sam = mail({ sender: "sam@acme.example", subject: "Lunch on Friday?" });
    const outbox = withSentMail
      ? [sent({ to: to("dana@acme.example", "priya@acme.example") }), sent({ cc: to("sam@acme.example") })]
      : [];
    const s = new WinnowStore({ seed: [dana, priya, sam, ...outbox] });
    s.changeSmartFilters([dana.id], [{ filter: "urgent", into: true }]);
    s.changeSmartFilters([priya.id], [{ filter: "urgent", into: true }]);
    return { s, sam };
  }

  it("without Sent mail, two colleagues still make a rule for the whole company", () => {
    const { s, sam } = store(false);
    expect(s.getSnapshot().filterLearning.senderRules().some((rule) => rule.kind === "domain")).toBe(true);
    expect(s.smartFilterMembership([sam.id]).get("urgent")).toBe("all");
  });

  it("with Sent mail to three of them, there is no domain rule and Sam's mail stays put", () => {
    const { s, sam } = store(true);
    const model = s.getSnapshot().filterLearning;
    expect(model.isOwnDomain("acme.example")).toBe(true);
    expect(model.senderRules().every((rule) => rule.kind === "address")).toBe(true);
    expect(s.smartFilterMembership([sam.id]).get("urgent")).not.toBe("all");
  });
});
