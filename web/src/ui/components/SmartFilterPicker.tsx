/**
 * "Change smart filters…": every smart filter as a checkbox, ticked where the message is
 * now. A click moves the message at once and is recorded as a correction, which is all
 * Winnow learns from (`core/learn/filterLearning.ts`). For one message the picker also
 * says why it is where it is, so the phone, which has no reader header to spare, gets
 * "Why it's here" in the same place it changes it.
 */

import { useRef } from "react";
import { Check, Minus } from "lucide-react";
import { Sheet, SheetHeader } from "./Overlay";
import { filterIcon } from "../filterIcons";
import { clickInto, pickerRows, pickerTitle, type FilterCheck } from "../smartFilterPicker";
import type { LearnableFilter } from "../../core/learn/filterLearning";
import type { FilterReason } from "../../core/learn/filterExplain";
import { WhyHere } from "./WhyHere";

export function SmartFilterPicker({
  count,
  membership,
  reasons,
  status,
  onChange,
  onClose,
}: {
  /** How many messages the picker is for. */
  count: number;
  membership: ReadonlyMap<LearnableFilter, FilterCheck>;
  /** "Why it's here", for a single message; empty for several. */
  reasons: readonly FilterReason[];
  /** What the last click did, read out politely. */
  status: string;
  onChange: (filter: LearnableFilter, into: boolean) => void;
  onClose: () => void;
}) {
  const doneRef = useRef<HTMLButtonElement>(null);
  const rows = pickerRows(membership);
  return (
    <Sheet label={pickerTitle(count)} onClose={onClose} initialFocus={doneRef} dismissOnBackdrop className="flex w-full max-w-[400px] flex-col overflow-hidden rounded-pane border border-hairline bg-chrome shadow-lift">
      <div data-filter-picker="" className="flex max-h-[min(700px,90vh)] flex-col">
        <SheetHeader title={pickerTitle(count)} onClose={onClose} />
        <p className="border-b border-hairline px-5 py-3 text-meta text-ink-muted">
          Tick where {count === 1 ? "it belongs" : "they belong"}. Winnow learns from each change, on this device only.
        </p>
        {/*
          One scroll area for the ticks and "Why it's here": with Dev Options' scores on,
          the reasons can be taller than the phone, and a fixed reasons block used to
          squeeze the ticks into a sliver while the reasons themselves could not scroll.
        */}
        <div data-filter-picker-scroll="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div role="group" aria-label="Smart filters" className="py-1">
          {rows.map(({ filter, label, check }) => {
            const { Icon } = filterIcon(filter);
            return (
              <button
                key={filter}
                type="button"
                role="checkbox"
                aria-checked={check === "all" ? "true" : check === "some" ? "mixed" : "false"}
                data-filter-option={filter}
                onClick={() => onChange(filter, clickInto(check))}
                className="flex w-full items-center gap-3 px-5 py-2 text-left text-ui text-ink-body transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-hidden"
              >
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-ctl border ${
                    check === "none" ? "border-control-border" : "border-accent bg-accent text-on-accent"
                  }`}
                >
                  {check === "all" && <Check size={12} strokeWidth={3} />}
                  {check === "some" && <Minus size={12} strokeWidth={3} />}
                </span>
                <Icon size={14} strokeWidth={2} className="shrink-0 text-ink-icon" />
                <span className="min-w-0 truncate">{label}</span>
              </button>
            );
          })}
        </div>
        {reasons.length > 0 && (
          <div className="border-t border-hairline px-5 py-3">
            <WhyHere reasons={reasons} />
          </div>
        )}
        </div>
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-hairline px-5 py-3">
          <span role="status" aria-live="polite" data-filter-picker-status="" className="min-w-0 truncate text-meta text-ink-muted">
            {status}
          </span>
          <button
            ref={doneRef}
            type="button"
            data-filter-picker-done=""
            onClick={onClose}
            className="shrink-0 rounded-ctl bg-accent px-4 py-1.5 text-ui font-semibold text-on-accent transition-opacity hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            Done
          </button>
        </div>
      </div>
    </Sheet>
  );
}
