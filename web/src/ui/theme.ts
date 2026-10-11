/**
 * Every colour in the app, in one place.
 *
 * How it works:
 *   1. Edit a value below.
 *   2. `applyTheme(root, scheme)` mirrors the active palette to `--wn-*` custom
 *      properties on `<html>`, so plain CSS in `index.css` — the scrollbar, the
 *      focus ring — reads from the same source as Tailwind.
 *   3. `tailwind.config.js` maps the same names onto utilities, so components
 *      write `bg-surface` and never a hex value.
 *
 * Names are semantic (`surfaceActive`, not `blue-100`), so a component never has
 * to know which palette is live.
 *
 * Token colours are CSS variables, so Tailwind's `/opacity` modifier does not work
 * on them — any alpha is baked into the value here.
 *
 * `contrastRatio` and `relativeLuminance` live here so `theme.test.ts` can assert
 * the palette's contrast guarantees rather than trusting them.
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

/**
 * The semantic names, grouped by the job a colour does: surfaces, text, lines,
 * and everything else (scrollbar, focus, depth).
 */
type Palette = {
  color: Record<string, string>;
  /**
   * Accent per bucket. Drives the `starred` tint and the hue identities that
   * `ui/filterColors` builds its pill washes from.
   */
  badge: Record<string, string>;
  /** The two shadows in the system: `pane` and `lift`. */
  elevation: Record<string, string>;
};

const LIGHT: Palette = {
  color: {
    // ── Surfaces ────────────────────────────────────────────────
    /** Whole-app backdrop. Tinted, not white, so an unshadowed card still reads as raised. */
    canvas: "#EFF3F3",
    /** Pane and control fill — the default "thing you can touch". */
    surface: "#FFFFFF",
    /** Recessed fill: list section headers, search, empty states. */
    surfaceSunken: "#F6F8F8",
    /** Hover wash on rows and icon buttons. */
    surfaceHover: "#F2F5F6",
    /** The selected list row. */
    surfaceActive: "#E6EDEF",
    /** Masthead and the mobile bar under it. */
    chrome: "#FFFFFF",

    // ── Text ────────────────────────────────────────────────────
    /** Headlines — sender name, subject. */
    ink: "#15181D",
    /** Long-form body copy. */
    inkBody: "#3C434C",
    /** Secondary metadata: addresses, timestamps. Clears AA on every plane it sits on. */
    inkMuted: "#5A5F67",
    /** Tertiary: section labels, empty-state copy, the row timestamp. Kept a visible step from `inkMuted`. */
    inkSubtle: "#656B72",
    /** Toolbar icon buttons. */
    inkIcon: "#4A515A",
    /** Search placeholder. Same size requirement as `inkSubtle`: 13px text. */
    inkPlaceholder: "#656B72",

    // ── Status ──────────────────────────────────────────────────
    /** Destructive actions and errors. The only red that is not a bucket. */
    danger: "#B42318",
    /** Confirmation, and "this worked". */
    success: "#15803D",
    /** The notice strip's wash, for a non-blocking message. */
    notice: "rgba(21, 128, 61, 0.08)",
    /** The error strip's wash. */
    dangerWash: "rgba(180, 35, 24, 0.07)",

    // ── Lines & controls ────────────────────────────────────────
    /** Default separator. Everything structural uses this unless it needs to recede. */
    hairline: "rgba(15, 23, 42, 0.09)",
    /** Separator inside a container that already has a border. */
    hairlineSoft: "rgba(15, 23, 42, 0.055)",
    /** Vertical separators splitting an action cluster into groups. */
    divider: "rgba(15, 23, 42, 0.14)",
    /** Neutral control border (search, action cluster). */
    controlBorder: "rgba(15, 23, 42, 0.1)",
    /** Focus ring. Replaces `ring-neutral-400/60`. */
    focusRing: "rgba(120, 130, 145, 0.55)",

    // ── Chrome ──────────────────────────────────────────────────
    scrollbar: "rgba(15, 23, 42, 0.2)",

    // ── Depth, without borders ─────────────────────────────────
    /** Translucent fill for layers floating over content (drawer, sheets); pair with `backdrop-filter`. */
    veil: "rgba(255, 255, 255, 0.74)",
    /** Selection as a low-alpha wash of the palette's own ink: darkens on light, lightens on dark. */
    sheen: "rgba(21, 24, 29, 0.055)",
    /** What the drawer dims. Warm-neutral, not black, so dimming reads as depth. */
    scrim: "rgba(15, 23, 42, 0.16)",
  },

  badge: {
    starred: "#B8860B",
    important: "#C2410C",
    urgent: "#E11D48",
    security: "#0369A1",
    needs_action: "#B45309",
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
    unsafe: "#C2410C",
  },

  /** `pane` sits on the list and reader cards; `lift` is for chrome floating over scrolling content. */
  elevation: {
    pane: "0 1px 2px rgba(15, 23, 42, 0.05)",
    lift: "0 12px 32px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.05)",
  },
};

/**
 * Dark mode.
 *
 * Not an inversion: surfaces step up in lightness rather than dropping to black,
 * because a true-black list behind white text is hard on the eyes. `#15181D` is
 * the light palette's ink, promoted to the canvas, so the two read as one system.
 */
const DARK: Palette = {
  color: {
    canvas: "#0F1216",
    surface: "#181C22",
    surfaceSunken: "#13171C",
    surfaceHover: "#1F242B",
    surfaceActive: "#2A313A",
    chrome: "#151A20",

    ink: "#EDF1F4",
    inkBody: "#C3CBD3",
    /** Kept a visible step above `inkSubtle`; both must clear AA on `surfaceActive`. */
    inkMuted: "#A9B2BA",
    inkSubtle: "#929BA3",
    inkIcon: "#A7B1BC",
    /** Held one step off `inkSubtle`, so a placeholder does not read as filled-in text. */
    inkPlaceholder: "#929AA2",

    hairline: "rgba(255, 255, 255, 0.09)",
    hairlineSoft: "rgba(255, 255, 255, 0.055)",
    divider: "rgba(255, 255, 255, 0.15)",
    controlBorder: "rgba(255, 255, 255, 0.11)",
    focusRing: "rgba(160, 172, 186, 0.7)",

    danger: "#F97066",
    success: "#4ADE80",
    notice: "rgba(74, 222, 128, 0.1)",
    dangerWash: "rgba(249, 112, 102, 0.1)",

    scrollbar: "rgba(255, 255, 255, 0.24)",

    // `veil` is the lighter alpha on purpose: on a near-black canvas a 74% fill reads
    // as a grey card rather than glass. `sheen` lightens here, inverting the ink ramp.
    veil: "rgba(28, 33, 40, 0.72)",
    sheen: "rgba(237, 241, 244, 0.07)",
    scrim: "rgba(0, 0, 0, 0.34)",
  },

  // The light palette's badge accents all fail on a dark surface: same hues, lifted.
  badge: {
    starred: "#FACC15",
    important: "#FB923C",
    urgent: "#FB7185",
    security: "#7DD3FC",
    needs_action: "#FDBA74",
    receipts: "#67E8F9",
    shipping: "#A3E635",
    travel: "#A5B4FC",
    events: "#E879F9",
    codes: "#F0ABFC",
    social: "#A5B4FC",
    unread: "#BEF264",
    attachments: "#BEF264",
    new_senders: "#67E8F9",
    top_contacts: "#4ADE80",
    quiet_contacts: "#A3E635",
    newsletters: "#9CA3AF",
    promotional: "#4ADE80",
    low_priority: "#94A3B8",
    long_reads: "#94A3B8",
    unsafe: "#FB7185",
  },

  elevation: {
    pane: "0 1px 2px rgba(0, 0, 0, 0.3)",
    lift: "0 12px 32px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.3)",
  },
};

export const PALETTES = { light: LIGHT, dark: DARK } as const;

export type ThemeName = keyof typeof PALETTES;

/** The light palette, for callers that need a value without the active scheme. */
export const theme = LIGHT.color;

/** The active palette, defaulting to light. */
export function paletteFor(scheme: ThemeName): Palette {
  return PALETTES[scheme];
}

/**
 * Mirror the active palette into `--wn-*` custom properties on `<html>`.
 *
 * Called on mount and whenever the scheme changes, because the Tailwind utilities
 * resolve against these variables at paint time.
 */
export function applyTheme(root: HTMLElement, scheme: ThemeName = "light"): void {
  const palette = paletteFor(scheme);
  for (const [key, value] of Object.entries(palette.color)) {
    root.style.setProperty(`--wn-${key}`, value);
  }
  for (const [key, value] of Object.entries(palette.badge)) {
    root.style.setProperty(`--wn-badge-${key}`, value);
  }
  for (const [key, value] of Object.entries(palette.elevation)) {
    root.style.setProperty(`--wn-elev-${key}`, value);
  }
  // Drives native form controls, scrollbars, and the OS `color-scheme`, so a dark
  // app does not flash white before first paint.
  root.style.colorScheme = scheme;
  root.dataset.theme = scheme;
}

/**
 * The scheme to actually render. `system` resolves against the OS; the caller
 * (`ThemeProvider`) owns the subscription.
 */
export function resolveScheme(
  preference: "system" | "light" | "dark",
  systemPrefersDark: boolean,
): ThemeName {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}
