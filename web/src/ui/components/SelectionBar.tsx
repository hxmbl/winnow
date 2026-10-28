/**
 * The batch action bar for a multi-row selection.
 *
 * On the desktop it takes the place of the triage line above the list while anything is
 * selected; on a phone it replaces the top bar (select mode), at thumb size, with Cancel
 * where the mark was. Same verbs in both: archive (whatever that means in this mailbox),
 * delete, read or unread, move to another mailbox, and clear.
 */

import { useRef, useState } from "react";
import { AlarmClock, AlarmClockOff, Archive, ArchiveRestore, FolderInput, ListFilter, MailMinus, MailOpen, Trash2, X } from "lucide-react";
import type { Mailbox } from "../../core/model/email";
import { MAILBOX_LABEL } from "../../core/model/email";
import { archiveLabel, moveTargets } from "../menus";
import { Menu } from "./Menu";
import { anchorFromElement, type MenuAnchor } from "../menuPlacement";
import { Icon, type IconSize } from "./Icon";

type Props = {
  count: number;
  mailbox: Mailbox;
  anyUnread: boolean;
  phone: boolean;
  onArchive: () => void;
  onTrash: () => void;
  onSetRead: (read: boolean) => void;
  onMove: (mailbox: Mailbox) => void;
  /** "Change smart filters…" for the selection. Absent outside the inbox. */
  onChangeFilters?: () => void;
  /** Open the snooze choices beside `trigger`. Absent where snoozing means nothing. */
  onSnooze?: (trigger: HTMLElement) => void;
  onClear: () => void;
};

export function SelectionBar({
  count,
  mailbox,
  anyUnread,
  phone,
  onArchive,
  onTrash,
  onSetRead,
  onMove,
  onChangeFilters,
  onSnooze,
  onClear,
}: Props) {
  const archive = archiveLabel(mailbox);
  // Scheduled sends are not mail yet: the one thing to do with several is cancel them.
  const scheduled = mailbox === "scheduled";
  const trashText = scheduled ? "Cancel schedule" : mailbox === "trash" ? "Delete forever" : "Delete";
  const moveButton = useRef<HTMLButtonElement>(null);
  const [moveAnchor, setMoveAnchor] = useState<MenuAnchor | null>(null);

  const button = phone
    ? "flex h-11 w-11 shrink-0 items-center justify-center rounded-ctl text-ink-icon transition-colors active:bg-surface-active focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
    : "flex h-8 shrink-0 items-center gap-1.5 rounded-ctl px-2.5 text-meta font-medium text-ink-body transition-colors hover:bg-sheen hover:text-ink focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring";
  const iconSize: IconSize = phone ? 20 : 16;
  const label = (text: string) => (phone ? <span className="sr-only">{text}</span> : <span>{text}</span>);

  return (
    <div
      role="toolbar"
      aria-label={`${count} selected`}
      data-selection-bar={phone ? "phone" : "desktop"}
      className={
        phone
          ? "relative z-30 flex shrink-0 items-center gap-1 px-2 pb-1.5 pt-[max(0.5rem,env(safe-area-inset-top))]"
          : // The desktop's, floating in the list's header in the chips' place: the
            // same glass as the bar above it.
            "wn-glass wn-glass-bar wn-glass-behind pointer-events-auto flex h-10 min-w-0 flex-1 items-center gap-1 rounded-ctl px-1.5"
      }
    >
      <button type="button" onClick={onClear} aria-label="Clear selection" title="Clear selection (Esc)" className={phone ? button : `${button} px-2`}>
        <Icon icon={X} size={iconSize} />
      </button>
      <span
        aria-live="polite"
        data-selection-count={count}
        className={`min-w-0 truncate pl-1 pr-2 tabular-nums text-ink ${phone ? "text-read font-semibold" : "text-ui font-semibold"}`}
      >
        {count} selected
      </span>
      <span className="flex-1" />
      {archive && (
        <button type="button" onClick={onArchive} aria-label={phone ? archive.label : undefined} className={button}>
          {mailbox === "snoozed" ? (
            <Icon icon={AlarmClockOff} size={iconSize} />
          ) : archive.restore ? (
            <Icon icon={ArchiveRestore} size={iconSize} />
          ) : (
            <Icon icon={Archive} size={iconSize} />
          )}
          {label(archive.label)}
        </button>
      )}
      {onSnooze && (
        <button
          type="button"
          data-selection-snooze=""
          aria-haspopup="menu"
          onClick={(event) => onSnooze(event.currentTarget)}
          aria-label={phone ? "Snooze" : undefined}
          title="Snooze (b)"
          className={button}
        >
          <Icon icon={AlarmClock} size={iconSize} />
          {label("Snooze")}
        </button>
      )}
      <button
        type="button"
        onClick={onTrash}
        aria-label={phone ? trashText : undefined}
        data-destructive={mailbox === "trash" ? "" : undefined}
        className={`${button} ${mailbox === "trash" ? "text-danger!" : ""}`}
      >
        {scheduled ? <Icon icon={AlarmClockOff} size={iconSize} /> : <Icon icon={Trash2} size={iconSize} />}
        {label(trashText)}
      </button>
      {!scheduled && (
      <button
        type="button"
        onClick={() => onSetRead(anyUnread)}
        aria-label={phone ? (anyUnread ? "Mark read" : "Mark unread") : undefined}
        className={button}
      >
        {anyUnread ? <Icon icon={MailOpen} size={iconSize} /> : <Icon icon={MailMinus} size={iconSize} />}
        {label(anyUnread ? "Mark read" : "Mark unread")}
      </button>
      )}
      {!scheduled && (
      <button
        ref={moveButton}
        type="button"
        aria-haspopup="menu"
        aria-expanded={moveAnchor !== null}
        aria-label={phone ? "Move to" : undefined}
        onClick={(event) => setMoveAnchor(anchorFromElement(event.currentTarget))}
        className={button}
      >
        <Icon icon={FolderInput} size={iconSize} />
        {label("Move to")}
      </button>
      )}
      {onChangeFilters && (
        <button
          type="button"
          data-selection-filters=""
          onClick={onChangeFilters}
          aria-label={phone ? "Change smart filters" : undefined}
          title="Change smart filters…"
          className={button}
        >
          <Icon icon={ListFilter} size={iconSize} />
          {label("Filters")}
        </button>
      )}
      {moveAnchor && (
        <Menu
          label="Move to"
          testId="move"
          anchor={moveAnchor}
          returnFocus={moveButton.current}
          onClose={() => setMoveAnchor(null)}
          items={moveTargets(mailbox).map((target) => ({
            kind: "item" as const,
            id: `move-${target}`,
            label: MAILBOX_LABEL[target],
            onSelect: () => onMove(target),
          }))}
        />
      )}
    </div>
  );
}
