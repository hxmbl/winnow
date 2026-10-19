/**
 * "Why it's here": one plain line per smart filter a message is in.
 *
 *   In Deliveries because: from evri.com, has a tracking number, you moved 2 similar emails here
 *
 * Built from the same decision the list uses (`FilterLearning.decide`) and the same
 * vocabulary the built-in rules match (`classify/heuristics.ts`), so the sentence names
 * the path that actually decided — your correction for the message, a sender rule,
 * similar mail you corrected, or the built-in signals — and never a reason that had no
 * part in it. Generic clues (Gmail's category, a no-reply address) are never a reason.
 * No scores, ever: a reason is a thing about the message or a thing you did.
 */

import type { Email } from "../model/email";
import {
  BUILTIN_FILTERS,
  FILTER_LABELS,
  IMPORTANT_THRESHOLD,
  isUnsafe,
  type BuiltinSmartFilter,
  type EmailSignals,
} from "../model/signals";
import type { UserProfile } from "../model/profile";
import { matchesBuiltin } from "../classify/filters";
import { contentBag, matchesSocialDomain, senderRankBonus } from "../classify/classify";
import { STANDARD_WEIGHTS, type SignalWeights } from "../classify/weights";
import {
  codesKeywords,
  eventsKeywords,
  financeKeywords,
  financeRegex,
  needsActionRegexes,
  newsletterKeywords,
  promoRegex,
  replyRequestRegex,
  securityKeywords,
  shippingKeywords,
  socialKeywords,
  travelKeywords,
  urgentKeywords,
} from "../classify/heuristics";
import { PhraseMatcher, type KeywordTable } from "../classify/text";
import {
  SPECIFIC_TRACKING,
  cachedClues,
  clueKind,
  clueLabel,
  isGenericClue,
  registrableDomain,
  senderAddress,
} from "./filterClues";
import {
  EMPTY_BACKGROUND,
  isLearnable,
  type ClueBackground,
  type Decision,
  type FilterLearning,
  type LearnableFilter,
} from "./filterLearning";

/** Which path put the message in the filter: the same as `Decision["by"]`. */
export type ReasonSource = Decision["by"];

export type FilterReason = {
  filter: BuiltinSmartFilter;
  /** "Deliveries". */
  label: string;
  /** The reasons, each a phrase: "from evri.com", "has a tracking number". */
  reasons: string[];
  /** "In Deliveries because: from evri.com, has a tracking number". */
  line: string;
  /** What decided: your correction, a sender rule, similar mail, or the built-in rules. */
  source: ReasonSource;
};

/** At most this many reasons in one line; more reads as a list, not a sentence. */
export const MAX_REASONS = 3;

/** Filters that never get a line: Unread says itself. */
const SILENT: ReadonlySet<BuiltinSmartFilter> = new Set(["unread"]);

function firstPhrase(table: KeywordTable, text: string): string | null {
  for (const phrase of table.phrases) {
    if (new PhraseMatcher(phrase).test(text)) return phrase;
  }
  return null;
}

const quote = (text: string): string => `mentions “${text.trim().toLowerCase()}”`;

/** What the built-in rules matched, for one filter, in words. */
export function builtInReasons(
  filter: BuiltinSmartFilter,
  email: Email,
  signals: EmailSignals,
  profile: UserProfile,
  weights: SignalWeights = STANDARD_WEIGHTS,
): string[] {
  const text = contentBag(email);
  const action = `${email.subject} ${email.body}`;
  const phrase = (table: KeywordTable): string[] => {
    const hit = firstPhrase(table, text);
    return hit ? [quote(hit)] : [];
  };
  switch (filter) {
    case "shipping":
      return phrase(shippingKeywords);
    case "receipts": {
      const hit = firstPhrase(financeKeywords, text);
      if (hit) return [quote(hit)];
      const match = financeRegex.exec(text);
      return match ? [quote(match[0])] : [];
    }
    case "codes":
      return email.code ? ["has a one-time code", ...phrase(codesKeywords)] : phrase(codesKeywords);
    case "travel":
      return phrase(travelKeywords);
    case "events":
      return phrase(eventsKeywords);
    case "security":
      return phrase(securityKeywords);
    case "social":
      if (matchesSocialDomain(email)) return [`from ${registrableDomain(senderAddress(email))}`];
      return phrase(socialKeywords);
    case "urgent":
      if (email.urgent) return ["the sender marked it urgent"];
      return phrase(urgentKeywords);
    case "needs_action": {
      for (const pattern of [...needsActionRegexes, replyRequestRegex]) {
        const match = pattern.exec(action);
        if (match) return [`asks you to act (“${match[0].trim().toLowerCase()}”)`];
      }
      return [];
    }
    case "newsletters": {
      const out: string[] = [];
      if (email.category === "newsletter") out.push("Gmail files it as a newsletter");
      if (email.bulk || email.unsubscribe) out.push("has a List-Unsubscribe header");
      const hit = firstPhrase(newsletterKeywords, text);
      if (hit) out.push(quote(hit));
      return out;
    }
    case "promotional": {
      const out: string[] = [];
      if (email.category === "promotions") out.push("Gmail files it under Promotions");
      const match = promoRegex.exec(text);
      if (match) out.push(quote(match[0]));
      return out;
    }
    case "important":
      return importantReasons(email, signals, profile, weights);
    case "starred":
      return ["you starred it"];
    case "attachments":
      return ["has attachments"];
    case "new_senders":
      return ["the first email from this sender"];
    case "top_contacts":
      return ["one of the people you hear from most"];
    case "quiet_contacts":
      return ["a person who writes rarely"];
    case "low_priority":
      return ["nothing in it asks for you now"];
    case "long_reads":
      return ["it is long, with nothing urgent in it"];
    case "unsafe":
      return ["it reads like spam or phishing"];
    case "unread":
      return [];
  }
}

/**
 * Why the built-in rules call a message Important: only what pushed it there. A message
 * whose score falls short is Important because it asks for something; otherwise the
 * reasons are the parts of the score that added to it. The sender counts only when its
 * net contribution (the engagement bonus less any quiet-sender penalty) is above zero.
 */
function importantReasons(email: Email, signals: EmailSignals, profile: UserProfile, weights: SignalWeights): string[] {
  if (signals.importanceScore < IMPORTANT_THRESHOLD) {
    return signals.needsAction ? ["it asks you to do something"] : ["it stands out from your usual mail"];
  }
  const out: string[] = [];
  if (email.starred && weights.starBoost > 0) out.push("you starred it");
  const quiet = profile.quietSenders.includes(email.sender);
  const senderNet = senderRankBonus(profile, email.sender, weights.topSenderBoost) - (quiet ? weights.quietContactPenalty : 0);
  if (senderNet > 0) out.push(quiet ? "you engage with this sender's mail" : "you hear from this sender often");
  if (signals.security && weights.security > 0) out.push("it is a security notice");
  if (signals.urgentText && weights.urgency > 0) out.push("it reads as urgent");
  if (signals.needsAction && weights.actionNeeded > 0) out.push("it asks you to do something");
  if (signals.finance && weights.finance > 0) out.push("it is about money you owe or paid");
  if (signals.promotional && email.urgent) out.push("the sender marked it urgent");
  return out.length > 0 ? out : ["it stands out from your usual mail"];
}

/** Clue phrases, with the generic tracking number left out when a courier is named. */
function cluePhrases(clues: readonly string[]): string[] {
  const specific = clues.some((clue) => SPECIFIC_TRACKING.has(clue));
  const strong = clues.filter((clue) => clueKind(clue) !== "word");
  const words = clues.filter((clue) => clueKind(clue) === "word");
  return [...strong, ...words]
    .filter((clue) => !isGenericClue(clue))
    .filter((clue) => !(specific && clue === "p:tracking"))
    .map(clueLabel);
}

const moved = (n: number, into: boolean, what = "similar email"): string =>
  `you moved ${n} ${what}${n === 1 ? "" : "s"} ${into ? "here" : "out"}`;

/** The learned half of a line, for a filter the message is in. */
function learnedReasons(decision: Decision, email: Email, model: FilterLearning, filter: LearnableFilter): string[] {
  switch (decision.by) {
    case "message":
      return ["you put it here"];
    case "sender": {
      const out = [`from ${decision.rule.key}`];
      // A pattern this message shares with mail you moved here says what the sender
      // has in common; one is enough for a sentence.
      const taught = new Set(
        model.corrections.filter((c) => c.filter === filter && c.into).flatMap((c) => c.clues),
      );
      const shared = cachedClues(email).filter((clue) => clueKind(clue) === "pattern" && taught.has(clue));
      const phrase = cluePhrases(shared)[0];
      if (phrase) out.push(phrase);
      if (decision.into) out.push(moved(decision.rule.count, true, "email"));
      return out;
    }
    case "similar": {
      // The specific clues that carried the decision, and the corrections behind it
      // (counted the way the decision counted them). Never generic clues alone.
      const out = cluePhrases(decision.clues).slice(0, MAX_REASONS - 1);
      out.push(moved(decision.similar, true));
      return out;
    }
    case "built-in":
      return [];
  }
}

/** What `explainFilters` reads besides the message: the same context the list used. */
export type ExplainContext = {
  /** The clue background the list's decision used (`clueBackground` of the inbox). */
  background?: ClueBackground;
  /** The sorting weights the importance score was computed with. */
  weights?: SignalWeights;
};

/**
 * Every line for one message.
 *
 * `base` is what the built-in rules said; `learned` is what the list uses (the same
 * signals with the model applied). A filter is explained only when the message is in it
 * by `learned`, the way the list decides, and by the path that decided it.
 */
export function explainFilters(
  email: Email,
  base: EmailSignals,
  learned: EmailSignals,
  profile: UserProfile,
  model: FilterLearning,
  context: ExplainContext = {},
): FilterReason[] {
  const background = context.background ?? EMPTY_BACKGROUND;
  const weights = context.weights ?? STANDARD_WEIGHTS;
  const out: FilterReason[] = [];
  const unsafe = isUnsafe(learned);
  for (const filter of BUILTIN_FILTERS) {
    if (SILENT.has(filter)) continue;
    if (unsafe && filter !== "unsafe") continue;
    if (!matchesBuiltin(filter, email, learned, profile)) continue;
    let reasons: string[] = [];
    let source: ReasonSource = "built-in";
    if (isLearnable(filter)) {
      const decision = model.decide(email, filter, base, background);
      if (decision.by !== "built-in") {
        source = decision.by;
        reasons = learnedReasons(decision, email, model, filter);
      }
    }
    if (source === "built-in") reasons = builtInReasons(filter, email, base, profile, weights);
    if (reasons.length === 0) reasons = ["its wording matches this filter"];
    const unique = [...new Set(reasons)].slice(0, MAX_REASONS);
    const label = FILTER_LABELS[filter];
    out.push({ filter, label, reasons: unique, line: `In ${label} because: ${unique.join(", ")}`, source });
  }
  return out;
}
