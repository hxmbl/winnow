/**
 * The sidebar's Labels section: the user's own Gmail labels, each a place to go, browsed
 * like a mailbox (`WinnowStore.setLabelView`). Nested labels (`Work/Northwind`) are
 * indented under their parent's name. The same rows on the desktop sidebar and in the
 * phone's dock menu, at that layout's row size.
 */

import { Tag } from "lucide-react";
import { labelHue } from "../../core/mail/labels";

export type NavLabel = { id: string; name: string; unread: number };

export function LabelNavSection({
  labels,
  current,
  onSelect,
  touch,
  onNavigate,
}: {
  labels: readonly NavLabel[];
  current: string | null;
  onSelect: (id: string) => void;
  touch: boolean;
  onNavigate?: () => void;
}) {
  if (labels.length === 0) return null;
  const names = new Set(labels.map((label) => label.name));
  const headingId = touch ? "nav-labels-touch" : "nav-labels";
  const row = touch
    ? "flex min-h-12 w-full items-center gap-3.5 rounded-full px-3.5 py-2 text-left text-read transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
    : "flex w-full items-center gap-2 rounded-ctl px-2.5 py-1.5 text-left text-ui transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";
  const idle = touch ? "text-ink-body active:bg-sheen" : "text-ink-body hover:bg-surface-hover";
  const on = touch
    ? "bg-[color-mix(in_srgb,var(--wn-ink)_10%,transparent)] font-medium text-ink"
    : "bg-surface-active font-medium text-ink";
  return (
    <>
      <h3
        id={headingId}
        className={touch ? "px-3.5 pb-1 pt-2 text-meta font-medium text-ink-subtle" : "px-2.5 pb-1 pt-4 text-meta font-medium text-ink-subtle"}
      >
        Labels
      </h3>
      <ul aria-labelledby={headingId} data-nav-labels="" className="flex flex-col">
        {labels.map((label) => {
          // Indented under its parent only when the parent is a label in the list too;
          // otherwise the whole path, so "Work/Northwind" never reads as plain "Northwind".
          const parts = label.name.split("/");
          const parent = parts.slice(0, -1).join("/");
          const nested = parent !== "" && names.has(parent);
          const depth = nested ? Math.min(parts.length - 1, 3) : 0;
          const leaf = nested ? parts[parts.length - 1] || label.name : label.name;
          const selected = current === label.id;
          return (
            <li key={label.id}>
              <button
                type="button"
                data-nav-label={label.name}
                aria-current={selected ? "page" : undefined}
                aria-label={label.unread > 0 ? `${label.name}, ${label.unread} unread` : label.name}
                title={label.name}
                onClick={() => {
                  onSelect(label.id);
                  onNavigate?.();
                }}
                className={`${row} ${selected ? on : idle}`}
                style={depth > 0 ? { paddingLeft: `calc(${touch ? "0.875rem" : "0.625rem"} + ${depth * 0.875}rem)` } : undefined}
              >
                <Tag
                  size={touch ? 18 : 14}
                  strokeWidth={1.9}
                  aria-hidden="true"
                  className="shrink-0"
                  style={{ color: `hsl(${labelHue(label.name)} 62% 52%)` }}
                />
                <span className="min-w-0 flex-1 truncate">{leaf}</span>
                {label.unread > 0 && (
                  <span className={`ml-auto shrink-0 text-meta tabular-nums ${selected ? "text-accent" : "text-ink-subtle"}`}>
                    {label.unread}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
