/**
 * The account halo's colour from its own Google profile picture.
 *
 * The ring around an account's avatar (`AccountGlow`) takes the picture's most dominant
 * colour, so the open account reads by its own photo, and falls back to the account's
 * colour (the accent ring as before) when there is no picture or no colour in it.
 *
 * Two pure steps, so both are tested:
 *
 * 1. `dominantColor` — from the picture's RGBA pixels (sampled small by
 *    `ui/pictureCapture.ts` `canvasPictureColor`, from the kept `data:` copy). Pixels
 *    that are see-through, near-white, near-black or greyish say nothing about the photo
 *    (a white background, hair, shadow), so they are left out. What is left is counted in
 *    coarse hue/lightness bins; the busiest bin wins and its pixels are averaged. Too
 *    little colour (under `MIN_COLOURFUL_SHARE` of the opaque pixels) means none.
 * 2. `ringColor` — that colour moved in lightness only (hue and saturation kept) until
 *    it has `RING_CONTRAST` (3:1, WCAG 1.4.11 for a non-text UI graphic) against every
 *    plane of the theme the ring can sit on: light planes darken it, dark and OLED planes
 *    lighten it.
 *
 * The raw colour is what is kept per account (`AccountProfile.color`), and each theme
 * adjusts it when drawing, so switching Light / Dark / OLED needs no new read.
 */

import { contrastRatio as hexContrast, relativeLuminance } from "./color";
import { PALETTES, SURFACE_TOKENS, type ThemeName } from "./theme";

export type Rgb = { r: number; g: number; b: number };

/** WCAG 1.4.11: a UI graphic needs 3:1 against what it sits on. */
export const RING_CONTRAST = 3;

/** A picture whose colourful pixels are fewer than this share of its opaque ones has no colour. */
export const MIN_COLOURFUL_SHARE = 0.04;

/** Hue bins (30° each) and lightness bands per hue: coarse, so one colour is one bin. */
const HUE_BINS = 12;
const LIGHT_BANDS = 3;

/** What counts as near-white, near-black and greyish (HSL). */
const MIN_LIGHTNESS = 0.12;
const MAX_LIGHTNESS = 0.9;
const MIN_SATURATION = 0.2;
/** Chroma (max − min channel, 0–255) under this is grey whatever the HSL saturation says. */
const MIN_CHROMA = 24;

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

export function hslToRgb({ h, s, l }: { h: number; s: number; l: number }): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = l - c / 2;
  const [r, g, b] = rgb.map((v) => Math.round(Math.min(1, Math.max(0, v + m)) * 255)) as [number, number, number];
  return { r, g, b };
}

export function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

/** `#RRGGBB` (or `#RGB`) to RGB; anything else is `null`. */
export function parseHex(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let digits = m[1]!;
  if (digits.length === 3) digits = digits.replace(/./g, (c) => c + c);
  const n = Number.parseInt(digits, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Whether a stored colour is a plain `#RRGGBB` (what `dominantColor` hands back). */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

/** WCAG relative luminance (`color.ts`). */
export function luminance(rgb: Rgb): number {
  return relativeLuminance(toHex(rgb));
}

/** WCAG contrast ratio, 1–21 (`color.ts`). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  return hexContrast(toHex(a), toHex(b));
}

/** Whether a pixel says something about the picture's colour (not white, black or grey). */
export function isColourful(rgb: Rgb): boolean {
  const chroma = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
  if (chroma < MIN_CHROMA) return false;
  const { s, l } = rgbToHsl(rgb);
  return l >= MIN_LIGHTNESS && l <= MAX_LIGHTNESS && s >= MIN_SATURATION;
}

/**
 * The picture's most dominant colour as `#RRGGBB`, from RGBA bytes (canvas
 * `getImageData().data`), or `null` when it has too little colour to pick one.
 */
export function dominantColor(rgba: ArrayLike<number>): string | null {
  type Bin = { count: number; r: number; g: number; b: number };
  const bins = new Map<number, Bin>();
  let opaque = 0;
  let colourful = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3]!;
    if (a < 128) continue;
    opaque++;
    const px = { r: rgba[i]!, g: rgba[i + 1]!, b: rgba[i + 2]! };
    if (!isColourful(px)) continue;
    colourful++;
    const { h, l } = rgbToHsl(px);
    const hueBin = Math.floor(h / (360 / HUE_BINS)) % HUE_BINS;
    const band = Math.min(LIGHT_BANDS - 1, Math.floor(((l - MIN_LIGHTNESS) / (MAX_LIGHTNESS - MIN_LIGHTNESS)) * LIGHT_BANDS));
    const key = hueBin * LIGHT_BANDS + band;
    const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bin.count++;
    bin.r += px.r;
    bin.g += px.g;
    bin.b += px.b;
    bins.set(key, bin);
  }
  if (opaque === 0 || colourful / opaque < MIN_COLOURFUL_SHARE) return null;
  let best: Bin | null = null;
  for (const bin of bins.values()) if (!best || bin.count > best.count) best = bin;
  if (!best) return null;
  return toHex({ r: best.r / best.count, g: best.g / best.count, b: best.b / best.count });
}

/** The opaque planes of a theme the halo can sit on. */
export function planesOf(scheme: ThemeName): Rgb[] {
  const color = PALETTES[scheme].color as Record<string, string>;
  return SURFACE_TOKENS.map((token) => parseHex(color[token] ?? "")).filter((rgb): rgb is Rgb => rgb !== null);
}

function minContrast(rgb: Rgb, planes: readonly Rgb[]): number {
  return Math.min(...planes.map((plane) => contrastRatio(rgb, plane)));
}

/**
 * `colour` moved in lightness only until it has `target` contrast against every plane:
 * darker on light planes, lighter on dark ones. Hue and saturation are kept, so the
 * halo still reads as the picture's colour. A colour that already passes is unchanged.
 */
export function adjustForContrast(colour: Rgb, planes: readonly Rgb[], target = RING_CONTRAST): Rgb {
  if (planes.length === 0 || minContrast(colour, planes) >= target) return colour;
  const meanPlane = planes.reduce((sum, plane) => sum + luminance(plane), 0) / planes.length;
  const darken = meanPlane > 0.18;
  const hsl = rgbToHsl(colour);
  // Bisect lightness between the colour's own and the far end (black or white), for the
  // smallest move that passes.
  let pass = darken ? 0 : 1;
  let fail = hsl.l;
  for (let i = 0; i < 24; i++) {
    const mid = (pass + fail) / 2;
    if (minContrast(hslToRgb({ ...hsl, l: mid }), planes) >= target) pass = mid;
    else fail = mid;
  }
  return hslToRgb({ ...hsl, l: pass });
}

/**
 * The halo for a picture colour (`#RRGGBB`, from `dominantColor`) in a theme, with 3:1
 * against every plane of that theme, or `null` when there is no picture colour (the
 * caller then draws the account colour, as before).
 */
export function ringColor(pictureColor: string | null | undefined, scheme: ThemeName): string | null {
  if (!pictureColor) return null;
  const rgb = parseHex(pictureColor);
  if (!rgb) return null;
  return toHex(adjustForContrast(rgb, planesOf(scheme)));
}
