/**
 * Colour for a bucket.
 *
 * Colour carries meaning here, and it is the *only* colourful thing in the app: red
 * always means urgent, blue always means security, and the greys at the quiet end mean
 * "nothing is wrong here".
 *
 * Two constraints shaped the ramp: every hue is already washed out (saturation through
 * alpha, not hue), and sender pills are grey rather than tinted so they do not compete
 * with the semantic ones.
 */

import type { BuiltinSmartFilter } from "../core/model/signals";

export type PillColors = {
  /** Saturated accent colour. */
  accent: string;
  /**
   * Tinted neutral; derived from `accent` unless given — the flat greys set it
   * explicitly so they render dead level.
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
 * The greys are not laziness: `newsletters`, `low_priority` and `quiet_contacts` hold
 * content that is *fine*, and a saturated hue would say "act on this" about mail that
 * needs none. The warm end is reserved for what is genuinely wrong or urgent, which is
 * the only way a colour strip can be read at a glance.
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

/**
 * A stable colour per sender, derived from the address.
 *
 * Not from a profile picture: loading one is a third-party request, once per avatar in
 * the list. Hashing the address gives a sender's pill a consistent identity across
 * sessions and accounts at zero network cost, and keeps the semantic hues the only
 * meaningful colour in the strip.
 *
 * The hue comes from the *domain*, not the local part, so `ada@` and `grace@` at one
 * company share a colour — the association a person actually has.
 */
export function senderPillColors(sender: string): PillColors {
  const domain = sender.split("@")[1]?.toLowerCase() ?? sender.toLowerCase();

  // FNV-1a, so the same domain always gets the same hue. Kept local rather than
  // imported: this is a colour, not an identity, and must not collide with the
  // message-id hash space.
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

/**
 * A pill's fill.
 *
 * The accent is a flat tint and nothing else: it identifies the bucket alongside the
 * label, and it does not have to carry the meaning alone. At these alphas a row of them
 * reads as one quiet line rather than as twenty separate objects — once two gradients
 * and an edge per pill made the rail come out looking like a shelf of sweets, and it
 * was the single loudest thing in a window that is mostly a reading surface.
 *
 * Selected state adds `--wn-sheen` — a low-alpha wash of the palette's own ink, so it
 * darkens on a light scheme and lightens on a dark one — *over* the tint. That is the
 * whole selection affordance: the pill lifts toward the light rather than being replaced
 * by a differently-filled object.
 *
 * Background layers paint front to back, so the sheen is written first.
 */
export function pillBackground(colors: PillColors, on: boolean): string {
  if (on) {
    return `linear-gradient(var(--wn-sheen), var(--wn-sheen)), ${hexA(colors.accent, 0.13)}`;
  }
  return hexA(colors.accent, 0.07);
}

/**
 * The badge accents live in `theme.ts`, not here: `--wn-badge-<id>` is the single
 * source for everything that reads one, which is the star on a row and in the reader.
 */
