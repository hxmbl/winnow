/**
 * Smart filters that learn from your corrections — readably.
 *
 * The only thing this learns from is "Change smart filters…": you tick or untick a
 * filter for a message, and that is one *correction*. Nothing is learned from opening,
 * reading, starring or ignoring mail. Everything stays on this device.
 *
 * A correction changes exactly one filter. It is applied as a per-filter override
 * (`EmailSignals.filterOverrides`), never by rewriting the classifier's flags, so it
 * cannot leak into another filter, the importance score or star learning.
 *
 * A message's place in a filter is decided in this order, and the first that has an
 * answer wins:
 *
 *   1. **You moved this message.** Your correction for this exact message stands.
 *   2. **A sender rule.** You have moved mail from this exact address into (or out of)
 *      the filter, and never the other way: one correction is enough for an address.
 *      A rule for a whole domain is broader, so it needs more: corrections from at least
 *      `MIN_DOMAIN_ADDRESSES` different addresses at that domain, all the same way. A
 *      sender or domain with corrections both ways has no rule. Your own domain (the
 *      signed-in account's) and shared domains — gmail.com, outlook.com — never become a
 *      domain rule, only addresses. An exact address beats its domain. Sender rules are
 *      listed in Settings, one per sender, and each can be removed.
 *   3. **Similar mail you corrected.** A per-filter naive Bayes over the message's clues
 *      (`filterClues.ts`). Generic clues — Gmail's category, a no-reply address, a
 *      List-Unsubscribe header, attachments, a date — never count, and the words of a
 *      message together count as one clue at most. Each clue's evidence is smoothed
 *      toward how common it is in your inbox (`ClueBackground`), so a clue most mail
 *      carries says little, a clue never votes against the direction you moved it, and
 *      no single clue weighs more than the built-in answer, so it takes two different
 *      specific clues (a tracking number and the words, say) to overturn it.
 *      It may overturn the built-in answer only when at least `MIN_SUPPORT` of your
 *      corrections for this filter moved mail the same way sharing a clue that pushes
 *      this message that way (not merely any clue in common), and it never takes mail out of Security or Important on its own.
 *   4. **The built-in rules** (`classify.ts`), which are also the starting point of
 *      step 3: their answer is taken to be right three times in four (`BUILT_IN_ODDS`).
 *
 * One action counts once per sender: ticking a filter for thirty messages from one
 * newsletter is one decision about that sender, not thirty (`FilterCorrection.batch`).
 *
 * No score is ever shown; "Why it's here" (`filterExplain.ts`) says it in words.
 *
 * Storage: a versioned snapshot of the corrections themselves (`FilterLearningSnapshot`),
 * capped at `MAX_CORRECTIONS`, `MAX_CLUES` per correction and `MAX_VOCABULARY` distinct
 * clues. Everything else is recomputed from it, so snapshots written before these rules
 * load unchanged and are simply read by them. It is kept in this device's local storage
 * only, is never written to Gmail or any server, and belongs to one account: it is
 * cleared on sign-out and when a different account connects.
 */

import type { Email } from "../model/email";
import {
  SIGNAL_FILTERS,
  builtInSignalFilter,
  isSignalFilter,
  type EmailSignals,
  type SignalFilter,
} from "../model/signals";
import { cachedClues, canRuleDomain, clueKind, isGenericClue, registrableDomain, senderAddress } from "./filterClues";

// ── What can be learned ─────────────────────────────────────────────────────

/**
 * The smart filters a correction can change, in rail order. Filters that are facts about
 * a message rather than a judgement — Starred, Unread, Files, the contact buckets, Read
 * later, Long reads and Unsafe — are not here: they are changed by starring, reading, or
 * "Not spam", not by teaching. The list lives beside the predicate (`SIGNAL_FILTERS`), so
 * the filter, its badge and the learning read one answer.
 */
export const LEARNABLE_FILTERS = SIGNAL_FILTERS;

export type LearnableFilter = SignalFilter;

export function isLearnable(filter: string): filter is LearnableFilter {
  return isSignalFilter(filter);
}

/**
 * What the built-in rules say about one filter for one message: exactly what the filter
 * would show with no correction, gates included (Urgent leaves promos out, most filters
 * leave unsafe mail out). The naive-Bayes prior starts from this, so it starts from what
 * the user actually sees.
 */
export function builtInSays(filter: LearnableFilter, email: Email, signals: EmailSignals): boolean {
  return builtInSignalFilter(filter, email, signals);
}

/** The signals with one filter's answer set as an override; the classifier's flags stay. */
function withAnswer(signals: EmailSignals, filter: LearnableFilter, into: boolean): EmailSignals {
  return { ...signals, filterOverrides: { ...signals.filterOverrides, [filter]: into } };
}

// ── The numbers, all of them ────────────────────────────────────────────────

/**
 * Odds that the built-in rules are right about a message, before any similar
 * correction is counted: three to one.
 */
export const BUILT_IN_ODDS = 3;
/**
 * Similar mail can overturn the built-in answer only when at least this many of your
 * corrections (one per sender per action) moved mail the same way sharing a clue that
 * pushes it that way. One correction is never enough on its own.
 */
export const MIN_SUPPORT = 2;
/**
 * How strongly a clue's evidence is pulled toward how common it is in your inbox, in
 * corrections' worth. With few corrections a clue most mail carries says almost nothing.
 */
export const BACKGROUND_WEIGHT = 2;
/** A rule for a whole domain needs corrections from at least this many addresses there. */
export const MIN_DOMAIN_ADDRESSES = 2;
/** The demo mailbox's own domain: the demo account is alex@northwind.example. */
export const DEMO_OWN_DOMAIN = "northwind.example";
/** Corrections kept. The oldest go first; the newest are what you meant most recently. */
export const MAX_CORRECTIONS = 300;
/** Clues kept per correction (patterns and headers first, words last). */
export const MAX_CLUES = 20;
/** Distinct clues across every correction. Past it, the rarest words are dropped. */
export const MAX_VOCABULARY = 1200;
export const SNAPSHOT_VERSION = 1;

// ── Storage shape ───────────────────────────────────────────────────────────

/** One correction, as stored. Readable on purpose. */
export type FilterCorrection = {
  /** The Gmail id of the message that was moved. */
  message: string;
  filter: LearnableFilter;
  /** True: moved into the filter. False: taken out of it. */
  into: boolean;
  /** The sender's address, or `""` once its sender rule was removed in Settings. */
  address: string;
  /** The sender's registrable domain, or `""` (removed, or a shared domain). */
  domain: string;
  clues: string[];
  at: number;
  /**
   * The action this correction was part of. Corrections from one action and one sender
   * count as one decision. Absent in snapshots written before it existed, where each
   * correction counts on its own.
   */
  batch?: number;
};

export type FilterLearningSnapshot = {
  version: typeof SNAPSHOT_VERSION;
  /** The account these corrections belong to; `"demo"` for the demo mailbox. */
  owner: string | null;
  corrections: FilterCorrection[];
};

/** A sender rule as Settings lists it. */
export type SenderRule = {
  filter: LearnableFilter;
  /** The address, or the domain for a domain rule. */
  key: string;
  kind: "address" | "domain";
  /** Moved in (true) or out (false); a sender with both has no rule. */
  into: boolean;
  /** How many decisions made the rule (one per message, or per sender per action). */
  count: number;
};

/**
 * How common each clue is in the mail being sorted: the background a clue's evidence is
 * smoothed toward. Built from the inbox on this device (`clueBackground`).
 */
export type ClueBackground = {
  readonly size: number;
  readonly counts: ReadonlyMap<string, number>;
};

/** No background: every clue is taken to be on half of all mail. Conservative. */
export const EMPTY_BACKGROUND: ClueBackground = { size: 0, counts: new Map() };

/** Share of mail carrying a clue, smoothed so it is never exactly 0 or 1. */
function backgroundRate(background: ClueBackground, clue: string): number {
  return ((background.counts.get(clue) ?? 0) + 1) / (background.size + 2);
}

const backgroundCache = new WeakMap<readonly Email[], ClueBackground>();
/** The clue background of a set of messages, memoised per array. */
export function clueBackground(emails: readonly Email[]): ClueBackground {
  const hit = backgroundCache.get(emails);
  if (hit) return hit;
  const counts = new Map<string, number>();
  for (const email of emails) {
    for (const clue of new Set(cachedClues(email))) counts.set(clue, (counts.get(clue) ?? 0) + 1);
  }
  const background = { size: emails.length, counts };
  backgroundCache.set(emails, background);
  return background;
}

/**
 * One decision: a single correction, or every correction one action made for one sender.
 * `clues` holds the share of its messages carrying each clue (1 for a single message).
 */
type Unit = {
  filter: LearnableFilter;
  into: boolean;
  address: string;
  domain: string;
  messages: string[];
  clues: Map<string, number>;
};

/** Per-filter tallies, the naive-Bayes side, counted in decisions. */
type ClueStats = {
  moved: { in: number; out: number };
  clues: Map<string, { in: number; out: number }>;
  units: Unit[];
};

type Tally = { in: number; out: number; addressesIn: Set<string>; addressesOut: Set<string> };

/** Why a message is where it is, for one filter. Read by `filterExplain.ts`. */
export type Decision =
  | { by: "message"; into: boolean }
  | { by: "sender"; into: boolean; rule: SenderRule }
  | { by: "similar"; into: boolean; clues: string[]; similar: number }
  | { by: "built-in"; into: boolean };

// ── The model ───────────────────────────────────────────────────────────────

/**
 * Immutable: every change returns a new model, so the store can memoise its derived
 * view on identity, the same way it does for the sorting weights.
 */
export class FilterLearning {
  readonly owner: string | null;
  readonly corrections: readonly FilterCorrection[];

  private constructor(owner: string | null, corrections: readonly FilterCorrection[]) {
    this.owner = owner;
    this.corrections = corrections;
  }

  static empty(owner: string | null = null): FilterLearning {
    return new FilterLearning(owner, []);
  }

  /**
   * Revive a stored snapshot, dropping anything malformed. A wrong version starts fresh.
   * Snapshots from before `batch` existed load as they are: each correction is its own
   * decision, and the sender and similarity rules here apply to them unchanged.
   */
  static fromSnapshot(raw: unknown): FilterLearning {
    if (!raw || typeof raw !== "object") return FilterLearning.empty();
    const snapshot = raw as Partial<FilterLearningSnapshot>;
    if (snapshot.version !== SNAPSHOT_VERSION) return FilterLearning.empty();
    const owner = typeof snapshot.owner === "string" ? snapshot.owner : null;
    const list = Array.isArray(snapshot.corrections) ? snapshot.corrections : [];
    return new FilterLearning(owner, capVocabulary(list.filter(isCorrection).slice(-MAX_CORRECTIONS)));
  }

  toSnapshot(): FilterLearningSnapshot {
    return { version: SNAPSHOT_VERSION, owner: this.owner, corrections: this.corrections.slice() };
  }

  get isEmpty(): boolean {
    return this.corrections.length === 0;
  }

  /** The same corrections, claimed by an account. */
  withOwner(owner: string | null): FilterLearning {
    return owner === this.owner ? this : new FilterLearning(owner, this.corrections);
  }

  /**
   * The account's own domain, which never gets a domain rule: everyone you work with
   * writes from it, and one colleague's mail says nothing about another's.
   */
  get ownDomain(): string {
    if (!this.owner) return "";
    if (this.owner === "demo") return DEMO_OWN_DOMAIN;
    return this.owner.includes("@") ? registrableDomain(this.owner.toLowerCase()) : "";
  }

  /**
   * Record one correction. A second correction for the same message and filter
   * replaces the first, so changing your mind is not counted twice. Pass the same
   * `batch` for every correction one action makes.
   */
  record(email: Email, filter: LearnableFilter, into: boolean, at: number, batch?: number): FilterLearning {
    const address = senderAddress(email);
    const domain = registrableDomain(address);
    const clues = cachedClues(email).slice(0, MAX_CLUES);
    const correction: FilterCorrection = {
      message: email.gmailId,
      filter,
      into,
      address,
      domain: canRuleDomain(domain) ? domain : "",
      clues,
      at,
      ...(batch !== undefined ? { batch } : {}),
    };
    const kept = this.corrections.filter((c) => !(c.message === email.gmailId && c.filter === filter));
    kept.push(correction);
    return new FilterLearning(this.owner, capVocabulary(kept.slice(-MAX_CORRECTIONS)));
  }

  /** Forget everything, or one filter's corrections. */
  reset(filter?: LearnableFilter): FilterLearning {
    if (!filter) return new FilterLearning(this.owner, []);
    return new FilterLearning(this.owner, this.corrections.filter((c) => c.filter !== filter));
  }

  /**
   * Remove a sender rule. The corrections stay — the messages you moved keep their place
   * and their clues still count as similar mail — but they no longer speak for the
   * sender. Removing a domain also removes the address rules under it, since Settings
   * shows them as one.
   */
  removeSenderRule(filter: LearnableFilter, key: string): FilterLearning {
    const lower = key.toLowerCase();
    const isDomain = !lower.includes("@");
    const next = this.corrections.map((c) => {
      if (c.filter !== filter) return c;
      if (isDomain) {
        const hit = c.domain === lower || (c.address !== "" && registrableDomain(c.address) === lower);
        return hit ? { ...c, address: "", domain: "" } : c;
      }
      return c.address === lower ? { ...c, address: "" } : c;
    });
    return new FilterLearning(this.owner, next);
  }

  // ── Derived, memoised on this instance ──

  private unitsCache: Unit[] | null = null;
  private statsCache: Map<LearnableFilter, ClueStats> | null = null;
  private senderCache: Map<string, Tally> | null = null;

  /** The corrections grouped into decisions: one per message, or per sender per action. */
  private units(): Unit[] {
    if (this.unitsCache) return this.unitsCache;
    const groups = new Map<string, FilterCorrection[]>();
    for (const c of this.corrections) {
      const who = c.address || c.domain || `message:${c.message}`;
      const key =
        c.batch !== undefined
          ? `${c.filter}|${c.into}|batch:${c.batch}|${who}`
          : `${c.filter}|message:${c.message}`;
      const list = groups.get(key);
      if (list) list.push(c);
      else groups.set(key, [c]);
    }
    const units: Unit[] = [];
    for (const list of groups.values()) {
      const first = list[0];
      const clues = new Map<string, number>();
      for (const c of list) for (const clue of new Set(c.clues)) clues.set(clue, (clues.get(clue) ?? 0) + 1 / list.length);
      units.push({
        filter: first.filter,
        into: first.into,
        address: first.address,
        domain: first.domain,
        messages: list.map((c) => c.message),
        clues,
      });
    }
    this.unitsCache = units;
    return units;
  }

  private stats(): Map<LearnableFilter, ClueStats> {
    if (this.statsCache) return this.statsCache;
    const map = new Map<LearnableFilter, ClueStats>();
    for (const unit of this.units()) {
      let entry = map.get(unit.filter);
      if (!entry) {
        entry = { moved: { in: 0, out: 0 }, clues: new Map(), units: [] };
        map.set(unit.filter, entry);
      }
      entry.units.push(unit);
      entry.moved[unit.into ? "in" : "out"] += 1;
      for (const [clue, share] of unit.clues) {
        let tally = entry.clues.get(clue);
        if (!tally) {
          tally = { in: 0, out: 0 };
          entry.clues.set(clue, tally);
        }
        tally[unit.into ? "in" : "out"] += share;
      }
    }
    this.statsCache = map;
    return map;
  }

  /** Decisions per `filter|kind|key`, with the distinct addresses behind each direction. */
  private senders(): Map<string, Tally> {
    if (this.senderCache) return this.senderCache;
    const map = new Map<string, Tally>();
    const bump = (key: string, unit: Unit) => {
      let tally = map.get(key);
      if (!tally) {
        tally = { in: 0, out: 0, addressesIn: new Set(), addressesOut: new Set() };
        map.set(key, tally);
      }
      tally[unit.into ? "in" : "out"] += 1;
      if (unit.address) (unit.into ? tally.addressesIn : tally.addressesOut).add(unit.address);
    };
    for (const unit of this.units()) {
      if (unit.address) bump(`${unit.filter}|address|${unit.address}`, unit);
      if (unit.domain) bump(`${unit.filter}|domain|${unit.domain}`, unit);
    }
    this.senderCache = map;
    return map;
  }

  /**
   * The rule a tally makes, or null. Corrections both ways make no rule; a domain also
   * needs `MIN_DOMAIN_ADDRESSES` distinct addresses, and is never the account's own or a
   * shared one.
   */
  private ruleFrom(filter: LearnableFilter, kind: "address" | "domain", key: string): SenderRule | null {
    if (!key) return null;
    if (kind === "domain" && (!canRuleDomain(key) || key === this.ownDomain)) return null;
    const tally = this.senders().get(`${filter}|${kind}|${key}`);
    if (!tally) return null;
    if (tally.in > 0 && tally.out > 0) return null;
    const into = tally.in > 0;
    if (kind === "domain" && (into ? tally.addressesIn : tally.addressesOut).size < MIN_DOMAIN_ADDRESSES) return null;
    return { filter, key, kind, into, count: into ? tally.in : tally.out };
  }

  /** The filters that have any correction at all. */
  filtersWithCorrections(): Set<LearnableFilter> {
    return new Set(this.stats().keys());
  }

  /** Corrections stored for a filter (one per message). */
  correctionCount(filter: LearnableFilter): number {
    return this.corrections.filter((c) => c.filter === filter).length;
  }

  /**
   * Sender rules, as Settings lists them: domain rules, then address rules — leaving out
   * an address that only repeats its domain's rule, and senders with no rule.
   */
  senderRules(filter?: LearnableFilter): SenderRule[] {
    const rules: SenderRule[] = [];
    const keys = [...this.senders().keys()].map((key) => key.split("|") as [LearnableFilter, "address" | "domain", string]);
    const domainRules = new Map<string, SenderRule>();
    for (const [f, kind, id] of keys) {
      if (kind !== "domain" || (filter && f !== filter)) continue;
      const rule = this.ruleFrom(f, kind, id);
      if (!rule) continue;
      domainRules.set(`${f}|${id}`, rule);
      rules.push(rule);
    }
    for (const [f, kind, id] of keys) {
      if (kind !== "address" || (filter && f !== filter)) continue;
      const rule = this.ruleFrom(f, kind, id);
      if (!rule) continue;
      // An address under a domain rule is shown as that domain, unless it disagrees.
      const domainRule = domainRules.get(`${f}|${registrableDomain(id)}`);
      if (domainRule && domainRule.into === rule.into) continue;
      rules.push(rule);
    }
    return rules.sort(
      (a, b) =>
        LEARNABLE_FILTERS.indexOf(a.filter) - LEARNABLE_FILTERS.indexOf(b.filter) || b.count - a.count || a.key.localeCompare(b.key),
    );
  }

  /** Your correction for this exact message, if any. */
  messageAnswer(gmailId: string, filter: LearnableFilter): boolean | undefined {
    for (let i = this.corrections.length - 1; i >= 0; i -= 1) {
      const c = this.corrections[i];
      if (c.message === gmailId && c.filter === filter) return c.into;
    }
    return undefined;
  }

  /**
   * The sender rule that applies to this message. An address rule beats its domain's
   * when the two disagree; when they agree the domain is the one named, since that is
   * the rule Settings lists. An address with corrections both ways has no rule, and
   * neither does its domain then.
   */
  senderRuleFor(email: Email, filter: LearnableFilter): SenderRule | null {
    const address = senderAddress(email);
    const byAddress = this.ruleFrom(filter, "address", address);
    const byDomain = this.ruleFrom(filter, "domain", registrableDomain(address));
    if (byAddress && byDomain && byAddress.into === byDomain.into) return byDomain;
    return byAddress ?? byDomain;
  }

  /**
   * Naive Bayes for one filter, when it may overturn the built-in answer: the built-in
   * answer as the prior (`BUILT_IN_ODDS` to one), then one likelihood ratio per specific
   * clue the message shares with your corrections, each smoothed toward the clue's
   * background rate. Each clue is capped at the prior's own weight, and words together at
   * the strongest single word, so no one clue can overturn the built-in answer. Returns the
   * flipped answer, the clues that pushed toward it (strongest first) and how many of
   * your decisions back it, counting only those that share one of those clues — or null
   * when the built-in answer stands.
   */
  private similarEvidence(
    email: Email,
    filter: LearnableFilter,
    builtIn: boolean,
    background: ClueBackground,
  ): { into: boolean; clues: string[]; support: number } | null {
    const stats = this.stats().get(filter);
    if (!stats) return null;
    const { moved } = stats;
    const prior = Math.log(BUILT_IN_ODDS);
    // No single clue may outweigh the built-in rules on its own: overturning them takes
    // at least two different specific clues pointing the same way (a pattern and the
    // words, say), never one rare word or one pattern alone.
    const cap = (weight: number) => Math.max(-prior, Math.min(prior, weight));
    let logOdds = (builtIn ? 1 : -1) * prior;
    const pushes: { clue: string; weight: number }[] = [];
    let words = 0;
    let strongestWord = 0;
    for (const clue of cachedClues(email)) {
      if (isGenericClue(clue)) continue;
      const tally = stats.clues.get(clue);
      if (!tally) continue;
      const weight = cap(clueWeight(tally, moved, backgroundRate(background, clue)));
      if (weight === 0) continue;
      pushes.push({ clue, weight });
      if (clueKind(clue) === "word") {
        words += weight;
        strongestWord = Math.max(strongestWord, Math.abs(weight));
      } else {
        logOdds += weight;
      }
    }
    // Words come together (a template's boilerplate is many words, one fact), so all of
    // them together are worth at most the strongest one.
    logOdds += Math.max(-strongestWord, Math.min(strongestWord, words));
    const into = logOdds > 0;
    if (into === builtIn) return null;
    // Similarity alone never takes mail out of Security or Important: missing a security
    // notice or something important costs far more than an extra one shown.
    if (!into && (filter === "security" || filter === "important")) return null;
    // The clues that pushed this message toward the flipped answer: each pattern, header
    // or category whose own weight points that way, and each word that does, but words
    // only when the words together point that way too, since a word moves the answer
    // only through their combined, capped sum.
    const sign = into ? 1 : -1;
    const wordsToward = Math.sign(words) === sign;
    const toward = pushes
      .filter((push) => Math.sign(push.weight) === sign && (clueKind(push.clue) !== "word" || wordsToward))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || kindRank(a.clue) - kindRank(b.clue))
      .map((push) => push.clue);
    // A decision of yours backs the flip only when it shares one of those clues. Sharing
    // a clue with no weight, or one that pushes the other way, is not support.
    const support = stats.units.filter((unit) => unit.into === into && toward.some((clue) => (unit.clues.get(clue) ?? 0) > 0)).length;
    if (support < MIN_SUPPORT) return null;
    return { into, clues: toward, support };
  }

  /**
   * The whole decision for one filter, with its reason. `background` is the clue
   * background of the mail being sorted (`clueBackground`); without one every clue is
   * taken to be common, which makes similar mail hard to overturn anything.
   */
  decide(email: Email, filter: LearnableFilter, signals: EmailSignals, background: ClueBackground = EMPTY_BACKGROUND): Decision {
    const builtIn = builtInSays(filter, email, signals);
    if (!this.filtersWithCorrections().has(filter)) return { by: "built-in", into: builtIn };
    const mine = this.messageAnswer(email.gmailId, filter);
    if (mine !== undefined) return { by: "message", into: mine };
    const rule = this.senderRuleFor(email, filter);
    if (rule) return { by: "sender", into: rule.into, rule };
    const similar = this.similarEvidence(email, filter, builtIn, background);
    if (similar) return { by: "similar", into: similar.into, clues: similar.clues, similar: similar.support };
    return { by: "built-in", into: builtIn };
  }

  /**
   * The signals with every learned answer applied as a per-filter override. Returns the
   * same object when nothing changed, so an untouched message costs nothing downstream.
   */
  apply(email: Email, signals: EmailSignals, background: ClueBackground = EMPTY_BACKGROUND): EmailSignals {
    let next = signals;
    for (const filter of this.filtersWithCorrections()) {
      const decision = this.decide(email, filter, signals, background);
      if (decision.by === "built-in") continue;
      if (decision.into === builtInSays(filter, email, signals)) continue;
      next = withAnswer(next, filter, decision.into);
    }
    return next;
  }
}

/**
 * One clue's log-likelihood ratio. Each side is the clue's share of your decisions that
 * way, smoothed toward its background rate by `BACKGROUND_WEIGHT` decisions. A clue
 * never votes against the direction it was seen in more often: with lopsided counts the
 * smoothing alone could flip the sign, so that case is zero.
 */
export function clueWeight(
  tally: { in: number; out: number },
  moved: { in: number; out: number },
  rate: number,
): number {
  const pIn = (tally.in + BACKGROUND_WEIGHT * rate) / (moved.in + BACKGROUND_WEIGHT);
  const pOut = (tally.out + BACKGROUND_WEIGHT * rate) / (moved.out + BACKGROUND_WEIGHT);
  const weight = Math.log(pIn / pOut);
  const shareIn = moved.in > 0 ? tally.in / moved.in : 0;
  const shareOut = moved.out > 0 ? tally.out / moved.out : 0;
  if ((weight > 0 && shareIn <= shareOut) || (weight < 0 && shareOut <= shareIn)) return 0;
  return weight;
}

/** Patterns before headers before the category before words. */
function kindRank(clue: string): number {
  switch (clueKind(clue)) {
    case "pattern":
      return 0;
    case "header":
      return 1;
    case "category":
      return 2;
    default:
      return 3;
  }
}

function isCorrection(raw: unknown): raw is FilterCorrection {
  if (!raw || typeof raw !== "object") return false;
  const c = raw as Partial<FilterCorrection>;
  return (
    typeof c.message === "string" &&
    typeof c.filter === "string" &&
    isLearnable(c.filter) &&
    typeof c.into === "boolean" &&
    typeof c.address === "string" &&
    typeof c.domain === "string" &&
    Array.isArray(c.clues) &&
    c.clues.every((clue) => typeof clue === "string") &&
    typeof c.at === "number" &&
    Number.isFinite(c.at) &&
    (c.batch === undefined || (typeof c.batch === "number" && Number.isFinite(c.batch)))
  );
}

/**
 * Keep the distinct clues under `MAX_VOCABULARY` by dropping the rarest *words* first.
 * Patterns, headers and categories are a fixed, small set and are never dropped.
 */
export function capVocabulary(corrections: readonly FilterCorrection[]): FilterCorrection[] {
  const counts = new Map<string, number>();
  for (const c of corrections) for (const clue of c.clues) counts.set(clue, (counts.get(clue) ?? 0) + 1);
  if (counts.size <= MAX_VOCABULARY) return corrections.map((c) => ({ ...c, clues: c.clues.slice(0, MAX_CLUES) }));
  const words = [...counts.entries()]
    .filter(([clue]) => clueKind(clue) === "word")
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
  const drop = new Set<string>();
  let size = counts.size;
  for (const [clue] of words) {
    if (size <= MAX_VOCABULARY) break;
    drop.add(clue);
    size -= 1;
  }
  return corrections.map((c) => ({ ...c, clues: c.clues.filter((clue) => !drop.has(clue)).slice(0, MAX_CLUES) }));
}

/**
 * Apply a model to a whole signal map, with the clue background of those messages. The
 * map is returned as-is when nothing is learned.
 */
export function applyFilterLearning(
  emails: readonly Email[],
  signals: ReadonlyMap<number, EmailSignals>,
  model: FilterLearning,
  background: ClueBackground = clueBackground(emails),
): ReadonlyMap<number, EmailSignals> {
  if (model.isEmpty) return signals;
  const out = new Map(signals);
  for (const email of emails) {
    const base = signals.get(email.id);
    if (!base) continue;
    const next = model.apply(email, base, background);
    if (next !== base) out.set(email.id, next);
  }
  return out;
}
