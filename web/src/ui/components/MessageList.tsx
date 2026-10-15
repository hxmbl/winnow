/**
 * The message list.
 *
 * Three lines a row, ragged right, no rules between rows — the section headers do the
 * separating. Sender, subject and preview, with the timestamp right-aligned on the
 * first; each line truncates independently, so a long subject never pushes the preview
 * out of the row.
 *
 * Rows are memoised on exactly the four things that change their appearance, so
 * selecting a message re-renders two rows rather than a thousand.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check } from "lucide-react";
import { Avatar } from "./Avatar";
import { CodeChip } from "./CodeCopy";
import { codeChipVisible } from "../../core/mail/otp";
import { anchorFromElement, type MenuAnchor } from "../menuPlacement";
import {
  DRAG_THRESHOLD,
  LONG_PRESS_MS,
  LongPress,
  avatarDragBase,
  dragSelection,
  edgeScrollSpeed,
  nearestRow,
  sameSelection,
  shiftSelection,
  toggleId,
  type Selection,
} from "../selection";
import { daySections, formatRowTime, type DayBucket } from "../../core/mail/datetime";
import { displayName } from "../../core/model/email";
import {
  rowIndicators,
  FILTER_LABELS,
  type BuiltinSmartFilter,
  type EmailSignals,
} from "../../core/model/signals";
import { filterIcon } from "../filterIcons";
import type { SortBy } from "../../core/classify/scoring";
import type { EmptyReason, ThreadRow } from "../../core/classify/pipeline";
import {
  ESTIMATED_HEADER_HEIGHT,
  ESTIMATED_ROW_HEIGHT,
  computeOffsets,
  indexAt,
  scrollTopForIndex,
  visibleRange,
} from "../windowing";

/**
 * One entry in the windowed list: a day header, or a message row.
 *
 * A flat union rather than a nested section/row tree, because windowing needs a single
 * index space to slice — and a viewport edge can land in the middle of a day.
 */
type ListItem =
  | { kind: "header"; key: string; section: DaySection; label: string; count: number }
  | {
      kind: "row";
      key: string;
      section: DaySection;
      row: ThreadRow;
      bucket: DayBucket;
      signals: EmailSignals;
    };

/** What a row needs to rebuild its day boundary: the key to group on, and the text. */
type DaySection = {
  key: string;
  /** Null for a sort that is not chronological, and then there is no boundary. */
  label: string | null;
  /** The day's full row count, not the number currently mounted. */
  count: number;
};

/**
 * Which item the keyboard cursor is on.
 *
 * `cursorIndex` counts *rows*, not items, so it has to be walked past the headers.
 * Returns `null` when out of range — a real state, not an error: `NO_CURSOR` is `-1`.
 */
function rowIndexForCursor(items: readonly ListItem[], cursorIndex: number): number | null {
  if (cursorIndex < 0) return null;
  let seen = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (items[i]!.kind !== "row") continue;
    if (seen === cursorIndex) return i;
    seen += 1;
  }
  return null;
}

/** One day boundary's worth of mounted items. */
type ItemRun = { section: DaySection; firstKey: string; items: ListItem[] };

/**
 * The mounted window, cut into runs of consecutive items that share a day.
 *
 * The key includes the first item so a day split by the window edge becomes two
 * sections rather than two sibling runs colliding on one React key.
 */
function runsInWindow(items: readonly ListItem[], start: number, end: number): ItemRun[] {
  const runs: ItemRun[] = [];
  for (let i = start; i < end; i += 1) {
    const item = items[i]!;
    const current = runs[runs.length - 1];
    if (current && current.section.key === item.section.key) current.items.push(item);
    else runs.push({ section: item.section, firstKey: item.key, items: [item] });
  }
  return runs;
}

type RowProps = {
  row: ThreadRow;
  signals: EmailSignals;
  bucket: DayBucket;
  selected: boolean;
  unread: boolean;
  /** True for a message that arrived in the last sync. */
  fresh: boolean;
  /** Part of the multi-row selection. */
  checked: boolean;
  /**
   * Something is selected: the avatar is the row's checkbox and a click or tap on it
   * toggles the row. On a phone a tap on the row body toggles too (see the list).
   */
  selectMode: boolean;
  /** The sender's contact photo, when known. */
  photo: string | undefined;
  onSelect: (id: number) => void;
  onToggleStar: (id: number) => void;
  onAvatar: (id: number, trigger: HTMLElement) => void;
  onToggleChecked: (id: number) => void;
  /** The one-time code, while it is fresh enough for the row chip; otherwise null. */
  chipCode: string | null;
  /** This row's code was just copied: the chip says so for a moment. */
  codeCopied: boolean;
  onCopyCode: (id: number) => void;
};

/**
 * What Winnow thinks of a row, as one word.
 *
 * It used to be a glyph per judgement — bookmark, bolt, shield — and most rows carried
 * two or three of them, which is a cluster of tiny icons you have to decode rather than
 * a signal. Now a row says at most one thing, and only when it is worth interrupting the
 * scan for: unsafe, urgent, or security, in that order. "Important" is not shown here; it
 * fired on most of the inbox, so as a label it said nothing, and it is what the rail and
 * the triage line are for. A message that arrived in the last sync says "New" when it
 * has nothing more pressing to say.
 *
 * Every judgement still reaches a screen reader through the row's accessible name, and
 * the reader still lists them all with their reasons.
 */
const ROW_SIGNAL_ORDER: readonly BuiltinSmartFilter[] = ["unsafe", "urgent", "security"];

function rowSignal(
  indicators: readonly BuiltinSmartFilter[],
  fresh: boolean,
): { label: string; title: string; danger: boolean } | null {
  const id = ROW_SIGNAL_ORDER.find((candidate) => indicators.includes(candidate));
  if (id) return { label: FILTER_LABELS[id], title: filterIcon(id).title, danger: id === "unsafe" };
  if (fresh) return { label: "New", title: "Arrived in the last sync", danger: false };
  return null;
}

/**
 * The row's accessible name.
 *
 * `aria-label` wins over descendant content when a name is computed, so this replaces the
 * row's text wholesale rather than adding to it: left to content, the name would be sender
 * + subject + preview + timestamp run together, with the indicators' labels buried in the
 * middle.
 *
 * Ordered the way the row reads: who, which conversation, what it says, then the state,
 * then the judgement, then when. The visible row is untouched.
 */
function rowAccessibleName({
  email,
  time,
  indicators,
  unread,
  fresh,
  messageCount,
  checked,
}: {
  email: ThreadRow["representative"];
  time: string;
  indicators: readonly BuiltinSmartFilter[];
  unread: boolean;
  fresh: boolean;
  messageCount: number;
  checked?: boolean;
}): string {
  const parts = [displayName(email)];
  if (messageCount > 1) parts.push(`${messageCount} messages`);
  parts.push(email.subject || "no subject");
  if (unread) parts.push("unread");
  if (fresh) parts.push("new");
  // Lowercased because these run as a comma list inside a sentence, not as a set of pill
  // captions: "security, urgent" rather than "Security, Urgent".
  if (indicators.length > 0) {
    parts.push(indicators.map((id) => FILTER_LABELS[id].toLowerCase()).join(", "));
  }
  parts.push(time);
  if (checked) parts.push("selected");
  return parts.join(", ");
}

const Row = memo(function Row({
  row,
  signals,
  bucket,
  selected,
  unread,
  fresh,
  checked,
  selectMode,
  photo,
  onSelect,
  onToggleStar,
  onAvatar,
  onToggleChecked,
  chipCode,
  codeCopied,
  onCopyCode,
}: RowProps) {
  const email = row.representative;
  const indicators = rowIndicators(email, signals);
  const time = formatRowTime(email.receivedAt, bucket);
  const name = displayName(email);

  const signal = rowSignal(indicators, fresh);

  return (
    <div
      data-row-id={email.id}
      data-checked={checked ? "" : undefined}
      className={`group/row relative flex w-full items-start gap-2 rounded-ctl px-3 py-1.5 text-left transition-colors duration-150 [-webkit-touch-callout:none] ${
        /*
         * Selection is the accent, washed into the surface: the one place in the list the
         * accent appears besides the unread dot, so the two are never confused with any
         * other state. A row in the multi-selection gets the same wash; the check in the
         * avatar slot is what tells it from the open message.
         */
        selected || checked ? "bg-surface-selected" : "hover:bg-surface-hover"
      }`}
    >
      {/*
        The unread mark, in a gutter of its own so read and unread rows line up. Outside
        every button, so it is never a click target of its own.
      */}
      <span
        aria-hidden="true"
        className={`mt-[14px] h-2 w-2 shrink-0 rounded-full transition-colors duration-150 ${
          unread ? "bg-accent" : "bg-transparent"
        }`}
      />

      {/*
        The avatar is its own button — a sibling of the row button, never inside it —
        and opens the sender menu rather than the message. Once anything is selected it
        is the row's checkbox instead. Pressing it and dragging selects a range (see the
        gestures in the list): it is marked `data-row-control` so a click on it never
        opens the row, but the drag code lets the avatar through.
      */}
      <button
        type="button"
        data-row-control="avatar"
        aria-label={
          selectMode
            ? checked
              ? `Deselect message from ${name}`
              : `Select message from ${name}`
            : `Sender options for ${name}`
        }
        aria-haspopup={selectMode ? undefined : "menu"}
        aria-pressed={selectMode ? checked : undefined}
        onClick={(event) => {
          if (selectMode) onToggleChecked(email.id);
          else onAvatar(email.id, event.currentTarget);
        }}
        // Right-click (or the menu key) does exactly what a left click does: the sender
        // menu, or the row's checkbox in select mode. Never the row's own menu, and
        // never the browser's. A touch long-press is left to the list, where it is
        // select mode.
        onContextMenu={(event) => {
          if ((event.nativeEvent as PointerEvent).pointerType === "touch") return;
          event.preventDefault();
          event.stopPropagation();
          if (selectMode) onToggleChecked(email.id);
          else onAvatar(email.id, event.currentTarget);
        }}
        // The menu key and Shift+F10 fire `contextmenu` on the avatar themselves; keep
        // the list's keyboard handler from also opening the row menu.
        onKeyDown={(event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) event.stopPropagation();
        }}
        // The children take no pointer events, so a press always lands on the button
        // itself. The button outlives the swap from picture to check when a long-press
        // selects the row; a swapped-out child would take the rest of the touch with it
        // (events on a detached node reach no listener), and the finger could not slide
        // on to extend the range.
        className="mt-0.5 shrink-0 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring [&>*]:pointer-events-none"
      >
        {checked ? (
          <span
            aria-hidden="true"
            data-avatar="check"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-on-accent"
          >
            <Check size={16} strokeWidth={2.6} />
          </span>
        ) : selectMode ? (
          <span
            aria-hidden="true"
            data-avatar="unchecked"
            className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-control-border"
          />
        ) : (
          <Avatar name={name} address={email.sender} photo={photo} />
        )}
      </button>

      {/*
        The row is a `<button>`, and the star is its *sibling* — putting the star inside
        the row button is invalid HTML and breaks keyboard navigation.

        `aria-current="true"` rather than `aria-selected`, because the selected option of
        a listbox needs a `listbox` parent and this list is a set of independent choices,
        not a single-select list.
      */}
      <button
        type="button"
        data-message-id={email.id}
        aria-current={selected ? "true" : undefined}
        aria-label={rowAccessibleName({
          email,
          time,
          indicators,
          unread,
          fresh,
          messageCount: row.messageCount,
          checked,
        })}
        onClick={() => onSelect(email.id)}
        className="flex min-w-0 flex-1 items-start rounded-ctl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-baseline gap-1.5">
              {/*
                Weight means unread, and only unread. A read row is regular weight
                throughout; its hierarchy is carried by colour (ink-body for the sender
                and subject, ink-subtle for the preview and count).
              */}
              <span
                data-row-sender=""
                className={`truncate text-ui ${unread ? "font-semibold text-ink" : "font-normal text-ink-body"}`}
              >
                {name}
              </span>
              {row.messageCount > 1 && (
                <span className="shrink-0 text-meta font-normal tabular-nums text-ink-subtle">
                  {row.messageCount}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-baseline gap-2">
              {signal && (
                <span
                  title={signal.title}
                  aria-hidden="true"
                  className={`text-meta font-medium ${signal.danger ? "text-danger" : "text-ink-muted"}`}
                >
                  {signal.label}
                </span>
              )}
              <span className="text-meta tabular-nums text-ink-subtle">{time}</span>
            </span>
          </span>

          {/*
            Subject and preview share the second line. No dash between them: the preview
            is set apart by colour and a gap, and it is the part that gives way.
          */}
          <span className="block truncate text-ui">
            <span
              data-row-subject=""
              className={unread ? "font-semibold text-ink" : "font-normal text-ink-body"}
            >
              {email.subject || "(no subject)"}
            </span>
            {email.body && <span className="ml-2 text-ink-subtle">{email.body}</span>}
          </span>
        </span>
      </button>

      {/*
        "Copy 418 902", for a code that arrived in the last five minutes. A sibling of the
        row button like the star, marked `data-row-control` so a press on it never starts
        a drag-select, a long-press or an open.
      */}
      {chipCode && <CodeChip code={chipCode} copied={codeCopied} onCopy={() => onCopyCode(email.id)} />}

      {/*
        The star.

        Visible on hover, on keyboard focus, and *always* on a device with no hover.

        `opacity-0` with reveal-on-hover produced a 24px invisible tappable target on
        every touch device. `@media (hover: hover)` scopes the hiding to devices that
        actually have a pointer, so a phone shows it outright and a mouse still gets a
        quiet list.
      */}
      <button
        type="button"
        onClick={() => onToggleStar(email.id)}
        aria-label={email.starred ? "Unstar" : "Star"}
        aria-pressed={email.starred}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-ctl text-ink-subtle [@media(hover:none)]:-m-2.5 [@media(hover:none)]:h-11 [@media(hover:none)]:w-11 transition-opacity hover:bg-sheen hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:aria-pressed:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
      >
        {/*
          The star is a sprite rather than a lucide icon so the filled and outline states
          are the same shape at the same weight.

          The colour comes from `--wn-badge-starred`, the same token the reader's badge
          and the palette use, so it follows the theme.
        */}
        <svg
          viewBox="0 0 24 24"
          width={14}
          height={14}
          aria-hidden="true"
          fill={email.starred ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth={1.9}
          className={email.starred ? "text-[var(--wn-badge-starred)]" : ""}
        >
          <path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.4l6-.8Z" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
});

/**
 * The day heading.
 *
 * Not sticky itself: once the list is windowed, the containing block is the translated
 * window, so `sticky top-0` no longer works. `MessageList` draws the pinned copy over the
 * scroller; this is the in-flow original that copy is painted over, which is why the
 * background is opaque.
 */
function SectionHeader({ label, count }: { label: string; count: number }) {
  // Sentence case and a plain count: the old letter-spaced capitals with a bullet were
  // the loudest thing in a list that is meant to be read quietly. Inset to the sender
  // column, so the label sits over the names rather than over the unread gutter.
  return (
    <div className="flex items-baseline gap-2 bg-surface pb-1 pl-[68px] pr-3 pt-4 text-meta">
      <span className="font-semibold text-ink-muted">{label}</span>
      <span className="tabular-nums text-ink-subtle">{count}</span>
    </div>
  );
}

export type EmptyState = {
  reason: EmptyReason;
  onClearFilters: () => void;
  onClearSearch: () => void;
  onSync: () => void;
  canSync: boolean;
};

/**
 * The empty state, which says *why* rather than just reporting emptiness.
 *
 * "No messages match" is not actionable; the three reasons are genuinely different
 * problems with genuinely different fixes.
 */
function Empty({
  reason,
  onClearFilters,
  onClearSearch,
  onSync,
  canSync,
}: EmptyState) {
  /**
   * What the user can do about *this* emptiness.
   *
   * Five reasons and five different answers, which is the whole point of the state.
   * `mailbox` is the only case where the remedy depends on something outside the list,
   * which is why `canSync` is a prop — offering "Check for new mail" over the demo
   * mailbox would be a button that cannot do anything.
   */
  const remedy = (() => {
    switch (reason) {
      case "search":
        return {
          body: "Nothing matches that search.",
          action: { label: "Clear search", run: onClearSearch },
        };
      case "filters":
        return {
          body: "Nothing matches those filters.",
          action: { label: "Show everything", run: onClearFilters },
        };
      case "noSignal":
        return {
          body: "All of this looks like junk, so Winnow is holding it back.",
          action: { label: "Show the hidden mail", run: onClearFilters },
        };
      case "mailbox":
        return {
          body: "Nothing here yet.",
          action: canSync
            ? { label: "Check for new mail", run: onSync }
            : null,
        };
      default:
        return null;
    }
  })();

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-surface px-6 text-center">
      {remedy ? (
        <>
          <p className="max-w-[26rem] text-ui text-ink-body">{remedy.body}</p>
          {remedy.action && (
            <button
              type="button"
              onClick={remedy.action.run}
              className="rounded-ctl border border-control-border px-3.5 py-1.5 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {remedy.action.label}
            </button>
          )}
        </>
      ) : (
        // `emptyReason` is null only when the list is non-empty, so this branch is
        // unreachable — but an empty screen with no explanation is worse than a wrong
        // one, so it says something.
        <p className="text-ui text-ink-muted">Nothing to show.</p>
      )}
    </div>
  );
}

type Props = {
  threads: ThreadRow[];
  signals: ReadonlyMap<number, EmailSignals>;
  selectedId: number | null;
  cursorIndex: number;
  /** Bumped by the store when the cursor moved by navigation. See the reveal effect. */
  revealSeq: number;
  unreadIds: ReadonlySet<number>;
  freshIds: ReadonlySet<number>;
  emptyReason: EmptyState["reason"];
  /**
   * The list's order, which decides whether day sections mean anything.
   *
   * Only a date-sorted list can group by day; the other two sorts interleave the days,
   * and labelling that produced a duplicate React key on every repeated section. See
   * `daySections`.
   */
  sortBy: SortBy;
  onSelect: (id: number) => void;
  onToggleStar: (id: number) => void;
  onClearFilters: () => void;
  onClearSearch: () => void;
  /** Re-fetch. Only offered when the mailbox is empty for want of mail. */
  onSync: () => void;
  /** False in the demo, where there is nothing to sync with. */
  canSync: boolean;
  /** Reference instant for the day sections. */
  now: number;
  /** Lowercased sender address → contact photo URL. */
  photos: ReadonlyMap<string, string>;
  /** The multi-row selection. */
  selection: Selection;
  onSelectionChange: (next: Selection) => void;
  /**
   * The phone layout: long-press selects, and once anything is selected a tap toggles.
   * Off on the desktop, where a drag selects and a click always opens.
   */
  touchSelect: boolean;
  /** Open the sender menu for a row's avatar. */
  onAvatar: (id: number, trigger: HTMLElement) => void;
  /** Open the row context menu (desktop only); `trigger` gets focus back. */
  onRowMenu?: (id: number, anchor: MenuAnchor, trigger: HTMLElement) => void;
  /** Copy a row's one-time code. */
  onCopyCode: (id: number) => void;
  /** The message whose code was just copied, for the chip's "Copied". */
  copiedCodeId: number | null;
  className?: string;
};

function MessageList({
  threads,
  signals,
  selectedId,
  cursorIndex,
  revealSeq,
  unreadIds,
  freshIds,
  emptyReason,
  sortBy,
  onSelect,
  onToggleStar,
  onClearFilters,
  onClearSearch,
  onSync,
  canSync,
  now,
  photos,
  selection,
  onSelectionChange,
  touchSelect,
  onAvatar,
  onRowMenu,
  onCopyCode,
  copiedCodeId,
  className = "",
}: Props) {

  // Day sections, on the *representative* message's date, since that is the date the row
  // displays. One flat section unless the sort is chronological.
  const sections = daySections(
    threads,
    now,
    (row) => row.representative.receivedAt,
    sortBy === "date",
  );

  /**
   * The sections flattened into one index space, so headers and rows can be windowed
   * together.
   *
   * Rows whose signals are missing are dropped here rather than at render time.
   * Filtering during render would leave holes that `querySelectorAll`-by-index silently
   * miscounts, and the classifier runs over the whole mailbox before anything is shown,
   * so a miss means the message left the list between the two passes.
   */
  const items = useMemo<ListItem[]>(() => {
    const out: ListItem[] = [];
    for (const section of sections) {
      const day: DaySection = { key: section.key, label: section.label, count: section.rows.length };
      if (section.label) {
        out.push({ kind: "header", key: section.key, section: day, label: section.label, count: section.rows.length });
      }
      for (const { row, bucket } of section.rows) {
        const signalsForRow = signals.get(row.representative.id);
        if (!signalsForRow) continue;
        out.push({ kind: "row", key: row.key, section: day, row, bucket, signals: signalsForRow });
      }
    }
    return out;
  }, [sections, signals]);

  /**
   * Measured heights, by item key.
   *
   * A `Map` keyed by identity rather than an array by index, because the list is rebuilt
   * on every derive — an index-keyed cache would be invalidated wholesale by an unrelated
   * change and every row would have to be measured again.
   */
  const heightsRef = useRef(new Map<string, number>());
  /** Bumped when a measurement changes an offset, to force the prefix sums. */
  const [measureVersion, setMeasureVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const offsets = useMemo(
    () =>
      computeOffsets(items.length, items.map((item) => heightsRef.current.get(item.key) ?? null), (i) =>
        items[i]!.kind === "header" ? ESTIMATED_HEADER_HEIGHT : ESTIMATED_ROW_HEIGHT,
      ),
    // `measureVersion` is the dependency that matters: `heightsRef` is a ref, so mutating
    // it does not invalidate this memo on its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, measureVersion],
  );

  const { start, end } = useMemo(
    () => visibleRange(offsets, scrollTop, viewportHeight),
    [offsets, scrollTop, viewportHeight],
  );

  /** Measure one rendered item, and record it only if it actually moved. */
  const measure = useCallback((key: string, height: number) => {
    const known = heightsRef.current.get(key);
    // Sub-pixel differences are not worth a re-render and a new set of offsets.
    if (known != null && Math.abs(known - height) < 1) return;
    heightsRef.current.set(key, height);
    setMeasureVersion((n) => n + 1);
  }, []);

  /**
   * Height bookkeeping for every mounted item.
   *
   * A `ResizeObserver` rather than `offsetHeight` on mount, because a row's height is not
   * known when it mounts — fonts may not have loaded and the preview may not have wrapped
   * — and it changes again if the pane is resized.
   */
  const itemObserver = useRef<ResizeObserver | null>(null);
  if (!itemObserver.current && typeof ResizeObserver !== "undefined") {
    itemObserver.current = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.itemKey;
        if (key) measure(key, entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
      }
    });
  }

  /**
   * The scroller itself, as state rather than a ref.
   *
   * A callback ref rather than `useRef` + an effect keyed on `[]`: the empty state
   * replaces the list wholesale, so the scroller unmounts and **mounts a different
   * element** when the search is cleared. An effect with `[]` dependencies does not
   * re-run for that, so the new element got no scroll listener or viewport height.
   */
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);

  // Viewport height, and the scroll position, in one observer on the scroller.
  useEffect(() => {
    if (!scroller) return;

    /*
     * The scroll position survives the list being hidden.
     *
     * Below `lg` an open message hides the list with `display: none`, and Chromium drops a
     * hidden scroller's offset — so Back on a phone used to land at the top of the inbox,
     * or wherever the cursor effect dragged it. The last offset seen while the list was
     * actually on screen is kept here and put back when it reappears.
     */
    let kept = scroller.scrollTop;
    let shown = scroller.clientHeight > 0;

    const readViewport = (): void => {
      const height = scroller.clientHeight;
      if (height > 0 && !shown && kept > 0 && Math.abs(scroller.scrollTop - kept) > 1) {
        scroller.scrollTop = kept;
        setScrollTop(scroller.scrollTop);
      }
      shown = height > 0;
      setViewportHeight(height);
    };
    readViewport();

    const onScroll = (): void => {
      // A scroll event on a hidden list is the browser zeroing it, not the user.
      if (scroller.clientHeight > 0) kept = scroller.scrollTop;
      setScrollTop(scroller.scrollTop);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });

    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(readViewport) : null;
    observer?.observe(scroller);

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [scroller]);

  // Heights are per-item and only meaningful for the keys it has seen, so a key that
  // leaves the list drops out rather than growing the map forever.
  useEffect(() => {
    const live = new Set(items.map((item) => item.key));
    for (const key of heightsRef.current.keys()) {
      if (!live.has(key)) heightsRef.current.delete(key);
    }
  }, [items]);

  /** Attach the shared observer to one mounted item. */
  const observeItem = useCallback((element: HTMLDivElement | null) => {
    const observer = itemObserver.current;
    if (!element || !observer) return;
    observer.observe(element);
  }, []);

  /** How many rows the list holds, headers excluded. */
  const rowCount = useMemo(() => items.reduce((n, item) => n + (item.kind === "row" ? 1 : 0), 0), [items]);

  const ariaLabel = useMemo(() => {
    const days = sections.filter((section) => section.label).map((section) => section.label!);
    if (days.length === 0) return `${rowCount} ${rowCount === 1 ? "message" : "messages"}`;
    return `${rowCount} ${rowCount === 1 ? "message" : "messages"}, grouped by day`;
  }, [sections, rowCount]);

  /**
   * The day header to pin over the top of the viewport.
   *
   * The last header at or above the current scroll position. Null once the list is
   * scrolled into a section that has no header — the non-chronological sorts — which
   * is correct: there is no day to name.
   */
  const stickyHeader = useMemo(() => {
    const at = indexAt(offsets, Math.max(0, scrollTop + 1));
    for (let i = at; i >= 0; i -= 1) {
      const item = items[i];
      if (item?.kind === "header") return item;
    }
    return null;
  }, [items, offsets, scrollTop]);

  /**
   * Bring the cursor's row into view — once per navigation, and only if it is off screen.
   *
   * Keyed on `revealSeq`, which the store bumps only when the cursor moved by navigation
   * (`j`/`k`, arrows, prev/next, a deep link, the auto-advance after marking unread). It
   * used to run whenever the cursor index, the items or the offsets changed — and the
   * offsets change every time a newly mounted row is measured, which is exactly what
   * scrolling does. So a user who opened a message and scrolled away was yanked back to
   * it a frame later, and again on every sync. A click opens the row under the pointer,
   * which is already on screen, so it does not bump the sequence at all.
   *
   * `block: "nearest"` semantics: a row already fully visible is left alone.
   */
  const revealedSeq = useRef(revealSeq);
  useEffect(() => {
    if (revealedSeq.current === revealSeq) return;
    if (cursorIndex < 0) return;
    const element = scroller;
    if (!element) return;
    // A list hidden behind the phone reader has no height; reveal when it is back.
    if (element.clientHeight === 0) return;
    revealedSeq.current = revealSeq;

    // Scroll by *offset*, not by `querySelectorAll` index: only a window of the list is
    // mounted, so an index into the DOM is an index into whatever happened to be visible.
    const rowIndex = rowIndexForCursor(items, cursorIndex);
    if (rowIndex === null) return;

    const target = scrollTopForIndex(offsets, rowIndex, element.clientHeight);
    const rowTop = offsets[rowIndex] ?? 0;
    const rowBottom = offsets[rowIndex + 1] ?? 0;
    const viewTop = element.scrollTop;
    const viewBottom = viewTop + element.clientHeight;
    if (rowTop >= viewTop && rowBottom <= viewBottom) return;

    element.scrollTop = target;
    setScrollTop(target);
  }, [revealSeq, cursorIndex, items, offsets, scroller, viewportHeight]);

  /**
   * Carry keyboard focus along with the cursor, but only when it is already on a row.
   *
   * Click a row, press `j`, and the cursor and the open message move on while DOM focus
   * stays on the clicked button — and a key press is exactly what makes a browser start
   * drawing `focus-visible`, so the ring lit up on one row while another was open. Focus
   * that is anywhere else (search, the reader, a dialog) is left alone: `j` must never
   * pull the caret out of a text field. Deferred a frame because the target row may only
   * mount once the scroll effect above has moved the window to it.
   */
  useEffect(() => {
    if (cursorIndex < 0 || !scroller) return;
    const rowIndex = rowIndexForCursor(items, cursorIndex);
    const item = rowIndex === null ? undefined : items[rowIndex];
    if (!item || item.kind === "header") return;
    const id = String(item.row.representative.id);

    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !scroller.contains(active)) return;
      if (!active.hasAttribute("data-message-id")) return;
      if (active.getAttribute("data-message-id") === id) return;
      const target = scroller.querySelector<HTMLElement>(`button[data-message-id="${id}"]`);
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [cursorIndex, items, scroller]);

  // ── Selection gestures ─────────────────────────────────────────────────────

  /** Row ids in list order, for ranges. */
  const order = useMemo(
    () => items.flatMap((item) => (item.kind === "row" ? [item.row.representative.id] : [])),
    [items],
  );

  // The gesture handlers read the latest values through refs, so they can be attached
  // once and never rebuilt mid-drag.
  const live = useRef({ order, selection, onSelectionChange, touchSelect, onRowMenu });
  live.current = { order, selection, onSelectionChange, touchSelect, onRowMenu };

  const selectMode = touchSelect && selection.size > 0;

  /** The row a shift-click ranges from: the last row clicked or toggled. */
  const anchorRef = useRef<number | null>(null);
  /** Set when a gesture already handled the press, so its trailing click is eaten. */
  const suppressClick = useRef(false);
  const lastPointerType = useRef<string>("mouse");
  const longPress = useRef(new LongPress());
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyMenuAt = useRef(0);
  /**
   * The drag in progress, if any.
   *
   * A mouse press on a row's body or its avatar arms one and it becomes active past
   * `DRAG_THRESHOLD`; a touch becomes one when a long-press fires (on the avatar in any
   * layout, on the row body on a phone), so the finger can then slide on to extend it.
   * `before` is the selection the press found, which Escape puts back.
   */
  const drag = useRef<{
    pointerId: number;
    pointerType: string;
    anchor: number;
    x: number;
    y: number;
    base: Selection;
    before: Selection;
    active: boolean;
    lastX: number;
    lastY: number;
    frame: number | null;
  } | null>(null);
  /** Undoes what an active drag attached to the window (Escape, scroll, blur). */
  const dragCleanup = useRef<(() => void) | null>(null);

  const rowIdAt = (target: EventTarget | null): number | null => {
    const element = target instanceof Element ? target.closest<HTMLElement>("[data-row-id]") : null;
    const id = element ? Number(element.dataset.rowId) : NaN;
    return Number.isFinite(id) ? id : null;
  };

  const onToggleChecked = useCallback((id: number) => {
    const { selection: current, onSelectionChange: change } = live.current;
    anchorRef.current = id;
    change(toggleId(current, id));
  }, []);

  const clearLongPress = () => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  };

  /** The row under (x, y), or the nearest mounted one when the pointer is past the rows. */
  const rowNear = (x: number, y: number): number | null => {
    if (!scroller) return null;
    const box = scroller.getBoundingClientRect();
    const probeX = Math.max(box.left + 1, Math.min(box.right - 1, x));
    const probeY = Math.max(box.top + 1, Math.min(box.bottom - 1, y));
    const under = rowIdAt(document.elementFromPoint(probeX, probeY));
    if (under !== null) return under;
    const mounted = [...scroller.querySelectorAll<HTMLElement>("[data-row-id]")].map((element) => {
      const rect = element.getBoundingClientRect();
      return { id: Number(element.dataset.rowId), top: rect.top, bottom: rect.bottom };
    });
    return nearestRow(mounted, y);
  };

  /** Extend a drag to the row under the pointer, scrolling the list near its edges. */
  const dragTo = (x: number, y: number) => {
    const state = drag.current;
    if (!state || !state.active || !scroller) return;
    state.lastX = x;
    state.lastY = y;
    const id = rowNear(x, y);
    if (id !== null) {
      const next = dragSelection(state.base, live.current.order, state.anchor, id);
      if (!sameSelection(next, live.current.selection)) live.current.onSelectionChange(next);
    }
    // Edge scrolling, so a drag can reach rows that are not mounted yet. It keeps going
    // while the pointer rests near (or past) an edge, one step a frame.
    const box = scroller.getBoundingClientRect();
    const speed = edgeScrollSpeed(y, box.top, box.bottom);
    if (speed !== 0 && state.frame === null) {
      state.frame = requestAnimationFrame(() => {
        const now = drag.current;
        if (!now) return;
        now.frame = null;
        const before = scroller.scrollTop;
        scroller.scrollTop += speed;
        // At the end of the list there is nothing left to scroll to: stop asking.
        if (scroller.scrollTop !== before) dragTo(now.lastX, now.lastY);
      });
    }
  };

  /**
   * End the drag. `keep` false is Escape: the selection goes back to what it was before
   * the press. Either way the click the browser sends after the release is eaten, so a
   * drag that ends where it began never opens the row or the sender menu.
   */
  const finishDrag = (keep: boolean) => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    if (state.frame !== null) cancelAnimationFrame(state.frame);
    dragCleanup.current?.();
    dragCleanup.current = null;
    if (scroller?.hasPointerCapture?.(state.pointerId)) scroller.releasePointerCapture(state.pointerId);
    if (!state.active) return;
    suppressClick.current = true;
    anchorRef.current = state.anchor;
    if (!keep) live.current.onSelectionChange(state.before);
  };

  /** A pressed drag passes the threshold (or a long-press fires): it starts selecting. */
  const activateDrag = () => {
    const state = drag.current;
    if (!state || state.active || !scroller) return;
    state.active = true;
    try {
      // On the scroller rather than the row, so rows unmounted by the window (or by an
      // edge scroll) cannot take the capture with them, and the release still arrives
      // when the pointer is let go outside the window.
      scroller.setPointerCapture(state.pointerId);
    } catch {
      // The pointer is already gone (released between the press and this frame).
    }
    window.getSelection()?.removeAllRanges();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finishDrag(false);
    };
    // Scrolling with the wheel (or a trackpad) mid-drag moves rows under a still
    // pointer, so the range follows.
    const onScroll = () => {
      const now = drag.current;
      if (now?.active) dragTo(now.lastX, now.lastY);
    };
    const onBlur = () => finishDrag(true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    dragCleanup.current = () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      scroller.removeEventListener("scroll", onScroll);
    };
  };

  const onPointerDown = (event: React.PointerEvent) => {
    lastPointerType.current = event.pointerType;
    // A fresh press: a click left unclaimed by an earlier gesture (a touch that ended in
    // a long-press and never produced one) must not eat this press's click.
    suppressClick.current = false;
    if (drag.current) finishDrag(true);
    const target = event.target as Element;
    const control = target.closest<HTMLElement>("[data-row-control]");
    const onAvatar = control?.dataset.rowControl === "avatar";
    if (control && !onAvatar) return;
    const id = rowIdAt(target);
    if (id === null) return;

    if (event.pointerType === "mouse") {
      if (event.button !== 0 || event.shiftKey) return;
      // The phone layout with a mouse attached keeps its tap semantics on the body; the
      // avatar still drags.
      if (live.current.touchSelect && !onAvatar) return;
      const additive = event.metaKey || event.ctrlKey;
      const current = live.current.selection;
      drag.current = {
        pointerId: event.pointerId,
        pointerType: "mouse",
        anchor: id,
        x: event.clientX,
        y: event.clientY,
        base: onAvatar ? avatarDragBase(current, additive) : additive ? current : new Set<number>(),
        before: current,
        active: false,
        lastX: event.clientX,
        lastY: event.clientY,
        frame: null,
      };
      return;
    }

    // Touch and pen: a long-press. On the avatar in any layout, on the row body only on
    // a phone (the desktop layout's body is a tap that opens).
    if (!live.current.touchSelect && !onAvatar) return;
    // Touch events keep the element the finger first landed on as their target, even
    // after the window unmounts its row during an edge scroll; a listener on that
    // element is the one place the scroll can still be vetoed from. See `noScroll`.
    if (event.pointerType === "touch") holdTouchTarget(target);
    const pointerId = event.pointerId;
    const pointerType = event.pointerType;
    longPress.current.down(id, event.clientX, event.clientY, performance.now());
    clearLongPress();
    longPressTimer.current = setTimeout(() => {
      const fired = longPress.current.tick(performance.now());
      if (fired === null) return;
      const { selection: current, onSelectionChange: change } = live.current;
      anchorRef.current = fired;
      const next = current.size === 0 ? new Set([fired]) : toggleId(current, fired);
      change(next);
      navigator.vibrate?.(8);
      // Pressed onto a row: the finger can now slide to extend the range. Pressing a row
      // that was already selected took it out, and that is the whole gesture.
      if (next.has(fired)) {
        drag.current = {
          pointerId,
          pointerType,
          anchor: fired,
          x: 0,
          y: 0,
          base: next,
          before: current,
          active: false,
          lastX: 0,
          lastY: 0,
          frame: null,
        };
        activateDrag();
      }
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const state = drag.current;
    if (state && state.pointerId === event.pointerId) {
      if (state.pointerType === "mouse" && (event.buttons & 1) === 0) {
        // The button came up somewhere we never heard about.
        finishDrag(true);
        return;
      }
      if (!state.active) {
        if (Math.hypot(event.clientX - state.x, event.clientY - state.y) < DRAG_THRESHOLD) return;
        activateDrag();
      }
      event.preventDefault();
      dragTo(event.clientX, event.clientY);
      return;
    }
    if (event.pointerType !== "mouse" && !longPress.current.move(event.clientX, event.clientY)) clearLongPress();
  };

  const endPointer = (event: React.PointerEvent) => {
    const state = drag.current;
    if (state && state.pointerId === event.pointerId) {
      finishDrag(true);
      if (state.pointerType !== "mouse") {
        clearLongPress();
        longPress.current.up();
      }
      return;
    }
    clearLongPress();
    if (longPress.current.up()) suppressClick.current = event.type === "pointerup";
  };

  /** Capture went elsewhere (the window lost the pointer): the drag ends where it is. */
  const onLostPointerCapture = (event: React.PointerEvent) => {
    const state = drag.current;
    if (state?.active && state.pointerId === event.pointerId) finishDrag(true);
  };

  /** Stops a touch drag from scrolling the list; attached to the scroller and the touch target. */
  const noScroll = useRef((event: TouchEvent) => {
    const state = drag.current;
    if (state?.active && state.pointerType !== "mouse" && event.cancelable) event.preventDefault();
  }).current;
  const touchTarget = useRef<Element | null>(null);
  const holdTouchTarget = (target: Element) => {
    touchTarget.current?.removeEventListener("touchmove", noScroll as EventListener);
    touchTarget.current = target;
    target.addEventListener("touchmove", noScroll as EventListener, { passive: false });
  };

  /*
    While a press may become a drag, the browser's own drags stay out of it: no text
    selection sweeping across the rows and no ghost image of an avatar. And a touch drag
    must not scroll the list: React's touch listeners are passive, so this one is
    attached by hand, and only cancels once a long-press has turned into a drag.
  */
  useEffect(() => {
    const veto = (event: Event) => {
      if (drag.current) event.preventDefault();
    };
    document.addEventListener("selectstart", veto, true);
    document.addEventListener("dragstart", veto, true);
    scroller?.addEventListener("touchmove", noScroll, { passive: false });
    return () => {
      document.removeEventListener("selectstart", veto, true);
      document.removeEventListener("dragstart", veto, true);
      scroller?.removeEventListener("touchmove", noScroll);
    };
  }, [scroller, noScroll]);

  useEffect(
    () => () => {
      dragCleanup.current?.();
      dragCleanup.current = null;
      touchTarget.current?.removeEventListener("touchmove", noScroll as EventListener);
    },
    [noScroll],
  );

  /**
   * Clicks, decided before the row's own handler sees them.
   *
   * Captured on the scroller so a gesture can veto the open: a drag or a long-press ends
   * with a click the browser still delivers, and select mode turns a tap into a toggle.
   */
  const onClickCapture = (event: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const target = event.target as Element;
    if (target.closest("[data-row-control]")) return;
    const id = rowIdAt(target);
    if (id === null) return;
    const { selection: current, onSelectionChange: change, order: rows, touchSelect: touch } = live.current;

    if (touch) {
      if (current.size > 0) {
        event.preventDefault();
        event.stopPropagation();
        anchorRef.current = id;
        change(toggleId(current, id));
      }
      return;
    }

    if (event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      change(shiftSelection(current, rows, anchorRef.current, id, event.metaKey || event.ctrlKey));
      return;
    }
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      event.stopPropagation();
      anchorRef.current = id;
      change(toggleId(current, id));
      return;
    }
    // A plain click opens the message (the row's own handler) and ends a selection.
    anchorRef.current = id;
    if (current.size > 0) change(new Set());
  };

  const openRowMenu = (id: number, anchor: MenuAnchor | null) => {
    const handler = live.current.onRowMenu;
    if (!handler || !scroller) return;
    const button = scroller.querySelector<HTMLElement>(`button[data-message-id="${id}"]`);
    if (!button) return;
    handler(id, anchor ?? anchorFromElement(button), button);
  };

  const onContextMenu = (event: React.MouseEvent) => {
    const id = rowIdAt(event.target);
    if (id === null) return;
    // Never the browser's menu over a row: on a phone a long-press is select mode, and
    // on the desktop the row has its own menu.
    event.preventDefault();
    if (live.current.touchSelect || lastPointerType.current !== "mouse" && event.button !== 2) {
      if (live.current.touchSelect) return;
    }
    if (performance.now() - keyMenuAt.current < 400) return;
    // A keyboard-opened `contextmenu` reports (0, 0) or no button; anchor it to the row.
    const fromKeyboard = event.button !== 2 || (event.clientX === 0 && event.clientY === 0);
    openRowMenu(id, fromKeyboard ? null : { kind: "point", x: event.clientX, y: event.clientY });
  };

  const onKeyDownList = (event: React.KeyboardEvent) => {
    if (!(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
    if (live.current.touchSelect) return;
    const id = rowIdAt(event.target);
    if (id === null) return;
    event.preventDefault();
    event.stopPropagation();
    keyMenuAt.current = performance.now();
    openRowMenu(id, null);
  };

  useEffect(() => () => clearLongPress(), []);

  if (threads.length === 0) {
    return (
      <Empty
        reason={emptyReason}
        onClearFilters={onClearFilters}
        onClearSearch={onClearSearch}
        onSync={onSync}
        canSync={canSync}
      />
    );
  }

  return (
    // A positioning wrapper, so the pinned day header can sit over the scroller rather
    // than inside it. See the note on the overlay below.
    <div className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${className}`}>
      <div
        ref={setScroller}
        // The true row count, for anything that needs the size of the list rather than the
        // size of the window. The smoke test asserts against it: `[data-message-id]` is only
        // the mounted window, so counting those elements measures the viewport.
        data-row-count={rowCount}
        data-select-mode={selectMode ? "" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onLostPointerCapture={onLostPointerCapture}
        onDragStart={(event) => event.preventDefault()}
        onClickCapture={onClickCapture}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDownList}
        className="thin-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-surface pb-4"
      >
      {/*
        The scroll extent, and the window positioned inside it.

        The outer div is the full height of the list so the scrollbar is honest; the inner
        one is translated to the first mounted item's offset. Only the mounted rows exist
        as DOM, which is the entire point — a 5,000-message inbox used to build 5,000 row
        subtrees.
      */}
      <div style={{ height: offsets[items.length] ?? 0, position: "relative" }}>
        <div
          role="list"
          aria-label={ariaLabel}
          className="absolute inset-x-0 top-0 px-1.5"
          style={{ transform: `translateY(${offsets[start] ?? 0}px)` }}
        >
          {/*
            Each day is its own boundary, with an accessible name.

            The heading was purely visual before, so a screen reader heard one
            undifferentiated list of messages with no indication of where today ended and
            yesterday began. The section wrapper is gone because a window cannot contain
            part of a `<section>` — a day boundary would be cut in half by the viewport
            edge — so the boundary is preserved as a header item plus `aria-label` on the
            list. `label` is null for a sort that is not chronological, and then there are
            no header items at all: the boundary would be false.
          */}
          {/*
            Rendered items, re-wrapped into the day sections they belong to.

            A window cannot hold a whole `<section>`, but it can hold the *run* of mounted
            items that share one — so a day split across the window edge renders as two
            sections with the same accessible name rather than one section with a hole.
            The name carries the day's full count.
          */}
          {runsInWindow(items, start, end).map((run) => (
            <section
              key={`${run.section.key}:${run.firstKey}`}
              aria-label={
                run.section.label
                  ? `${run.section.label}, ${run.section.count} ${run.section.count === 1 ? "message" : "messages"}`
                  : undefined
              }
            >
              {run.items.map((item) => {
                if (item.kind === "header") {
                  return (
                    <div key={item.key} data-item-key={item.key} ref={observeItem}>
                      <SectionHeader label={item.label} count={item.count} />
                    </div>
                  );
                }
                const email = item.row.representative;
                return (
                  <div role="listitem" key={item.key} data-item-key={item.key} ref={observeItem}>
                    <Row
                      row={item.row}
                      signals={item.signals}
                      bucket={item.bucket}
                      selected={email.id === selectedId}
                      unread={unreadIds.has(email.id)}
                      fresh={freshIds.has(email.id)}
                      checked={selection.has(email.id)}
                      selectMode={selection.size > 0}
                      photo={photos.get(email.sender.toLowerCase())}
                      onSelect={onSelect}
                      onToggleStar={onToggleStar}
                      onAvatar={onAvatar}
                      onToggleChecked={onToggleChecked}
                      // Re-checked on every clock tick (`now`), so the chip leaves on
                      // its own five minutes after the message arrived.
                      chipCode={codeChipVisible(email, now) ? (email.code ?? null) : null}
                      codeCopied={copiedCodeId === email.id}
                      onCopyCode={onCopyCode}
                    />
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </div>
      </div>

      {/*
        The day header, pinned while its day scrolls under it.

        It sits outside the scroller because `position: sticky` cannot be used: sticky
        resolves against the nearest scrolling ancestor *within its own containing block*,
        and the containing block here is the translated window, so a sticky header would
        stop sticking the moment it scrolled out of the window — exactly when it is
        needed. Tracking the scroll position and painting the current header over the top
        is the same behaviour without the dependency.

        `pointer-events-none` because this is a copy of a header that is also in the flow
        below; it must not swallow a click meant for the row underneath.
      */}
      {stickyHeader && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-surface px-1.5">
          <SectionHeader label={stickyHeader.label} count={stickyHeader.count} />
        </div>
      )}
    </div>
  );
}

export default memo(MessageList);
