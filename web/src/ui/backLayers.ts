/**
 * Android's Back, as data: which layer one press closes.
 *
 * Back closes the topmost thing on screen and only leaves the app from the bare list —
 * the way every Android app behaves, and the way Winnow did not: with no handler the
 * webview's own Back either did nothing useful (there is no history to go back through)
 * or closed the whole app over an open message.
 *
 * The order is the stacking order, top first:
 *
 *   1. a popover or menu (row/sender menu, a setting's (?) popover, the recipient list)
 *   2. a sheet (a confirmation, Google setup, the shortcut sheet, the `!` palette)
 *   3. the composer — parked as a draft, never discarded (see `App.tsx`)
 *   4. the sidebar
 *   5. the Settings page
 *   6. the open message, back to the list
 *
 * and with none of them, `exit`. Pure so the order is pinned by a test rather than by
 * whichever handler happened to run first; `App.tsx` reads the state and does the
 * closing.
 */

export type BackLayer = "popover" | "sheet" | "composer" | "sidebar" | "settings" | "message";

/** What is open right now. Each flag is one layer; several can be true at once. */
export type BackState = Readonly<Record<BackLayer, boolean>>;

/** The layers in the order Back closes them, topmost first. */
export const BACK_ORDER: readonly BackLayer[] = ["popover", "sheet", "composer", "sidebar", "settings", "message"];

/** The layer one Back press closes, or `exit` at the root list. */
export function backTarget(state: BackState): BackLayer | "exit" {
  return BACK_ORDER.find((layer) => state[layer]) ?? "exit";
}

/** Nothing open: the root list. */
export const ROOT_STATE: BackState = {
  popover: false,
  sheet: false,
  composer: false,
  sidebar: false,
  settings: false,
  message: false,
};

/** The selectors that mark a popover in the DOM: a menu, a setting's popover, a recipient list. */
export const POPOVER_SELECTOR = '[role="menu"], [data-setting-popover], [role="listbox"]';

/**
 * A modal sheet in the DOM, other than the three layers `App.tsx` tracks itself: the
 * composer (`data-composer`), the sidebar (`data-mail-nav`) and the Settings page
 * (`data-settings-layout`), each of which is a modal too.
 */
export function isSheetElement(element: Pick<Element, "getAttribute" | "querySelector">): boolean {
  if (element.getAttribute("aria-modal") !== "true") return false;
  return element.querySelector("[data-composer], [data-mail-nav], [data-settings-layout]") === null;
}
