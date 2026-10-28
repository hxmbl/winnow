/**
 * A tap anywhere on a setting's row presses its switch (STRM-426).
 *
 * The switch is a small thing at the far edge of the row; the name is where a thumb (or
 * an S Pen) lands. So a click on the row's own surface — the name, the gap, the padding —
 * is passed to the row's switch, like a native Android preference row.
 *
 * Not passed on:
 * - a click on anything interactive inside the row: the (?) button keeps its popover,
 *   a link stays a link, and a click on the switch itself is already the switch's;
 * - a row with no switch, or more than one (which switch would it be?);
 * - a disabled switch;
 * - the end of a text selection, so selecting a setting's name doesn't flip it.
 *
 * Kept DOM-free (an element only needs `closest`) so it runs under the node test suite.
 */
export const ROW_TAP_IGNORE = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "label",
  "summary",
  "[contenteditable]",
  '[role="switch"]',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="radiogroup"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="tooltip"]',
  "[data-setting-info]",
].join(", ");

export type RowTapTarget = { closest(selector: string): unknown };
export type RowTapSwitch = { disabled?: boolean; getAttribute(name: string): string | null };
export type RowTapBlock<S extends RowTapSwitch> = { querySelectorAll(selector: string): ArrayLike<S> };

export function rowTapSwitch<S extends RowTapSwitch>(
  target: RowTapTarget | null,
  block: RowTapBlock<S>,
  selectedText = "",
): S | null {
  if (!target || typeof target.closest !== "function") return null;
  if (target.closest(ROW_TAP_IGNORE)) return null;
  if (selectedText.trim() !== "") return null;
  const switches = block.querySelectorAll('[role="switch"]');
  if (switches.length !== 1) return null;
  const only = switches[0];
  if (only.disabled || only.getAttribute("aria-disabled") === "true") return null;
  return only;
}
