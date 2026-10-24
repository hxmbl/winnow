/**
 * Email dark mode (1.4.0): a message body drawn in the reader's dark or OLED theme
 * instead of as a white card on a dark app, the way Apple Mail, Gmail and Outlook do.
 *
 * Two paths, chosen per message by [`emailDarkMode`]:
 *
 *   - **`own`** — the message ships its own dark styles (an `@media (prefers-color-scheme:
 *     dark)` block). They are honoured: `scopedSheet.ts` unwraps the block so its rules
 *     apply whenever the reader is dark (the app's theme, not the OS, decides), and the
 *     sender's other colours are left exactly as written, as Apple Mail does.
 *   - **`adaptive`** — everything else. Outlook/Gmail-style *partial* inversion, never a
 *     blunt CSS `invert()`: every colour the sender wrote is re-mapped in OKLCH, keeping
 *     its hue.
 *       - Light, near-neutral backgrounds become the theme's dark surface (white → the
 *         surface itself; light greys a step above it, so a grey frame around a white
 *         card stays a visible frame). OLED's surface is true black.
 *       - Vivid light backgrounds (a brand blue hero, an amber button) keep their hue
 *         and chroma but drop to OKLCH L ≤ 0.48, so light text reads on them.
 *       - Dark and mid backgrounds (a navy footer, a black button) are kept.
 *       - Text: dark ink is lightness-flipped (black → near white, #555 → light grey),
 *         light ink kept, and every result is lifted until it clears WCAG AA (4.5:1)
 *         against the theme surface, and against the element's own background when the
 *         same declaration block or element sets one.
 *       - Light borders become dark-but-visible hairlines.
 *     `[data-ogsc]`/`[data-ogsb]` rules (Outlook.com's "after we recoloured you" hooks)
 *     are applied on top, unrecoloured.
 *
 * Images are never touched: no `filter`, no inversion of photos or logos. Light mode
 * is unchanged: nothing here runs unless the reader is dark and the setting is on.
 *
 * Pure: strings in, strings out, no DOM, so `core/`'s node tests cover all of it.
 */

/** The theme colours a recoloured message is drawn against. All `#RRGGBB`. */
export type DarkPalette = {
  /** The card the message sits on, and what white becomes. */
  surface: string;
  /** Text with no colour of its own. */
  ink: string;
  /** A link with no colour of its own. */
  link: string;
};

/** Dark: the reader's own surface and ink (see `ui/theme.ts`). */
export const DARK_EMAIL_PALETTE: DarkPalette = { surface: "#252525", ink: "#E3E3E3", link: "#8AB4F8" };
/** OLED: the lights all the way off. */
export const OLED_EMAIL_PALETTE: DarkPalette = { surface: "#000000", ink: "#E3E3E3", link: "#8AB4F8" };

/** WCAG AA for body text. */
export const AA = 4.5;

/** Above this OKLCH lightness a background counts as light and is re-mapped. */
const LIGHT_BG = 0.48;
/** Chroma at or above which a light background is a brand colour, not paper. */
const VIVID = 0.07;
/** The lightest a re-mapped neutral background may become, so light text reads on it. */
const BG_CAP = 0.46;

// ── Colour parsing ──────────────────────────────────────────────────────────

/** sRGB 0–255 per channel (unrounded allowed), alpha 0–1. */
export type Rgba = { r: number; g: number; b: number; a: number };

/**
 * The named colours that turn up in mail. Not all 148: the ones senders write. A
 * name not here is left as written, which is the safe direction (it is simply not
 * recoloured).
 */
const NAMED: Record<string, string> = {
  white: "#ffffff", black: "#000000", red: "#ff0000", green: "#008000", blue: "#0000ff",
  yellow: "#ffff00", orange: "#ffa500", purple: "#800080", gray: "#808080", grey: "#808080",
  silver: "#c0c0c0", navy: "#000080", teal: "#008080", maroon: "#800000", olive: "#808000",
  lime: "#00ff00", aqua: "#00ffff", fuchsia: "#ff00ff", whitesmoke: "#f5f5f5",
  gainsboro: "#dcdcdc", lightgray: "#d3d3d3", lightgrey: "#d3d3d3", darkgray: "#a9a9a9",
  darkgrey: "#a9a9a9", dimgray: "#696969", dimgrey: "#696969", ghostwhite: "#f8f8ff",
  snow: "#fffafa", ivory: "#fffff0", beige: "#f5f5dc", linen: "#faf0e6",
  aliceblue: "#f0f8ff", lavender: "#e6e6fa", honeydew: "#f0fff0", mintcream: "#f5fffa",
  azure: "#f0ffff", seashell: "#fff5ee", floralwhite: "#fffaf0", oldlace: "#fdf5e6",
  cornsilk: "#fff8dc", lightyellow: "#ffffe0", lightblue: "#add8e6", darkblue: "#00008b",
  darkred: "#8b0000", darkgreen: "#006400", royalblue: "#4169e1", steelblue: "#4682b4",
  dodgerblue: "#1e90ff", crimson: "#dc143c", gold: "#ffd700", tomato: "#ff6347",
  coral: "#ff7f50", slategray: "#708090", slategrey: "#708090", darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f", lightslategray: "#778899", lightslategrey: "#778899",
};

const NAMED_PATTERN = Object.keys(NAMED).sort((a, b) => b.length - a.length).join("|");

/** Every colour token in a CSS value: hex, rgb[a](), hsl[a](), or a known name. */
const COLOR_TOKEN = new RegExp(
  `#[0-9a-fA-F]{3,8}(?![0-9a-zA-Z_-])|\\b(?:rgba?|hsla?)\\([^()]*\\)|(?<![\\w#.-])(?:${NAMED_PATTERN})(?![\\w-])`,
  "gi",
);

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function hue2rgb(p: number, q: number, t: number): number {
  let x = t;
  if (x < 0) x += 1;
  if (x > 1) x -= 1;
  if (x < 1 / 6) return p + (q - p) * 6 * x;
  if (x < 1 / 2) return q;
  if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
  return p;
}

/** One numeric CSS argument: `12`, `12%` (of `scale`), `.5`. NaN when not a number. */
function cssNumber(raw: string, scale: number): number {
  const text = raw.trim();
  if (text.endsWith("%")) return (Number.parseFloat(text) / 100) * scale;
  return Number.parseFloat(text);
}

/** Parse a CSS colour. Null for anything that is not a concrete colour we know. */
export function parseColor(input: string): Rgba | null {
  const text = input.trim().toLowerCase();
  if (text in NAMED) return parseColor(NAMED[text]);
  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a] = [...h].map((c) => Number.parseInt(c + c, 16));
      return { r, g, b, a: h.length === 4 ? a / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
      return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
    }
    return null;
  }
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(text);
  if (!fn) return null;
  // Both syntaxes: `rgb(1, 2, 3, .5)` and `rgb(1 2 3 / .5)`.
  const parts = fn[2].replace(/\//g, " ").split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length < 3 || parts.length > 4) return null;
  const alpha = parts.length === 4 ? clamp(cssNumber(parts[3], 1), 0, 1) : 1;
  if (Number.isNaN(alpha)) return null;
  if (fn[1].startsWith("rgb")) {
    const [r, g, b] = parts.slice(0, 3).map((p) => clamp(cssNumber(p, 255), 0, 255));
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b, a: alpha };
  }
  const h = (((Number.parseFloat(parts[0]) % 360) + 360) % 360) / 360;
  const s = clamp(cssNumber(parts[1], 1), 0, 1);
  const l = clamp(cssNumber(parts[2], 1), 0, 1);
  if ([h, s, l].some(Number.isNaN)) return null;
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255, a: alpha };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return { r: hue2rgb(p, q, h + 1 / 3) * 255, g: hue2rgb(p, q, h) * 255, b: hue2rgb(p, q, h - 1 / 3) * 255, a: alpha };
}

/** `#rrggbb`, or `rgba(…)` when not opaque. */
export function formatColor(c: Rgba): string {
  const channel = (v: number) => Math.round(clamp(v, 0, 255));
  if (c.a < 1) return `rgba(${channel(c.r)}, ${channel(c.g)}, ${channel(c.b)}, ${Math.round(c.a * 1000) / 1000})`;
  return `#${[c.r, c.g, c.b].map((v) => channel(v).toString(16).padStart(2, "0")).join("")}`;
}

// ── OKLCH ───────────────────────────────────────────────────────────────────

export type Oklch = { l: number; c: number; h: number };

const toLinear = (v: number) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055) * 255;

export function toOklch(c: Rgba): Oklch {
  const r = toLinear(c.r);
  const g = toLinear(c.g);
  const b = toLinear(c.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.hypot(A, B);
  const H = C < 1e-6 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c: C, h: H };
}

/** Linear sRGB of an OKLCH colour, unclamped (may be out of gamut). */
function oklchToLinear({ l: L, c: C, h: H }: Oklch): [number, number, number] {
  const A = C * Math.cos((H * Math.PI) / 180);
  const B = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (rgb: [number, number, number]) => rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);

/**
 * Back to sRGB, keeping lightness and hue and giving up chroma until it fits: the
 * CSS Color 4 approach in miniature. Hue is what makes a brand colour recognisable.
 */
export function fromOklch(colour: Oklch, alpha = 1): Rgba {
  const l = clamp(colour.l, 0, 1);
  let c = Math.max(0, colour.c);
  let rgb = oklchToLinear({ l, c, h: colour.h });
  if (!inGamut(rgb)) {
    let low = 0;
    let high = c;
    for (let i = 0; i < 24; i += 1) {
      const mid = (low + high) / 2;
      if (inGamut(oklchToLinear({ l, c: mid, h: colour.h }))) low = mid;
      else high = mid;
    }
    c = low;
    rgb = oklchToLinear({ l, c, h: colour.h });
  }
  const [r, g, b] = rgb.map((v) => fromLinear(clamp(v, 0, 1)));
  return { r, g, b, a: alpha };
}

// ── Contrast ────────────────────────────────────────────────────────────────

/** WCAG 2 relative luminance. */
export function luminance(c: Rgba): number {
  return 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
}

export function contrast(a: Rgba, b: Rgba): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `top` composited over the opaque `base`. */
function over(top: Rgba, base: Rgba): Rgba {
  const a = top.a;
  return { r: top.r * a + base.r * (1 - a), g: top.g * a + base.g * (1 - a), b: top.b * a + base.b * (1 - a), a: 1 };
}

// ── The mapping ─────────────────────────────────────────────────────────────

function surfaceOf(palette: DarkPalette): Rgba {
  return parseColor(palette.surface) ?? { r: 0, g: 0, b: 0, a: 1 };
}

/** A background, mapped. See the module comment for the rules. */
export function mapBackground(colour: Rgba, palette: DarkPalette): Rgba {
  if (colour.a === 0) return colour;
  const lch = toOklch(colour);
  if (lch.l <= LIGHT_BG) return colour;
  if (lch.c >= VIVID) {
    // A brand colour: keep its hue and chroma, drop it to where light text reads on it.
    // A lighter original lands a little darker, so two brand tints stay two.
    return fromOklch({ l: LIGHT_BG - (lch.l - LIGHT_BG) * 0.2, c: lch.c, h: lch.h }, colour.a);
  }
  // Paper. White becomes the surface; each step greyer is a step lighter than it.
  const base = toOklch(surfaceOf(palette)).l;
  const l = Math.min(base + (1 - lch.l) * 1.6, Math.max(BG_CAP, base));
  return fromOklch({ l, c: lch.c * 0.6, h: lch.h }, colour.a);
}

/** A border: like a background, but kept a visible step off the surface. */
export function mapBorder(colour: Rgba, palette: DarkPalette): Rgba {
  if (colour.a === 0) return colour;
  const lch = toOklch(colour);
  if (lch.l <= LIGHT_BG) return colour;
  const base = toOklch(surfaceOf(palette)).l;
  const l = Math.min(base + 0.1 + (1 - lch.l) * 0.8, 0.55);
  return fromOklch({ l, c: Math.min(lch.c, 0.12), h: lch.h }, colour.a);
}

/**
 * Text, mapped: dark ink flipped, light ink kept, then lifted (hue kept) until it
 * clears AA on the surface and on every background in `against`.
 */
export function mapText(colour: Rgba, palette: DarkPalette, against: readonly Rgba[] = []): Rgba {
  if (colour.a === 0) return colour;
  const surface = surfaceOf(palette);
  const grounds = [surface, ...against.map((bg) => (bg.a < 1 ? over(bg, surface) : bg))];
  const lch = toOklch(colour.a < 1 ? over(colour, surface) : colour);
  // The flip keeps the sender's hierarchy: #000 → 0.96, #333 → 0.84, #777 → 0.76.
  let l = lch.l < 0.62 ? 0.96 - lch.l * 0.35 : lch.l;
  const c = lch.c;
  const passes = (candidate: Rgba) => grounds.every((ground) => contrast(candidate, ground) >= AA);
  let out = fromOklch({ l, c, h: lch.h });
  while (!passes(out) && l < 1) {
    l = Math.min(1, l + 0.01);
    out = fromOklch({ l, c, h: lch.h });
  }
  return { ...out, a: 1 };
}

type Role = "background" | "text" | "border";

/** Which role a property's colours play; null for a property left alone. */
function roleOf(property: string): Role | null {
  const name = property.trim().toLowerCase();
  if (name === "color" || name === "-webkit-text-fill-color" || name === "caret-color") return "text";
  if (name === "background" || name === "background-color" || name === "background-image") return "background";
  if (/^border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?$/.test(name)) return "border";
  if (name === "outline-solid" || name === "outline-color" || name === "column-rule-color" || name === "text-decoration-color") return "border";
  return null;
}

/** Replace each colour token in `value` outside `url(…)`, leaving the rest as written. */
function replaceColours(value: string, map: (c: Rgba) => Rgba): string {
  // `url(…)` is masked first: a `data:` URI is base64, and `/red+` inside one is a word.
  const urls: string[] = [];
  const masked = value.replace(/url\([^)]*\)/gi, (whole) => {
    urls.push(whole);
    return `\uE000${urls.length - 1}\uE001`;
  });
  const replaced = masked.replace(COLOR_TOKEN, (token) => {
    const parsed = parseColor(token);
    return parsed ? formatColor(map(parsed)) : token;
  });
  return replaced.replace(/\uE000(\d+)\uE001/g, (_, i: string) => urls[Number(i)] ?? "");
}

/** Split declarations on top-level `;`, honouring strings and parentheses. */
function splitDeclarations(css: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === ";" && depth === 0) {
      out.push(css.slice(start, i));
      start = i + 1;
    }
  }
  out.push(css.slice(start));
  return out;
}

/** The first concrete background colour a declaration block sets, as written. */
export function backgroundOf(css: string): Rgba | null {
  let found: Rgba | null = null;
  for (const declaration of splitDeclarations(css)) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    if (name !== "background" && name !== "background-color") continue;
    const value = declaration.slice(colon + 1).replace(/url\([^)]*\)/gi, "");
    const token = value.match(COLOR_TOKEN)?.[0];
    const parsed = token ? parseColor(token) : null;
    if (parsed) found = parsed;
  }
  return found;
}

/**
 * Recolour one declaration block (a `style` attribute, or a rule body).
 *
 * `elementBackground` is a background the same element sets some other way (its
 * `bgcolor`), so a text colour beside it is held to AA against that too.
 */
export function recolourDeclarations(css: string, palette: DarkPalette, elementBackground: Rgba | null = null): string {
  if (!/[#(]|[a-z]/i.test(css)) return css;
  const ownBackground = backgroundOf(css) ?? elementBackground;
  const against = ownBackground ? [mapBackground(ownBackground, palette)] : [];
  return splitDeclarations(css)
    .map((declaration) => {
      const colon = declaration.indexOf(":");
      if (colon === -1) return declaration;
      const role = roleOf(declaration.slice(0, colon));
      if (!role) return declaration;
      const name = declaration.slice(0, colon + 1);
      const value = declaration.slice(colon + 1);
      const map =
        role === "text"
          ? (c: Rgba) => mapText(c, palette, against)
          : role === "border"
            ? (c: Rgba) => mapBorder(c, palette)
            : (c: Rgba) => mapBackground(c, palette);
      return name + replaceColours(value, map);
    })
    .join(";");
}

/** An HTML colour attribute (`bgcolor`, `color`), recoloured; the input when it is not a colour. */
export function recolourAttribute(value: string, role: "background" | "text", palette: DarkPalette, elementBackground: Rgba | null = null): string {
  const raw = value.trim();
  // Legacy `bgcolor="ffffff"` without the hash is common in generated mail.
  const parsed = parseColor(raw) ?? (/^[0-9a-f]{6}$/i.test(raw) ? parseColor(`#${raw}`) : null);
  if (!parsed) return value;
  const against = elementBackground ? [mapBackground(elementBackground, palette)] : [];
  return formatColor(role === "text" ? mapText(parsed, palette, against) : mapBackground(parsed, palette));
}

// ── Does the message bring its own? ─────────────────────────────────────────

export type OwnDarkStyles = {
  /** An `@media (prefers-color-scheme: dark)` block in its stylesheets. */
  mediaQuery: boolean;
  /** `[data-ogsc]` / `[data-ogsb]` rules, Outlook.com's dark hooks. */
  outlookHooks: boolean;
  /** `<meta name="color-scheme" | "supported-color-schemes">` naming `dark`, or CSS `color-scheme: … dark`. */
  declaresDark: boolean;
};

/**
 * What the message says about dark mode. `html` is the raw body (the `<meta>` is
 * dropped by the sanitiser, so it is read here); `sheets` the sanitised stylesheets,
 * or none, and the raw `<style>` blocks are read instead.
 * A hint, not a security decision: a sender who lies only changes their own colours.
 */
export function detectOwnDarkStyles(html: string, sheets: readonly string[]): OwnDarkStyles {
  // With no sanitised sheets to hand, the raw `<style>` blocks: one pass, not two.
  const css = sheets.length > 0
    ? sheets.join("\n")
    : (html.match(/<style\b[^>]*>[\s\S]*?(?:<\/style\s*>|$)/gi) ?? []).join("\n");
  const metas = html.match(/<meta\b[^>]*>/gi) ?? [];
  const metaDark = metas.some(
    (tag) => /name\s*=\s*["']?(?:color-scheme|supported-color-schemes)\b/i.test(tag) && /content\s*=\s*["'][^"']*\bdark\b/i.test(tag),
  );
  return {
    mediaQuery: /@media[^{]*prefers-color-scheme\s*:\s*dark/i.test(css),
    outlookHooks: /\[\s*data-ogs[cb]\s*\]/i.test(css),
    declaresDark: metaDark || /(?:^|[;{\s])(?:supported-)?color-scheme\s*:[^;}]*\bdark\b/i.test(css),
  };
}

/** How a message is drawn in a dark reader. */
export type EmailDarkMode = "off" | "own" | "adaptive";

/**
 * The path for one message: `own` when it ships dark rules to honour, else `adaptive`.
 * A `color-scheme: light dark` declaration with no dark rules behind it says the
 * sender *expects* to be drawn dark, which adaptive does; it is not a dark style.
 */
export function emailDarkMode(enabled: boolean, own: OwnDarkStyles | null): EmailDarkMode {
  if (!enabled) return "off";
  return own?.mediaQuery ? "own" : "adaptive";
}
