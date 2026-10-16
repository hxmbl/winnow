/**
 * The sidebar as an overlay: when it closes on its own, and how the rest of the app is
 * blurred while it is open.
 *
 * Kept apart from the component so the rules can be tested without a DOM: the idle
 * close is a policy (who gets to keep the sidebar open), and the scrim is a recipe
 * (which blur sits where), and both are easy to break by "tidying" a number.
 */

/**
 * How long the pointer can be away from the sidebar before it closes itself.
 *
 * Long enough to overshoot the edge and come back without losing it, short enough that
 * the sidebar is gone by the time the eye has moved to the list.
 */
export const SIDEBAR_IDLE_CLOSE_MS = 1500;

/** What the idle close looks at when its timer runs out. */
export type IdleState = {
  /** The pointer is back over the sidebar (or a menu it opened). */
  pointerInside: boolean;
  /** A menu opened from inside the sidebar (the account menu) is showing. */
  menuOpen: boolean;
  /** Focus is in a text field, a select or an editable region inside the sidebar. */
  editing: boolean;
  /**
   * Focus inside the sidebar is keyboard focus (`:focus-visible`).
   *
   * Someone walking the sidebar with Tab is using it, wherever their mouse happens to
   * be resting. Focus the sidebar placed itself after a click does not count, or the
   * idle close could never fire: opening always moves focus in.
   */
  keyboardFocus: boolean;
  /**
   * A button is held down after a press that began inside the sidebar: a drag-select,
   * or the scrollbar being dragged, which both carry the pointer out of the panel
   * without anyone having walked away. Optional so older callers read as "no".
   */
  pressing?: boolean;
  /**
   * The browser's own context menu was opened from inside the sidebar. It draws outside
   * the page, so the pointer "leaves" to reach it; the hold lifts on the next pointer
   * movement over the page.
   */
  contextMenu?: boolean;
  /** Text inside the sidebar is selected, presumably to be copied. */
  selecting?: boolean;
};

/** Whether the sidebar may close itself now. Anything still using it keeps it open. */
export function idleCloseAllowed(state: IdleState): boolean {
  return (
    !state.pointerInside &&
    !state.menuOpen &&
    !state.editing &&
    !state.keyboardFocus &&
    !state.pressing &&
    !state.contextMenu &&
    !state.selecting
  );
}

/** Only a mouse or a pen "leaves": a finger lifting off the glass is not walking away. */
export function armsIdleClose(pointerType: string): boolean {
  return pointerType === "mouse" || pointerType === "pen";
}

/**
 * Whether a click on the scrim should close the sidebar.
 *
 * Not the second (or third) click of a multi-click. The toggle sits under the scrim
 * once the sidebar is open, so a double-click on the toggle used to open the sidebar
 * with the first click and close it with the second, landing on the scrim. `detail` is
 * the browser's own count of clicks in quick succession on one spot; a single click
 * after a pause is 1 again, so closing by clicking outside is unaffected.
 */
export function scrimClickCloses(detail: number): boolean {
  return !(detail > 1);
}

/**
 * The first of several sidebar toggles that is actually on screen.
 *
 * There can be more than one in the document (the masthead's, the phone bar's, the
 * medium-width reader's), and the masthead's stays mounted, hidden, while the reader
 * replaces the list. Giving focus back to a hidden toggle drops it on the body.
 */
export function firstVisible<T extends { getClientRects(): { length: number } }>(
  candidates: Iterable<T>,
): T | null {
  for (const candidate of candidates) if (candidate.getClientRects().length > 0) return candidate;
  return null;
}

/**
 * `--wn-sidebar-mid` for a measured panel: the height of its middle in px, or `null`
 * when the measurement means nothing (a panel with no height yet, or not laid out), in
 * which case the property is removed and the origin falls back to the window's middle.
 */
export function scrimMidpoint(rect: { top: number; height: number }): string | null {
  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.height) || rect.height <= 0) return null;
  return `${Math.round(rect.top + rect.height / 2)}px`;
}

/**
 * `--wn-sidebar-mid` for the phone's bottom sheet: the height of its top edge in px,
 * which is where its blur spreads from (across, it is the middle of the window). `null`
 * for a panel that is not laid out, as for `scrimMidpoint`.
 */
export function scrimSheetTop(rect: { top: number; height: number }): string | null {
  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.height) || rect.height <= 0) return null;
  return `${Math.round(rect.top)}px`;
}

/** A text field, a select, or an editable region: somewhere typing is happening. */
export function isEditingElement(element: Element | null): boolean {
  if (!element) return false;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (element.getAttribute("type") ?? "text").toLowerCase();
    return !["button", "checkbox", "radio", "submit", "reset", "image", "range", "color"].includes(type);
  }
  return (element as HTMLElement).isContentEditable === true;
}

/**
 * One layer of the progressive blur.
 *
 * The blur is radial: it spreads from one point, the middle of the sidebar's right edge
 * (`SCRIM_ORIGIN`), and falls off evenly in every direction, so a spot above or below
 * the sidebar is as clear as a spot the same distance to its right.
 *
 * `reach` is where the layer has faded to nothing, as a share of the distance from that
 * point to the window's farthest corner (0 is the point itself, 1 is the corner). In
 * between the layer fades in a straight line with distance.
 */
export type ScrimLayer = { blur: number; reach: number };

/**
 * The layers, strongest first.
 *
 * Stacked, so they compound: right at the sidebar's edge all of them are on and the
 * content is unreadable glass; a little further out only the weaker ones are left; at
 * the window's farthest corner nothing is. The phone gets three lighter layers instead
 * of four, because a full-screen backdrop blur is paid for per frame and a phone's GPU is
 * the one that notices.
 */
export function scrimLayers(compact: boolean): ScrimLayer[] {
  return compact
    ? [
        { blur: 10, reach: 0.2 },
        { blur: 5, reach: 0.5 },
        { blur: 2, reach: 1 },
      ]
    : [
        { blur: 16, reach: 0.12 },
        { blur: 8, reach: 0.3 },
        { blur: 4, reach: 0.55 },
        { blur: 1.5, reach: 1 },
      ];
}

/**
 * Where the blur spreads from: the middle of the sidebar's right edge.
 *
 * Two custom properties set on the scrim, so the point follows the sidebar on every
 * screen: `--wn-sidebar-edge` is the edge's distance from the left (a CSS length worked
 * out from the sidebar's own width rules), and `--wn-sidebar-mid` is the height of the
 * sidebar's middle, measured from the panel, since the panel is only as tall as its
 * contents. Until it is measured, the middle of the window.
 */
export const SCRIM_ORIGIN = "var(--wn-sidebar-edge) var(--wn-sidebar-mid, 50%)";

/**
 * A layer's mask: a circle around `origin`, opaque at its centre and fading in a straight
 * line to nothing at the layer's reach.
 *
 * `farthest-corner` sizes the circle to the window's farthest corner from the origin, so
 * a reach of 1 is the whole window and every reach is the same distance in every
 * direction.
 */
export function scrimMask(layer: ScrimLayer, origin: string): string {
  const end = `${+(layer.reach * 100).toFixed(2)}%`;
  return `radial-gradient(circle farthest-corner at ${origin}, #000 0, transparent ${end})`;
}

/**
 * How strongly the stack blurs a point `distance` from the origin, where `corner` is
 * the distance to the window's farthest corner: each layer's blur times how much of its
 * mask is left there. For tests, and for checking a real window against the recipe.
 */
export function scrimBlurAt(layers: ScrimLayer[], distance: number, corner: number): number {
  return layers.reduce(
    (sum, layer) => sum + layer.blur * Math.max(0, 1 - distance / (layer.reach * corner)),
    0,
  );
}
