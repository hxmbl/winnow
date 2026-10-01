import { Fragment } from "react";
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Forward,
  Info,
  Mail,
  Search,
  Tag,
  Trash2,
} from "lucide-react";
import type { FilterId } from "../inbox/smart";
import { hexA, pillBackground, type PillColors } from "../inbox/palette";

export type PillItem = {
  id: FilterId;
  label: string;
  colors: PillColors;
};

type FilterStripProps = {
  pills: PillItem[];
  activeFilters: FilterId[];
  onToggle: (id: FilterId) => void;
  onClear: () => void;
  className?: string;
};

export function FilterStrip({
  pills,
  activeFilters,
  onToggle,
  onClear,
  className = "",
}: FilterStripProps) {
  const hasActive = activeFilters.length > 0;

  return (
    <div
      className={`no-scrollbar flex items-center gap-2 overflow-x-auto ${className}`}
    >
      {hasActive && (
        <button
          type="button"
          onClick={onClear}
          className="h-7 shrink-0 rounded-full border border-control-border px-3.5 text-[13px] font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          All
        </button>
      )}
      {pills.map(({ id, label, colors }) => {
        const on = activeFilters.includes(id);
        return (
          <button
            key={id}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(id)}
            className="h-7 shrink-0 rounded-full px-3.5 text-[13px] font-semibold whitespace-nowrap text-ink-body transition-[filter] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            style={{
              background: pillBackground(colors, on),
              // Selected state is carried by the ring alone — the wash is already
              // the loudest thing in the strip, a second fill would drown it.
              boxShadow: on ? `inset 0 0 0 1px ${hexA(colors.solid, 0.7)}` : "none",
            }}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The message actions, already grouped in the design. The gaps *between* groups
 * are wider than the gaps within them, so the dividers reinforce an existing
 * rhythm rather than inventing one.
 */
const TOOL_GROUPS: { icon: typeof Archive; label: string }[][] = [
  [
    { icon: Archive, label: "Archive" },
    { icon: Info, label: "Details" },
    { icon: Trash2, label: "Delete" },
  ],
  [
    { icon: Mail, label: "Mark as unread" },
    { icon: Forward, label: "Forward" },
  ],
  [{ icon: Tag, label: "Label" }],
];

const ICON_BUTTON =
  "flex h-8 w-8 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring";

type TopBarProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
  pills: PillItem[];
  activeFilters: FilterId[];
  onToggle: (id: FilterId) => void;
  onClear: () => void;
  position: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
};

/**
 * Three jobs, three treatments: search is an input, the filters are the one
 * colourful thing in the app, the actions are a button cluster. The hairline
 * between the last two marks where "narrow the list" ends and "act on the open
 * message" begins.
 */
export default function TopBar({
  searchQuery,
  onSearchChange,
  pills,
  activeFilters,
  onToggle,
  onClear,
  position,
  total,
  onPrev,
  onNext,
}: TopBarProps) {
  const stripProps = { pills, activeFilters, onToggle, onClear };

  return (
    <header className="relative z-30 shrink-0 border-b border-hairline bg-chrome">
      <div className="flex h-16 items-center gap-3 px-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center">
          <img src="/relayLight.svg" alt="" aria-hidden="true" className="h-9 w-9" />
          <span className="sr-only">Winnow</span>
        </div>

        <label
          htmlFor="topbar-search"
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-full border border-hairline bg-surface-sunken px-3.5 lg:w-[200px] lg:flex-none"
        >
          <Search size={14} className="shrink-0 text-ink-placeholder" aria-hidden="true" />
          <input
            id="topbar-search"
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent text-[13px] font-medium text-ink outline-none placeholder:text-ink-placeholder"
          />
        </label>

        <FilterStrip {...stripProps} className="hidden min-w-0 flex-1 lg:flex" />

        <div className="ml-auto flex shrink-0 items-center gap-2 lg:ml-0">
          <span className="hidden h-6 w-px bg-divider lg:block" aria-hidden="true" />

          {/* Message actions. One border, internal dividers — reads as a single
              control that happens to hold six verbs. */}
          <div className="hidden items-center gap-0.5 rounded-full border border-hairline px-1 py-0.5 lg:flex">
            {TOOL_GROUPS.map((group, gi) => (
              <Fragment key={gi}>
                {gi > 0 && <span className="mx-1 h-4 w-px bg-divider" aria-hidden="true" />}
                {group.map(({ icon: Icon, label }) => (
                  <button
                    key={label}
                    type="button"
                    title={label}
                    aria-label={label}
                    aria-disabled="true"
                    className={ICON_BUTTON}
                  >
                    <Icon size={16} strokeWidth={1.9} />
                  </button>
                ))}
              </Fragment>
            ))}
          </div>

          <span className="hidden h-6 w-px bg-divider lg:block" aria-hidden="true" />

          {/* Where you are in the list. The position is the point, so it is the
              only thing here that isn't muted. */}
          <div className="flex items-center gap-0.5 rounded-full border border-hairline py-0.5 pl-3 pr-1">
            <span className="text-[13px] font-semibold tabular-nums text-ink">
              {position}
            </span>
            <span className="text-[13px] tabular-nums text-ink-subtle">of {total}</span>
            <button
              type="button"
              onClick={onPrev}
              aria-label="Previous message"
              className={ICON_BUTTON}
            >
              <ChevronLeft size={17} />
            </button>
            <button
              type="button"
              onClick={onNext}
              aria-label="Next message"
              className={ICON_BUTTON}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </div>
      </div>

      <FilterStrip {...stripProps} className="px-4 pb-2.5 lg:hidden" />
    </header>
  );
}