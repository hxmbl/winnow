/** Menu data types and placement, kept out of `components/Menu` so they test without React. */

import type { LucideIcon } from "lucide-react";

export type MenuEntry =
  | {
      kind: "item";
      id: string;
      label: string;
      icon?: LucideIcon;
      /** A keyboard shortcut to print on the right, e.g. `e`. */
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect?: () => void;
      submenu?: MenuEntry[];
    }
  | { kind: "divider"; id: string };

export type MenuAnchor =
  /** A point, for a right-click. */
  | { kind: "point"; x: number; y: number }
  /** An element's box, for a button or a keyboard-opened row menu. */
  | { kind: "rect"; top: number; left: number; bottom: number; right: number };

export function anchorFromElement(element: Element): MenuAnchor {
  const rect = element.getBoundingClientRect();
  return { kind: "rect", top: rect.top, left: rect.left, bottom: rect.bottom, right: rect.right };
}

/** Viewport margin a menu keeps from every edge. */
export const MENU_MARGIN = 8;

/**
 * Where a menu of `size` goes for `anchor`, kept inside a `viewport`.
 *
 * A point opens the menu down-right of the pointer; a box opens it below its left edge
 * (or, for a submenu, `side: "right"`, beside it). Whichever way it would overflow, it
 * flips, and as a last resort it is clamped so no part is ever off screen.
 */
export function placeMenu(
  anchor: MenuAnchor,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  side: "below" | "right" = "below",
): { top: number; left: number } {
  const maxLeft = viewport.width - size.width - MENU_MARGIN;
  const maxTop = viewport.height - size.height - MENU_MARGIN;
  let left: number;
  let top: number;
  if (anchor.kind === "point") {
    left = anchor.x + size.width > viewport.width - MENU_MARGIN ? anchor.x - size.width : anchor.x;
    top = anchor.y + size.height > viewport.height - MENU_MARGIN ? anchor.y - size.height : anchor.y;
  } else if (side === "right") {
    left = anchor.right + size.width > viewport.width - MENU_MARGIN ? anchor.left - size.width : anchor.right;
    top = anchor.top - 4;
  } else {
    left = anchor.left;
    top = anchor.bottom + 4 + size.height > viewport.height - MENU_MARGIN
      ? anchor.top - 4 - size.height
      : anchor.bottom + 4;
  }
  return {
    left: Math.max(MENU_MARGIN, Math.min(left, maxLeft)),
    top: Math.max(MENU_MARGIN, Math.min(top, maxTop)),
  };
}

