/**
 * The mailbox palette, on `!`.
 *
 * A small overlay rather than a permanent sidebar: a mail client is a full-window
 * reading surface, and a folder rail spends 200px of it on destinations the user visits
 * deliberately rather than continuously. The palette costs nothing until summoned.
 *
 * Archive is deliberately absent — you go to Archive to look for something, you do not
 * flip to it while triaging, and a sixth row would dilute the ones that matter. Sent is
 * here despite being the same kind of destination, because it is the one folder this app
 * has no other way into: it is what the composer's recipient suggestions are built from,
 * so being unable to read it would make a derived feature unauditable.
 *
 * **It is a `menu`, not a `dialog`:** the rows are destinations with a roving selection,
 * and `aria-activedescendant` is what makes it announce which row is highlighted.
 */

import { Inbox, Send, Settings, Trash2, TriangleAlert } from "lucide-react";
import { NAVIGATION_ITEMS, type NavigationItem } from "../../core/model/signals";
import { MAILBOX_LABEL, type Mailbox } from "../../core/model/email";
import { Sheet } from "./Overlay";

const ICONS: Record<NavigationItem, typeof Inbox> = {
  inbox: Inbox,
  spam: TriangleAlert,
  trash: Trash2,
  sent: Send,
  settings: Settings,
};

/**
 * What a row says.
 *
 * A mailbox is named by `MAILBOX_LABEL` — the same map the tabs use — so a folder has one
 * name in the product. Only Settings, which is not a mailbox, carries its own.
 */
const labelFor = (item: { mailbox?: Mailbox }): string =>
  item.mailbox ? MAILBOX_LABEL[item.mailbox] : "Settings";

type Props = {
  index: number;
  unread: Partial<Record<Mailbox, number>>;
  onActivate: (item: NavigationItem) => void;
  onClose: () => void;
};

export function NavigationPalette({ index, unread, onActivate, onClose }: Props) {
  const active = NAVIGATION_ITEMS[index];

  return (
    <Sheet
      role="menu"
      label="Switch mailbox"
      onClose={onClose}
      // Without this the palette is announced as a menu with a handful of items and no
      // position, which is the entire thing a menu is supposed to convey.
      activeDescendant={active ? `nav-row-${active.id}` : undefined}
      className="animate-sheet w-full max-w-[280px] overflow-hidden rounded-pane border border-hairline bg-chrome p-1.5 shadow-lift"
    >
      {NAVIGATION_ITEMS.map((item, i) => {
        const Icon = ICONS[item.id];
        const isActive = i === index;
        const label = labelFor(item);
        const count = item.mailbox ? (unread[item.mailbox] ?? 0) : 0;

        return (
          <button
            key={item.id}
            id={`nav-row-${item.id}`}
            type="button"
            role="menuitem"
            // `aria-selected` is not valid on a menuitem, and `aria-checked` would claim
            // it is a toggle. The correct signal is `aria-activedescendant` on the *menu*,
            // set above.
            tabIndex={-1}
            onClick={() => onActivate(item.id)}
            className={`flex w-full items-center gap-2.5 rounded-ctl px-3 py-2 text-left text-ui transition-colors ${
              isActive ? "bg-surface-active text-ink" : "text-ink-body hover:bg-surface-hover"
            }`}
          >
            <Icon size={15} strokeWidth={1.9} className="shrink-0 text-ink-muted" aria-hidden="true" />
            <span className="flex-1 font-medium">{label}</span>
            {count > 0 && (
              <span className="rounded-ctl bg-surface-sunken px-1.5 text-meta font-semibold tabular-nums text-ink-muted">
                {count}
              </span>
            )}
          </button>
        );
      })}
    </Sheet>
  );
}
