/**
 * "Why it's here": one plain line per smart filter the message is in, built in
 * `core/learn/filterExplain.ts`. Words only — no scores, no percentages — unless Dev
 * Options → Show filter scores put numbers in `reason.scores`, shown under each line.
 */

import type { FilterReason } from "../../core/learn/filterExplain";
import { filterIcon } from "../filterIcons";

export function WhyHere({
  reasons,
  onChange,
}: {
  reasons: readonly FilterReason[];
  /** Open "Change smart filters…" from here. Absent inside the picker itself. */
  onChange?: () => void;
}) {
  if (reasons.length === 0 && !onChange) return null;
  return (
    <div data-why-here="" className="flex flex-col gap-1">
      <p className="text-meta font-semibold text-ink-muted">Why it&rsquo;s here</p>
      <ul className="flex flex-col gap-0.5">
        {reasons.map((reason) => {
          const { Icon } = filterIcon(reason.filter);
          return (
            <li key={reason.filter} data-why-line={reason.filter} className="flex items-start gap-1.5 text-meta text-ink-body">
              <Icon size={12} strokeWidth={2} className="mt-[3px] shrink-0 text-ink-subtle" />
              <span className="min-w-0">
                In <span className="font-medium text-ink">{reason.label}</span> because: {reason.reasons.join(", ")}
                {reason.scores && reason.scores.length > 0 && (
                  <span
                    data-filter-scores={reason.filter}
                    className="selectable mt-0.5 block whitespace-pre-wrap font-mono text-meta leading-snug text-ink-muted"
                  >
                    {reason.scores.join("\n")}
                  </span>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {onChange && (
        <button
          type="button"
          data-why-change=""
          onClick={onChange}
          className="self-start rounded-ctl text-meta font-medium text-ink-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          Change smart filters…
        </button>
      )}
    </div>
  );
}
