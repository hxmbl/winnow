/**
 * "Pick date & time…" for snooze and send later: a small dialog with a date and a time
 * field in the user's local time, the time said back in words as it is picked, and a
 * refusal in place for a time that has already passed.
 *
 * Native `<input type="date">` and `type="time"`, so each platform shows its own picker
 * (the Android wheel, the desktop calendar) and the values are plain local strings
 * (`core/mail/when.ts` turns them into an instant).
 */

import { useId, useRef, useState } from "react";
import { Sheet } from "./Overlay";
import { customTimeProblem, formatWhen, fromLocalInputs, toLocalInputs } from "../../core/mail/when";
import { buttonClass } from "../button";

type Props = {
  /** "Snooze until…", "Send later…". */
  title: string;
  /** One line under the title (send later's "Winnow has to be open…"). */
  note?: string;
  /** Where the fields start. */
  initial: number;
  confirmLabel: string;
  onConfirm: (at: number) => void;
  onCancel: () => void;
  /** The clock, injected for the "in the past" check. */
  now?: () => number;
};

const FIELD =
  "min-h-10 w-full rounded-ctl border border-control-border bg-surface px-3.5 py-1.5 text-ui text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring";

export function WhenPicker({ title, note, initial, confirmLabel, onConfirm, onCancel, now = Date.now }: Props) {
  const start = toLocalInputs(initial);
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [tried, setTried] = useState(false);
  const dateRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const at = fromLocalInputs(date, time);
  const problem = customTimeProblem(at, now());

  const confirm = () => {
    if (problem !== null || at === null) {
      setTried(true);
      return;
    }
    onConfirm(at);
  };

  return (
    <Sheet
      label={title}
      onClose={onCancel}
      onEscape={onCancel}
      dismissOnBackdrop={false}
      initialFocus={dateRef}
      className="w-full max-w-sheet-sm rounded-pane border border-hairline bg-chrome p-5 shadow-lift"
    >
      <form
        data-when-picker=""
        // Our own refusal, in words, rather than the browser's tooltip for `min`.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        <h2 className="text-read font-semibold text-ink">{title}</h2>
        {note && <p className="mt-1.5 text-meta leading-relaxed text-ink-muted">{note}</p>}
        <div className="mt-4 grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-meta font-medium text-ink-muted" htmlFor={`${id}-date`}>
            Date
            <input
              ref={dateRef}
              id={`${id}-date`}
              data-when-date=""
              type="date"
              value={date}
              min={toLocalInputs(now()).date}
              onChange={(event) => setDate(event.target.value)}
              className={FIELD}
            />
          </label>
          <label className="flex flex-col gap-1 text-meta font-medium text-ink-muted" htmlFor={`${id}-time`}>
            Time
            <input
              id={`${id}-time`}
              data-when-time=""
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className={FIELD}
            />
          </label>
        </div>
        <p
          aria-live="polite"
          data-when-summary=""
          className={`mt-2 min-h-5 text-meta ${tried && problem ? "font-medium text-danger" : "text-ink-subtle"}`}
        >
          {tried && problem ? problem : at !== null && !problem ? formatWhen(at, now()) : ""}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className={buttonClass("secondary")}
          >
            Cancel
          </button>
          <button
            type="submit"
            data-when-confirm=""
            className={buttonClass("primary")}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** A Scheduled row, opened: what goes, to whom and when, and the three things to do with it. */
export function ScheduledSheet({
  subject,
  to,
  when,
  problem,
  body,
  onEdit,
  onSendNow,
  onCancelSchedule,
  onClose,
}: {
  subject: string;
  to: string;
  when: string;
  problem?: string;
  body: string;
  onEdit: () => void;
  onSendNow: () => void;
  onCancelSchedule: () => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const BUTTON =
    buttonClass("secondary");
  return (
    <Sheet
      label={`Scheduled: ${subject || "(no subject)"}`}
      onClose={onClose}
      onEscape={onClose}
      initialFocus={closeRef}
      className="w-full max-w-sheet-md rounded-pane border border-hairline bg-chrome p-5 shadow-lift"
    >
      <div data-scheduled-sheet="">
        <p className="text-meta font-medium text-ink-muted">{problem ? "Not sent" : `Sends ${when}`}</p>
        <h2 className="mt-1 text-read font-semibold text-ink">{subject || "(no subject)"}</h2>
        <p className="mt-0.5 truncate text-ui text-ink-muted">To {to || "nobody yet"}</p>
        {problem && (
          <p role="alert" className="mt-2 text-meta font-medium text-danger">
            {problem}
          </p>
        )}
        <p className="thin-scroll mt-3 max-h-40 overflow-y-auto whitespace-pre-wrap text-ui text-ink-body">{body.trim() || "(empty)"}</p>
        <p className="mt-3 text-meta leading-relaxed text-ink-subtle">
          Winnow sends it from this device: if Winnow is closed at that time, it goes the next time you open it.
        </p>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button ref={closeRef} type="button" onClick={onClose} className={BUTTON}>
            Close
          </button>
          <button type="button" data-scheduled-cancel="" onClick={onCancelSchedule} className={BUTTON}>
            Cancel schedule
          </button>
          <button type="button" data-scheduled-edit="" onClick={onEdit} className={BUTTON}>
            Edit
          </button>
          <button
            type="button"
            data-scheduled-send=""
            onClick={onSendNow}
            className={buttonClass("primary")}
          >
            Send now
          </button>
        </div>
      </div>
    </Sheet>
  );
}
