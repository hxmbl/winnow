/**
 * The list pipeline: search, filter, sort.
 *
 * The hottest function in the app, and the one whose three performance properties
 * are all statements about work *not* being done — bags passed in, signals read from
 * a caller-built map, score computed only after filtering. Each is asserted here,
 * since a regression in any is invisible in the output. The other thing pinned is
 * honesty about emptiness: an empty list has five reasons and must say which.
 */

import { describe, expect, it } from "vitest";
import {
  buildSearchBags,
  conversationFor,
  groupThreads,
  runInboxQuery,
  type InboxQuery,
  type InboxResult,
} from "./pipeline";
import { inboxSearchBag } from "./classify";
import { EMPTY_PROFILE } from "../model/profile";
import {
  NEUTRAL_SIGNALS,
  builtinFilter,
  type EmailSignals,
  type FilterId,
} from "../model/signals";
import { MAX_RECENCY_BONUS } from "./scoring";
import type { Email } from "../model/email";

/** A message with only what a test cares about. */
function email(over: Partial<Email> = {}): Email {
  return {
    id: 1,
    gmailId: "g1",
    sender: "someone@northwind.example",
    mailbox: "inbox",
    receivedAt: 1_700_000_000_000,
    subject: "",
    body: "",
    category: "primary",
    starred: false,
    unread: false,
    attachments: [],
    urgent: false,
    ...over,
  };
}

/**
 * A mailbox, with ids assigned in order.
 *
 * The ids are load-bearing rather than incidental: the search bags and the
 * score map are both keyed by the numeric id, so two fixtures sharing one would
 * collapse into a single entry in every count below and the count would pass
 * for the wrong reason.
 */
function mailbox(specs: readonly Partial<Email>[]): Email[] {
  return specs.map((over, index) =>
    email({ id: index + 1, gmailId: `g${index + 1}`, ...over }),
  );
}

/** A signal set with one field overridden, for the tests that need exact spam. */
function sig(over: Partial<EmailSignals> = {}): EmailSignals {
  return { ...NEUTRAL_SIGNALS, ...over };
}

function query(over: Partial<InboxQuery> = {}): InboxQuery {
  return {
    emails: [],
    profile: EMPTY_PROFILE,
    signals: new Map<number, EmailSignals>(),
    filters: [],
    searchQuery: "",
    sortBy: "date",
    ...over,
  };
}

/** The result as gmail ids, which is what every assertion below is about. */
function gmailIds(result: InboxResult): string[] {
  return result.emails.map((message) => message.gmailId);
}

describe("buildSearchBags", () => {
  it("keys one bag per message, by id", () => {
    // The map is built once per mailbox and handed to every keystroke's
    // `runInboxQuery`, so a missing or doubled key is a wrong result, not just a
    // slow one.
    const messages = mailbox([{}, { subject: "Second" }]);
    const bags = buildSearchBags(messages);
    expect(bags.size).toBe(2);
    expect(bags.get(messages[0].id)).toBe(inboxSearchBag(messages[0]));
    expect(bags.get(messages[1].id)).toBe(inboxSearchBag(messages[1]));
  });

  it("covers the sender, the subject and the body", () => {
    // Wider than the classification bag on purpose: searching for a name should
    // find the mail from that person even when the name is nowhere in the text,
    // and a bag that dropped the sender made that silently fail.
    const message = email({
      sender: "ada@northwind.example",
      subject: "Invoice 441",
      body: "The total came to forty pounds.",
    });
    const hay = buildSearchBags([message]).get(message.id)!;
    for (const needle of ["ada@northwind.example", "invoice 441", "forty pounds"]) {
      expect(hay).toContain(needle);
    }
  });

  it("lowercases the haystack, since the query is lowercased to match it", () => {
    // Half-lowercased on one side only would make "Invoice" unsearchable, and
    // the failure is invisible on a lowercase-only mailbox.
    const hay = buildSearchBags([email({ subject: "INVOICE" })]).get(1)!;
    expect(hay).toContain("invoice");
    expect(hay).not.toContain("INVOICE");
  });
});

describe("runInboxQuery — search", () => {
  const three = mailbox([
    { subject: "Invoice", body: "for the March period." },
    { subject: "Invoice for April", body: "Nothing else to report." },
    { subject: "Contract review", body: "On the budget." },
  ]);

  it("is case-insensitive", () => {
    for (const searchQuery of ["invoice", "INVOICE", "Invoice", "iNvOiCe"]) {
      expect(gmailIds(runInboxQuery(query({ emails: three, searchQuery })))).toEqual(["g1", "g2"]);
    }
  });

  it("ANDs whitespace-separated tokens rather than matching the whole query", () => {
    // The bug this guards: a substring search on the raw query means "invoice march"
    // finds nothing, since no message contains that exact run. The control line below
    // makes the assertion falsifiable.
    expect(buildSearchBags(three).get(1)).not.toContain("invoice march");

    expect(gmailIds(runInboxQuery(query({ emails: three, searchQuery: "invoice march" })))).toEqual([
      "g1",
    ]);
    // Each token on its own is broader, which is what makes the AND the point
    // rather than the conjunction being an accident of the fixture.
    expect(gmailIds(runInboxQuery(query({ emails: three, searchQuery: "invoice" })))).toEqual([
      "g1",
      "g2",
    ]);
    expect(gmailIds(runInboxQuery(query({ emails: three, searchQuery: "march" })))).toEqual(["g1"]);
  });

  it("narrows as tokens are added, and an unsatisfiable token empties the list", () => {
    // Three tokens across two messages, so the progressive narrowing is visible
    // rather than asserted as a single before/after pair.
    const steps = [
      ["invoice", ["g1", "g2"]],
      ["invoice march", ["g1"]],
      ["invoice march budget", []],
    ] as const;
    for (const [searchQuery, expected] of steps) {
      expect(gmailIds(runInboxQuery(query({ emails: three, searchQuery })))).toEqual(expected);
    }
  });

  it("collapses runs of whitespace, so a pasted or wrapped query still works", () => {
    // Search is fed a text input. A user who types two words after a soft wrap
    // arrives at "invoice march", and one who pastes a paragraph arrives at
    // something with tabs and newlines in it.
    const queries = ["invoice march", "  invoice march  ", "invoice \t march", "invoice\n\nmarch"];
    for (const searchQuery of queries) {
      expect(gmailIds(runInboxQuery(query({ emails: three, searchQuery })))).toEqual(["g1"]);
    }
  });

  it("treats an empty or whitespace-only query as no query at all", () => {
    // The commonest keystroke there is: clearing the box. It has to restore the
    // list, not empty it — an empty token would match nothing.
    for (const searchQuery of ["", " ", "   ", "\t", "\n\n", " \t\n "]) {
      const result = runInboxQuery(query({ emails: three, searchQuery }));
      expect(gmailIds(result)).toEqual(["g1", "g2", "g3"]);
      expect(result.emptyReason).toBe(null);
    }
  });

  it("searches the sender address as well as the text", () => {
    // Wider than classification on purpose: a person is identified by their
    // address, and it is the one thing a user reliably knows to type.
    const messages = mailbox([
      { sender: "ada@northwind.example", subject: "Notes" },
      { sender: "sam@northwind.example", subject: "Notes" },
    ]);
    expect(gmailIds(runInboxQuery(query({ emails: messages, searchQuery: "ada@" })))).toEqual([
      "g1",
    ]);
  });

  it("honours a prebuilt bag map instead of rebuilding one", () => {
    // Property 1 in the module header, and the reason the caller builds the bags
    // at all. A caller that passed a map and had it ignored would still get the
    // right answer whenever the map agrees with the mail — which is exactly the
    // control line here, and exactly why the tampered one is the real assertion.
    const messages = mailbox([
      { subject: "Invoice 441", body: "Due Friday." },
      { subject: "Invoice 442", body: "Also due Friday." },
    ]);
    const honest = runInboxQuery(
      query({ emails: messages, searchQuery: "invoice", searchBags: buildSearchBags(messages) }),
    );
    expect(gmailIds(honest)).toEqual(["g1", "g2"]);

    const tampered = new Map<number, string>([
      [messages[0].id, "invoice"],
      [messages[1].id, ""],
    ]);
    const narrowed = runInboxQuery(
      query({ emails: messages, searchQuery: "invoice", searchBags: tampered }),
    );
    expect(gmailIds(narrowed)).toEqual(["g1"]);
  });

  it("falls back to the real haystack for an id the map does not carry", () => {
    // Bags are keyed by id and built from one mailbox, so a map that is missing
    // an id is the normal state of a stale cache — and must degrade to the truth
    // rather than to "this message does not match anything".
    const messages = mailbox([
      { subject: "Invoice 441", body: "Due Friday." },
      { subject: "Invoice 442", body: "Also due Friday." },
    ]);
    const partial = new Map<number, string>([[messages[0].id, "invoice"]]);
    const result = runInboxQuery(
      query({ emails: messages, searchQuery: "due", searchBags: partial }),
    );
    // g1 is filtered out by its bag, which says nothing about Friday; g2 has no
    // bag, so the real one is built and matches.
    expect(gmailIds(result)).toEqual(["g2"]);
  });
});

describe("runInboxQuery — filters", () => {
  it("ANDs several active filters", () => {
    // Several buckets can be active at once, and they narrow rather than union:
    // "Starred and Unread" has to mean the intersection or it is a synonym for
    // either of them.
    const messages = mailbox([
      { starred: true, unread: true },
      { starred: true, unread: false },
      { starred: false, unread: true },
      { starred: false, unread: false },
    ]);
    const base = { emails: messages };
    const both: readonly FilterId[] = [builtinFilter("starred"), builtinFilter("unread")];

    expect(gmailIds(runInboxQuery(query({ ...base, filters: both })))).toEqual(["g1"]);
    // The controls: either filter on its own is wider than the pair.
    expect(gmailIds(runInboxQuery(query({ ...base, filters: [builtinFilter("starred")] })))).toEqual([
      "g1",
      "g2",
    ]);
    expect(gmailIds(runInboxQuery(query({ ...base, filters: [builtinFilter("unread")] })))).toEqual([
      "g1",
      "g3",
    ]);
  });

  it("hides unsafe messages when no filter is active", () => {
    // The default inbox's own spam rule. Without it, opening the app is how you
    // read a phishing lure, and the Unsafe bucket stops being somewhere you go
    // on purpose.
    const messages = mailbox([{ subject: "Ordinary" }, { subject: "Lure" }]);
    const signals = new Map<number, EmailSignals>([[2, sig({ spamLikelihood: 0.9 })]]);
    const result = runInboxQuery(query({ emails: messages, signals }));
    expect(gmailIds(result)).toEqual(["g1"]);
    expect(result.emptyReason).toBe(null);
  });

  it("shows unsafe messages when Unsafe is the filter you asked for", () => {
    // The safety valve only works if it is reachable. A rule that hid spam from
    // the bucket named after it would pin that bucket to nothing.
    const messages = mailbox([{ subject: "Ordinary" }, { subject: "Lure" }]);
    const signals = new Map<number, EmailSignals>([[2, sig({ spamLikelihood: 0.9 })]]);
    const result = runInboxQuery(
      query({ emails: messages, signals, filters: [builtinFilter("unsafe")] }),
    );
    expect(gmailIds(result)).toEqual(["g2"]);
  });

  it("applies a muted bucket only while no filter is explicitly active", () => {
    // Silencing a bucket is a statement about the default inbox, not about the
    // bucket itself. Archiving everything in "Newsletters" and then clicking
    // "Newsletters" to check what is in there must not show an empty list.
    const messages = mailbox([{ starred: true, subject: "Contract" }]);
    const removed = new Set(["starred"] as const);

    const muted = runInboxQuery(
      query({ emails: messages, removedFilters: new Set(removed) }),
    );
    expect(gmailIds(muted)).toEqual([]);
    expect(muted.emptyReason).toBe("hidden");

    const deliberate = runInboxQuery(
      query({
        emails: messages,
        filters: [builtinFilter("starred")],
        removedFilters: new Set(removed),
      }),
    );
    expect(gmailIds(deliberate)).toEqual(["g1"]);
  });
});

describe("runInboxQuery — matchCount", () => {
  /**
   * Two starred and one unread message, of which two carry "Invoice".
   *
   *   g1  starred, "Invoice 441",  newest
   *   g2  unread,  "Invoice 442"
   *   g3  starred, "Statement",    oldest
   *
   * Distinct timestamps, so every id order below is the date order and a wrong
   * one cannot be an accident of a stable sort on equal keys.
   */
  const messages = mailbox([
    { starred: true, subject: "Invoice 441", receivedAt: 3_000 },
    { unread: true, subject: "Invoice 442", receivedAt: 2_000 },
    { starred: true, subject: "Statement", receivedAt: 1_000 },
  ]);

  it("is the whole visible list when nothing is narrowing it", () => {
    const result = runInboxQuery(query({ emails: messages }));
    expect(result.matchCount).toBe(3);
    expect(result.emails).toHaveLength(3);
  });

  it("counts what the filters alone admit when only a filter is active", () => {
    const result = runInboxQuery(
      query({ emails: messages, filters: [builtinFilter("starred")] }),
    );
    expect(gmailIds(result)).toEqual(["g1", "g3"]);
    expect(result.matchCount).toBe(2);
  });

  it("counts the search's own hits when only a search is active", () => {
    const result = runInboxQuery(query({ emails: messages, searchQuery: "invoice" }));
    expect(gmailIds(result)).toEqual(["g1", "g2"]);
    expect(result.matchCount).toBe(2);
  });

  it("is the number of results, under every combination", () => {
    // Now simply the length of the result; the interesting property is that it
    // cannot disagree with what is rendered.
    const cases = [
      { label: "nothing narrowing", searchQuery: "", filters: [] as readonly FilterId[] },
      { label: "search only", searchQuery: "invoice", filters: [] as readonly FilterId[] },
      { label: "filter only", searchQuery: "", filters: [builtinFilter("starred")] },
      {
        label: "search and filter",
        searchQuery: "invoice",
        filters: [builtinFilter("starred")] as readonly FilterId[],
      },
      {
        label: "search that matches nothing",
        searchQuery: "nothing",
        filters: [builtinFilter("starred")] as readonly FilterId[],
      },
    ];

    for (const { label, ...over } of cases) {
      const result = runInboxQuery(query({ emails: messages, ...over }));
      expect(result.matchCount, label).toBe(result.emails.length);
    }

    // And the specific case the old second pass was built for, now honestly: the
    // starred filter alone admits two, the search narrows that to one.
    const filters = [builtinFilter("starred")] as readonly FilterId[];
    expect(runInboxQuery(query({ emails: messages, filters })).matchCount).toBe(2);
    expect(
      runInboxQuery(query({ emails: messages, filters, searchQuery: "invoice" })).matchCount,
    ).toBe(1);
  });
});

describe("runInboxQuery — emptyReason", () => {
  const plain = mailbox([{ starred: true, subject: "Contract" }]);

  it("is null when there are rows to show", () => {
    // The ordinary case, and the one an implementation that returned a reason
    // unconditionally would get wrong — the UI hides the empty state on it.
    expect(runInboxQuery(query({ emails: plain })).emptyReason).toBe(null);
  });

  it("says mailbox when there is genuinely no mail", () => {
    // The remedy is to sync, which is the only thing the user can usefully do.
    expect(runInboxQuery(query({ emails: [] })).emptyReason).toBe("mailbox");
  });

  it("says search when the query is too narrow", () => {
    const result = runInboxQuery(query({ emails: plain, searchQuery: "zzznomatch" }));
    expect(result.emails).toEqual([]);
    expect(result.emptyReason).toBe("search");
  });

  it("says filters when the buckets are too narrow", () => {
    const result = runInboxQuery(
      query({ emails: plain, filters: [builtinFilter("unread")] }),
    );
    expect(result.emptyReason).toBe("filters");
  });

  it("says hidden when a muted bucket is hiding all the mail", () => {
    // The case that used to report "This mailbox is empty" — a statement about
    // the user's mail that is plainly false, with no way out of it. Archive
    // everything in a bucket you muted and the mailbox goes quiet without ever
    // being empty.
    const result = runInboxQuery(
      query({ emails: plain, removedFilters: new Set(["starred"]) }),
    );
    expect(result.emptyReason).toBe("hidden");
  });

  it("says noSignal when the default inbox's own spam rule is hiding all of it", () => {
    // The mirror of `hidden`. Reading as an empty bin from inside the bin, which
    // is what a spam folder looked like when it was filtered by the inbox's
    // rules.
    const signals = new Map<number, EmailSignals>([[1, sig({ spamLikelihood: 0.95 })]]);
    const result = runInboxQuery(query({ emails: plain, signals }));
    expect(result.emptyReason).toBe("noSignal");
  });
});

describe("runInboxQuery — emptyReason precedence", () => {
  // The order is the order a user would want to be told, and it decides which
  // remedy the UI offers. A query box the user just typed into is the thing they
  // are most likely to want to undo, so `search` outranks everything.

  it("prefers search over an empty mailbox", () => {
    expect(runInboxQuery(query({ emails: [], searchQuery: "invoice" })).emptyReason).toBe("search");
  });

  it("prefers search over an active filter", () => {
    // Both axes narrow at once, so the remedy "clear your filters" would be
    // wrong for the message the user just typed.
    const result = runInboxQuery(
      query({
        emails: mailbox([{ starred: true, subject: "Contract" }]),
        filters: [builtinFilter("starred")],
        searchQuery: "zzznomatch",
      }),
    );
    expect(result.emptyReason).toBe("search");
  });

  it("prefers filters over an empty mailbox", () => {
    expect(
      runInboxQuery(query({ emails: [], filters: [builtinFilter("starred")] })).emptyReason,
    ).toBe("filters");
  });

  it("prefers an empty mailbox over the muted-bucket explanation", () => {
    // With no mail at all there is nothing for a mute to be hiding, and telling
    // the user to unmute a bucket would send them to fix a problem they do not
    // have.
    expect(
      runInboxQuery(query({ emails: [], removedFilters: new Set(["starred"]) })).emptyReason,
    ).toBe("mailbox");
  });

  it("prefers search over hidden and over noSignal alike", () => {
    const messages = mailbox([{ starred: true }]);
    const signals = new Map<number, EmailSignals>([[1, sig({ spamLikelihood: 0.95 })]]);
    const hidden = runInboxQuery(
      query({ emails: messages, searchQuery: "zzznomatch", removedFilters: new Set(["starred"]) }),
    );
    expect(hidden.emptyReason).toBe("search");

    const noSignal = runInboxQuery(
      query({ emails: messages, signals, searchQuery: "zzznomatch" }),
    );
    expect(noSignal.emptyReason).toBe("search");
  });
});

describe("runInboxQuery — sort", () => {
  it("puts the newest first for date", () => {
    const messages = mailbox([
      { receivedAt: 1_000, subject: "Oldest" },
      { receivedAt: 3_000, subject: "Newest" },
      { receivedAt: 2_000, subject: "Middle" },
    ]);
    const result = runInboxQuery(query({ emails: messages, sortBy: "date" }));
    expect(gmailIds(result)).toEqual(["g2", "g3", "g1"]);
  });

  it("orders ascending by sender, address included", () => {
    // The whole address, not a display name: the address is the identity key
    // everywhere else, and sorting on a name would put two colleagues from one
    // company in the wrong order.
    const messages = mailbox([
      { sender: "zoe@northwind.example", subject: "Z" },
      { sender: "ada@northwind.example", subject: "A" },
      { sender: "mike@northwind.example", subject: "M" },
    ]);
    const result = runInboxQuery(query({ emails: messages, sortBy: "sender" }));
    expect(gmailIds(result)).toEqual(["g2", "g3", "g1"]);
  });

  it("scores only when the sort asks for it", () => {
    // Property 3 in the module header. Computing the score up front cost a regex
    // pass over every message for a sort the user may never have selected, so
    // the map is null for the two orders that do not read it.
    const messages = mailbox([{ subject: "Invoice", body: "Due." }]);
    for (const sortBy of ["date", "sender"] as const) {
      expect(runInboxQuery(query({ emails: messages, sortBy })).scores).toBe(null);
    }
    expect(runInboxQuery(query({ emails: messages, sortBy: "score" })).scores).not.toBe(null);
  });

  it("puts the higher score first, which is not the same as the newer one", () => {
    // The two orders have to disagree somewhere or the sort is decoration. An
    // older starred message beats a newer empty one, because a star and a
    // security word are worth 30 points between them and being the newest in a
    // two-message window is worth three.
    const messages = mailbox([
      { receivedAt: 1_000, starred: true, subject: "Password reset" },
      { receivedAt: 2_000, subject: "Nothing to report" },
    ]);
    const byDate = runInboxQuery(query({ emails: messages, sortBy: "date" }));
    const byScore = runInboxQuery(query({ emails: messages, sortBy: "score" }));

    expect(gmailIds(byDate)).toEqual(["g2", "g1"]);
    expect(gmailIds(byScore)).toEqual(["g1", "g2"]);
    expect(byScore.scores!.get(1)).toBe(80);
    expect(byScore.scores!.get(2)).toBe(53);
  });

  it("carries an entry for every row it returns, and nothing else", () => {
    // Scoring happens *after* filtering, over the survivors only. A map holding
    // a score for a filtered-out message is the signature of the earlier version
    // that scored first: correct output, a regex pass over the whole mailbox per
    // keystroke, and a recency window spanning mail the user cannot see.
    const messages = mailbox([
      { starred: true, subject: "Invoice", receivedAt: 3_000 },
      { subject: "Statement", receivedAt: 2_000 },
      { starred: true, subject: "Receipt", receivedAt: 1_000 },
    ]);
    const result = runInboxQuery(
      query({ emails: messages, sortBy: "score", filters: [builtinFilter("starred")] }),
    );

    // Only the two starred survive, and g1 — which the whole mailbox would have
    // made newest anyway — is the only row at the window's edge.
    expect(gmailIds(result)).toEqual(["g1", "g3"]);
    expect(result.scores!.size).toBe(result.emails.length);
    expect(result.scores!.has(2)).toBe(false);
    // 50 base + 15 for the star + 8 for "invoice", and 3 more for being the
    // newest of the two that survived.
    expect(result.scores!.get(1)).toBe(76);
    expect(result.scores!.get(3)).toBe(73);
  });

  it("measures recency against the survivors, not the whole mailbox", () => {
    // The consequence of scoring last, and the reason it is worth the extra pass:
    // the newest *visible* message is at the edge of its own window even when the
    // mailbox continues past it. Scored against all three, g2 sits halfway across
    // a twice-as-wide window and would earn 2 points instead of 3 — so the exact
    // gap is the assertion, and the control at the end is what makes it falsifiable.
    const messages = mailbox([
      { receivedAt: 0, starred: true },
      { receivedAt: 1_000, starred: true },
      { receivedAt: 2_000 },
    ]);
    const result = runInboxQuery(
      query({ emails: messages, sortBy: "score", filters: [builtinFilter("starred")] }),
    );

    expect(gmailIds(result)).toEqual(["g2", "g1"]);
    // 50 base + 15 for the star, and then the recency gap between them.
    expect(result.scores!.get(1)).toBe(65);
    expect(result.scores!.get(2)).toBe(65 + MAX_RECENCY_BONUS);

    // The control: unfiltered, the same pair is ranked among mail neither of them
    // is next to, so the middle one earns less than the full nudge.
    const unfiltered = runInboxQuery(query({ emails: messages, sortBy: "score" }));
    const gap = unfiltered.scores!.get(2)! - unfiltered.scores!.get(1)!;
    expect(gap).toBeLessThan(MAX_RECENCY_BONUS);
  });

  it("returns rows even when the score is a dead heat", () => {
    // A stable sort with equal keys must not drop anything: two identical
    // messages are two rows, and a tie is not a reason to hide one.
    const messages = mailbox([{ subject: "Same" }, { subject: "Same" }]);
    const result = runInboxQuery(query({ emails: messages, sortBy: "score" }));
    expect(result.emails).toHaveLength(2);
    expect(result.scores!.get(1)).toBe(result.scores!.get(2));
  });
});

describe("runInboxQuery — purity", () => {
  it("does not reorder or filter the caller's array", () => {
    // The store hands in the filtered view it already holds. Sorting in place
    // would reorder that array, and the next derive — after a filter toggle, a
    // search keystroke, a sync — would start from an order no longer related to
    // the mailbox's, so the list would shuffle for no reason the user did.
    const messages = mailbox([
      { receivedAt: 2_000, sender: "zoe@northwind.example" },
      { receivedAt: 1_000, sender: "ada@northwind.example" },
      { receivedAt: 3_000, sender: "mike@northwind.example" },
    ]);
    const before = messages.map((message) => message.gmailId);

    for (const sortBy of ["date", "sender", "score"] as const) {
      runInboxQuery(query({ emails: messages, sortBy, searchQuery: "northwind" }));
      expect(messages.map((message) => message.gmailId)).toEqual(before);
    }
  });

  it("gives the same answer every time it is asked", () => {
    // It runs on every keystroke over every message, so a result that varied
    // between two identical calls would make rows swap under the cursor.
    const messages = mailbox([
      { starred: true, receivedAt: 1_000, subject: "Password reset" },
      { receivedAt: 2_000, subject: "Nothing urgent" },
    ]);
    const first = runInboxQuery(query({ emails: messages, sortBy: "score" }));
    for (let run = 0; run < 5; run += 1) {
      const again = runInboxQuery(query({ emails: messages, sortBy: "score" }));
      expect(gmailIds(again)).toEqual(gmailIds(first));
      expect([...again.scores!]).toEqual([...first.scores!]);
    }
  });
});

describe("groupThreads", () => {
  it("collapses a thread into one row and counts every message in it", () => {
    // The list is one row per conversation. Two rows for one exchange means the
    // user reads the same thread twice and cannot tell which row is the newer
    // half.
    const messages = mailbox([
      { threadId: "t1", receivedAt: 1_000, subject: "Re: plan" },
      { threadId: "t1", receivedAt: 3_000, subject: "Re: plan" },
      { threadId: "t2", receivedAt: 2_000, subject: "Lunch?" },
    ]);
    const rows = groupThreads(messages);

    expect(rows.map((row) => row.key)).toEqual(["t1", "t2"]);
    expect(rows[0].messageCount).toBe(2);
    expect(rows[1].messageCount).toBe(1);
  });

  it("gives a threadless message a key of its own, so two never merge", () => {
    // The failure this guards: keying the threadless case on anything shared —
    // a bare `"single"`, or the empty string — collapses every standalone
    // message in the mailbox into a single row, and the user is left with one
    // conversation containing mail from unrelated people.
    const messages = mailbox([
      { gmailId: "alpha", subject: "Notes from Tuesday" },
      { gmailId: "beta", subject: "Notes from Wednesday" },
    ]);
    const rows = groupThreads(messages);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.key)).toEqual(["single-alpha", "single-beta"]);
    for (const row of rows) {
      expect(row.messageCount).toBe(1);
    }
  });

  it("keeps the thread id and the single- keys in different namespaces", () => {
    // Both forms are opaque strings in one key space, so a collision would be
    // silent. Keying on the Gmail id means a thread whose id happens to be a
    // message id cannot be the same conversation.
    const messages = mailbox([{ gmailId: "t1", threadId: "t1", receivedAt: 1_000 }]);
    const rows = groupThreads(messages);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("t1");

    const orphan = mailbox([{ gmailId: "orphan" }]);
    expect(groupThreads(orphan)[0].key).toBe("single-orphan");
  });

  it("shows the newest message as the representative", () => {
    // The representative is the row's face and the message that gets opened, so
    // it has to be the newest — the group's messages are sorted oldest-first
    // precisely so the last one is the newest. Given out of order below, because
    // a list order that happens to match the date order hides the sort.
    const messages = mailbox([
      { threadId: "t1", receivedAt: 3_000, subject: "Third" },
      { threadId: "t1", receivedAt: 1_000, subject: "First" },
      { threadId: "t1", receivedAt: 2_000, subject: "Second" },
    ]);
    const [row] = groupThreads(messages);

    expect(row.representative.gmailId).toBe("g1");
    expect(row.representative.subject).toBe("Third");
    expect(row.messageCount).toBe(3);
  });

  it("is unread when any message in it is unread", () => {
    // "Unread" on a conversation means there is something in it you have not
    // read. Keying it off the representative alone would mark a thread read the
    // moment its newest half was opened, with an older half still waiting.
    const messages = mailbox([
      { threadId: "t1", receivedAt: 1_000, unread: true },
      { threadId: "t1", receivedAt: 3_000, unread: false },
      { threadId: "t2", receivedAt: 2_000, unread: false },
    ]);
    const rows = groupThreads(messages);
    const byKey = new Map(rows.map((row) => [row.key, row.unread]));

    expect(byKey.get("t1")).toBe(true);
    expect(byKey.get("t2")).toBe(false);
  });

  it("keeps the order the list arrived in", () => {
    // The grouping runs after the sort, so first-seen order is exactly the order
    // the user is looking at. Sorting by thread key or by date here would make
    // the list jump the moment the sort changed.
    const messages = mailbox([
      { threadId: "t3", receivedAt: 1_000 },
      { threadId: "t1", receivedAt: 3_000 },
      { threadId: "t3", receivedAt: 2_000 },
      { threadId: "t2", receivedAt: 2_500 },
    ]);
    expect(groupThreads(messages).map((row) => row.key)).toEqual(["t3", "t1", "t2"]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupThreads([])).toEqual([]);
  });
});

describe("conversationFor", () => {
  it("returns the whole thread across mailboxes, oldest first", () => {
    // Gmail files one exchange across Inbox, Archive and even the bin, so the
    // list is showing a fragment and the reader has to fetch the rest from the
    // full store. Oldest-first is not cosmetic: a reply above the message it
    // answers is unreadable.
    const all = mailbox([
      { threadId: "t1", mailbox: "inbox", receivedAt: 3_000, subject: "Third" },
      { threadId: "t1", mailbox: "archive", receivedAt: 1_000, subject: "First" },
      { threadId: "t1", mailbox: "inbox", receivedAt: 2_000, subject: "Second" },
      { threadId: "t2", mailbox: "inbox", receivedAt: 2_500, subject: "Other thread" },
    ]);
    const conversation = conversationFor(all, "t1", "g1");

    expect(conversation.map((message) => message.subject)).toEqual(["First", "Second", "Third"]);
  });

  it("matches the single- key when there is no thread", () => {
    // The two key forms are produced in two different functions and have to agree
    // exactly, or opening a standalone message hands the reader nothing. The
    // second message here shares neither the id nor the sender, so the only thing
    // that could pull it in is a key that matches too broadly.
    const all = mailbox([
      { gmailId: "alpha", subject: "Alpha", receivedAt: 2_000 },
      { gmailId: "beta", subject: "Beta", receivedAt: 1_000 },
    ]);
    const conversation = conversationFor(all, undefined, "alpha");

    expect(conversation).toHaveLength(1);
    expect(conversation[0].subject).toBe("Alpha");
    // And it is the same key `groupThreads` would have produced for that row.
    expect(groupThreads(all).map((row) => row.key)).toEqual(["single-alpha", "single-beta"]);
  });

  it("does not mix a threadless message into a real thread", () => {
    // A message with no thread id is its own conversation, so it must not be
    // swept up by whichever thread happens to be open. The two keys are different
    // strings and nothing bridges them.
    const all = mailbox([
      { threadId: "t1", receivedAt: 1_000, subject: "In the thread" },
      { receivedAt: 2_000, subject: "Standalone" },
    ]);
    expect(conversationFor(all, "t1", "g1").map((m) => m.subject)).toEqual(["In the thread"]);
    expect(conversationFor(all, undefined, "g2").map((m) => m.subject)).toEqual(["Standalone"]);
  });

  it("returns an empty conversation rather than everything for an unknown thread", () => {
    // The reader opens on whatever the row said. A stale row, or a message
    // deleted by a sync, must read as empty rather than dumping the mailbox.
    const all = mailbox([{ threadId: "t1", receivedAt: 1_000 }]);
    expect(conversationFor(all, "gone", "g1")).toEqual([]);
    expect(conversationFor([], "t1", "g1")).toEqual([]);
  });

  it("does not reorder the store's array", () => {
    // The full store is handed in, and it is sorted in place on the way out if
    // anything is careless. The next derive reads the same array, and the
    // conversation order would then depend on whether the reader had been opened.
    const all = mailbox([
      { threadId: "t1", receivedAt: 3_000 },
      { threadId: "t1", receivedAt: 1_000 },
      { threadId: "t1", receivedAt: 2_000 },
    ]);
    const before = all.map((message) => message.gmailId);

    conversationFor(all, "t1", "g1");
    expect(all.map((message) => message.gmailId)).toEqual(before);
  });
});