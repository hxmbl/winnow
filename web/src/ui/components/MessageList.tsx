/**
 * The message list.
 *
 * Three lines a row, ragged right, no rules between rows — the section headers
 * do the separating. A border on every row is what made an earlier version read
 * as one long ruled table rather than as a list of messages.
 *
 * The row is the densest thing in the app and it has to earn that. Sender,
 * subject and preview in three lines, with the timestamp right-aligned on the
 * first. Each line truncates independently, so a long subject never pushes the
 * preview out of the row.
 *
 * Rows are memoised on exactly the four things that change their appearance, so
 * selecting a message re-renders two rows rather than a thousand. The
 * alternative — letting the list re-render and hoping React's reconciliation is
 * cheap enough — was measurably not, once the inbox passed a few hundred rows.
 */

import { memo, useEffect, useRef } from "react";
import { formatRowTime, groupByDay, type DayBucket } from "../../core/mail/datetime";
import { displayName, monogram } from "../../core/model/email";
import { rowIndicators, type EmailSignals } from "../../core/model/signals";
import { avatarColor, avatarTextColor } from "../avatarColor";
import { hexA, FILTER_PILLS } from "../filterColors";
import type { ThreadRow } from "../../core/classify/pipeline";

type RowProps = {
  row: ThreadRow;
  signals: EmailSignals;
  bucket: DayBucket;
  selected: boolean;
  unread: boolean;
  /** True for a message that arrived in the last sync. */
  fresh: boolean;
  onSelect: (id: number) => void;
  onToggleStar: (id: number) => void;
};

/**
 * The row indicators: the buckets that change how a row is *judged*, with the
 * category buckets dropped. The list is scanned, not read — six chips on a row
 * turns a scannable list into a wall.
 */
function Indicator({ id }: { id: string }) {
  const pill = FILTER_PILLS[id as keyof typeof FILTER_PILLS];
  return (
    <span
      aria-hidden="true"
      className="h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: hexA(pill.solid, 0.7) }}
    />
  );
}

const Row = memo(function Row({
  row,
  signals,
  bucket,
  selected,
  unread,
  fresh,
  onSelect,
  onToggleStar,
}: RowProps) {
  const email = row.representative;
  const indicators = rowIndicators(signals);

  return (
    <div
      className={`group/row relative flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
        selected ? "bg-surface-active" : "hover:bg-surface-hover"
      }`}
    >
      {/*
        The row is a button, but the star is a second button inside it — which is
        invalid HTML and breaks keyboard navigation. So the row is a `div` with
        `role="button"`, and the two are siblings. `aria-current` rather than
        `aria-selected`, because the listbox pattern needs a `listbox` parent and
        this list is a simple set of choices.
      */}
      <button
        type="button"
        data-message-id={email.id}
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(email.id)}
        className="flex min-w-0 flex-1 items-start gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold"
          style={{
            background: avatarColor(email.sender),
            color: avatarTextColor(email.sender),
          }}
        >
          {monogram(email)}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5">
              {/* Unread is a weight, not a dot. A dot is a thing Gmail invented
                  and users have to learn; weight is how print has always
                  signalled it, and it survives a screenshot. */}
              <span
                className={`truncate text-row ${
                  unread ? "font-bold text-ink" : "font-semibold text-ink"
                }`}
              >
                {displayName(email)}
              </span>
              {row.messageCount > 1 && (
                <span className="shrink-0 rounded-full bg-surface-sunken px-1.5 text-[11px] font-semibold tabular-nums text-ink-muted">
                  {row.messageCount}
                </span>
              )}
              {fresh && (
                <span
                  aria-label="New"
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
                />
              )}
            </span>
            <span className="shrink-0 text-tiny tabular-nums leading-snug text-ink-subtle">
              {formatRowTime(email.receivedAt, bucket)}
            </span>
          </span>

          <span
            className={`mt-px block truncate text-row ${
              unread ? "font-semibold text-ink-body" : "font-medium text-ink-body"
            }`}
          >
            {email.subject || "(no subject)"}
          </span>

          {email.body && (
            <span className="mt-px block truncate text-preview text-ink-muted">
              {email.body}
            </span>
          )}

          {indicators.length > 0 && (
            <span className="mt-1 flex items-center gap-1">
              {indicators.map((id) => (
                <Indicator key={id} id={id} />
              ))}
            </span>
          )}
        </span>
      </button>

      {/* The star, revealed on hover but always reachable by keyboard. */}
      <button
        type="button"
        onClick={() => onToggleStar(email.id)}
        aria-label={email.starred ? "Unstar" : "Star"}
        aria-pressed={email.starred}
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-subtle opacity-0 transition-opacity hover:bg-surface-active hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring group-hover/row:opacity-100 aria-pressed:opacity-100"
      >
        <svg viewBox="0 0 24 24" width={14} height={14} aria-hidden="true" fill={email.starred ? "currentColor" : "none"} stroke="currentColor" strokeWidth={1.9} className={email.starred ? "text-[#B8860B]" : ""}>
          <path d="m12 3 2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-2.9-5.3 2.9 1.1-6L3.4 9.4l6-.8Z" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
});

/**
 * Sticky, so it stays legible while its section scrolls under it.
 *
 * The label is aligned to the avatar edge below it, because the label describes
 * the rows and should sit where the rows start.
 */
function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-baseline gap-2 bg-surface px-4 pb-1.5 pt-4">
      <span className="text-micro font-semibold uppercase tracking-[0.07em] text-ink-subtle">
        {label}
      </span>
      <span className="text-micro tabular-nums text-ink-subtle">{count}</span>
    </div>
  );
}

export type EmptyState = {
  reason: "search" | "filters" | "unsafe" | "mailbox" | null;
  onClearFilters: () => void;
  onClearSearch: () => void;
};

/**
 * The empty state, which says *why* rather than just reporting emptiness.
 *
 * "No messages match" is not actionable. "Nothing matches these two filters —
 * [clear them]" tells the user what to do about it, and the three reasons are
 * genuinely different problems with genuinely different fixes.
 */
function Empty({ reason, onClearFilters, onClearSearch }: EmptyState) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-surface px-6 text-center">
      <p className="text-[13.5px] text-ink-muted">
        {reason === "search" && "Nothing matches that search."}
        {reason === "filters" && "Nothing matches those filters."}
        {reason === "unsafe" && "Every message here is in a bucket you've hidden."}
        {reason === "mailbox" && "This mailbox is empty."}
      </p>
      {(reason === "search" || reason === "filters") && (
        <button
          type="button"
          onClick={reason === "search" ? onClearSearch : onClearFilters}
          className="rounded-full border border-control-border px-3.5 py-1.5 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {reason === "search" ? "Clear search" : "Clear filters"}
        </button>
      )}
    </div>
  );
}

type Props = {
  threads: ThreadRow[];
  signals: ReadonlyMap<number, EmailSignals>;
  selectedId: number | null;
  cursorIndex: number;
  unreadIds: ReadonlySet<number>;
  freshIds: ReadonlySet<number>;
  emptyReason: EmptyState["reason"];
  onSelect: (id: number) => void;
  onToggleStar: (id: number) => void;
  onClearFilters: () => void;
  onClearSearch: () => void;
  /** Reference instant for the day sections. */
  now: number;
  className?: string;
};

function MessageList({
  threads,
  signals,
  selectedId,
  cursorIndex,
  unreadIds,
  freshIds,
  emptyReason,
  onSelect,
  onToggleStar,
  onClearFilters,
  onClearSearch,
  now,
  className = "",
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Group by day, but on the *representative* message's date, since that is the
  // date the row displays.
  const groups = groupByDay(
    threads.map((row) => ({ row, receivedAt: row.representative.receivedAt })),
    now,
  );

  /**
   * Keep the cursor's row in view.
   *
   * `block: "nearest"` matters: `"center"` would yank the list on every `j`
   * press, which in a keyboard-driven client is unusable. And this follows the
   * *cursor* rather than the selection, because `j` moves the cursor without
   * opening anything, and a list that does not follow the cursor is a list you
   * cannot navigate blind.
   */
  useEffect(() => {
    if (cursorIndex < 0) return;
    const rows = containerRef.current?.querySelectorAll<HTMLElement>("[data-message-id]");
    rows?.[cursorIndex]?.scrollIntoView({ block: "nearest" });
  }, [cursorIndex, threads]);

  if (threads.length === 0) {
    return (
      <Empty
        reason={emptyReason}
        onClearFilters={onClearFilters}
        onClearSearch={onClearSearch}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className={`thin-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-surface pb-4 ${className}`}
    >
      {groups.map(({ bucket, label, rows }) => (
        <section key={bucket}>
          <SectionHeader label={label} count={rows.length} />
          <div className="flex flex-col gap-0.5 px-1.5">
            {rows.map(({ row }) => {
              const email = row.representative;
              const signalsForRow = signals.get(email.id);
              // A row whose signals are missing is not rendered at all: the
              // classifier runs over the whole mailbox before anything is
              // shown, so a miss here means the message left the list between
              // the two passes, and an empty row would be worse than none.
              if (!signalsForRow) return null;
              return (
                <Row
                  key={row.key}
                  row={row}
                  signals={signalsForRow}
                  bucket={bucket}
                  selected={email.id === selectedId}
                  unread={unreadIds.has(email.id)}
                  fresh={freshIds.has(email.id)}
                  onSelect={onSelect}
                  onToggleStar={onToggleStar}
                />
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export default memo(MessageList);
