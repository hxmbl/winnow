/**
 * Smart filters that learn from your corrections — readably.
 *
 * The only thing this learns from is "Change smart filters…": you tick or untick a
 * filter for a message, and that is one *correction*. Nothing is learned from opening,
 * reading, starring or ignoring mail. Everything stays on this device.
 *
 * A message's place in a filter is decided in this order, and the first that has an
 * answer wins:
 *
 *   1. **You moved this message.** Your correction for this exact message stands.
 *   2. **A sender rule.** You have moved mail from this address (or, for a company's
 *      own domain, from anyone at that domain) into or out of the filter. The rule
 *      follows the balance of your corrections for that sender: moved in more often than
 *      out means in. An exact address beats its domain. A shared domain — gmail.com,
 *      outlook.com — never becomes a rule, only the address does. Sender rules are listed
 *      in Settings, one per sender, and each can be removed.
 *   3. **Similar mail you corrected.** A per-filter naive Bayes over the message's clues
 *      (`filterClues.ts`): tracking numbers, order numbers, amounts, dates, headers,
 *      Gmail's category and a few words. It counts, for every clue, how many of your
 *      corrections for this filter moved mail *with* that clue in and how many moved it
 *      out, and weighs the message's clues by those counts. Only clues you have actually
 *      corrected mail with count; a clue it has never seen says nothing.
 *   4. **The built-in rules** (`classify.ts`), which are also the starting point of
 *      step 3: their answer is taken to be right three times in four (`BUILT_IN_ODDS`),
 *      so one similar correction rarely overturns it, and two or three usually do.
 *
 * A correction changes exactly one filter. It is applied as a per-filter override
 * (`EmailSignals.filterOverrides`), never by rewriting the classifier's flags, so it
 * cannot leak into another filter, the importance score or star learning.
 *
 * So learned evidence can both add a message to a filter and take it out of one the
 * built-in rules put it in. No score is ever shown; "Why it's here" (`filterExplain.ts`)
 * says it in words.
 *
 * Storage: a versioned snapshot of the corrections themselves (`FilterLearningSnapshot`),
 * capped at `MAX_CORRECTIONS`, `MAX_CLUES` per correction and `MAX_VOCABULARY` distinct
 * clues. Everything else is recomputed from it. It is kept in this device's local storage
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
import { cachedClues, canRuleDomain, clueKind, registrableDomain, senderAddress } from "./filterClues";

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
 * correction is counted: three to one. This is the only tuning constant in the
 * decision; everything else is your own counts.
 */
export const BUILT_IN_ODDS = 3;
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
  /** Moved in more often than out. */
  into: boolean;
  /** How many messages tipped the balance (moved in minus moved out, or the reverse). */
  count: number;
};

/** Per-filter tallies, the naive-Bayes side. */
type ClueStats = {
  moved: { in: number; out: number };
  clues: Map<string, { in: number; out: number }>;
};

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

  /** Revive a stored snapshot, dropping anything malformed. A wrong version starts fresh. */
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
   * Record one correction. A second correction for the same message and filter
   * replaces the first, so changing your mind is not counted twice.
   */
  record(email: Email, filter: LearnableFilter, into: boolean, at: number): FilterLearning {
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

  private statsCache: Map<LearnableFilter, ClueStats> | null = null;
  private senderCache: Map<string, { in: number; out: number }> | null = null;

  private stats(): Map<LearnableFilter, ClueStats> {
    if (this.statsCache) return this.statsCache;
    const map = new Map<LearnableFilter, ClueStats>();
    for (const c of this.corrections) {
      let entry = map.get(c.filter);
      if (!entry) {
        entry = { moved: { in: 0, out: 0 }, clues: new Map() };
        map.set(c.filter, entry);
      }
      entry.moved[c.into ? "in" : "out"] += 1;
      for (const clue of c.clues) {
        let tally = entry.clues.get(clue);
        if (!tally) {
          tally = { in: 0, out: 0 };
          entry.clues.set(clue, tally);
        }
        tally[c.into ? "in" : "out"] += 1;
      }
    }
    this.statsCache = map;
    return map;
  }

  /** Balance per `filter|kind|key`. */
  private senders(): Map<string, { in: number; out: number }> {
    if (this.senderCache) return this.senderCache;
    const map = new Map<string, { in: number; out: number }>();
    const bump = (key: string, into: boolean) => {
      const tally = map.get(key) ?? { in: 0, out: 0 };
      tally[into ? "in" : "out"] += 1;
      map.set(key, tally);
    };
    for (const c of this.corrections) {
      if (c.address) bump(`${c.filter}|address|${c.address}`, c.into);
      if (c.domain) bump(`${c.filter}|domain|${c.domain}`, c.into);
    }
    this.senderCache = map;
    return map;
  }

  /** The filters that have any correction at all. */
  filtersWithCorrections(): Set<LearnableFilter> {
    return new Set(this.stats().keys());
  }

  correctionCount(filter: LearnableFilter): number {
    const moved = this.stats().get(filter)?.moved;
    return moved ? moved.in + moved.out : 0;
  }

  /**
   * Sender rules, as Settings lists them: one per company domain, else one per address,
   * leaving out senders whose corrections cancel out.
   */
  senderRules(filter?: LearnableFilter): SenderRule[] {
    const rules: SenderRule[] = [];
    const domainsShown = new Set<string>();
    for (const [key, tally] of this.senders()) {
      const [f, kind, id] = key.split("|") as [LearnableFilter, "address" | "domain", string];
      if (filter && f !== filter) continue;
      const net = tally.in - tally.out;
      if (net === 0) continue;
      if (kind === "domain") {
        domainsShown.add(`${f}|${id}`);
        rules.push({ filter: f, key: id, kind, into: net > 0, count: Math.abs(net) });
      }
    }
    for (const [key, tally] of this.senders()) {
      const [f, kind, id] = key.split("|") as [LearnableFilter, "address" | "domain", string];
      if (filter && f !== filter) continue;
      if (kind !== "address") continue;
      const net = tally.in - tally.out;
      if (net === 0) continue;
      // An address under a domain rule is shown as that domain, unless it disagrees.
      const domainRule = domainsShown.has(`${f}|${registrableDomain(id)}`);
      const domainTally = this.senders().get(`${f}|domain|${registrableDomain(id)}`);
      const domainInto = domainTally ? domainTally.in - domainTally.out > 0 : undefined;
      if (domainRule && domainInto === net > 0) continue;
      rules.push({ filter: f, key: id, kind, into: net > 0, count: Math.abs(net) });
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
   * the rule Settings lists.
   */
  senderRuleFor(email: Email, filter: LearnableFilter): SenderRule | null {
    const address = senderAddress(email);
    const domain = registrableDomain(address);
    const tallyOf = (kind: "address" | "domain", key: string): SenderRule | null => {
      if (!key || (kind === "domain" && !canRuleDomain(key))) return null;
      const tally = this.senders().get(`${filter}|${kind}|${key}`);
      if (!tally || tally.in === tally.out) return null;
      const net = tally.in - tally.out;
      return { filter, key, kind, into: net > 0, count: Math.abs(net) };
    };
    const byAddress = tallyOf("address", address);
    const byDomain = tallyOf("domain", domain);
    if (byAddress && byDomain && byAddress.into === byDomain.into) return byDomain;
    return byAddress ?? byDomain;
  }

  /**
   * Naive Bayes for one filter: the built-in answer as the prior (`BUILT_IN_ODDS` to one),
   * then one likelihood ratio per clue the message shares with your corrections, each
   * Laplace-smoothed from the counts. Returns the clues that pushed toward the answer,
   * strongest first, for the explanation.
   */
  private similarEvidence(
    email: Email,
    filter: LearnableFilter,
    builtIn: boolean,
  ): { into: boolean; clues: string[] } | null {
    const stats = this.stats().get(filter);
    if (!stats) return null;
    const { moved } = stats;
    let logOdds = (builtIn ? 1 : -1) * Math.log(BUILT_IN_ODDS);
    const pushes: { clue: string; weight: number }[] = [];
    for (const clue of cachedClues(email)) {
      const tally = stats.clues.get(clue);
      if (!tally) continue;
      const pIn = (tally.in + 1) / (moved.in + 2);
      const pOut = (tally.out + 1) / (moved.out + 2);
      const weight = Math.log(pIn / pOut);
      logOdds += weight;
      pushes.push({ clue, weight });
    }
    if (pushes.length === 0) return null;
    const into = logOdds > 0;
    const toward = pushes
      .filter((push) => (into ? push.weight > 0 : push.weight < 0))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight) || kindRank(a.clue) - kindRank(b.clue))
      .map((push) => push.clue);
    return { into, clues: toward };
  }

  /**
   * How many of your corrections for this filter moved mail like this one the same way:
   * from the same sender, or sharing two clues that are not words, or three of any kind.
   * The message itself is not counted.
   */
  similarCount(email: Email, filter: LearnableFilter, into: boolean): number {
    const address = senderAddress(email);
    const domain = registrableDomain(address);
    const mine = new Set(cachedClues(email));
    let count = 0;
    for (const c of this.corrections) {
      if (c.filter !== filter || c.into !== into || c.message === email.gmailId) continue;
      if ((c.address && c.address === address) || (c.domain && c.domain === domain)) {
        count += 1;
        continue;
      }
      let shared = 0;
      let strong = 0;
      for (const clue of c.clues) {
        if (!mine.has(clue)) continue;
        shared += 1;
        if (clueKind(clue) !== "word") strong += 1;
      }
      if (strong >= 2 || shared >= 3) count += 1;
    }
    return count;
  }

  /** The whole decision for one filter, with its reason. */
  decide(email: Email, filter: LearnableFilter, signals: EmailSignals): Decision {
    const builtIn = builtInSays(filter, email, signals);
    if (!this.filtersWithCorrections().has(filter)) return { by: "built-in", into: builtIn };
    const mine = this.messageAnswer(email.gmailId, filter);
    if (mine !== undefined) return { by: "message", into: mine };
    const rule = this.senderRuleFor(email, filter);
    if (rule) return { by: "sender", into: rule.into, rule };
    const similar = this.similarEvidence(email, filter, builtIn);
    if (similar && similar.into !== builtIn) {
      return { by: "similar", into: similar.into, clues: similar.clues, similar: this.similarCount(email, filter, similar.into) };
    }
    return { by: "built-in", into: builtIn };
  }

  /**
   * The signals with every learned answer applied as a per-filter override. Returns the
   * same object when nothing changed, so an untouched message costs nothing downstream.
   */
  apply(email: Email, signals: EmailSignals): EmailSignals {
    let next = signals;
    for (const filter of this.filtersWithCorrections()) {
      const decision = this.decide(email, filter, signals);
      if (decision.by === "built-in") continue;
      if (decision.into === builtInSays(filter, email, signals)) continue;
      next = withAnswer(next, filter, decision.into);
    }
    return next;
  }
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
    Number.isFinite(c.at)
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

/** Apply a model to a whole signal map. The map is returned as-is when nothing is learned. */
export function applyFilterLearning(
  emails: readonly Email[],
  signals: ReadonlyMap<number, EmailSignals>,
  model: FilterLearning,
): ReadonlyMap<number, EmailSignals> {
  if (model.isEmpty) return signals;
  const out = new Map(signals);
  for (const email of emails) {
    const base = signals.get(email.id);
    if (!base) continue;
    const next = model.apply(email, base);
    if (next !== base) out.set(email.id, next);
  }
  return out;
}
