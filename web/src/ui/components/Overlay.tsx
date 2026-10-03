/**
 * The modal sheet every overlay is built from.
 *
 * One component because there are four, and they had drifted into four different
 * opinions about what a modal is. Three things were wrong in all of them:
 *
 *   - **`aria-modal="true"` with nothing to make it true.** No focus trap, so Tab
 *     walked out of the sheet and into the inert page behind it, and no focus
 *     restore, so dismissing a sheet dropped the caret at the top of the document.
 *     A dialog that lets you tab into the page it is covering is not a dialog.
 *   - **No Escape.** Each overlay relied on the app's global keybind handler, which
 *     meant the composer's Escape did nothing (`App.tsx` sets `ready: false` when the
 *     composer is open, and the router returns nothing for a context that is not
 *     ready) — so a sheet had a close button, a backdrop and a working Escape
 *     handler *somewhere else*, and the composer's Escape simply did not exist.
 *   - **A backdrop click handler on a non-interactive element.** `role="presentation"`
 *     was there to silence the a11y warning, which silenced the real problem: a click
 *     outside a dialog is ambiguous. For a viewer it is obviously "close"; for a
 *     composer with a typed reply in it, it destroys work.
 *
 * So: focus is moved in, trapped while open, and restored to whatever had it on the
 * way out; Escape is handled here; and the backdrop is opt-in, because the composer
 * must not be dismissable by a stray click.
 *
 * `role="dialog"` with `aria-modal` is right for the settings sheet and the composer,
 * which contain focusable content the user must reach. For the palette — a list of
 * destinations with its own roving selection — `role="menu"` with `aria-activedescendant`
 * is the correct pattern, so the palette keeps its own role and takes the focus
 * handling from here.
 */

import { useCallback, useEffect, useRef } from "react";

type Props = {
  /** Where focus goes when the sheet opens. Null focuses the sheet itself. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Escape. Defaults to `onClose`. */
  onEscape?: () => void;
  /**
   * Clicking the backdrop closes the sheet.
   *
   * Off by default. A viewer or a list is obviously dismissable by clicking away from
   * it; a composer holding typed text is not, and the caller passes `onClose` only
   * after confirming there is nothing to lose.
   */
  dismissOnBackdrop?: boolean;
  /** `dialog` for content, `menu` for a roving list of destinations. */
  role?: "dialog" | "menu";
  /** The accessible name, and the `aria-label` for the menu. */
  label: string;
  /**
   * `aria-activedescendant` for a `menu`.
   *
   * Ignored for a `dialog`, which has no such concept. Passed in rather than derived,
   * because the element ids belong to whoever rendered the rows.
   */
  activeDescendant?: string;
  className?: string;
  children: React.ReactNode;
};

/** Elements that can hold focus, for the Tab trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Sheet({
  initialFocus,
  onClose,
  onEscape,
  dismissOnBackdrop = true,
  role = "dialog",
  label,
  activeDescendant,
  className = "max-w-[520px]",
  children,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  /** The element focus came from, so it can be given back. */
  const restoreRef = useRef<HTMLElement | null>(null);

  // Move focus in, and remember where it came from.
  //
  // Recorded in an effect rather than during render because reading
  // `document.activeElement` during render is a side effect, and because the element
  // that had focus when the sheet *opened* is not necessarily the one that had it
  // when the effect runs.
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const target = initialFocus?.current ?? panelRef.current;
    target?.focus();
    return () => {
      // Restored on unmount rather than by the caller, so every overlay gets it and
      // none can forget. `preventScroll` because a sheet scrolled the page under it
      // and restoring focus would otherwise jump the user back down.
      restoreRef.current?.focus?.({ preventScroll: true });
    };
  }, [initialFocus]);

  /*
    The focus trap.

    Tab and Shift+Tab are intercepted at the panel's edges and wrapped, which is the
    only behaviour `aria-modal` actually promises: that the content outside is not
    reachable by keyboard. The two other things `aria-modal` implies — that the
    background is inert to a screen reader, and that nothing outside is clickable — are
    handled by the backdrop, which covers it.

    Implemented on `keydown` rather than by mutating `tabindex` on every focusable
    element in the document, because the latter has to be undone reliably and there are
    three overlays that can be open at different times.
  */
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      // Handled here rather than left to the app's global handler, because a global
      // handler has to be told about every sheet and gets it wrong when a new one is
      // added. `stopPropagation` so the app's `window` listener does not also act on
      // it — two handlers closing two different things for one Escape is how a sheet
      // closes the reader *and* itself.
      event.stopPropagation();
      event.preventDefault();
      (onEscape ?? onClose)();
      return;
    }

    if (event.key !== "Tab") return;

    const panel = panelRef.current;
    if (!panel) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      // `offsetParent` is null for a `display: none` element, and a hidden control
      // that is in the tab order is a trap of the other kind: focus lands on something
      // the user cannot see.
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
    if (focusable.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const current = document.activeElement;

    if (event.shiftKey && (current === first || current === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  }, [onClose, onEscape]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      // A click handler on a div, which is only acceptable because this div is
      // genuinely a backdrop and genuinely dismissable — and it is *optional*, which is
      // the part that was missing. `onMouseDown` rather than `onClick` so a drag that
      // starts inside the sheet and ends on the backdrop does not dismiss it.
      onMouseDown={
        dismissOnBackdrop
          ? (event) => {
              if (event.target === event.currentTarget) onClose();
            }
          : undefined
      }
      role="presentation"
    >
      <div
        ref={panelRef}
        role={role}
        aria-modal={role === "dialog" ? true : undefined}
        aria-label={label}
        aria-activedescendant={activeDescendant}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`animate-sheet outline-none ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The sticky header every sheet has: a title, and the close button.
 *
 * Extracted rather than repeated because three sheets had three slightly different
 * close buttons, one of which had no `aria-label` and so announced only as "button".
 */
export function SheetHeader({
  title,
  id,
  onClose,
}: {
  title: string;
  /** Wired to the panel's `aria-labelledby` when the panel has no `aria-label`. */
  id?: string;
  onClose: () => void;
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-hairline bg-chrome px-5 py-3.5">
      <h2 id={id} className="text-[15px] font-semibold text-ink">
        {title}
      </h2>
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${title}`}
        className="flex h-7 w-7 items-center justify-center rounded-full text-ink-icon transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
