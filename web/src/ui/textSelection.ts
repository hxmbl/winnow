/**
 * Text selection in an app whose chrome is not selectable.
 *
 * The body is `user-select: none` so a drag across the list, a double-click on a button
 * or a long-press on a row never paints a selection over the controls. Readable text
 * opts back in with `.selectable`, and a region the user reads as one thing — the
 * reader, the Settings sheet, the Google setup sheet — is a *select scope*
 * (`data-select-scope`), which is what ⌘A / Ctrl+A selects instead of every selectable
 * fragment on the page.
 *
 * Pure and DOM-free in its types, so it runs in the node test environment: the DOM
 * shapes it needs are the two methods below.
 */

/** The attribute that marks a region ⌘A selects as a whole. */
export const SELECT_SCOPE = "data-select-scope";
const SCOPE_SELECTOR = `[${SELECT_SCOPE}]`;

/** Error texts at least this long are clamped behind a disclosure. */
export const LONG_ERROR_CHARS = 120;

export function isLongError(text: string): boolean {
  return text.length > LONG_ERROR_CHARS;
}

/** The slice of `Element` the scope search needs. */
export type ScopeNode = {
  closest(selector: string): ScopeNode | null;
  querySelectorAll(selector: string): ArrayLike<ScopeNode>;
};

/**
 * The region ⌘A should select, from the places the user's attention could be, in order
 * of preference: what has focus, what was last pressed, where the selection already is.
 *
 * A candidate inside a scope answers with that scope. A candidate that *contains*
 * exactly one scope answers with it too, which is the modal sheet case: focus sits on
 * the sheet's panel, and the scope is its scrolling body. A candidate that contains
 * several is ambiguous and is skipped rather than guessed at. `null` when nothing
 * answers — the caller then selects nothing rather than the whole app.
 */
export function selectAllScope(candidates: readonly (ScopeNode | null | undefined)[]): ScopeNode | null {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const around = candidate.closest(SCOPE_SELECTOR);
    if (around) return around;
    const inside = candidate.querySelectorAll(SCOPE_SELECTOR);
    if (inside.length === 1) return inside[0] ?? null;
  }
  return null;
}

/** The modifier state of a key event, as far as select-all cares. */
export type SelectAllKey = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

/**
 * Whether a key event is the platform's select-all: ⌘A on a Mac, Ctrl+A elsewhere.
 * Either modifier is accepted on every platform, because the desktop webview and a
 * browser on a PC keyboard attached to a Mac disagree about which one is "primary".
 * Shift or Alt makes it a different shortcut.
 */
export function isSelectAll(event: SelectAllKey): boolean {
  if (event.altKey || event.shiftKey) return false;
  if (!(event.ctrlKey || event.metaKey)) return false;
  return event.key === "a" || event.key === "A";
}
