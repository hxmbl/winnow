/**
 * The user's own Gmail labels on a message, as small chips: a coloured dot (a stable hue
 * per label name, `labelHue`) and the name in the muted ink, so the chip reads at AA on
 * every theme without a colour of its own to check. Rows show the last part of a nested
 * name and at most two chips with a "+n"; the reader shows every label in full.
 */

import { labelHue, labelLeaf, labelsOn } from "../../core/mail/labels";
import { useLabelNames } from "../labelNames";

export function LabelChips({
  ids,
  compact = false,
  all = false,
  className = "",
}: {
  /** The message's `labels`. */
  ids: readonly string[] | undefined;
  /** A row's: leaf names, two at most. */
  compact?: boolean;
  /** Include the label being browsed (the reader shows every label). */
  all?: boolean;
  className?: string;
}) {
  const { names, hidden } = useLabelNames();
  const on = labelsOn(ids, names, all ? null : hidden);
  if (on.length === 0) return null;
  const shown = compact ? on.slice(0, 2) : on;
  const more = on.length - shown.length;
  return (
    <span
      data-label-chips=""
      aria-label={`Labels: ${on.map((label) => label.name).join(", ")}`}
      className={`inline-flex min-w-0 items-center gap-1 align-middle ${className}`}
    >
      {shown.map((label) => (
        <span
          key={label.id}
          data-label-chip={label.name}
          title={label.name}
          aria-hidden="true"
          className={`inline-flex min-w-0 max-w-[10rem] items-center gap-1 rounded-full border border-hairline bg-sheen px-1.5 font-medium text-ink-muted ${
            compact ? "py-0 text-meta leading-snug" : "py-0.5 text-meta"
          }`}
        >
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: `hsl(${labelHue(label.name)} 62% 52%)` }}
          />
          <span className="truncate">{compact ? labelLeaf(label.name) : label.name}</span>
        </span>
      ))}
      {more > 0 && (
        <span aria-hidden="true" className="shrink-0 text-meta font-medium text-ink-subtle">
          +{more}
        </span>
      )}
    </span>
  );
}
