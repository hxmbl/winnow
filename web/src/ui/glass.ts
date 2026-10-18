/**
 * The floating glass: on a phone the dock pill, the menu panel it grows into, and the
 * smart-filter chips that float above it; on the desktop the list's floating top bar
 * (search, where-you-are, Compose), its chips and the selection bar.
 *
 * Light frost, not heavy: a modest `backdrop-filter` (`GLASS_BLUR`) over a translucent
 * tint of the mode's glass base, so rows and colours stay perceptible as they scroll
 * underneath. A hairline edge and a soft shadow lift it off the list.
 *
 * Two opacities per mode. `rim` is the frost itself, at a chip's rounded ends and
 * around the dock's icons. `text` (and `textOn` for a chip that is on) is the tint
 * behind words: a chip's label and count, the panel's rows, the dock's icons. It is
 * the lowest opacity that keeps every chip label at AA (4.5:1) over the worst
 * backdrop that can slide under it (`WORST_BACKDROPS`), which `glass.test.ts` checks
 * against the real pill arithmetic (`pillFill`). Only that zone is raised; the rim
 * stays light.
 *
 * Published as `--wn-glass-*` by `applyTheme`, combined in `index.css` (`.wn-glass`,
 * `.wn-glass-bar`, `.wn-chip-glass`). Without `backdrop-filter` the tint is `fallback` instead.
 */

import type { ThemeName } from "./theme";

export type GlassRecipe = {
  /** The palette colour the tint is made of. */
  base: "surface" | "canvas";
  /** Frost opacity at the edges, 0–1. */
  rim: number;
  /** Opacity behind text and icons, 0–1. */
  text: number;
  /** Behind the label of a chip that is on, whose stronger hue needs more. */
  textOn: number;
  /**
   * The desktop's floating bars (the list's top bar, the selection bar). They carry
   * secondary text across their whole face ("of 39", the list's name), which needs
   * `inkMuted` at AA rather than the 3:1 an icon needs, so their tint can sit higher.
   */
  bar: number;
  /** With no `backdrop-filter` there is no frost to read through: nearly opaque. */
  fallback: number;
};

export const GLASS_BLUR = "blur(12px) saturate(1.3)";

export const GLASS: Record<ThemeName, GlassRecipe> = {
  // Dark ink on a pale tint: the worst backdrop is something dark (the accent, an avatar).
  light: { base: "surface", rim: 0.62, text: 0.72, textOn: 0.76, bar: 0.72, fallback: 0.94 },
  // Light ink: the worst is something bright. The canvas (darker than the surface) is
  // the base, so the frost is a shade darker than the list and the ink keeps its edge.
  dark: { base: "canvas", rim: 0.62, text: 0.68, textOn: 0.84, bar: 0.78, fallback: 0.94 },
  oled: { base: "surface", rim: 0.62, text: 0.62, textOn: 0.74, bar: 0.68, fallback: 0.94 },
};

/**
 * What can slide under the glass, per mode, already as it arrives through the blur: the
 * accents of every accent theme at full strength (an avatar, a selected row), and for
 * the extreme, black (light mode) or white (the dark modes) covering 60% of the chip
 * with the list's surface between: through a 12px blur, nothing in the list comes
 * closer to solid than that.
 * `glass.test.ts` holds every chip, rest and on, to AA over each.
 */
export const WORST_BACKDROPS: Record<ThemeName, readonly string[]> = {
  light: ["#5028E2", "#74306A", "#A2470D", "#0A6E68", "black@0.6"],
  dark: ["#B9A5FF", "#D4A3CE", "#F0964F", "#5ED6C5", "white@0.6"],
  oled: ["#B9A5FF", "#D4A3CE", "#F0964F", "#5ED6C5", "white@0.6"],
};

/** The custom properties `applyTheme` publishes for a mode, given its colours. */
export function glassProperties(scheme: ThemeName, color: Record<string, string>): Record<string, string> {
  const recipe = GLASS[scheme];
  return {
    "--wn-glass-base": color[recipe.base],
    "--wn-glass-rim": `${Math.round(recipe.rim * 100)}%`,
    "--wn-glass-text": `${Math.round(recipe.text * 100)}%`,
    "--wn-glass-text-on": `${Math.round(recipe.textOn * 100)}%`,
    "--wn-glass-bar": `${Math.round(recipe.bar * 100)}%`,
    "--wn-glass-fallback": `${Math.round(recipe.fallback * 100)}%`,
  };
}
