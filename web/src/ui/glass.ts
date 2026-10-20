/**
 * The floating glass: on a phone the dock pill, the menu panel it grows into, and the
 * smart-filter chips that float above it; on the desktop the list's floating top bar
 * (search, where-you-are, Compose), its chips and the selection bar.
 *
 * One universal recipe since 1.4 (`.wn-glass` in `index.css`): a translucent tint of the
 * mode's glass base with a light frost (`GLASS_BLUR`, `--wn-glass-filter`) straight on the
 * element, a hairline edge and a soft shadow that lifts it off the list. The frost is
 * light on purpose (the owner's ask): rows and colours stay perceptible as they pass
 * underneath, and the tint, not the blur, is what keeps the words on the glass readable.
 * (A glass that opens a fixed menu from inside itself, `.wn-glass-behind`, carries the
 * same tint and frost on an inset `::before`: on the element, a backdrop-filter would
 * make it the menu's containing block.)
 *
 * Two opacities per mode. `rim` is the frost itself, at a chip's rounded ends and
 * around the dock's icons. `text` (and `textOn` for a chip that is on) is the tint
 * behind words: a chip's label and count, the panel's rows, the dock's icons. It is
 * the lowest opacity that keeps every chip label at AA (4.5:1) over the worst
 * backdrop that can slide under it (`WORST_BACKDROPS`), which `glass.test.ts` checks
 * against the real pill arithmetic (`pillFill`). Only that zone is raised; the rim
 * stays light.
 *
 * Liquid Glass (`.wn-liquid`, `LIQUID`) is the same tint and frost with a lit rim, a
 * sheen across the face and, in Chromium, an edge-only refraction (`LIQUID_FILTER`, the
 * SVG filter `#wn-liquid` in `index.html`). It is for the small floating chrome: the
 * dock pill, the compose circle, the filter chips, the reader pill, the desktop's
 * floating top bar and the status pill. Large panels (the phone's menu panel, sheets)
 * stay lean.
 *
 * Behind it all, each accent washes the list's backdrop faintly in its own hue (`WASH`,
 * `.wn-backdrop`), so the glass has a colour to frost: Plum reads plum through it.
 *
 * Published as `--wn-glass-*`, `--wn-liquid-*` and `--wn-wash-*` by `applyTheme`, combined
 * in `index.css`. Without `backdrop-filter` the tint is `fallback` instead.
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

/** The light frost, on the glass itself (`--wn-glass-filter` in `index.css`). */
export const GLASS_BLUR = "blur(6px) saturate(1.8)";

/** The blur radius, in px, of a `backdrop-filter` value such as `GLASS_BLUR`. */
export function blurRadius(filter: string): number {
  const match = /blur\(\s*([\d.]+)px\s*\)/.exec(filter);
  return match ? Number(match[1]) : 0;
}

export const GLASS: Record<ThemeName, GlassRecipe> = {
  // Dark ink on a pale tint: the worst backdrop is something dark (the accent, an avatar).
  light: { base: "surface", rim: 0.62, text: 0.72, textOn: 0.76, bar: 0.72, fallback: 0.94 },
  // Light ink: the worst is something bright. The canvas (darker than the surface) is
  // the base, so the frost is a shade darker than the list and the ink keeps its edge.
  dark: { base: "canvas", rim: 0.62, text: 0.68, textOn: 0.84, bar: 0.76, fallback: 0.94 },
  oled: { base: "surface", rim: 0.62, text: 0.62, textOn: 0.74, bar: 0.68, fallback: 0.94 },
};

/**
 * What can slide under the glass, per mode: the accents of every accent theme at full
 * strength (an avatar, a selected row, a button), and for the extreme, black (light
 * mode) or white (the dark modes) covering 60% of the glass with the list's surface
 * between: a line of row text is strokes a pixel or two wide, and even the light frost
 * spreads each over a dozen, so nothing in the list arrives closer to solid than that.
 * `glass.test.ts` holds every chip, rest and on, to AA over each.
 *
 * The reader pill also floats over a message, where a photo can be solid black or
 * white; it carries icons only, which `SOLID_BACKDROPS` holds to 3:1.
 */
export const WORST_BACKDROPS: Record<ThemeName, readonly string[]> = {
  light: ["#5028E2", "#74306A", "#9A430C", "#096863", "black@0.6"],
  dark: ["#B9A5FF", "#D4A3CE", "#F0964F", "#5ED6C5", "white@0.6"],
  oled: ["#B9A5FF", "#D4A3CE", "#F0964F", "#5ED6C5", "white@0.6"],
};

/** Solid extremes, for icon-only glass over a message (the reader pill, the dock). */
export const SOLID_BACKDROPS: readonly string[] = ["black", "white"];

export type LiquidRecipe = {
  /**
   * The sheen's white at its brightest (the top-left corner of the face), 0–1. It lies
   * over the tint, so in the dark modes it lifts the plate toward the ink: the tests
   * hold every label to AA with it at full strength.
   */
  sheen: number;
  /** The lit top-left rim (1px, inset), white at this opacity. */
  rimLight: number;
  /** The soft bottom-right rim. */
  rimShade: number;
  /** A faint inner glow around the edge (12px, inset), white at this opacity. */
  glow: number;
};

export const LIQUID: Record<ThemeName, LiquidRecipe> = {
  // Dark ink on a pale tint: white over it only adds contrast, so the sheen can be bright.
  light: { sheen: 0.32, rimLight: 0.9, rimShade: 0.35, glow: 0.18 },
  // Light ink: any white over the words lifts the plate toward the ink, and the tints
  // above are already the lowest that keep AA. So no sheen or glow: the rim and the bend.
  dark: { sheen: 0, rimLight: 0.32, rimShade: 0.1, glow: 0 },
  oled: { sheen: 0, rimLight: 0.26, rimShade: 0.08, glow: 0 },
};

/**
 * The refraction (`#wn-liquid` in `index.html`, Chromium only). The edge map is built
 * inside the filter from the glass's own box, in px (`userSpaceOnUse`), so the bend is
 * the same on a 40px chip and a 390px dock: within `edge` px of a side the backdrop is
 * pulled inward, up to `scale / 2` px at the very edge, and the middle is untouched.
 * `fringe` splits the bend per colour channel (red, green, blue) for a faint chromatic
 * edge. Only the backdrop bends, never the glass's own text, and the tint over it still
 * carries the AA arithmetic above.
 *
 * (The first draft painted the map as an image with `primitiveUnits="objectBoundingBox"`:
 * in Chromium that stretched its edge band with the box, resolved `scale` against the
 * box's width for both axes, so a wide dock bent ~7px vertically while a 60px circle bent
 * ~2px, and it pulled from outside the box, folding mirrored pixels into the rim.)
 */
export const LIQUID_FILTER = {
  /** Blur (px) of the box's edge before it is differentiated: the softness of the bend. */
  softness: 5,
  /** Half-width (px) of the difference taken across the softened edge: the band. */
  edge: 3,
  /** How hard the edge's slope drives the map (the arithmetic `k2`/`k3`). */
  gain: 1,
  /** Displacement scale per channel, red, green, blue (px; the bend is half of it). */
  fringe: [16, 14.5, 13] as const,
} as const;

/** The largest bend, in px, at the very edge of the glass. */
export function liquidMaxBend(): number {
  return Math.max(...LIQUID_FILTER.fringe) / 2;
}

/**
 * The compose circle, which is the accent rather than a neutral tint: the accent at this
 * opacity, so a little of the list shows through its liquid edge while its icon (text on
 * the accent) keeps 3:1 over anything.
 */
export const COMPOSE_TINT = 0.86;

/** The compose circle's sheen: faint, since its icon is white on the light accents. */
export const COMPOSE_SHEEN = 0.08;

/**
 * The accent's wash over the list's backdrop (`.wn-backdrop` in `index.css`): two soft
 * radial glows of the accent, `near` (behind the top bar, top right) and `far` (behind
 * the dock and chips, bottom left), as opacity over the surface. Faint enough that every
 * row ink keeps AA on the washed surface at its strongest point (`glass.test.ts`); OLED
 * stays near black.
 */
export const WASH: Record<ThemeName, { near: number; far: number }> = {
  light: { near: 0.14, far: 0.12 },
  dark: { near: 0.12, far: 0.11 },
  oled: { near: 0.1, far: 0.08 },
};

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** The custom properties `applyTheme` publishes for a mode, given its colours. */
export function glassProperties(scheme: ThemeName, color: Record<string, string>): Record<string, string> {
  const recipe = GLASS[scheme];
  const liquid = LIQUID[scheme];
  const wash = WASH[scheme];
  return {
    "--wn-glass-base": color[recipe.base],
    "--wn-glass-rim": pct(recipe.rim),
    "--wn-glass-text": pct(recipe.text),
    "--wn-glass-text-on": pct(recipe.textOn),
    "--wn-glass-bar": pct(recipe.bar),
    "--wn-glass-fallback": pct(recipe.fallback),
    "--wn-liquid-sheen": pct(liquid.sheen),
    "--wn-liquid-rim-light": pct(liquid.rimLight),
    "--wn-liquid-rim-shade": pct(liquid.rimShade),
    "--wn-liquid-glow": pct(liquid.glow),
    "--wn-liquid-accent": pct(COMPOSE_TINT),
    "--wn-liquid-accent-sheen": pct(COMPOSE_SHEEN),
    "--wn-wash-near": pct(wash.near),
    "--wn-wash-far": pct(wash.far),
  };
}
