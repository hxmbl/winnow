import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { formatRowTime, groupByDay, type DayBucket } from "../inbox/time";
import type { RelayEmail } from "../inbox/types";

function displayName(email: RelayEmail): string {
  if (email.name) return email.name;
  return email.sender.includes("@") ? email.sender.split("@")[0] : email.sender;
}

function initials(email: RelayEmail): string {
  const source = displayName(email).trim();
  return source.charAt(0).toUpperCase();
}

type RowProps = {
  email: RelayEmail;
  bucket: DayBucket;
  selected: boolean;
  onSelect: (id: number) => void;
};

/**
 * Memoised so selecting a message only re-renders the two rows whose `selected`
 * flips.
 *
 * Three lines, ragged right, no rules between rows — the section headers do the
 * separating. A border on every row is what made the old list read as one long
 * ruled table rather than as a list of messages.
 */
const Row = memo(function Row({ email, bucket, selected, onSelect }: RowProps) {
  return (
    <button
      type="button"
      data-email-id={email.id}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(email.id)}
      className={`flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring ${
        selected
          ? "bg-surface-active"
          : "hover:bg-surface-hover"
      }`}
    >
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-avatar text-[13px] font-semibold text-ink-subtle">
        {initials(email)}
      </span>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[13.5px] font-semibold leading-snug text-ink">
            {displayName(email)}
          </span>
          <span className="shrink-0 text-[11.5px] tabular-nums leading-snug text-ink-subtle">
            {formatRowTime(email.receivedAt, bucket)}
          </span>
        </span>

        <span className="mt-px block truncate text-[13.5px] font-medium leading-snug text-ink-body">
          {email.subject}
        </span>

        {email.body && (
          <span className="mt-px block truncate text-[12.5px] leading-snug text-ink-muted">
            {email.body}
          </span>
        )}
      </span>
    </button>
  );
});

/**
 * Sticky, so it stays legible while its section scrolls under it. `px-4` lines
 * the label up with the avatar edge below it — the label describes the rows,
 * so it should sit where the rows start.
 */
function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="sticky top-0 z-10 flex items-baseline gap-2 bg-surface px-4 pb-1.5 pt-4">
      <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-subtle">
        {label}
      </span>
      <span className="text-[11px] tabular-nums text-ink-subtle/70">{count}</span>
    </div>
  );
}

type Props = {
  emails: RelayEmail[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  /** Reference instant for the day sections. See `dayBucket`. */
  now: number;
  className?: string;
};

function EmailList({ emails, selectedId, onSelect, now, className = "" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => groupByDay(emails, now), [emails, now]);

  useEffect(() => {
    if (selectedId == null) return;
    const row =
      containerRef.current?.querySelector<HTMLElement>(
        `[data-email-id="${selectedId}"]`,
      ) ?? null;
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const handleSelect = useCallback(
    (id: number) => onSelect(id),
    [onSelect],
  );

  if (emails.length === 0) {
    return (
      <div
        className={`flex min-h-0 flex-1 items-center justify-center bg-surface px-6 text-sm text-ink-subtle ${className}`}
      >
        No messages match the current search or filters.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain bg-surface pb-4 ${className}`}
    >
      {groups.map(({ bucket, label, emails: rows }) => (
        <section key={bucket}>
          <SectionHeader label={label} count={rows.length} />
          <div className="flex flex-col gap-0.5 px-1.5">
            {rows.map((email) => (
              <Row
                key={email.id}
                email={email}
                bucket={bucket}
                selected={email.id === selectedId}
                onSelect={handleSelect}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export default memo(EmailList);