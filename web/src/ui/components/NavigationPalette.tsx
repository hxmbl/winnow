/**
 * The mailbox palette, on `!`.
 *
 * A four-row overlay rather than a permanent sidebar. The reasoning is about
 * frequency: a mail client is a full-window reading surface, and a permanent
 * folder rail permanently spends 200px of it on four destinations the user
 * visits deliberately rather than continuously. The palette costs nothing until
 * summoned, and `!` is two keys from anywhere.
 *
 * Archive is deliberately absent — the same reasoning as the Swift
 * implementation's. You go to Archive to look for something; you do not flip to
 * it while triaging, and a fifth row for it would dilute the four that matter.
 */

import { Inbox, Settings, Trash2, TriangleAlert } from "lucide-react";
import { NAVIGATION_ITEMS, type NavigationItem } from "../../core/model/signals";
import type { Mailbox } from "../../core/model/email";

const ICONS: Record<NavigationItem, typeof Inbox> = {
  inbox: Inbox,
  spam: TriangleAlert,
  trash: Trash2,
  settings: Settings,
};

type Props = {
  index: number;
  unread: Partial<Record<Mailbox, number>>;
  onActivate: (item: NavigationItem) => void;
  onClose: () => void;
};

export function NavigationPalette({ index, unread, onActivate, onClose }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/20 p-4 pt-24"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="menu"
        aria-label="Switch mailbox"
        onClick={(event) => event.stopPropagation()}
        className="animate-sheet w-full max-w-[280px] overflow-hidden rounded-pane border border-hairline bg-chrome p-1.5 shadow-lift"
      >
        {NAVIGATION_ITEMS.map((item, i) => {
          const Icon = ICONS[item.id];
          const active = i === index;
          const count = item.mailbox ? (unread[item.mailbox] ?? 0) : 0;

          return (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              // `aria-selected` is not valid on a menuitem; the highlighted row is
              // conveyed by the visual state and by the palette's own keyboard
              // handling, which announces nothing until activation.
              onClick={() => onActivate(item.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] transition-colors ${
                active ? "bg-surface-active text-ink" : "text-ink-body hover:bg-surface-hover"
              }`}
            >
              <Icon size={15} strokeWidth={1.9} className="shrink-0 text-ink-muted" aria-hidden="true" />
              <span className="flex-1 font-medium">{item.label}</span>
              {count > 0 && (
                <span className="rounded-full bg-surface-sunken px-1.5 text-[11px] font-semibold tabular-nums text-ink-muted">
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
