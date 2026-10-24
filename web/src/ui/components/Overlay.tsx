/**
 * The modal sheet every overlay is built from.
 *
 * `aria-modal="true"` is made true here: focus is moved in, trapped while open, and
 * restored on the way out; Escape is handled here; and the backdrop is opt-in, because the
 * composer must not be dismissable by a stray click.
 *
 * `role="dialog"` with `aria-modal` is right for the settings sheet and the composer. For
 * the palette — a list of destinations with its own roving selection — `role="menu"` with
 * `aria-activedescendant` is the correct pattern, so it keeps its own role and takes the
 * focus handling from here.
 */

import { useCallback, useEffect, useRef } from "react";

type Props = {
  /** Where focus goes when the sheet opens. Null focuses the sheet itself. */
  initialFocus?: React.RefObject<HTMLElement | null>;
  /**
   * What dismissing the sheet means.
   *
   * Required, because every sheet here has a real way out; optional, a caller could ship a
   * dialog that could only be closed by the system. `ConfirmDialog` supplies it as its
   * cancel path, which is the same function as `onEscape` — a confirmation has to be
   * cancelable by every route.
   */
  onClose: () => void;
  /** Escape. Defaults to `onClose`. */
  onEscape?: () => void;
  /**
   * Clicking the backdrop closes the sheet.
   *
   * Off by default: a viewer or a list is obviously dismissable by clicking away; a
   * composer holding typed text is not, and the caller passes this explicitly once it has
   * decided the click is not ambiguous.
   *
   * Routes to `onClose`, not `onEscape`: a backdrop click on a confirmation dialog is not
   * a decision, which is why `ConfirmDialog` turns this off and lets Escape go to the safe
   * answer via `onEscape`.
   */
  dismissOnBackdrop?: boolean;
  /** `dialog` for content, `menu` for a roving list of destinations. */
  role?: "dialog" | "menu";
  /** The accessible name, and the `aria-label` for the menu. */
  label: string;
  /**
   * `aria-activedescendant` for a `menu`.
   *
   * Ignored for a `dialog`. Passed in rather than derived, because the element ids belong
   * to whoever rendered the rows.
   */
  activeDescendant?: string;
  /**
   * Where the panel sits in the backdrop.
   *
   * `center` for a sheet that is about content, and `left` for the navigation drawer,
   * which is about *place* and belongs against the edge it emerges from — a panel floating
   * in the middle of the window says "dialog".
   */
  placement?: "center" | "left" | "fill" | "bottom";
  /**
   * Stop the backdrop this far above the window's bottom edge, leaving what is there
   * (the phone dock) visible and live. Settings on a phone uses it so the tabs stay
   * on screen, and any of them leaves Settings for that mailbox.
   */
  bottomInset?: string;
  /**
   * What is behind the panel. `scrim` (the default) dims the app and lets it show
   * through: right for a sheet the user should see as over something. `opaque` paints
   * the backdrop the chrome colour and carries that colour past the bottom edge, for a
   * panel that *replaces* the screen (Settings on a phone): the panel still rises in, but
   * over a surface the app cannot show through, in any frame of the motion, under the
   * gesture bar, or while the viewport is resizing (keyboard, browser toolbar).
   */
  backdrop?: "scrim" | "opaque";
  className?: string;
  children: React.ReactNode;
};

/** Elements that can hold focus, for the Tab trap. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * How a surface arrives.
 *
 * Two motions, because the two surfaces are different objects. A sheet *appears*: it is
 * content that was not there, so it can scale a hair as it settles. The drawer *emerges*
 * — it is a place, sliding out of the edge it belongs to, and scaling it would make it
 * read as a card rather than as a surface of the window.
 *
 * Kept as whole keyframe names rather than inline `style` so they stay in
 * `index.css`'s `@theme` and `prefers-reduced-motion` in `index.css` reaches them.
 */
const SURFACE_ENTER = {
  center: "animate-sheet",
  left: "animate-drawer",
  // The phone composer: the whole window, so it rises like a sheet.
  fill: "animate-sheet",
  // A phone's action sheet: rises from the bottom edge, as iOS's does.
  bottom: "animate-rise",
} as const;

export function Sheet({
  initialFocus,
  onClose,
  onEscape,
  dismissOnBackdrop = true,
  role = "dialog",
  label,
  activeDescendant,
  placement = "center",
  bottomInset,
  backdrop = "scrim",
  className = "max-w-[520px]",
  children,
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  /** The element focus came from, so it can be given back. */
  const restoreRef = useRef<HTMLElement | null>(null);

  // Move focus in, and remember where it came from.
  //
  // Recorded in an effect rather than during render because reading
  // `document.activeElement` during render is a side effect, and the element that had
  // focus when the sheet *opened* is not necessarily the one it has when the effect runs.
  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const target = initialFocus?.current ?? panelRef.current;
    target?.focus();
    return () => {
      // Restored on unmount rather than by the caller, so every overlay gets it. `preventScroll`
      // because a sheet scrolled the page under it and restoring focus would otherwise jump
      // the user back down.
      restoreRef.current?.focus?.({ preventScroll: true });
    };
  }, [initialFocus]);

  /*
    The focus trap.

    Tab and Shift+Tab are intercepted at the panel's edges and wrapped, which is the only
    behaviour `aria-modal` actually promises: that the content outside is not reachable by
    keyboard. The other two implications — the background is inert to a screen reader, and
    nothing outside is clickable — are handled by the backdrop covering it.

    On `keydown` rather than by mutating `tabindex` on every focusable element, because the
    latter has to be undone reliably and there are three overlays that can be open.
  */
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      // Handled here rather than left to the app's global handler, because a global handler
      // has to be told about every sheet and gets it wrong when a new one is added.
      // `stopPropagation` so the app's `window` listener does not also act on it — two
      // handlers closing two different things for one Escape is how a sheet closes the
      // reader *and* itself.
      event.stopPropagation();
      event.preventDefault();
      (onEscape ?? onClose)();
      return;
    }

    if (event.key !== "Tab") return;

    const panel = panelRef.current;
    if (!panel) return;
    const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      // `getClientRects()` rather than `offsetParent !== null`, which was wrong in both
      // directions: `offsetParent` is null for a `position: fixed` element, so fixed
      // content inside a sheet was dropped from the tab order while on screen; and it is
      // the wrong instrument for a hidden control that is still in the tab order. A rect
      // list answers the actual question — does this box exist on screen — for fixed and
      // static positioning alike.
      //
      // `getBoundingClientRect()` would do the same thing for a zero-size box, but a
      // control with no area is not one anybody can click either.
      (element) =>
        element.getClientRects().length > 0 || element === document.activeElement,
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
      className={`fixed inset-0 ${
        // Layers (low to high): a page that replaces the screen (Settings on a phone)
        // at z-50, the phone dock raised over it at 55, every other sheet at 60, and
        // menus and popovers at 70. A sheet or menu opened from Settings must never
        // land under the dock.
        backdrop === "opaque" ? "z-50" : "z-60"
      } flex ${
        placement === "left"
          ? // Flush to the edge and full height: the drawer *is* the left side of the
            // window, and a rounded panel inset by 16px would read as a dialog
            // pretending to be a sidebar. No vertical padding either, so its top and
            // bottom edges are the window's own.
            "items-stretch justify-start"
          : placement === "fill"
            ? // The whole screen, top-aligned, so a panel shorter than the window (the
              // part the on-screen keyboard leaves) sits at the top rather than centred.
              "items-start justify-stretch"
            : placement === "bottom"
              ? // An action sheet: against the bottom edge, clear of the gesture bar.
                "items-end justify-center px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
              : "items-center justify-center p-4"
      } ${backdrop === "opaque" ? "wn-backdrop-opaque" : "bg-scrim"}`}
      data-backdrop={backdrop}
      style={bottomInset ? { bottom: bottomInset } : undefined}
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
        className={`outline-hidden ${SURFACE_ENTER[placement]} ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A question that has to be asked before something irreversible.
 *
 * Exists because the one place this came up used `window.confirm`, which is the
 * wrong tool in a desktop shell three separate ways: Tauri's webviews do not
 * reliably implement it (it is not part of the WebKit contract the app runs on),
 * a browser-native dialog cannot be styled and so reads as a web page rather than
 * as part of Winnow, and it blocks the render loop — which in a mail client means
 * a frozen window if the answer is slow.
 *
 * A real dialog also gets the details right: focus lands on *cancel*, Escape
 * cancels, and Tab cannot leave.
 */
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  destructive = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  /** Red for "this loses something", ink for "this is just a step". */
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  return (
    <Sheet
      label={title}
      onClose={onCancel}
      // Escape goes to `onCancel`, which is the safe answer for a confirmation.
      // Stated explicitly rather than left to default to `onClose`, because the
      // whole reason this component exists is that "close" and "cancel" must not be
      // allowed to drift apart by accident.
      onEscape={onCancel}
      // Not dismissable by clicking away: a click that lands outside a small
      // dialog is very often a mis-aimed click on the thing behind it, and the
      // answer to "did you mean to do that?" must never be a discard.
      dismissOnBackdrop={false}
      initialFocus={cancelRef}
      className="w-full max-w-[380px] rounded-pane border border-hairline bg-chrome p-5 shadow-lift"
    >
      <h2 className="text-read font-semibold text-ink">{title}</h2>
      <p className="mt-1.5 text-ui leading-relaxed text-ink-muted">{body}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-ctl border border-control-border px-4 py-1.5 text-ui font-semibold text-ink-body transition-colors hover:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          Keep editing
        </button>
        <button
          type="button"
          onClick={onConfirm}
          className={`rounded-ctl px-4 py-1.5 text-ui font-semibold transition-opacity hover:opacity-90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring ${
            destructive
              ? "bg-danger text-(--wn-surface)"
              : "bg-accent text-on-accent"
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </Sheet>
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
  touch = false,
  children,
}: {
  title: string;
  /** Wired to the panel's `aria-labelledby` when the panel has no `aria-label`. */
  id?: string;
  onClose: () => void;
  /** A 44px close target and room for the status bar, for the phone layout. */
  touch?: boolean;
  /** Controls between the title and the close button (the composer's toggle and status). */
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-hairline bg-chrome ${
        touch ? "pb-1.5 pl-5 pr-3 pt-[max(0.375rem,env(safe-area-inset-top))]" : "px-5 py-3.5"
      }`}
    >
      <h2 id={id} className="shrink-0 text-read font-semibold text-ink">
        {title}
      </h2>
      {children && <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>}
      <button
        type="button"
        onClick={onClose}
        aria-label={`Close ${title}`}
        className={`flex ${touch ? "h-11 w-11" : "h-7 w-7"} items-center justify-center rounded-ctl text-ink-icon transition-colors hover:bg-surface-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-ring`}
      >
        <svg viewBox="0 0 24 24" width={16} height={16} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

export type SheetAction = {
  /** Stable id, for tests (`data-action-sheet-item`). */
  id: string;
  label: string;
  /** Red: this loses something. */
  destructive?: boolean;
  onSelect: () => void;
};

/**
 * A phone's action sheet, as iOS draws one: the choices in one rounded group against the
 * bottom edge, an optional line saying what is being decided, and Cancel on its own
 * underneath, set apart and in bold, so the safe answer is the biggest and lowest target.
 *
 * Used where a tap on a phone would lose something (closing a written draft, deleting
 * from the Trash for good, signing out): the destructive choice is red and never the
 * focused one, Escape and a tap on the dimmed app both cancel, and focus starts on Cancel.
 */
export function ActionSheet({
  label,
  message,
  actions,
  onCancel,
  cancelLabel = "Cancel",
}: {
  /** The accessible name (and the heading when there is no `message`). */
  label: string;
  /** A line above the choices, in small grey type. */
  message?: string;
  actions: readonly SheetAction[];
  onCancel: () => void;
  cancelLabel?: string;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const ITEM =
    "flex min-h-[56px] w-full items-center justify-center px-4 text-read transition-colors active:bg-surface-active focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring";
  return (
    <Sheet
      label={label}
      onClose={onCancel}
      onEscape={onCancel}
      // Unlike a desktop confirmation, a tap above an action sheet is how iOS cancels it,
      // and cancelling is always the safe answer here.
      dismissOnBackdrop
      initialFocus={cancelRef}
      placement="bottom"
      className="flex w-full max-w-[480px] flex-col gap-2"
    >
      <div data-action-sheet="" className="overflow-hidden rounded-pane bg-chrome shadow-lift">
        {message && (
          <p className="border-b border-hairline px-4 py-3 text-center text-meta text-ink-subtle">{message}</p>
        )}
        {actions.map((action, index) => (
          <button
            key={action.id}
            type="button"
            data-action-sheet-item={action.id}
            onClick={action.onSelect}
            className={`${ITEM} ${index > 0 ? "border-t border-hairline" : ""} ${
              action.destructive ? "text-danger" : "text-accent"
            }`}
          >
            {action.label}
          </button>
        ))}
      </div>
      <button
        ref={cancelRef}
        type="button"
        data-action-sheet-item="cancel"
        onClick={onCancel}
        className={`${ITEM} rounded-pane bg-chrome font-semibold text-accent shadow-lift`}
      >
        {cancelLabel}
      </button>
    </Sheet>
  );
}
