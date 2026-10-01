/**
 * Colour for a bucket.
 *
 * Colour carries meaning here, and it is the *only* colourful thing in the app
 * — so the assignment below is the design's most load-bearing set of decisions.
 * Red always means urgent, blue always means security, and the greys at the
 * quiet end mean "nothing is wrong here". A user learns these in a day and then
 * reads the rail without reading it.
 *
 * Two constraints shaped the ramp:
 *
 *   1. **Every hue is already washed out.** The accents sit at roughly 40%
 *      opacity on white, so a row of pills reads as a soft spectrum rather than
 *      as a row of alert boxes. Saturation is applied through the alpha, not the
 *      hue.
 *   2. **Sender pills are grey, not coloured.** A sender's colour is derived
 *      from their own address, so if senders were tinted the sender pills would
 *      compete with the semantic ones for the same attention.
 */

import type { BuiltinSmartFilter } from "../core/model/signals";

export type PillColors = {
  /** Saturated midpoint of the resting gradient. */
  accent: string;
  /**
   * Tinted neutral at both ends of the resting gradient. Derived from `accent`
   * (same hue, low saturation, high lightness) unless given — the flat greys
   * set it explicitly so they render dead level.
   */
  edge?: string;
  /** Resting fill opacity. */
  alpha: number;
  /** Flat fill for the selected state. */
  solid: string;
};

/** Resting fill opacity, straight from the design export. */
const PILL_ALPHA = 0.4;

/** `#RRGGBB` → `rgba(...)`. */
export function hexA(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** HSL → `#RRGGBB`. */
export function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const channel = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, Math.min(9 - k, 1)));
    return Math.round(255 * c)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}

/** `#RRGGBB` → HSL. */
export function hexToHsl(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
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

/** Build a pill from an accent, deriving the edge tint and selected fill. */
function pill(accent: string, edge?: string): PillColors {
  const [h, s, l] = hexToHsl(accent);
  return {
    accent,
    edge,
    alpha: PILL_ALPHA,
    solid: hslToHex(h, Math.min(s * 1.1, 100), Math.max(l * 0.9, 12)),
  };
}

/** A flat grey, for the buckets where colour would be misleading. */
function grey(value: string): PillColors {
  return { accent: value, edge: value, alpha: PILL_ALPHA, solid: value };
}

/**
 * The categorical ramp, from the design export: eleven steps, red → rose, meant
 * to be assigned by meaning rather than by position.
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
 * Semantic assignment, one entry per bucket.
 *
 * The greys are not laziness. `newsletters`, `low_priority` and `quiet_contacts`
 * are all buckets whose content is *fine* — the user is not being warned about
 * anything — so giving them a saturated hue would say "act on this" about mail
 * that needs no action. The ramp's warm end is reserved for things that are
 * genuinely wrong or genuinely urgent, which is the only way a colour strip can
 * be read at a glance.
 */
export const FILTER_PILLS: Record<BuiltinSmartFilter, PillColors> = {
  // The loud end: something is wrong or something is on fire.
  urgent: pill(RAMP.red),
  security: pill(RAMP.blue),
  unsafe: pill(RAMP.rose),
  needs_action: pill(RAMP.orange),

  // The warm middle: worth a look today.
  important: pill(RAMP.yellow),
  starred: pill(RAMP.yellow),

  // Specific things you asked for. Distinct hues so a Deliveries pill and a
  // Codes pill do not read as the same thing.
  receipts: pill(RAMP.cyan),
  shipping: pill(RAMP.green),
  travel: pill(RAMP.indigo),
  events: pill(RAMP.violet),
  codes: pill(RAMP.magenta),
  social: pill(RAMP.violet),
  unread: pill(RAMP.lime),
  attachments: pill(RAMP.lime),
  new_senders: pill(RAMP.cyan),

  // People rather than topics.
  top_contacts: pill(RAMP.green),
  quiet_contacts: pill(RAMP.lime),

  // Bulk and skippable. Deliberately grey.
  newsletters: grey("#C8D2D3"),
  promotional: grey("#C8D2D3"),
  low_priority: grey("#C8D2D3"),
  long_reads: grey("#C8D2D3"),
};

/** The flat grey a sender pill falls back to. */
export const NEUTRAL_PILL: PillColors = {
  accent: "#C5D0D1",
  edge: "#C5D0D1",
  alpha: PILL_ALPHA,
  solid: "#A3B3B6",
};

/**
 * A stable colour per sender, derived from the address.
 *
 * Not from a profile picture: loading one is a third-party request to a company
 * the user has not chosen to contact, on every avatar in the list. Hashing the
 * address gives a senders' pills a consistent identity across sessions and
 * accounts at zero network cost, and it keeps the semantic hues as the only
 * meaningful colour in the strip.
 *
 * The hue comes from the *domain*, not the local part, so `ada@` and
 * `grace@` at one company share a colour — which is the association a person
 * actually has.
 */
export function senderPillColors(sender: string): PillColors {
  const domain = sender.split("@")[1]?.toLowerCase() ?? sender.toLowerCase();

  // FNV-1a, so the same domain always gets the same hue. Kept local rather than
  // imported: this is a colour, not an identity, and it must not collide with
  // the message-id hash space.
  let hash = 0x811c9dc5;
  for (let i = 0; i < domain.length; i += 1) {
    hash ^= domain.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  // Walk the ramp rather than the full wheel, so a sender colour can never land
  // on the same hue as a semantic bucket.
  const steps: readonly string[] = [
    RAMP.cyan,
    RAMP.lime,
    RAMP.orange,
    RAMP.violet,
    RAMP.magenta,
    RAMP.blue,
  ];
  const accent = steps[hash % steps.length];

  const [h, s] = hexToHsl(accent);
  // Desaturated and light: a sender pill is identity, not urgency.
  return {
    accent,
    alpha: PILL_ALPHA,
    solid: hslToHex(h, Math.min(Math.max(s * 0.55, 42), 60), 76),
  };
}

/** The derived edge tint, unless the pill sets one explicitly. */
function edgeTint(colors: PillColors): string {
  if (colors.edge) return colors.edge;
  const [h] = hexToHsl(colors.accent);
  return hslToHex(h, 11, 79);
}

/**
 * Resting state is a horizontal edge → accent → edge wash, so the colour reads
 * as a glow in the middle of the pill. Selected state thickens the same wash and
 * leans on a ring — the pills sit on a white bar, so an opaque fill would read
 * heavier than the rest of the strip.
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

/** The badge accent for a bucket, for the reader's chips. */
export const BADGE_COLORS: Record<BuiltinSmartFilter, string> = {
  urgent: "#C2410C",
  security: "#0369A1",
  unsafe: "#C2410C",
  needs_action: "#B45309",
  important: "#A16207",
  starred: "#B8860B",
  receipts: "#0E7490",
  shipping: "#4D7C0F",
  travel: "#4338CA",
  events: "#7E22CE",
  codes: "#A21CAF",
  social: "#4F46E5",
  unread: "#3F6212",
  attachments: "#3F6212",
  new_senders: "#0E7490",
  top_contacts: "#15803D",
  quiet_contacts: "#4D7C0F",
  newsletters: "#575757",
  promotional: "#15803D",
  low_priority: "#334155",
  long_reads: "#334155",
};
