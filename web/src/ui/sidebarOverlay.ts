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
};

/** Whether the sidebar may close itself now. Anything still using it keeps it open. */
export function idleCloseAllowed(state: IdleState): boolean {
  return !state.pointerInside && !state.menuOpen && !state.editing && !state.keyboardFocus;
}

/** Only a mouse or a pen "leaves": a finger lifting off the glass is not walking away. */
export function armsIdleClose(pointerType: string): boolean {
  return pointerType === "mouse" || pointerType === "pen";
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
 * `reach` is where the layer has faded to nothing, as a share of the space between the
 * sidebar's edge and the far side of the window (0 is the edge, 1 is the far side).
 * Every layer is fully on from the window's left edge to the sidebar's.
 */
export type ScrimLayer = { blur: number; reach: number };

/**
 * The layers, strongest first.
 *
 * Stacked, so they compound: right at the sidebar's edge all of them are on and the
 * content is unreadable glass; a little further out only the weaker ones are left; at
 * the far side of the window nothing is. The phone gets three lighter layers instead of
 * four, because a full-screen backdrop blur is paid for per frame and a phone's GPU is
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
 * A layer's mask: opaque up to the sidebar's edge, then fading out to its reach.
 *
 * `edge` is a CSS length (a custom property, in practice), so the same recipe follows
 * the sidebar whatever width it is on this screen.
 */
export function scrimMask(layer: ScrimLayer, edge: string): string {
  const end =
    layer.reach >= 1 ? "100%" : `calc(${edge} + (100% - ${edge}) * ${layer.reach})`;
  return `linear-gradient(to right, #000 0, #000 ${edge}, transparent ${end})`;
}
