/**
 * Smart filters that learn.
 *
 * The corrections the user makes ("Change smart filters…"), the built-in answer they
 * are layered over, and the explanations behind both. The model itself lives in
 * `state.filterLearning`; these functions are the only code that writes it.
 */

import { classifyEmail } from "../../classify/classify";
import { matchesBuiltin } from "../../classify/filters";
import { explainFilters, type FilterReason } from "../../learn/filterExplain";
import {
  FilterLearning,
  builtInSays,
  LEARNABLE_FILTERS,
  type LearnableFilter,
} from "../../learn/filterLearning";
import { workDomainsFromSent } from "../../learn/workDomains";
import type { Email } from "../../model/email";
import { isUnsafe } from "../../model/signals";
import type { WinnowStore } from "../store";

/** What one "Change smart filters…" change did, for the picker's status line. */
export type SmartFilterChange = {
  filter: LearnableFilter;
  into: boolean;
  /** Messages whose membership changed. */
  moved: number;
  /** Messages that could not be put in, because they look unsafe. */
  unsafe: number;
  /** Messages already where the change asked for. */
  already: number;
};

/** The inbox message with this id, if the inbox has it. */
function inboxEmail(store: WinnowStore, id: number): Email | undefined {
  return store.state.all.find((email) => email.id === id && email.mailbox === "inbox");
}

function setFilterLearning(store: WinnowStore, model: FilterLearning): void {
  store.state = { ...store.state, filterLearning: model };
  store.onPersist?.({ filterLearning: model.toSnapshot() });
  store.notify();
}

/**
 * Hand the corrections to the account that just connected, or drop them if they were
 * another account's (or the demo's). Corrections made before any account owned them
 * belong to whoever connects first.
 */
export function claimFilterLearning(store: WinnowStore, email: string): void {
  const model = store.state.filterLearning;
  const owner = email.toLowerCase();
  if (model.owner === owner) return;
  const next = model.owner !== null ? FilterLearning.empty(owner) : model.withOwner(owner);
  setFilterLearning(store, next);
}

/**
 * The corrections as they are applied: `state.filterLearning` with the domains your
 * Sent mail shows are yours (`workDomains.ts`), so colleagues at a work domain never
 * share a domain rule even when the account is a personal one. Memoised on the
 * mailbox and the model, so it keeps its identity until either changes.
 */
export function learningModel(store: WinnowStore): FilterLearning {
  return store.state.filterLearning.withWorkDomains(workDomainsFromSent(store.state.all));
}

/**
 * For each learnable filter, whether all, some or none of these messages are in it
 * now — what the picker opens with.
 */
export function smartFilterMembership(
  store: WinnowStore,
  ids: readonly number[],
): Map<LearnableFilter, "all" | "some" | "none"> {
  const { profile, signals } = store.selectors.inboxAnalysis(store);
  const emails = ids.map((id) => inboxEmail(store, id)).filter((email): email is Email => email !== undefined);
  const out = new Map<LearnableFilter, "all" | "some" | "none">();
  for (const filter of LEARNABLE_FILTERS) {
    let hits = 0;
    for (const email of emails) {
      const signal = signals.get(email.id);
      if (signal && matchesBuiltin(filter, email, signal, profile)) hits += 1;
    }
    out.set(filter, hits === 0 ? "none" : hits === emails.length ? "all" : "some");
  }
  return out;
}

/**
 * "Change smart filters…": record one correction per message whose membership the
 * change actually alters — a message already where it was asked to be teaches nothing.
 * The corrections share one batch, so the action counts once per sender. Those messages
 * move at once, because a correction for a message decides that message.
 *
 * Returns, per change, how many messages moved and how many could not because they
 * look unsafe (learning never puts unsafe mail into a filter), for the picker's status.
 */
export function changeSmartFilters(
  store: WinnowStore,
  ids: readonly number[],
  changes: readonly { filter: LearnableFilter; into: boolean }[],
): SmartFilterChange[] {
  if (changes.length === 0) return [];
  const { profile, signals } = store.selectors.inboxAnalysis(store);
  let model = store.state.filterLearning;
  if (model.owner === null) model = model.withOwner(store.state.account?.email.toLowerCase() ?? "demo");
  const at = store.now();
  const batch = (store.smartFilterBatch = Math.max(store.smartFilterBatch + 1, at));
  const results: SmartFilterChange[] = [];
  for (const { filter, into } of changes) {
    const result: SmartFilterChange = { filter, into, moved: 0, unsafe: 0, already: 0 };
    for (const id of ids) {
      const email = inboxEmail(store, id);
      const signal = email ? signals.get(email.id) : undefined;
      if (!email || !signal) continue;
      if (matchesBuiltin(filter, email, signal, profile) === into) {
        result.already += 1;
        continue;
      }
      if (into && isUnsafe(signal)) {
        result.unsafe += 1;
        continue;
      }
      model = model.record(email, filter, into, at, batch);
      result.moved += 1;
    }
    results.push(result);
  }
  if (model !== store.state.filterLearning) setFilterLearning(store, model);
  return results;
}

/**
 * "Why it's here" for a message in another mailbox (1.3.3): the same explanation, from
 * the classification that mailbox's smart filters use (`mailboxSignals`). Drafts have
 * none.
 */
function explainInMailbox(store: WinnowStore, id: number, scores: boolean): FilterReason[] {
  const email = store.state.all.find((candidate) => candidate.id === id);
  if (!email || email.mailbox === "inbox") return [];
  const { profile } = store.selectors.inboxAnalysis(store);
  const { background, weights } = store.selectors.background(store);
  const base = classifyEmail(email, profile, weights);
  const learned = store.selectors.mailboxSignals(store, [email], profile).get(id) ?? base;
  return explainFilters(email, base, learned, profile, learningModel(store), {
    background,
    weights,
    scores,
  });
}

/**
 * "Why it's here" for one inbox message: one line per filter it is in. `scores` is
 * Dev Options → Show filter scores: each line also carries its numbers.
 */
export function explainSmartFilters(
  store: WinnowStore,
  id: number,
  { scores = false }: { scores?: boolean } = {},
): FilterReason[] {
  const email = inboxEmail(store, id);
  if (!email) return explainInMailbox(store, id, scores);
  const explanation = store.selectors.explanationFor(store, email);
  if (!explanation) return [];
  return explainFilters(email, explanation.base, explanation.learned, explanation.profile, learningModel(store), {
    background: explanation.background,
    weights: explanation.weights,
    scores,
  });
}

/** Whether the built-in rules alone would put this message in a filter. For tests and Settings. */
export function builtInFilter(store: WinnowStore, id: number, filter: LearnableFilter): boolean {
  const email = inboxEmail(store, id);
  const base = store.selectors.baseSignal(store, id);
  return email && base ? builtInSays(filter, email, base) : false;
}

export function removeFilterSenderRule(store: WinnowStore, filter: LearnableFilter, key: string): void {
  setFilterLearning(store, store.state.filterLearning.removeSenderRule(filter, key));
}

/** "Reset what's learnt", for one filter or all of them. */
export function resetFilterLearning(store: WinnowStore, filter?: LearnableFilter): void {
  setFilterLearning(store, store.state.filterLearning.reset(filter));
}
