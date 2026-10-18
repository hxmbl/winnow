/**
 * Settings → Smart filters: what "Change smart filters…" has taught, and the way back.
 *
 * Per filter: how many corrections, and the sender rules they made, each removable. One
 * reset per filter and one for everything, each confirmed inline the way "Reset sorting"
 * is. Counts of *your* corrections only; no score is shown anywhere.
 */

import { useContext, useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { InfoButton, Section, SettingBlock, SettingLabel } from "./SettingsControls";
import { SettingsExplain } from "../settingsExplainContext";
import { filterIcon } from "../filterIcons";
import { FILTER_LABELS } from "../../core/model/signals";
import { LEARNABLE_FILTERS, type FilterLearning, type LearnableFilter, type SenderRule } from "../../core/learn/filterLearning";
import { learntSummary, ruleText } from "../smartFilterSettings";

const SECONDARY =
  "rounded-ctl border border-control-border px-3 py-1.5 text-meta font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
const DANGER =
  "rounded-ctl bg-danger px-3 py-1.5 text-meta font-semibold text-surface transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

export function SmartFilterSettings({
  model,
  onRemoveRule,
  onReset,
}: {
  model: FilterLearning;
  onRemoveRule: (filter: LearnableFilter, key: string) => void;
  /** One filter, or everything when `filter` is absent. */
  onReset: (filter?: LearnableFilter) => void;
}) {
  /** Which reset is asking: a filter id, `"all"`, or nothing. */
  const [confirming, setConfirming] = useState<LearnableFilter | "all" | null>(null);
  const [done, setDone] = useState<string>("");
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setDone(""), 2_500);
    return () => window.clearTimeout(timer);
  }, [done]);

  const taught = LEARNABLE_FILTERS.filter((filter) => model.correctionCount(filter) > 0);
  const rules = model.senderRules();

  const confirmRow = (target: LearnableFilter | "all") => (
    <div role="group" aria-label="Reset what's learnt?" className="flex flex-wrap items-center gap-2">
      <span className="text-meta font-medium text-ink-body">
        {target === "all"
          ? "Forget every correction and sender rule?"
          : `Forget what ${FILTER_LABELS[target]} has learnt?`}
      </span>
      <button
        ref={confirmRef}
        type="button"
        data-filter-reset-confirm={target}
        onClick={() => {
          onReset(target === "all" ? undefined : target);
          setConfirming(null);
          setDone(target === "all" ? "Smart filters reset" : `${FILTER_LABELS[target]} reset`);
        }}
        className={DANGER}
      >
        Reset
      </button>
      <button type="button" onClick={() => setConfirming(null)} className={SECONDARY}>
        Cancel
      </button>
    </div>
  );

  return (
    <>
      <Section>
        <SettingBlock setting="filterLearning">
          <SettingLabel setting="filterLearning" />
          <p data-filter-learnt-summary="" className="mt-1 text-meta text-ink-muted">
            {learntSummary(model)}
          </p>
          {taught.length > 0 && (
            <ul data-filter-learnt="" className="mt-3 flex flex-col divide-y divide-hairline-soft rounded-ctl border border-hairline">
              {taught.map((filter) => (
                <FilterLearnt
                  key={filter}
                  filter={filter}
                  corrections={model.correctionCount(filter)}
                  rules={rules.filter((rule) => rule.filter === filter)}
                  confirming={confirming === filter}
                  confirmRow={confirmRow}
                  onAskReset={() => setConfirming(filter)}
                  onRemoveRule={onRemoveRule}
                />
              ))}
            </ul>
          )}
        </SettingBlock>
      </Section>
      <Section>
        <SettingBlock setting="resetFilterLearning">
          {confirming === "all" ? (
            confirmRow("all")
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-filter-reset-all=""
                disabled={model.isEmpty}
                onClick={() => setConfirming("all")}
                className={`inline-flex items-center gap-1.5 ${SECONDARY} disabled:cursor-not-allowed disabled:opacity-50`}
              >
                <RotateCcw size={13} strokeWidth={2} aria-hidden="true" />
                Reset what&rsquo;s learnt
              </button>
              <SettingLabelHint />
            </div>
          )}
          <span role="status" aria-live="polite" className="mt-1 block text-meta font-medium text-success">
            {done}
          </span>
        </SettingBlock>
      </Section>
    </>
  );
}

/** The (?) for the reset, which has no label of its own beside the button. */
function SettingLabelHint() {
  const { mode } = useContext(SettingsExplain);
  return mode === "popover" ? <InfoButton setting="resetFilterLearning" /> : null;
}

function FilterLearnt({
  filter,
  corrections,
  rules,
  confirming,
  confirmRow,
  onAskReset,
  onRemoveRule,
}: {
  filter: LearnableFilter;
  corrections: number;
  rules: readonly SenderRule[];
  confirming: boolean;
  confirmRow: (target: LearnableFilter) => React.ReactNode;
  onAskReset: () => void;
  onRemoveRule: (filter: LearnableFilter, key: string) => void;
}) {
  const { Icon, label } = filterIcon(filter);
  return (
    <li data-filter-learnt-row={filter} className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 text-ui font-medium text-ink-body">
          <Icon size={14} strokeWidth={2} className="shrink-0 text-ink-icon" />
          <span className="truncate">{label}</span>
          <span className="shrink-0 text-meta font-normal text-ink-subtle">
            {corrections} correction{corrections === 1 ? "" : "s"}
            {rules.length > 0 && ` · ${rules.length} sender rule${rules.length === 1 ? "" : "s"}`}
          </span>
        </span>
        {!confirming && (
          <button type="button" data-filter-reset={filter} onClick={onAskReset} className={SECONDARY}>
            Reset
          </button>
        )}
      </div>
      {confirming && confirmRow(filter)}
      {rules.length > 0 && (
        <ul className="flex flex-col gap-1">
          {rules.map((rule) => (
            <li key={`${rule.kind}:${rule.key}`} data-sender-rule={rule.key} className="flex items-center justify-between gap-2 text-meta">
              <span className="min-w-0 truncate text-ink-body">{ruleText(rule)}</span>
              <button
                type="button"
                data-sender-rule-remove={rule.key}
                aria-label={`Remove the rule for ${rule.key}`}
                onClick={() => onRemoveRule(filter, rule.key)}
                className="inline-flex shrink-0 items-center gap-1 rounded-ctl px-2 py-1 font-medium text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <X size={12} strokeWidth={2.2} aria-hidden="true" />
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
