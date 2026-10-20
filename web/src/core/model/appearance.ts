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
 * The accent themes, in the order the picker shows them: round the colour wheel from
 * Space (violet) through the warm hues and back via the cool ones, with Graphite, the
 * near-neutral, last. `space` is the default and the app's own colour; the rest are a
 * curated few, each tuned per mode in `theme.ts`.
 */
export const ACCENT_THEMES = ["space", "plum", "rose", "ember", "green", "aurora", "blue", "graphite"] as const;
export type AccentTheme = (typeof ACCENT_THEMES)[number];

/**
 * The picker's last choice (1.4.0): any colour the user picks, stored as a hex in the
 * `accentCustom` preference and made safe per mode by `ui/customAccent.ts`. Not one of
 * `ACCENT_THEMES`, which are the curated, hand-tuned set.
 */
export const CUSTOM_ACCENT = "custom" as const;

/** What the `accent` preference can hold: a curated theme or `custom`. */
export type AccentPreference = AccentTheme | typeof CUSTOM_ACCENT;

export const DEFAULT_APPEARANCE: Appearance = "system";
export const DEFAULT_ACCENT_THEME: AccentTheme = "space";

/** The custom colour before one is picked: Space's own violet, so the picker opens on it. */
export const DEFAULT_ACCENT_CUSTOM = "#5028E2";

export function isAppearance(value: unknown): value is Appearance {
  return typeof value === "string" && (APPEARANCES as readonly string[]).includes(value);
}

export function isAccentTheme(value: unknown): value is AccentTheme {
  return typeof value === "string" && (ACCENT_THEMES as readonly string[]).includes(value);
}

export function isAccentPreference(value: unknown): value is AccentPreference {
  return value === CUSTOM_ACCENT || isAccentTheme(value);
}

/**
 * A stored custom colour, normalised to `#RRGGBB` upper case, or null. Accepts `#RGB` and
 * `#RRGGBB` with or without the `#` (what a person might type); anything else, including
 * `rgb()`, names and alpha, is rejected rather than guessed at.
 */
export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${[...raw].map((c) => c + c).join("")}`.toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw}`.toUpperCase();
  return null;
}
