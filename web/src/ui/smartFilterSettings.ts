/** The words Settings → Smart filters uses, kept here so they are tested. */

import { FILTER_LABELS } from "../core/model/signals";
import { LEARNABLE_FILTERS, type FilterLearning, type SenderRule } from "../core/learn/filterLearning";

/** "Mail from evri.com goes in Deliveries (you moved 2)". */
export function ruleText(rule: SenderRule): string {
  const who = rule.kind === "domain" ? `Mail from anyone at ${rule.key}` : `Mail from ${rule.key}`;
  const where = rule.into ? `goes in ${FILTER_LABELS[rule.filter]}` : `stays out of ${FILTER_LABELS[rule.filter]}`;
  const why = `you moved ${rule.count} ${rule.into ? "in" : "out"}`;
  return `${who} ${where} (${why})`;
}

/** One sentence over the whole model. */
export function learntSummary(model: FilterLearning): string {
  if (model.isEmpty) {
    return "Nothing yet. Use “Change smart filters…” on a message and Winnow will learn from it.";
  }
  const filters = LEARNABLE_FILTERS.filter((filter) => model.correctionCount(filter) > 0).length;
  const corrections = model.corrections.length;
  const rules = model.senderRules().length;
  return `${corrections} correction${corrections === 1 ? "" : "s"} across ${filters} filter${filters === 1 ? "" : "s"}, and ${rules} sender rule${rules === 1 ? "" : "s"}. Kept on this device only.`;
}
