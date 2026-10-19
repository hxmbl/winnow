/**
 * The Settings screen's behaviour, as pure functions the tests can drive without a DOM.
 *
 * - Which layout a width gets: three columns (categories, controls, explanation) from
 *   1200px, two columns (categories, controls, with a (?) per row) below that, and on a
 *   phone a category list that opens one category page at a time.
 * - The category list's selection and its arrow keys.
 * - The explanation panel: the category's intro until a setting is pointed at (hover or
 *   keyboard focus), then the last setting pointed at. Leaving a row does not clear it.
 * - The (?) popover used below 1200px: hover and focus show it, a click or tap pins it,
 *   Escape and a tap elsewhere close it, and it is placed inside the viewport.
 */

import { CATEGORIES, SETTINGS, categoryOf, type CategoryId, type SettingId } from "./settingsCatalog";

// ── Layout ──────────────────────────────────────────────────────────────────

export type SettingsLayout = "three" | "two" | "phone";

/** The width at which the explanation gets its own column. */
export const WIDE_SETTINGS_MIN = 1200;
/** The phone layout's width, shared with `usePhoneLayout` (below Tailwind's `sm`). */
export const PHONE_MAX = 639;

export function settingsLayoutFor(width: number): SettingsLayout {
  if (width <= PHONE_MAX) return "phone";
  return width >= WIDE_SETTINGS_MIN ? "three" : "two";
}

/**
 * The category column's width on the desktop layouts: about a seventh of the window,
 * never so narrow that the longest category name ("Hidden & muted senders") wraps
 * (212px, with room for font differences) nor wider than the names need (248px).
 * The controls and the explanation share the rest, controls first.
 */
export const SETTINGS_NAV_WIDTH = "clamp(212px, 15vw, 248px)";

/** `grid-template-columns` for a desktop layout (the phone has no columns). */
export function settingsColumns(layout: Exclude<SettingsLayout, "phone">): string {
  return layout === "three"
    ? `${SETTINGS_NAV_WIDTH} minmax(0, 60fr) minmax(0, 40fr)`
    : `${SETTINGS_NAV_WIDTH} minmax(0, 1fr)`;
}

/** The category column's width in px at a window width, for tests (mirrors the clamp). */
export function settingsNavWidthAt(windowWidth: number): number {
  return Math.min(240, Math.max(160, windowWidth * 0.125));
}

// ── Categories ──────────────────────────────────────────────────────────────

/** Arrow keys in the category list. Wraps; returns the current id for any other key. */
export function moveCategory(
  visible: readonly CategoryId[],
  current: CategoryId,
  key: string,
): CategoryId {
  if (visible.length === 0) return current;
  const index = Math.max(0, visible.indexOf(current));
  switch (key) {
    case "ArrowDown":
      return visible[(index + 1) % visible.length];
    case "ArrowUp":
      return visible[(index - 1 + visible.length) % visible.length];
    case "Home":
      return visible[0];
    case "End":
      return visible[visible.length - 1];
    default:
      return current;
  }
}

/** Every category, in order. A function so a host could one day hide one. */
export function visibleCategories(): CategoryId[] {
  return CATEGORIES.map((category) => category.id);
}

// ── Explanation panel ───────────────────────────────────────────────────────

export type ExplainState = {
  category: CategoryId;
  /** The last setting pointed at in this category, or null for the intro. */
  pointed: SettingId | null;
};

export function initialExplain(category: CategoryId = "reading"): ExplainState {
  return { category, pointed: null };
}

/** Choosing a category shows its intro, until something in it is pointed at. */
export function selectCategory(state: ExplainState, category: CategoryId): ExplainState {
  if (state.category === category) return state;
  return { category, pointed: null };
}

/**
 * Hover or keyboard focus entered a setting's row. Ignored for a setting outside the
 * current category (a stray event from a page being swapped out), and returns the same
 * object when nothing changes, so React skips the render.
 */
export function pointAt(state: ExplainState, setting: SettingId): ExplainState {
  if (SETTINGS[setting].category !== state.category) return state;
  if (state.pointed === setting) return state;
  return { ...state, pointed: setting };
}

/** The pointer or focus left a row: the explanation stays where it is, by design. */
export function pointerLeft(state: ExplainState): ExplainState {
  return state;
}

export type Explanation = {
  kind: "intro" | "setting";
  /** The setting's id, or null for the intro. */
  setting: SettingId | null;
  title: string;
  body: string;
};

export function explanationFor(state: ExplainState): Explanation {
  if (state.pointed) {
    const definition = SETTINGS[state.pointed];
    return { kind: "setting", setting: state.pointed, title: definition.label, body: definition.explanation };
  }
  const category = categoryOf(state.category);
  return { kind: "intro", setting: null, title: category.label, body: category.intro };
}

// ── The (?) popover ─────────────────────────────────────────────────────────

export type InfoState = {
  open: SettingId | null;
  /** Opened by a click or tap, so leaving the button does not close it. */
  pinned: boolean;
};

export type InfoEvent =
  | { type: "hover"; setting: SettingId }
  | { type: "unhover"; setting: SettingId }
  | { type: "focus"; setting: SettingId }
  | { type: "blur"; setting: SettingId }
  | { type: "press"; setting: SettingId }
  | { type: "escape" }
  | { type: "outside" };

export const INFO_CLOSED: InfoState = { open: null, pinned: false };

export function infoReducer(state: InfoState, event: InfoEvent): InfoState {
  switch (event.type) {
    case "hover":
    case "focus":
      // A pinned popover for another row gives way; the same row keeps its pin.
      if (state.open === event.setting) return state;
      return { open: event.setting, pinned: false };
    case "unhover":
    case "blur":
      if (state.open !== event.setting || state.pinned) return state;
      return INFO_CLOSED;
    case "press":
      // A press on an open, unpinned popover (the hover or focus that came with a
      // click) pins it rather than closing it; a press on a pinned one closes it.
      if (state.open === event.setting) return state.pinned ? INFO_CLOSED : { open: event.setting, pinned: true };
      return { open: event.setting, pinned: true };
    case "escape":
    case "outside":
      return state.open === null ? state : INFO_CLOSED;
  }
}

export type Rect = { top: number; left: number; width: number; height: number };

export type PopoverPlacement = { top: number; left: number; width: number; side: "below" | "above" };

/**
 * Where the popover goes: below its button if it fits, else above, else whichever side
 * has more room; horizontally aligned to the button and clamped so it never leaves the
 * viewport (with `margin` to spare). Width is `preferredWidth`, or the viewport less the
 * margins if that is narrower.
 */
export function placePopover(
  anchor: Rect,
  height: number,
  viewport: { width: number; height: number },
  preferredWidth = 320,
  margin = 8,
  gap = 6,
): PopoverPlacement {
  const width = Math.max(0, Math.min(preferredWidth, viewport.width - margin * 2));
  const below = anchor.top + anchor.height + gap;
  const roomBelow = viewport.height - margin - below;
  const roomAbove = anchor.top - gap - margin;
  const side: PopoverPlacement["side"] =
    height <= roomBelow ? "below" : height <= roomAbove ? "above" : roomBelow >= roomAbove ? "below" : "above";
  let top = side === "below" ? below : anchor.top - gap - height;
  top = Math.min(Math.max(top, margin), Math.max(margin, viewport.height - margin - height));
  let left = anchor.left + anchor.width / 2 - width / 2;
  left = Math.min(Math.max(left, margin), viewport.width - margin - width);
  return { top: Math.round(top), left: Math.round(left), width: Math.round(width), side };
}
