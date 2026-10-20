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

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArchiveRestore, Check, Mail, MailOpen, Trash2 } from "lucide-react";
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
import { draftRowName } from "../../core/mail/drafts";
import {
  rowIndicators,
  FILTER_LABELS,
  type BuiltinSmartFilter,
  type EmailSignals,
} from "../../core/model/signals";
import { filterIcon } from "../filterIcons";
import { FILTER_HUES } from "../filterColors";
import type { SortBy } from "../../core/classify/scoring";
import type { EmptyReason, ThreadRow } from "../../core/classify/pipeline";
import { InboxClear } from "./InboxClear";
import { emptyKindFor, viewKey, type EmptyContext, type EmptyKind } from "../inboxClear";
import { useClearCelebration } from "../useClearCelebration";
import {
  SWIPE_LABEL,
  SwipeGesture,
  removesRow,
  swipeActionsFor,
  type SwipeAction,
  type SwipeActions,
  type SwipeDirection,
} from "../swipe";
import {
  ESTIMATED_HEADER_HEIGHT,
  ESTIMATED_ROW_HEIGHT,
  computeOffsets,
  revealScrollTop,
  scrollTopForIndex,
  stickyIndex,
  visibleRange,
  windowKey,
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
type ItemRun = { section: DaySection; key: string; items: ListItem[] };

/**
 * The mounted window, cut into runs of consecutive items that share a day.
 *
 * A day is contiguous, so it is one run per window; the `#n` suffix only guards against
 * two runs ever colliding on one React key.
 */
function runsInWindow(items: readonly ListItem[], start: number, end: number): ItemRun[] {
  const runs: ItemRun[] = [];
  const seen = new Map<string, number>();
  for (let i = start; i < end; i += 1) {
    const item = items[i]!;
    const current = runs[runs.length - 1];
    if (current && current.section.key === item.section.key) current.items.push(item);
    else {
      // Keyed by the day, not by its first mounted item: keyed by the first item, every
      // scroll that moved the window's top inside a day remounted that whole day's rows.
      const n = seen.get(item.section.key) ?? 0;
      seen.set(item.section.key, n + 1);
      runs.push({ section: item.section, key: `${item.section.key}#${n}`, items: [item] });
    }
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

type RowSignal = {
  label: string;
  title: string;
  danger: boolean;
  /** Drawn in this smart filter's chip colour rather than grey (Urgent only). */
  hue?: BuiltinSmartFilter;
};

/**
 * Words drawn in their chip's colour. Urgent is the one a glance has to catch, so it
 * takes the Urgent chip's hue from the rail (`FILTER_HUES`, at the mode's text
 * lightness); the rest stay grey so colour keeps meaning something.
 */
const TINTED_SIGNALS: ReadonlySet<BuiltinSmartFilter> = new Set(["urgent"]);

function rowSignal(indicators: readonly BuiltinSmartFilter[], fresh: boolean): RowSignal | null {
  const id = ROW_SIGNAL_ORDER.find((candidate) => indicators.includes(candidate));
  if (id) {
    return {
      label: FILTER_LABELS[id],
      title: filterIcon(id).title,
      danger: id === "unsafe",
      hue: TINTED_SIGNALS.has(id) ? id : undefined,
    };
  }
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
  // A draft is named by who it is to, and says it is a draft where a row's signal word
  // goes, in the danger colour Gmail gives it.
  const draft = email.gmailDraft !== undefined;
  const name = draft ? draftRowName(email) : displayName(email);

  const signal: RowSignal | null = draft ? { label: "Draft", title: "Not sent yet", danger: true } : rowSignal(indicators, fresh);

  return (
    <div
      data-row-id={email.id}
      data-checked={checked ? "" : undefined}
      className={`group/row relative flex w-full items-start gap-2 rounded-pane px-3 py-1.5 text-left transition-colors duration-150 [-webkit-touch-callout:none] ${
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
                  data-row-signal={signal.hue ?? ""}
                  className={`text-meta font-medium ${
                    signal.danger ? "text-danger" : signal.hue ? "wn-signal-ink" : "text-ink-muted"
                  }`}
                  style={
                    signal.hue
                      ? ({ "--pill-h": FILTER_HUES[signal.hue].h, "--pill-s": FILTER_HUES[signal.hue].s } as React.CSSProperties)
                      : undefined
                  }
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

        Its centre sits on the time's centre: `-mt-[0.5px]` for the 24px box, and on a
        touch device the 44px target keeps that centre with `-mt-[10.5px]`. The code chip
        does the same (`CodeCopy.tsx`).
      */}
      {/* A draft has no star: it is not mail yet. */}
      {!draft && (
      <button
        type="button"
        onClick={() => onToggleStar(email.id)}
        aria-label={email.starred ? "Unstar" : "Star"}
        aria-pressed={email.starred}
        className="-mt-[0.5px] flex h-6 w-6 shrink-0 items-center justify-center rounded-ctl text-ink-subtle [@media(hover:none)]:-mx-2.5 [@media(hover:none)]:-mb-2.5 [@media(hover:none)]:-mt-[10.5px] [@media(hover:none)]:h-11 [@media(hover:none)]:w-11 transition-opacity hover:bg-sheen hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/row:opacity-100 [@media(hover:hover)]:aria-pressed:opacity-100 [@media(hover:hover)]:focus-visible:opacity-100"
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
      )}
    </div>
  );
});

/** The icon for a swipe action, as the backdrop shows it. */
function SwipeIcon({ action }: { action: SwipeAction }) {
  const props = { size: 20, strokeWidth: 2.2, "aria-hidden": true } as const;
  switch (action) {
    case "trash":
    case "discard":
      return <Trash2 {...props} />;
    case "restore":
      return <ArchiveRestore {...props} />;
    case "markRead":
      return <MailOpen {...props} />;
    case "markUnread":
      return <Mail {...props} />;
  }
}

/** Removing actions are drawn in the danger colour; the rest in the accent. */
function swipeTone(action: SwipeAction): "danger" | "accent" {
  return action === "trash" || action === "discard" ? "danger" : "accent";
}

/**
 * What is behind a row being swiped: the colour and the icon and words of what letting
 * go will do, on the side the row uncovers.
 *
 * Rendered only for the one row under the finger, and only once the touch has locked
 * sideways, so the list carries no hidden layer per row. Which side shows, its colour
 * and whether the icon is "armed" (past the commit line) are data attributes the list
 * sets by hand on every move, so a drag re-renders nothing.
 *
 * Trash and Discard take the danger colour with the surface's own colour on it (the
 * pairing every destructive button uses, light text on dark red in light mode and dark
 * on light red in dark and OLED); read, unread and Restore take the accent with
 * `on-accent`, which is checked for contrast per mode and per accent theme.
 */
function SwipeBackdrop({ actions }: { actions: SwipeActions }) {
  return (
    <div
      data-swipe-backdrop=""
      aria-hidden="true"
      className="group/swipe pointer-events-none absolute inset-0 flex items-center justify-between overflow-hidden rounded-pane px-5 text-ui font-semibold data-[tone=accent]:bg-accent data-[tone=accent]:text-on-accent data-[tone=danger]:bg-danger data-[tone=danger]:text-[var(--wn-surface)]"
    >
      {/* The finger moved right: the left side is uncovered. */}
      <span data-swipe-side="right" className="hidden items-center gap-2 group-data-[dir=right]/swipe:flex">
        {actions.right && (
          <>
            <span className="flex origin-center opacity-75 transition-transform duration-150 group-data-[armed]/swipe:scale-125 group-data-[armed]/swipe:opacity-100 motion-reduce:transition-none">
              <SwipeIcon action={actions.right} />
            </span>
            {SWIPE_LABEL[actions.right]}
          </>
        )}
      </span>
      <span data-swipe-side="left" className="ml-auto hidden items-center gap-2 group-data-[dir=left]/swipe:flex">
        {actions.left && (
          <>
            {SWIPE_LABEL[actions.left]}
            <span className="flex origin-center opacity-75 transition-transform duration-150 group-data-[armed]/swipe:scale-125 group-data-[armed]/swipe:opacity-100 motion-reduce:transition-none">
              <SwipeIcon action={actions.left} />
            </span>
          </>
        )}
      </span>
    </div>
  );
}

/** How long the row takes to leave, to collapse, and to spring back (ms). */
/**
 * The breathing gap between floating chrome and the first thing in the list, in px.
 * Added to the measured chrome height, never in place of it.
 */
const TOP_GAP = 6;

const SWIPE_OUT_MS = 180;
const SWIPE_COLLAPSE_MS = 160;
const SWIPE_BACK_MS = 220;

function prefersReducedMotion(): boolean {
  return globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

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
    <div className="flex items-baseline gap-2 pb-1 pl-[68px] pr-3 pt-4 text-meta">
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
  /** What an empty mailbox says and its button reads, where "Nothing here yet" is wrong (Drafts). */
  emptyMailbox?: { body: string; action: string };
  /** Which good-news state an empty list is (`ui/inboxClear`), or null for a remedy screen. */
  kind?: EmptyKind | null;
  now?: number;
  /** The last item was just cleared: play the one-time motion. */
  celebrating?: boolean;
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
  emptyMailbox,
  kind,
  now = Date.now(),
  celebrating = false,
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
          body: emptyMailbox?.body ?? "Nothing here yet.",
          action: canSync
            ? { label: emptyMailbox?.action ?? "Check for new mail", run: onSync }
            : null,
        };
      default:
        return null;
    }
  })();

  if (kind) {
    // A clear Inbox or filter gets the calm state; an empty folder or filter the quiet
    // one, which keeps this screen's remedy (and Drafts' own wording).
    return (
      <InboxClear
        kind={kind}
        now={now}
        celebrating={celebrating}
        action={remedy?.action ?? null}
        line={reason === "mailbox" ? emptyMailbox?.body : undefined}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
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
  /** The mailbox and filters on screen, for the inbox-clear state. */
  emptyContext?: EmptyContext;
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
  emptyMailbox?: EmptyState["emptyMailbox"];
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
  /**
   * Swipe actions on rows (see `ui/swipe.ts`), or null for none. The app passes this only
   * in the phone layout with the setting on and no menu, sheet or dialog open; the list
   * itself also holds off in select mode, and answers touch only, never a mouse.
   */
  swipe?: { mailbox: string; onAction: (id: number, action: SwipeAction) => void } | null;
  /**
   * How much of the top of the list is covered by chrome floating over it, in px: the
   * desktop's glass top bar and chips (`Masthead`). The rows start below it at rest and
   * scroll visibly underneath it; the pinned day header, the cursor's reveal and focus
   * scrolling (`scroll-padding-top`) all treat the band as covered. 0 (the phone, whose
   * top bar is in the flow) changes nothing.
   */
  topInset?: number;
  /**
   * What the list is showing: the mailbox or label, the smart filters and the search.
   * When it changes the list starts again at its top, so the new view's first email is
   * the first thing under the chrome rather than whatever sat at the old scroll offset.
   */
  listView?: string;
  /**
   * The store's cursor for revealing only, when it differs from the highlighted
   * `cursorIndex`: the phone shows no current row, but `j`/`k` in its reader still move
   * through the list, and Back should land where they went. Defaults to `cursorIndex`.
   */
  revealIndex?: number;
  /**
   * In-flow content at the top of the scroll, above the first day: the desktop's
   * briefing ("3 waiting on you…", the sync line, Connect Gmail). It scrolls away with
   * the list, and the windowing counts it in.
   */
  lead?: React.ReactNode;
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
  emptyContext,
  sortBy,
  onSelect,
  onToggleStar,
  onClearFilters,
  onClearSearch,
  onSync,
  canSync,
  emptyMailbox,
  now,
  photos,
  selection,
  onSelectionChange,
  touchSelect,
  onAvatar,
  onRowMenu,
  onCopyCode,
  copiedCodeId,
  swipe = null,
  topInset = 0,
  listView = "",
  revealIndex,
  lead,
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
  /** The lead's measured height (0 without one). */
  const [leadHeight, setLeadHeight] = useState(0);
  const leadObserver = useRef<ResizeObserver | null>(null);
  const measureLead = useCallback((element: HTMLDivElement | null) => {
    leadObserver.current?.disconnect();
    leadObserver.current = null;
    if (!element) {
      setLeadHeight(0);
      return;
    }
    const read = () => setLeadHeight(element.offsetHeight);
    read();
    if (typeof ResizeObserver !== "undefined") {
      leadObserver.current = new ResizeObserver(read);
      leadObserver.current.observe(element);
    }
  }, []);
  /**
   * The band at the top of the scroller the rows start below: the floating chrome plus a
   * small breathing gap, so the first day and row never sit flush against the glass.
   */
  const band = topInset > 0 ? topInset + TOP_GAP : 0;
  /** Where the first item starts inside the scroller: the floating band, then the lead. */
  const contentTop = band + (lead ? leadHeight : 0);

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
    () => visibleRange(offsets, scrollTop - contentTop, viewportHeight),
    [offsets, scrollTop, viewportHeight, contentTop],
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
      // The scroll listener skips renders that would draw the same rows, so the position
      // React knows can lag the real one by a few pixels; a new viewport re-reads it.
      setScrollTop(scroller.scrollTop);
    };
    readViewport();

    const onScroll = (): void => {
      // A scroll event on a hidden list is the browser zeroing it, not the user.
      if (scroller.clientHeight > 0) kept = scroller.scrollTop;
      const top = scroller.scrollTop;
      const w = windowInputs.current;
      const isHeader = (i: number) => w.items[i]?.kind === "header";
      const key = (at: number) => windowKey(w.offsets, isHeader, at, w.contentTop, w.viewportHeight, w.topInset);
      // Only when it changes what is drawn: most scroll events move the same rows.
      if (key(top) !== key(w.scrollTop)) setScrollTop(top);
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
    // Under floating chrome the copy is pinned just below it, so it names the day at
    // that line; above the first header (the lead still showing) there is none to pin.
    const line = scrollTop + topInset - contentTop;
    if (contentTop > 0 && line < 0) return null;
    const at = stickyIndex(offsets, (i) => items[i]?.kind === "header", line);
    const item = at >= 0 ? items[at] : undefined;
    return item?.kind === "header" ? item : null;
  }, [items, offsets, scrollTop, topInset, contentTop]);

  /**
   * What the latest render drew from, for the scroll listener: a scroll that leaves
   * `windowKey` unchanged skips React entirely (see `windowKey`). Written during render,
   * read in an event handler, never in render.
   */
  const windowInputs = useRef({ offsets, items, contentTop, viewportHeight, topInset, scrollTop });
  windowInputs.current = { offsets, items, contentTop, viewportHeight, topInset, scrollTop };

  /**
   * How much of the scroller's top a row has to clear to be seen: the floating chrome,
   * and the day header pinned under it. 0 on the phone, as before.
   */
  const firstHeaderKey = items[0]?.kind === "header" ? items[0].key : null;
  const coveredTop =
    topInset > 0
      ? // `||`, not `??`: an unmounted header can be on record as 0.
        band + (firstHeaderKey ? heightsRef.current.get(firstHeaderKey) || ESTIMATED_HEADER_HEIGHT : 0)
      : 0;

  /**
   * A new view (another mailbox or label, other smart filters, a new search, another sort)
   * starts at its top. Before, the scroller kept the old view's offset, so switching a
   * filter from halfway down the Inbox opened the filtered list halfway down too, its top
   * email out of sight above the chrome. Layout effect, so the old offset is never painted.
   */
  const shownView = useRef(listView);
  useLayoutEffect(() => {
    if (shownView.current === listView) return;
    shownView.current = listView;
    if (scroller && scroller.scrollTop !== 0) {
      scroller.scrollTop = 0;
      setScrollTop(0);
    }
  }, [listView, scroller]);

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
  /** The post-reveal check under floating chrome (see below). */
  const settleFrame = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (settleFrame.current !== null) cancelAnimationFrame(settleFrame.current);
    },
    [],
  );
  /**
   * A navigation that happened while the list was hidden (behind the phone's full-screen
   * reader, or the reader at 640–1023px): the row it landed on, by key, revealed when the
   * list is back. By key rather than by cursor, because leaving the phone reader drops
   * the cursor: `j` through messages from the list's top and Back used to return to the
   * old scroll offset, with the message just read (the top email, say) out of sight.
   */
  const pendingReveal = useRef<string | null>(null);
  useEffect(() => {
    const element = scroller;
    if (!element) return;
    let rowIndex: number | null;
    const revealAt = revealIndex ?? cursorIndex;
    if (revealedSeq.current !== revealSeq && revealAt >= 0) {
      revealedSeq.current = revealSeq;
      // Scroll by *offset*, not by `querySelectorAll` index: only a window of the list is
      // mounted, so an index into the DOM is an index into whatever happened to be visible.
      rowIndex = rowIndexForCursor(items, revealAt);
      // A list hidden behind the reader has no height; reveal when it is back.
      if (element.clientHeight === 0) {
        pendingReveal.current = rowIndex === null ? null : (items[rowIndex]?.key ?? null);
        return;
      }
      pendingReveal.current = null;
    } else if (pendingReveal.current !== null && element.clientHeight > 0) {
      const pending = pendingReveal.current;
      pendingReveal.current = null;
      const index = items.findIndex((item) => item.key === pending);
      rowIndex = index < 0 ? null : index;
    } else {
      return;
    }
    if (rowIndex === null) return;

    // The first message goes to the very top of the list: its day, the briefing and the
    // breathing gap all show, and nothing can leave it under the chrome.
    if (items.findIndex((item) => item.kind === "row") === rowIndex) {
      if (element.scrollTop !== 0) {
        element.scrollTop = 0;
        setScrollTop(0);
      }
      return;
    }

    // Rows sit `contentTop` down the scroller, and the top `coveredTop` of it is under
    // the floating chrome (and the pinned day header): a row there is not in view, and
    // one brought into view lands just below it.
    // Under floating chrome a mounted row is judged by where it really is: the offsets
    // of rows above it may still be estimates, and a few pixels off is under the glass.
    const key = items[rowIndex]?.key;
    const clearance = (top: number, bottom: number): number =>
      top < coveredTop ? top - coveredTop : bottom > element.clientHeight ? Math.min(bottom - element.clientHeight, top - coveredTop) : 0;
    if (contentTop > 0 && key) {
      const mounted = element.querySelector<HTMLElement>(`[data-item-key="${CSS.escape(key)}"]`);
      if (mounted) {
        const box = element.getBoundingClientRect();
        const rect = mounted.getBoundingClientRect();
        const delta = clearance(rect.top - box.top, rect.bottom - box.top);
        if (Math.abs(delta) >= 1) {
          element.scrollTop += delta;
          setScrollTop(element.scrollTop);
        }
        return;
      }
    }
    const rowTop = contentTop + (offsets[rowIndex] ?? 0);
    const rowBottom = contentTop + (offsets[rowIndex + 1] ?? 0);
    const viewTop = element.scrollTop + coveredTop;
    const viewBottom = element.scrollTop + element.clientHeight;
    if (rowTop >= viewTop && rowBottom <= viewBottom) return;

    const target =
      contentTop > 0
        ? revealScrollTop(rowTop, coveredTop, element.scrollHeight, element.clientHeight)
        : scrollTopForIndex(offsets, rowIndex, element.clientHeight);
    element.scrollTop = target;
    setScrollTop(target);
    if (contentTop === 0) return;
    // Under floating chrome, check where the row really landed once it is mounted: rows
    // above it that were only estimated can put it a little off, and here "a little"
    // is under the glass. Corrected against the DOM, a frame later.
    let frames = 0;
    if (settleFrame.current !== null) cancelAnimationFrame(settleFrame.current);
    // Not cancelled by this effect's cleanup: the offsets change (and re-run the effect)
    // in exactly the frames this is waiting on.
    settleFrame.current = requestAnimationFrame(function settle() {
      settleFrame.current = null;
      frames += 1;
      const row = key ? element.querySelector<HTMLElement>(`[data-item-key="${CSS.escape(key)}"]`) : null;
      if (!row) {
        if (frames < 4) settleFrame.current = requestAnimationFrame(settle);
        return;
      }
      const box = element.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      const delta = clearance(rect.top - box.top, rect.bottom - box.top);
      if (Math.abs(delta) >= 1) {
        element.scrollTop += delta;
        setScrollTop(element.scrollTop);
      }
      if (frames < 3) settleFrame.current = requestAnimationFrame(settle);
    });
  }, [revealSeq, cursorIndex, revealIndex, items, offsets, scroller, viewportHeight, contentTop, coveredTop]);

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
  const live = useRef({ order, selection, onSelectionChange, touchSelect, onRowMenu, swipe, unreadIds });
  live.current = { order, selection, onSelectionChange, touchSelect, onRowMenu, swipe, unreadIds };

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

  // ── Swipe actions ──────────────────────────────────────────────────────────

  /**
   * The touch that may be a swipe. Every decision is `SwipeGesture`'s; this holds the
   * elements it moves. `row` is the row's own element (translated), `item` its list item
   * (collapsed when the row leaves). `active` once the touch locked sideways.
   */
  const swipeRef = useRef<{
    pointerId: number;
    id: number;
    gesture: SwipeGesture;
    actions: SwipeActions;
    row: HTMLElement;
    item: HTMLElement;
    width: number;
    active: boolean;
    armed: boolean;
  } | null>(null);
  /** A released swipe still animating: no new one starts until it is done. */
  const swipeBusy = useRef(false);
  /** The row whose backdrop is mounted, and what its two sides do. */
  const [swiping, setSwiping] = useState<{ id: number; actions: SwipeActions } | null>(null);

  /** Put the row and its item back exactly as React left them. */
  const clearSwipeStyles = (row: HTMLElement, item: HTMLElement) => {
    row.style.transform = "";
    row.style.transition = "";
    row.style.willChange = "";
    row.style.backgroundColor = "";
    item.style.height = "";
    item.style.transition = "";
  };

  /** Draw the row at `offset`, and say on the backdrop which side and whether armed. */
  const paintSwipe = (offset: number, direction: SwipeDirection | null, armed: boolean) => {
    const state = swipeRef.current;
    if (!state) return;
    state.row.style.transform = `translate3d(${offset}px, 0, 0)`;
    const backdrop = state.item.querySelector<HTMLElement>("[data-swipe-backdrop]");
    if (!backdrop) return;
    const action = direction ? state.actions[direction] : null;
    if (direction && action) {
      backdrop.dataset.dir = direction;
      backdrop.dataset.tone = swipeTone(action);
    } else {
      delete backdrop.dataset.dir;
      delete backdrop.dataset.tone;
    }
    if (armed) backdrop.dataset.armed = "";
    else delete backdrop.dataset.armed;
  };

  /** Arm a swipe on a touch press over a row, when swipes are on and nothing else owns it. */
  const startSwipe = (event: React.PointerEvent, target: Element) => {
    swipeRef.current = null;
    const config = live.current.swipe;
    if (!config || event.pointerType !== "touch" || swipeBusy.current) return;
    if (live.current.selection.size > 0) return;
    const row = target.closest<HTMLElement>("[data-row-id]");
    const item = row?.parentElement;
    const id = row ? Number(row.dataset.rowId) : NaN;
    if (!row || !item || !Number.isFinite(id)) return;
    const actions = swipeActionsFor(config.mailbox, live.current.unreadIds.has(id));
    const width = row.getBoundingClientRect().width;
    swipeRef.current = {
      pointerId: event.pointerId,
      id,
      gesture: new SwipeGesture({ x: event.clientX, y: event.clientY, at: performance.now() }, width, actions, {
        screenWidth: window.innerWidth,
      }),
      actions,
      row,
      item,
      width,
      active: false,
      armed: false,
    };
  };

  /** A move of the swiping finger. True when the swipe owns this touch now. */
  const moveSwipe = (event: React.PointerEvent): boolean => {
    const state = swipeRef.current;
    if (!state || state.pointerId !== event.pointerId) return false;
    // A long-press that already fired (select mode, a range drag) owns the touch.
    if (!state.active && (drag.current || live.current.selection.size > 0)) {
      swipeRef.current = null;
      return false;
    }
    const move = state.gesture.move(event.clientX, event.clientY, performance.now());
    if (move.phase === "ignored") {
      if (!state.active) swipeRef.current = null;
      return false;
    }
    if (move.phase === "pending") return false;
    if (!state.active) {
      state.active = true;
      // Sideways is a swipe and never a long-press.
      clearLongPress();
      longPress.current.up();
      state.row.style.transition = "none";
      state.row.style.willChange = "transform";
      // Rows are transparent over the list's surface; the backdrop must not show through.
      state.row.style.backgroundColor = "var(--wn-surface)";
      setSwiping({ id: state.id, actions: state.actions });
    }
    if (move.armed && !state.armed) navigator.vibrate?.(10);
    state.armed = move.armed;
    paintSwipe(move.offset, move.direction, move.armed);
    return true;
  };

  /** The finger came up (`commit`) or the touch was taken away (not). */
  const endSwipe = (event: React.PointerEvent, commit: boolean): boolean => {
    const state = swipeRef.current;
    if (!state || state.pointerId !== event.pointerId) return false;
    swipeRef.current = null;
    if (!state.active) return false;
    // A swipe never ends in a tap: no open, no sender menu.
    suppressClick.current = true;
    const direction = commit ? state.gesture.release() : null;
    const action = direction ? state.actions[direction] : null;
    const reduce = prefersReducedMotion();
    const { row, item, id } = state;
    const onAction = live.current.swipe?.onAction;
    swipeBusy.current = true;
    const done = () => {
      swipeBusy.current = false;
      setSwiping((current) => (current?.id === id ? null : current));
    };

    if (!action || !onAction) {
      // Spring back. With reduced motion, simply back.
      row.style.transition = reduce ? "none" : `transform ${SWIPE_BACK_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1.15)`;
      row.style.transform = "translate3d(0, 0, 0)";
      window.setTimeout(() => {
        clearSwipeStyles(row, item);
        done();
      }, reduce ? 0 : SWIPE_BACK_MS);
      return true;
    }

    if (!removesRow(action)) {
      // Read or unread: toggled now, and the row snaps back showing it.
      onAction(id, action);
      row.style.transition = reduce ? "none" : `transform ${SWIPE_BACK_MS}ms cubic-bezier(0.2, 0.9, 0.3, 1)`;
      row.style.transform = "translate3d(0, 0, 0)";
      window.setTimeout(() => {
        clearSwipeStyles(row, item);
        done();
      }, reduce ? 0 : SWIPE_BACK_MS);
      return true;
    }

    // Trash, Discard, Restore: the row leaves the way it was going, its space closes,
    // and then the store takes it out. Whatever is still on screen after that (an
    // action that was refused, a thread with another message) is put back.
    const finish = () => {
      onAction(id, action);
      window.setTimeout(() => {
        if (row.isConnected) clearSwipeStyles(row, item);
        done();
      }, 50);
    };
    if (reduce) {
      finish();
      return true;
    }
    const sign = direction === "left" ? -1 : 1;
    row.style.transition = `transform ${SWIPE_OUT_MS}ms ease-out`;
    row.style.transform = `translate3d(${sign * (state.width + 16)}px, 0, 0)`;
    window.setTimeout(() => {
      item.style.height = `${item.offsetHeight}px`;
      // Read back so the height above is the starting value of the transition.
      void item.offsetHeight;
      item.style.transition = `height ${SWIPE_COLLAPSE_MS}ms ease-in`;
      item.style.height = "0px";
      window.setTimeout(finish, SWIPE_COLLAPSE_MS);
    }, SWIPE_OUT_MS);
    return true;
  };

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
    // The top edge that scrolls is the floating chrome's bottom, where the rows show.
    const speed = edgeScrollSpeed(y, box.top + topInset, box.bottom);
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
    startSwipe(event, target);
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
      // Held still long enough to select: this touch is no longer a swipe.
      if (swipeRef.current && !swipeRef.current.active) swipeRef.current = null;
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
    if (moveSwipe(event)) return;
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
    if (endSwipe(event, event.type === "pointerup")) {
      clearLongPress();
      longPress.current.up();
      return;
    }
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
    // A swipe that has locked sideways keeps the list still under it.
    else if (swipeRef.current?.active && event.cancelable) event.preventDefault();
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

  const emptyKind = emptyKindFor(emptyReason, emptyContext);
  // Keyed on the view, so leaving an emptied filter for another view never plays it.
  const celebrating = useClearCelebration(viewKey(emptyContext), threads.length, touchSelect) &&
    emptyKind?.kind === "clear";

  if (threads.length === 0) {
    const empty = (
      <Empty
        reason={emptyReason}
        onClearFilters={onClearFilters}
        onClearSearch={onClearSearch}
        onSync={onSync}
        canSync={canSync}
        emptyMailbox={emptyMailbox}
        kind={emptyKind}
        now={now}
        celebrating={celebrating}
      />
    );
    if (topInset === 0 && !lead) return empty;
    // Under floating chrome: start below it, the lead (briefing) still on top.
    return (
      <div
        data-list-empty=""
        className="flex min-h-0 flex-1 flex-col"
        style={{ "--wn-top-chrome": `${band}px`, paddingTop: "var(--wn-top-chrome)" } as React.CSSProperties}
      >
        {lead}
        {empty}
      </div>
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
        // No scroll anchoring: the list places its own window (spacer + measured rows), and
        // the browser's anchoring fought it, snapping a programmatic or flung scroll back by
        // a few hundred px and, with reduced motion, flip-flopping between two offsets.
        className="thin-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain pb-4 [overflow-anchor:none]"
        // Under floating chrome: the rows start below it, and anything the browser
        // scrolls into view itself (Tab onto a row) stops below it and the pinned day.
        // `--wn-top-chrome` is the measured chrome (a ResizeObserver on it in the app) plus
        // the gap; `--wn-top-clear` adds the first day's height, which the pinned day covers.
        style={
          band > 0
            ? ({
                "--wn-top-chrome": `${band}px`,
                "--wn-top-clear": `${coveredTop + TOP_GAP}px`,
                paddingTop: "var(--wn-top-chrome)",
                scrollPaddingTop: "var(--wn-top-clear)",
              } as React.CSSProperties)
            : undefined
        }
      >
      {lead && (
        <div ref={measureLead} data-list-lead="">
          {lead}
        </div>
      )}
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
          data-swipe-enabled={swipe ? "" : undefined}
          className="absolute inset-x-0 top-0 px-1.5"
          style={{
            transform: `translateY(${offsets[start] ?? 0}px)`,
            // With swipes on, the browser pans vertically and leaves sideways motion to
            // the list, so a swipe never gets cancelled by a horizontal pan or Chrome's
            // overscroll navigation. Pinch zoom is untouched.
            touchAction: swipe ? "pan-y pinch-zoom" : undefined,
          }}
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
              key={run.key}
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
                const swipedHere = swiping?.id === email.id;
                return (
                  <div
                    role="listitem"
                    key={item.key}
                    data-item-key={item.key}
                    ref={observeItem}
                    // Only while its row is swiped: the clip would otherwise cut the star's
                    // touch target, which reaches a little past the row.
                    className={swipedHere ? "relative overflow-hidden rounded-pane" : undefined}
                  >
                    {swipedHere && <SwipeBackdrop actions={swiping.actions} />}
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
      {stickyHeader &&
        (topInset > 0 ? (
          /*
            Under floating chrome there is no strip at all: an opaque band here (and the
            fade that softened its top edge) was a wall the mail stopped at, right under
            the glass. The day rides in its own small glass pill instead, at the sender
            column, and the rows run under it and on up under the bar.
          */
          <div
            data-sticky-day=""
            data-floating=""
            className="pointer-events-none absolute inset-x-0 z-10 px-1.5 pl-[56px] pt-1"
            style={{ top: topInset }}
          >
            <span className="wn-glass inline-flex h-7 items-center gap-2 rounded-full px-3 text-meta">
              <span className="font-semibold text-ink-muted">{stickyHeader.label}</span>
              <span className="tabular-nums text-ink-subtle">{stickyHeader.count}</span>
            </span>
          </div>
        ) : (
          <div data-sticky-day="" className="wn-backdrop pointer-events-none absolute inset-x-0 top-0 z-10 px-1.5">
            <SectionHeader label={stickyHeader.label} count={stickyHeader.count} />
          </div>
        ))}
    </div>
  );
}

export default memo(MessageList);
