/**
 * The contact index: everyone the mail in the store says the user has corresponded with.
 *
 * **Derived, never stored.** There is no table behind this and no cache in front of it —
 * the index is a function of the messages already in `state.all`, so it cannot disagree
 * with them and cannot go stale after a sync. Rebuilding it is a pass over the messages,
 * memoised against `state.all`'s identity, which is the same bargain the store already
 * makes for the profile.
 *
 * Three decisions worth naming:
 *
 *   - **One row per address, not per occurrence.** A message addressed To somebody and
 *     Cc'ing them is one interaction, and counting it twice would let a mailing list
 *     outrank a colleague on the strength of a single mail.
 *   - **Writing to someone counts for more than hearing from them.** A sent message is a
 *     deliberate choice of a specific person; an inbox full of a sender is not. Three to
 *     one is the ratio, and it is the reason a recipient list is worth building at all —
 *     without it the top suggestions are whoever wrote to you last week.
 *   - **The user is not in their own address book.** Derived from the account when there
 *     is one, and inferred from the sender of sent mail when there is not — which is what
 *     makes it work in the demo, where `state.account` is `null`.
 *
 * Google's own address book, when the user has opted in to it (`google.ts`), is merged
 * into the same rows: a saved contact or an "other contact" adds a fixed prior to
 * whatever the mail says, so the address book can surface someone the store has never
 * seen and break a tie between two people the mail rates the same — but it never
 * flattens the mail's own frequency, which still decides most of the order.
 */

import { domainPart, foldText, localPart, normalizeAddress } from "./addresses";
import { CATEGORY_WEIGHT } from "../model/profile";
import type { Email } from "../model/email";
import type { GoogleContact } from "./google";

/**
 * How much a message you wrote is worth against one you received.
 *
 * Only twice, and only because bulk is already handled elsewhere: received mail is
 * discounted by Gmail's own category, using the same table the engagement profile uses,
 * so a retailer sending four promotions cannot win on volume before this number is
 * consulted at all. Given that, a large multiple here would be solving the same problem
 * twice — and would let one message you happened to send outrank a correspondence you
 * have been having for months.
 */
export const SENT_WEIGHT = 2;

/**
 * Half the weight of an interaction is gone after this many days.
 *
 * Measured against the **newest message in the index**, not the wall clock, for the same
 * reason the list's importance nudge is: an inbox that re-ranked itself overnight would be
 * impossible to reason about, and a cached mailbox from last year would otherwise decay to
 * a flat list the first time it was opened.
 */
export const RECENCY_HALF_LIFE_DAYS = 45;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What being in Google's address book is worth, added to the mail-derived score.
 *
 * Additive and undecayed, because the address book has no dates: a saved contact is a
 * standing statement, not an interaction. The sizes are set against the mail's own
 * scale — a message you sent this week is worth `SENT_WEIGHT * SENT_WEIGHT = 4`, an
 * ordinary received one about 1:
 *
 *   - **saved: 3** — a contact the user deliberately kept is worth most of a fresh
 *     sent message, so with equal mail history a saved contact always ranks above an
 *     other contact and above a mail-only stranger, and with no mail at all they still
 *     appear above anyone you have only heard from once.
 *   - **other: 1** — Google's memory of someone you wrote to, possibly from another
 *     device or from before the sync window. About one received message: enough to
 *     surface them, never enough to outrank people the store shows you talk to.
 *
 * The gap is what keeps saved above other; the smallness of both is what keeps mail
 * frequency counting.
 */
export const SOURCE_PRIOR = { saved: 3, other: 1 } as const;

/** One person, as far as the mail in the store says. */
export type ContactEntry = {
  /** The address as it was last written, which is the form a draft should carry. */
  address: string;
  /** The best display name seen for it, or `undefined` if no message carried one. */
  name?: string;
  /** Messages from them, discounted by category so bulk cannot win on volume. */
  received: number;
  /** Messages the user wrote to them. */
  sent: number;
  /** Newest moment, in the message's own timestamp, at which they appeared. */
  lastSeen: number;
  /** Frequency weighted by recency, plus the address-book prior. The ranking number. */
  score: number;
  /**
   * Where Google's address book has them, if it does. `saved` wins when an address is
   * in both listings.
   */
  source?: "saved" | "other";
};

/**
 * The index, ready to search.
 *
 * `entries` is sorted by score and then by address, so a tie is a stable alphabetical
 * order rather than the order a `Map` happened to fill in — the same rule the rest of the
 * app follows when a ranking decides what is shown.
 */
export type ContactIndex = {
  readonly entries: readonly ContactEntry[];
  /** Folded address → entry, for looking a recipient's row up. */
  readonly byAddress: ReadonlyMap<string, ContactEntry>;
  /**
   * The user's own addresses, folded.
   *
   * Excluded rather than ranked last: suggesting somebody to write to at themselves is
   * the one result that makes the feature look broken rather than merely redundant.
   */
  readonly self: ReadonlySet<string>;
  /** The instant recency is measured from — the newest message in the corpus. */
  readonly reference: number;
};

export type BuildContactIndexOptions = {
  /** The signed-in address, when the store knows one. */
  selfAddress?: string | null;
  /** Google's address book, merged into the mail's rows. Empty without the opt-in. */
  googleContacts?: readonly GoogleContact[];
};

/** A row while it is being built, before recency has been folded in. */
type Draft = {
  /** The address as most recently spelled. */
  address: string;
  name?: string;
  /** When that name was seen, so a newer spelling of it wins and an absent one does not. */
  namedAt: number;
  /** Category-discounted weight of mail from them. See `CATEGORY_WEIGHT`. */
  received: number;
  sent: number;
  lastSeen: number;
  source?: "saved" | "other";
  /**
   * The address book's name, held apart from the mail's: a saved contact's name is what
   * the user chose to call them and wins over any header, while an other contact's name
   * is only a fallback for an address the mail never named.
   */
  bookName?: string;
};

/**
 * Build the index from a mailbox.
 *
 * Pure: no clock, no storage, no order dependence on anything but the messages. Every
 * query the composer makes is answered from the result.
 */
export function buildContactIndex(
  emails: readonly Email[],
  options: BuildContactIndexOptions = {},
): ContactIndex {
  const rows = new Map<string, Draft>();
  const self = new Set<string>();

  // The user's own address is knowable without being told, on sent mail: whatever wrote
  // it is the account. This is what makes the demo — where `state.account` is null —
  // exclude the sender of its own sent folder.
  for (const email of emails) {
    if (email.mailbox === "sent") self.add(normalizeAddress(email.sender));
  }
  if (options.selfAddress) self.add(normalizeAddress(options.selfAddress));

  for (const email of emails) {
    const outgoing = email.mailbox === "sent";
    const at = email.receivedAt;

    /*
      One sighting per address per *message*, whichever combination of header lines
      names it. A To/Cc pair is one interaction, and counting it twice lets a mailing
      list outrank a colleague on the strength of a single mail.
    */
    const inThisMessage = new Map<string, { address: string; name?: string }>();
    const remember = (raw: string, name?: string): void => {
      const key = normalizeAddress(raw);
      if (key === "" || self.has(key)) return;
      // First spelling wins inside one message: To before Cc before Bcc, which is the
      // order the headers themselves put them in.
      if (!inThisMessage.has(key)) inThisMessage.set(key, { address: raw.trim(), name });
    };

    remember(email.address ?? email.sender, email.name);
    for (const list of [email.to, email.cc, email.bcc]) {
      for (const contact of list ?? []) remember(contact.address, contact.name);
    }

    for (const [key, sighting] of inThisMessage) {
      // Recipients are counted at the sender's own weight. Being on the To line of a
      // message is being in the conversation, and it would be strange for a newsletter
      // that copied you to be a stronger contact than the newsletter itself.
      const weight = outgoing ? SENT_WEIGHT : CATEGORY_WEIGHT[email.category];
      merge(rows, key, sighting, at, weight, outgoing);
    }
  }

  for (const contact of options.googleContacts ?? []) {
    const key = normalizeAddress(contact.address);
    if (key === "" || self.has(key)) continue;
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, {
        address: contact.address.trim(),
        namedAt: Number.NEGATIVE_INFINITY,
        received: 0,
        sent: 0,
        // Never seen in mail. Zero rather than the reference, so the recency factor
        // has nothing to decay — the score is the prior alone.
        lastSeen: 0,
        source: contact.source,
        bookName: contact.name,
      });
      continue;
    }
    // Saved beats other when the same address arrives from both.
    if (existing.source !== "saved") {
      existing.source = contact.source;
      if (contact.name) existing.bookName = contact.name;
    } else if (!existing.bookName && contact.name) {
      existing.bookName = contact.name;
    }
  }

  const reference = emails.reduce((newest, email) => Math.max(newest, email.receivedAt), 0);

  const entries: ContactEntry[] = [];
  const byAddress = new Map<string, ContactEntry>();

  for (const [key, draft] of rows) {
    if (self.has(key)) continue;
    const entry: ContactEntry = {
      address: draft.address,
      name: displayName(draft),
      received: draft.received,
      sent: draft.sent,
      lastSeen: draft.lastSeen,
      score: rankScore(draft, reference),
    };
    if (draft.source) entry.source = draft.source;
    entries.push(entry);
    byAddress.set(key, entry);
  }

  entries.sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  return { entries, byAddress, self, reference };
}

/**
 * Fold one sighting into a row.
 *
 * Two clocks rather than one, and the reason is a bug this shape avoids: an older message
 * that carried a name must still lend it after a newer message arrived without one. With
 * a single "last seen" timestamp, the nameless message overwrites the name and the person
 * stops being anybody in particular.
 */
function merge(
  rows: Map<string, Draft>,
  key: string,
  sighting: { address: string; name?: string },
  at: number,
  weight: number,
  outgoing: boolean,
): void {
  const existing = rows.get(key);

  if (!existing) {
    rows.set(key, {
      address: sighting.address,
      name: sighting.name,
      // Never dated, so the first name seen from any direction replaces it.
      namedAt: sighting.name ? at : Number.NEGATIVE_INFINITY,
      // Mail you wrote counts whole; received mail is discounted by its category.
      received: outgoing ? 0 : weight,
      sent: outgoing ? 1 : 0,
      lastSeen: at,
    });
    return;
  }

  if (outgoing) existing.sent += 1;
  else existing.received += weight;

  // The address follows the most recent sighting, so a person who moved domains stops
  // being filed under the old one.
  if (at >= existing.lastSeen) {
    existing.address = sighting.address;
    existing.lastSeen = at;
  }

  // The name is never erased by a message that has none, and the newest spelling wins.
  if (sighting.name && at >= existing.namedAt) {
    existing.name = sighting.name;
    existing.namedAt = at;
  }
}

/**
 * How much this person is worth, in one number.
 *
 * Weight first, then decay: ten messages from two years ago should not outrank two from
 * last week, and multiplying rather than adding is what makes that true — an interaction
 * decays no matter how many others sit beside it.
 */
function rankScore(draft: Draft, reference: number): number {
  const mail = draft.sent + draft.received > 0
    ? (draft.sent * SENT_WEIGHT + draft.received) * recency(draft.lastSeen, reference)
    : 0;
  return mail + (draft.source ? SOURCE_PRIOR[draft.source] : 0);
}

/**
 * The name to show: a saved contact's own name first, then the newest name the mail
 * carried, then an other contact's name.
 */
function displayName(draft: Draft): string | undefined {
  if (draft.source === "saved" && draft.bookName) return draft.bookName;
  return draft.name ?? draft.bookName;
}

/** Exponential decay against the corpus's own newest message. Exported for its tests. */
export function recency(lastSeen: number, reference: number): number {
  const ageDays = Math.max(0, reference - lastSeen) / DAY_MS;
  return 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}

/** The folded haystacks a query is matched against. Built once per entry, on demand. */
export type MatchKey = {
  address: string;
  local: string;
  domain: string;
  name: string;
  words: readonly string[];
};

/**
 * The searchable form of one entry.
 *
 * Built lazily by `suggest.ts` rather than stored on the entry, because most entries are
 * never typed near: paying for the split of every name in a 5,000-message mailbox on
 * every keystroke would be paying for a search that does not happen.
 */
export function matchKey(entry: ContactEntry): MatchKey {
  const address = foldText(entry.address);
  // Folded *before* the split, so the words are the ones a query is compared against:
  // splitting the display name and folding afterwards leaves `Tomás` beside a search for
  // `tomas`, and the word match silently never fires for an accented name.
  const name = entry.name ? foldText(entry.name) : "";
  return {
    address,
    local: localPart(address),
    domain: domainPart(address),
    name,
    // Split on everything that is not a letter or digit, so "Ada, Countess" and
    // "O'Brien" are two words each and either half is findable.
    words: name ? name.split(/[^\p{L}\p{N}]+/u).filter(Boolean) : [],
  };
}