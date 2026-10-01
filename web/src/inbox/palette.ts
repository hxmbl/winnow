import type { BuiltinSmartFilter } from "./smart";
import { PROFILE_PICTURES, cachedAccent } from "./avatarColor";

export type PillColors = {
  /** Saturated midpoint of the resting gradient. */
  accent: string;
  /**
   * Tinted neutral at both ends of the resting gradient. Derived from `accent`
   * (same hue, ~17% sat, ~80% lightness) unless given — the flat greys set it
   * explicitly so they render dead level.
   */
  edge?: string;
  /** Resting fill opacity. */
  alpha: number;
  /** Flat fill for the selected state. */
  solid: string;
};

/** Resting fill opacity for filter pills, straight from the design export. */
const PILL_ALPHA = 0.4;

export function hexA(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) * 60
      : max === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60;
  return [h, s * 100, l * 100];
}

/** Builds a pill from an accent, deriving the edge tint and selected-state fill. */
function pill(accent: string, edge?: string): PillColors {
  const [h, s, l] = hexToHsl(accent);
  return {
    accent,
    edge,
    alpha: PILL_ALPHA,
    solid: hslToHex(h, Math.min(s * 1.1, 100), Math.max(l * 0.9, 12)),
  };
}

/**
 * Categorical hue wheel from references/filter-pill-gradients.svg. Eleven steps,
 * red → rose, meant to be assigned by meaning rather than by position.
 */
export const RAMP = {
  red: "#EDB5B5",
  orange: "#EDD1B5",
  yellow: "#D5D56F",
  lime: "#B8E362",
  green: "#9DCFA5",
  cyan: "#81CCD3",
  blue: "#7F8ED8",
  indigo: "#9A83E2",
  violet: "#B37CCF",
  magenta: "#D371CB",
  rose: "#D35F90",
} as const;

/**
 * Semantic assignment: colour now carries meaning, so red always means urgent
 * and blue always means security. `magenta` is held in reserve for a future
 * filter (or a sender accent that collides with a neighbouring hue).
 */
export const FILTER_PILLS: Record<BuiltinSmartFilter, PillColors> = {
  starred: pill(RAMP.yellow),
  important: pill(RAMP.orange),
  urgent: pill(RAMP.red),
  security: pill(RAMP.blue),
  top_contacts: pill(RAMP.green),
  quiet_contacts: pill(RAMP.lime),
  newsletters: pill(RAMP.cyan),
  promotional: pill(RAMP.indigo),
  low_priority: pill(RAMP.violet),
  unsafe: pill(RAMP.rose),
};

/**
 * The flat grey from the design export. Senders fall back to this until a
 * profile picture exists to derive an accent from.
 */
export const NEUTRAL_PILL: PillColors = {
  accent: "#C5D0D1",
  edge: "#C5D0D1",
  alpha: PILL_ALPHA,
  solid: "#A3B3B6",
};

/**
 * Sender accents come from the sender's profile picture so the pill matches the
 * avatar in the list. Until `PROFILE_PICTURES` is populated there is nothing to
 * sample, so senders get the flat grey — which also keeps the semantic filter
 * hues the only colourful thing in the strip.
 */
export function senderPillColors(sender: string): PillColors {
  const url = PROFILE_PICTURES[sender];
  const accent = url ? cachedAccent(url) : null;
  if (!accent) return NEUTRAL_PILL;
  const [h, s] = hexToHsl(accent);
  return {
    accent,
    alpha: PILL_ALPHA,
    solid: hslToHex(h, Math.min(Math.max(s * 0.55, 42), 60), 76),
  };
}

function edgeTint(colors: PillColors): string {
  if (colors.edge) return colors.edge;
  const [h] = hexToHsl(colors.accent);
  return hslToHex(h, 11, 79);
}

/**
 * Resting state is a horizontal edge → accent → edge wash so the colour reads
 * as a glow in the middle of the pill. Selected state thickens the same wash and
 * leans on the ring in `FilterStrip` — the pills sit on a white bar, so an
 * opaque fill would read heavier than the rest of the strip.
 */
export function pillBackground(colors: PillColors, on: boolean): string {
  if (on) {
    return `linear-gradient(180deg, ${hexA(colors.solid, 0.66)} 0%, ${hexA(colors.solid, 0.34)} 100%)`;
  }
  const edge = edgeTint(colors);
  return [
    `linear-gradient(90deg,`,
    `${hexA(edge, colors.alpha)} 0%,`,
    `${hexA(colors.accent, colors.alpha)} 50%,`,
    `${hexA(edge, colors.alpha)} 100%)`,
  ].join(" ");
}
