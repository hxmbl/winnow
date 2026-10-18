/**
 * A popover menu: the sender menu behind an avatar, and the row context menu.
 *
 * Flat like the rest of PR #10's surfaces — the `pane` radius (12px), a hairline edge
 * and no shadow — with 14px items, an icon column, and the keyboard shortcut on the
 * right where one exists. Groups are separated by a divider, not by headings.
 *
 * Behaviour follows the WAI-ARIA menu pattern:
 *
 *   - `role="menu"` with `menuitem` children; focus moves to the first item on open.
 *   - ↑/↓ (wrapping), Home/End move; Enter/Space activate; → opens a submenu and ← or
 *     Escape closes it, returning focus to its parent item.
 *   - Escape on the root closes everything and puts focus back on whatever opened the
 *     menu (`returnFocus`); so does activating an item. A click outside closes without
 *     moving focus, because the click already put it somewhere.
 *   - The menu is clamped into the viewport after it is measured, flipping above or to
 *     the left of its anchor when there is no room.
 *
 * Every key the menu handles stops there: the app's global shortcut handler must not see
 * `j` or `e` while a menu is open (App also checks `menuOpen` before routing).
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { anchorFromElement, placeMenu, type MenuAnchor, type MenuEntry } from "../menuPlacement";

export type { MenuAnchor, MenuEntry };

const ITEM =
  "flex w-full min-w-0 items-center gap-2.5 rounded-ctl px-2.5 py-1.5 text-left text-ui outline-none transition-colors disabled:opacity-40 focus-visible:bg-sheen hover:bg-sheen aria-expanded:bg-sheen [@media(hover:none)]:min-h-11";

type Props = {
  items: MenuEntry[];
  anchor: MenuAnchor;
  label: string;
  onClose: (reason: "escape" | "select" | "outside") => void;
  /** Where focus goes when the menu closes by Escape or selection. */
  returnFocus?: HTMLElement | null;
  /** For a submenu: open beside the parent item rather than below it. */
  side?: "below" | "right";
  /** For a submenu: close just this level (← or Escape). */
  onBack?: () => void;
  /** Set on the root; a submenu inherits the root's data attribute. */
  testId?: string;
  /** A non-interactive header above the items: the sender menu's avatar and address. */
  header?: ReactNode;
};

export function Menu({ items, anchor, label, onClose, returnFocus, side = "below", onBack, testId, header }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [openSub, setOpenSub] = useState<{ id: string; anchor: MenuAnchor } | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const isRoot = onBack === undefined;
  const hasHeader = header !== undefined;

  const enabled = items.filter(
    (entry): entry is Extract<MenuEntry, { kind: "item" }> => entry.kind === "item" && !entry.disabled,
  );

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition(
      placeMenu(anchor, { width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }, side),
    );
  }, [anchor, side, items.length, hasHeader]);

  // Focus the first item once placed.
  useEffect(() => {
    if (!position) return;
    const first = enabled[0];
    if (first) itemRefs.current.get(first.id)?.focus({ preventScroll: true });
    // Only on first placement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position === null]);

  const close = useCallback(
    (reason: "escape" | "select" | "outside") => {
      onClose(reason);
      if (reason !== "outside") returnFocus?.focus({ preventScroll: true });
    },
    [onClose, returnFocus],
  );

  // A click anywhere outside every open menu closes the root; a resize or a scroll
  // elsewhere does too, since the anchor has moved out from under it.
  useEffect(() => {
    if (!isRoot) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (target?.closest?.("[data-menu-root]")) return;
      close("outside");
    };
    const onViewport = (event: Event) => {
      const target = event.target as Element | null;
      if (target instanceof Element && target.closest("[data-menu-root]")) return;
      close("outside");
    };
    document.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("resize", onViewport);
    document.addEventListener("scroll", onViewport, true);
    window.addEventListener("blur", onViewport);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("resize", onViewport);
      document.removeEventListener("scroll", onViewport, true);
      window.removeEventListener("blur", onViewport);
    };
  }, [isRoot, close]);

  const focusAt = (index: number) => {
    const entry = enabled[(index + enabled.length) % enabled.length];
    if (entry) itemRefs.current.get(entry.id)?.focus({ preventScroll: true });
  };

  const currentIndex = () => {
    const active = document.activeElement;
    return enabled.findIndex((entry) => itemRefs.current.get(entry.id) === active);
  };

  const openSubmenu = (entry: Extract<MenuEntry, { kind: "item" }>) => {
    const button = itemRefs.current.get(entry.id);
    if (!button || !entry.submenu) return;
    setOpenSub({ id: entry.id, anchor: anchorFromElement(button) });
  };

  const activate = (entry: Extract<MenuEntry, { kind: "item" }>) => {
    if (entry.disabled) return;
    if (entry.submenu) {
      openSubmenu(entry);
      return;
    }
    close("select");
    entry.onSelect?.();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    // A submenu's keys are its own; do not let them reach this level.
    if (event.target instanceof Element && event.target.closest("[role='menu']") !== ref.current) return;
    const index = currentIndex();
    switch (event.key) {
      case "ArrowDown":
        focusAt(index + 1);
        break;
      case "ArrowUp":
        focusAt(index < 0 ? -1 : index - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(-1);
        break;
      case "ArrowRight": {
        const entry = enabled[index];
        if (entry?.submenu) openSubmenu(entry);
        break;
      }
      case "ArrowLeft":
        if (onBack) onBack();
        break;
      case "Escape":
        if (onBack) onBack();
        else close("escape");
        break;
      case "Tab":
        // Tab leaves a menu, as it does a native one.
        if (isRoot) close("escape");
        break;
      default:
        // Every other key is swallowed so the app's shortcuts stay quiet; Enter and
        // Space reach the focused button as a click.
        if (event.key !== "Enter" && event.key !== " ") {
          event.stopPropagation();
          event.preventDefault();
        }
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-menu-root=""
      data-menu={testId}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
      style={{
        position: "fixed",
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        visibility: position ? "visible" : "hidden",
      }}
      data-menu-animate={position ? "" : undefined}
      className={`${position ? "animate-menu" : ""} z-50 flex min-w-[220px] max-w-[min(320px,calc(100vw-16px))] flex-col gap-px rounded-pane border border-hairline bg-chrome p-1 text-ink-body [@media(hover:none)]:min-w-[240px]`}
    >
      {header && (
        <>
          <div role="presentation" data-menu-header="" className="flex min-w-0 items-center gap-2.5 px-2.5 py-2">
            {header}
          </div>
          <div role="separator" className="my-1 h-px bg-hairline" />
        </>
      )}
      {items.map((entry) => {
        if (entry.kind === "divider") {
          return <div key={entry.id} role="separator" className="my-1 h-px bg-hairline" />;
        }
        const Icon = entry.icon;
        return (
          <button
            key={entry.id}
            ref={(element) => {
              if (element) itemRefs.current.set(entry.id, element);
              else itemRefs.current.delete(entry.id);
            }}
            type="button"
            role="menuitem"
            data-menu-item={entry.id}
            tabIndex={-1}
            disabled={entry.disabled}
            aria-haspopup={entry.submenu ? "menu" : undefined}
            aria-expanded={entry.submenu ? openSub?.id === entry.id : undefined}
            onClick={() => activate(entry)}
            onPointerEnter={(event) => {
              if (event.pointerType !== "mouse") return;
              if (entry.submenu) openSubmenu(entry);
              else if (openSub) setOpenSub(null);
            }}
            className={`${ITEM} ${entry.danger ? "text-danger" : ""}`}
          >
            <span className="flex w-4 shrink-0 justify-center text-ink-icon">
              {Icon && <Icon size={15} strokeWidth={1.9} aria-hidden="true" />}
            </span>
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.hint && (
              <kbd className="shrink-0 font-sans text-meta text-ink-subtle">{entry.hint}</kbd>
            )}
            {entry.submenu && (
              <ChevronRight size={14} strokeWidth={1.9} className="shrink-0 text-ink-subtle" aria-hidden="true" />
            )}
          </button>
        );
      })}
      {openSub && (() => {
        const parent = items.find((entry) => entry.kind === "item" && entry.id === openSub.id);
        if (!parent || parent.kind !== "item" || !parent.submenu) return null;
        return (
          <Menu
            key={openSub.id}
            items={parent.submenu}
            anchor={openSub.anchor}
            label={parent.label}
            side="right"
            onClose={(reason) => onClose(reason)}
            returnFocus={returnFocus}
            onBack={() => {
              setOpenSub(null);
              itemRefs.current.get(openSub.id)?.focus({ preventScroll: true });
            }}
            testId={`${testId ?? "menu"}-sub`}
          />
        );
      })()}
    </div>
  );
}
