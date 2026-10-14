/**
 * What the user can choose about how Winnow looks: a mode and an accent.
 *
 * The names live in `core` rather than next to the palettes in `ui/theme.ts`, because
 * the store persists them and `core` does not import from `ui`. The colours themselves
 * are a `ui` concern and stay there; this file only knows the vocabulary.
 */

/**
 * The mode. `system` follows the OS (light or dark — never OLED, which is a choice a
 * person makes about their own screen, not something an OS reports). `oled` is the
 * true-black variant of dark.
 */
export const APPEARANCES = ["system", "light", "dark", "oled"] as const;
export type Appearance = (typeof APPEARANCES)[number];

/**
 * The accent themes, in the order the picker shows them. `space` is the default and
 * the app's own colour; the rest are a curated few, each tuned per mode in `theme.ts`.
 */
export const ACCENT_THEMES = ["space", "plum", "ember", "aurora"] as const;
export type AccentTheme = (typeof ACCENT_THEMES)[number];

export const DEFAULT_APPEARANCE: Appearance = "system";
export const DEFAULT_ACCENT_THEME: AccentTheme = "space";

export function isAppearance(value: unknown): value is Appearance {
  return typeof value === "string" && (APPEARANCES as readonly string[]).includes(value);
}

export function isAccentTheme(value: unknown): value is AccentTheme {
  return typeof value === "string" && (ACCENT_THEMES as readonly string[]).includes(value);
}
