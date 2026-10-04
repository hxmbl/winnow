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
import { daySections, formatRowTime, type DayBucket } from "../../core/mail/datetime";
import { displayName, monogram } from "../../core/model/email";
import { rowIndicators, type EmailSignals } from "../../core/model/signals";
import { avatarColor, avatarTextColor } from "../avatarColor";
import { hexA, FILTER_PILLS } from "../filterColors";
import type { SortBy } from "../../core/classify/scoring";
import type { EmptyReason, ThreadRow } from "../../core/classify/pipeline";

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
  const indicators = rowIndicators(email, signals);

  return (
    <div
      className={`group/row relative flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors ${
        selected ? "bg-surface-active" : "hover:bg-surface-hover"
      }`}
    >
      {/*
        The row is a `<button>`, and the star is its *sibling*.

        Both were correct at different times and the comment above outlived the change:
        an earlier version put the star inside the row button, which is invalid HTML and
        breaks keyboard navigation entirely. That was fixed by making the row a
        `div[role=button]` with two sibling buttons — and this is now a real `<button>`
        again, so it is focusable, works with Space, and is announced as a button
        without a role to be interpreted.

        `aria-current="true"` rather than `aria-selected`, because the selected option of
        a listbox needs a `listbox` parent and this list is a set of independent
        choices, not a single-select list.
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

      {/*
        The star.

        Visible on hover, on keyboard focus, and *always* on a device with no hover.

        `opacity-0` with reveal-on-hover was the rule, and it produced a 24px invisible
        tappable target on every touch device — a control you could hit by accident and
        could not aim at. `@media (hover: hover)` scopes the hiding to the devices that
        actually have a pointer to hover with, so a phone shows it outright and a mouse
        still gets a quiet list.
      */}
      <button
        type="button"
        onClick={() => onToggleStar(email.id)}
        aria-label={email.starred ? "Unstar" : "Star"}
        aria-pressed={email.starred}
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-ink-subtle transition-opacity hover:bg-surface-active hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring group-hover/row:opacity-100 aria-pressed:opacity-100 not-[[hover:hover]]:opacity-0"
      >
        {/*
          The star is a sprite rather than a lucide icon so that the filled and outline
          states are the same shape at the same weight — a star that gains a stroke
          weight when you fill it does not read as the same object turning on.

          The colour comes from `--wn-badge-starred`, the same token the reader's badge
          and the palette use. It was a literal `#B8860B`, which meant the star's colour
          could not follow the theme and had to be changed in two places whenever it did.
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
  reason: EmptyReason;
  onClearFilters: () => void;
  onClearSearch: () => void;
  onSync: () => void;
  canSync: boolean;
};

/**
 * The empty state, which says *why* rather than just reporting emptiness.
 *
 * "No messages match" is not actionable. "Nothing matches these two filters —
 * [clear them]" tells the user what to do about it, and the three reasons are
 * genuinely different problems with genuinely different fixes.
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
   * Three of them used to print text with no button, because only `search` and
   * `filters` had an action attached — so "This mailbox is empty." sat there with
   * nothing to do even where something *could* be done, and `noSignal` — the one a
   * user hits by accident, having archived everything in a bucket and watched it go
   * quiet — explained nothing at all.
   *
   * `mailbox` is the only case where the remedy is not about narrowing, and it is
   * also the only one that depends on something outside the list: there is an
   * account to sync with, or there is not. Which is why `canSync` is a prop rather
   * than a constant — offering "Check for new mail" over the demo mailbox would be a
   * button that cannot do anything.
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
      case "hidden":
        return {
          body: "Everything here is in a bucket you have hidden.",
          action: { label: "Show everything", run: onClearFilters },
        };
      case "noSignal":
        return {
          body: "Winnow is holding every message here back as likely junk.",
          action: { label: "Show the hidden mail", run: onClearFilters },
        };
      case "mailbox":
        return {
          body: "There is nothing in this mailbox yet.",
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
          <p className="max-w-[26rem] text-[13.5px] text-ink-muted">{remedy.body}</p>
          {remedy.action && (
            <button
              type="button"
              onClick={remedy.action.run}
              className="rounded-full border border-control-border px-3.5 py-1.5 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {remedy.action.label}
            </button>
          )}
        </>
      ) : (
        // `emptyReason` is null only when the list is non-empty, so this branch is
        // unreachable — but an empty screen with no explanation is worse than a
        // wrong one, so it says something.
        <p className="text-[13.5px] text-ink-muted">Nothing to show.</p>
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
  /**
   * The list's order, which decides whether day sections mean anything.
   *
   * Only a date-sorted list can group by day; the other two sorts interleave the
   * days, and labelling that interleaving produced a duplicate React key on every
   * repeated section. See `daySections`.
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
  sortBy,
  onSelect,
  onToggleStar,
  onClearFilters,
  onClearSearch,
  onSync,
  canSync,
  now,
  className = "",
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Day sections, on the *representative* message's date, since that is the date the
  // row displays. One flat section unless the sort is chronological.
  const sections = daySections(
    threads,
    now,
    (row) => row.representative.receivedAt,
    sortBy === "date",
  );

  /**
   * Keep the cursor's row in view.
   *
   * `block: "nearest"` matters: `"center"` would yank the list on every `j`
   * press, which in a keyboard-driven client is unusable. And this follows the
   * *cursor* rather than the selection, because `j` moves the cursor without
   * opening anything, and a list that does not follow the cursor is a list you
   * cannot navigate blind.
   *
   * The dependency is the *cursor index*, not `threads`. `threads` is a fresh array on
   * every derive, so it was in the dependency list and this effect therefore ran on
   * every store change — including the 80ms debounced reclassify after a weight tweak
   * and every background sync. The visible symptom was a user who had scrolled away
   * from the cursor being yanked back to it every few seconds while reading.
   *
   * The count is included because it is the other way this can go wrong: the cursor
   * index stays put while the list *shrinks* under it, and the row that needs following
   * is now a different one. Following on a length change and on a cursor move covers
   * both without re-running on every unrelated update.
   */
  useEffect(() => {
    if (cursorIndex < 0) return;
    const rows = containerRef.current?.querySelectorAll<HTMLElement>("[data-message-id]");
    rows?.[cursorIndex]?.scrollIntoView({ block: "nearest" });
  }, [cursorIndex, threads.length]);

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
    <div
      ref={containerRef}
      className={`thin-scroll min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-surface pb-4 ${className}`}
    >
      {sections.map(({ key, label, rows }) => (
        /*
          Each day is its own `section` with an accessible name.

          The heading was purely visual before, so a screen reader heard one
          undifferentiated list of messages with no indication of where today ended and
          yesterday began — which is the single most useful thing the grouping
          communicates. `aria-label` on the section is what turns the visual header into
          a real boundary, and `role="list"`/`listitem` below it is what makes the
          count and the position in the list available to assistive tech.

          `label` is null for a sort that is not chronological, and then there is one
          section with no header: the boundary would be false, so the whole wrapper
          collapses to the list itself.
        */
        <section
          key={key}
          aria-label={label ? `${label}, ${rows.length} ${rows.length === 1 ? "message" : "messages"}` : undefined}
        >
          {label && <SectionHeader label={label} count={rows.length} />}
          <div role="list" className="flex flex-col gap-0.5 px-1.5">
            {rows.map(({ row, bucket }) => {
              const email = row.representative;
              const signalsForRow = signals.get(email.id);
              // A row whose signals are missing is not rendered at all: the classifier
              // runs over the whole mailbox before anything is shown, so a miss here
              // means the message left the list between the two passes, and an empty row
              // would be worse than none.
              if (!signalsForRow) return null;
              return (
                <div role="listitem" key={row.key}>
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
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

export default memo(MessageList);
