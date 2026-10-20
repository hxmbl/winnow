/**
 * Colour arithmetic, with no palette in it: WCAG luminance and contrast, compositing a
 * translucent colour over an opaque one, and the HSL and OKLCH conversions the theme
 * and the custom accent (`customAccent.ts`) are built from.
 *
 * Its own module so `customAccent.ts` can use it without importing `theme.ts` (which
 * imports the custom accent): `theme.ts` re-exports the parts its callers and tests use.
 */

/** WCAG relative luminance of an `#RRGGBB` colour, 0–1. */
export function relativeLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const channel = (shift: number): number => {
    const raw = (value >> shift) & 255;
    const c = raw / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0);
}

/** The WCAG contrast ratio between two `#RRGGBB` colours, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const first = relativeLuminance(a);
  const second = relativeLuminance(b);
  const [high, low] = first > second ? [first, second] : [second, first];
  return (high + 0.05) / (low + 0.05);
}

/** HSL (degrees, percent, percent) → `[r, g, b]`, 0–255 unrounded, as CSS computes it. */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number): number => {
    const k = (n + h / 30) % 12;
    return 255 * (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [channel(0), channel(8), channel(4)];
}

/** `#hex` or `rgba()` → `[r, g, b, a]`. */
export function parseColor(value: string): [number, number, number, number] {
  if (value.startsWith("#")) {
    const n = Number.parseInt(value.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

/** `[r, g, b]` (0–255, clamped and rounded) → lower-case `#rrggbb`. */
export function toHex([r, g, b]: readonly number[]): string {
  return `#${[r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("")}`;
}

/** Paint `top` (any `#hex` or `rgba()` token) over an opaque `#hex`. */
export function composite(top: string, base: string): string {
  const [r, g, b, a] = parseColor(top);
  const [br, bg, bb] = parseColor(base);
  return toHex([r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)]);
}

/** `#RRGGBB` at an alpha, as `rgba()`. */
export function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** HSL hue in degrees (0–360) and saturation (0–1) of an `#RRGGBB`, as CSS defines them. */
export function hueAndSaturation(hex: string): { hue: number; saturation: number } {
  const [r, g, b] = parseColor(hex).slice(0, 3).map((value) => value / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return { hue: 0, saturation: 0 };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return { hue: (hue * 60 + 360) % 360, saturation };
}

/** The shorter way round the wheel between two hues, 0–180. */
export function hueGap(a: number, b: number): number {
  const gap = Math.abs(a - b) % 360;
  return gap > 180 ? 360 - gap : gap;
}

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** An OKLCH colour: perceptual lightness 0–1, chroma (0 to about 0.37), hue in degrees. */
export type Oklch = { l: number; c: number; h: number };

/** `#RRGGBB` → OKLCH (Björn Ottosson's matrices, sRGB D65). */
export function hexToOklch(hex: string): Oklch {
  const [r, g, b] = parseColor(hex).slice(0, 3).map((value) => toLinear(value / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const c = Math.hypot(A, B);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

/** OKLCH → gamma-encoded sRGB channels 0–1, unclamped (out of gamut if any is outside 0–1). */
function oklchToRgb({ l, c, h }: Oklch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    fromLinear(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    fromLinear(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
  ];
}

/**
 * OKLCH → `#RRGGBB`, mapped into sRGB by lowering chroma at the same lightness and hue
 * (rather than clipping each channel, which shifts the hue) until the colour fits.
 */
export function oklchToHex(colour: Oklch): string {
  const inGamut = (rgb: number[]) => rgb.every((v) => Number.isFinite(v) && v >= -0.0005 && v <= 1.0005);
  let rgb = oklchToRgb(colour);
  if (!inGamut(rgb)) {
    let low = 0;
    let high = colour.c;
    for (let step = 0; step < 24; step += 1) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToRgb({ ...colour, c: mid }))) low = mid;
      else high = mid;
    }
    rgb = oklchToRgb({ ...colour, c: low });
  }
  return toHex(rgb.map((v) => v * 255)).toUpperCase();
}

/** How far apart two colours look: the Euclidean distance in OKLab (about 0.02 is a just-visible step). */
export function oklabDistance(a: string, b: string): number {
  const [x, y] = [hexToOklch(a), hexToOklch(b)];
  const ax = x.c * Math.cos((x.h * Math.PI) / 180);
  const ay = x.c * Math.sin((x.h * Math.PI) / 180);
  const bx = y.c * Math.cos((y.h * Math.PI) / 180);
  const by = y.c * Math.sin((y.h * Math.PI) / 180);
  return Math.hypot(x.l - y.l, ax - bx, ay - by);
}
