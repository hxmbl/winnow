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
   * A hue per bucket, published as `--wn-badge-<id>`. Only `starred` is drawn today
   * (the star); the rest stay as named tokens so a bucket can be given a colour again
   * in one place, but the interface does not tint by bucket — the accent is the only
   * colour that means anything.
   */
  badge: Record<string, string>;
  /** The two shadows in the system: `pane` and `lift`. Both `none` while the design is flat. */
  elevation: Record<string, string>;
};

/**
 * Light.
 *
 * Warm paper rather than blue-grey: every neutral carries a little of the accent's
 * hue, so the rust reads as belonging to the page instead of sitting on top of it.
 * Surfaces are separated by value alone — no rules, no shadows.
 */
const LIGHT: Palette = {
  color: {
    // ── Surfaces ────────────────────────────────────────────────
    /** Whole-app backdrop: the chrome and the reader's gutter. */
    canvas: "#F2EFE9",
    /** Pane and control fill — the default "thing you can touch". */
    surface: "#FCFBF8",
    /** Recessed fill: the reader pane, search, empty states. */
    surfaceSunken: "#F7F5F0",
    /** Hover wash on rows and icon buttons. */
    surfaceHover: "#F2EFE9",
    /** Pressed and focused fills. */
    surfaceActive: "#E9E4DB",
    /** The selected list row: the accent, washed into `surface`. Opaque so the contrast test can see it. */
    surfaceSelected: "#F5EBE5",
    /** Masthead and the mobile bar under it. */
    chrome: "#FCFBF8",

    // ── Text ────────────────────────────────────────────────────
    /** Headlines — sender name, subject. */
    ink: "#1D1A16",
    /** Long-form body copy. */
    inkBody: "#3D3832",
    /** Secondary metadata: addresses, timestamps. Clears AA on every plane it sits on. */
    inkMuted: "#58524A",
    /** Tertiary: section labels, empty-state copy, the row timestamp. Kept a visible step from `inkMuted`. */
    inkSubtle: "#686158",
    /** Toolbar icon buttons. */
    inkIcon: "#4B463F",
    /** Search placeholder. Same size requirement as `inkSubtle`. */
    inkPlaceholder: "#686158",

    // ── Accent ──────────────────────────────────────────────────
    /**
     * Winnow's one colour: a rust, from the chaff the name is about. Unread, selection,
     * focus and the primary action, and nothing else. 5.4:1 or better on every surface,
     * so it can carry text as well as a ring.
     */
    accent: "#A63F18",
    /** Text on a solid accent fill. */
    onAccent: "#FFFFFF",

    // ── Status ──────────────────────────────────────────────────
    /** Destructive actions and errors. Crimson, pulled away from the rust so "delete" never reads as "go". */
    danger: "#B0203F",
    /** Confirmation, and "this worked". */
    success: "#2F7A3E",
    /** The notice strip's wash, for a non-blocking message. */
    notice: "rgba(47, 122, 62, 0.08)",
    /** The error strip's wash. */
    dangerWash: "rgba(176, 32, 63, 0.07)",

    // ── Lines & controls ────────────────────────────────────────
    /** Default separator. Everything structural uses this unless it needs to recede. */
    hairline: "rgba(48, 36, 20, 0.09)",
    /** Separator inside a container that already has a border. */
    hairlineSoft: "rgba(48, 36, 20, 0.055)",
    /** Vertical separators splitting an action cluster into groups. */
    divider: "rgba(48, 36, 20, 0.14)",
    /** Neutral control border (search, action cluster). */
    controlBorder: "rgba(48, 36, 20, 0.12)",
    /** Focus ring: the accent, solid. 3:1 or better against every surface. */
    focusRing: "#A63F18",

    // ── Chrome ──────────────────────────────────────────────────
    scrollbar: "rgba(48, 36, 20, 0.22)",

    // ── Depth, without borders ─────────────────────────────────
    /** Fill for layers floating over content (drawer, sheets). Opaque now that nothing blurs behind it. */
    veil: "rgba(252, 251, 248, 0.96)",
    /** A low-alpha wash of the palette's own ink: pressed states and quiet buttons. */
    sheen: "rgba(48, 36, 20, 0.06)",
    /** What the drawer dims. Warm, not black, so dimming reads as depth. */
    scrim: "rgba(40, 30, 18, 0.18)",
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
    pane: "none",
    lift: "none",
  },
};

/**
 * Dark mode.
 *
 * Not an inversion: surfaces step up in lightness rather than dropping to black,
 * because a true-black list behind white text is hard on the eyes. The neutrals keep
 * the light palette's warmth, so the two read as one system.
 */
const DARK: Palette = {
  color: {
    canvas: "#12110F",
    surface: "#1A1816",
    surfaceSunken: "#161412",
    surfaceHover: "#22201C",
    surfaceActive: "#2D2A25",
    surfaceSelected: "#36271F",
    chrome: "#171513",

    ink: "#F2EEE7",
    inkBody: "#D0C9BE",
    /** Kept a visible step above `inkSubtle`; both must clear AA on `surfaceSelected`. */
    inkMuted: "#B2AA9E",
    inkSubtle: "#9A9286",
    inkIcon: "#B0A89C",
    /** Held one step off `inkSubtle`, so a placeholder does not read as filled-in text. */
    inkPlaceholder: "#9A9286",

    /** The same rust, lifted until it reads on a dark page. */
    accent: "#EE8A5C",
    /** Dark text on the light accent: white on #EE8A5C would fail AA. */
    onAccent: "#1A1816",

    hairline: "rgba(255, 245, 230, 0.09)",
    hairlineSoft: "rgba(255, 245, 230, 0.055)",
    divider: "rgba(255, 245, 230, 0.15)",
    controlBorder: "rgba(255, 245, 230, 0.12)",
    focusRing: "#EE8A5C",

    danger: "#F47A8C",
    success: "#6BCB7F",
    notice: "rgba(107, 203, 127, 0.1)",
    dangerWash: "rgba(244, 122, 140, 0.1)",

    scrollbar: "rgba(255, 245, 230, 0.24)",

    veil: "rgba(26, 24, 22, 0.97)",
    sheen: "rgba(242, 238, 231, 0.07)",
    scrim: "rgba(0, 0, 0, 0.4)",
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
    pane: "none",
    lift: "none",
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
