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
 * Cool violet-grey rather than beige or blue-grey: every neutral carries a little of the
 * accent's hue, so the plum reads as belonging to the page instead of sitting on top of it.
 * Surfaces are separated by value alone — no rules, no shadows.
 */
const LIGHT: Palette = {
  color: {
    // ── Surfaces ────────────────────────────────────────────────
    /** Whole-app backdrop: the chrome and the reader's gutter. */
    canvas: "#EFEDF2",
    /** Pane and control fill — the default "thing you can touch". */
    surface: "#FBFAFC",
    /** Recessed fill: the reader pane, search, empty states. */
    surfaceSunken: "#F6F4F8",
    /** Hover wash on rows and icon buttons. */
    surfaceHover: "#EFEDF2",
    /** Pressed and focused fills. */
    surfaceActive: "#E5E1EA",
    /** The selected list row: the accent, washed into `surface`. Opaque so the contrast test can see it. */
    surfaceSelected: "#EFE8EF",
    /** Masthead and the mobile bar under it. */
    chrome: "#FBFAFC",

    // ── Text ────────────────────────────────────────────────────
    /** Headlines — sender name, subject. */
    ink: "#1B1820",
    /** Long-form body copy. */
    inkBody: "#3A3541",
    /** Secondary metadata: addresses, timestamps. Clears AA on every plane it sits on. */
    inkMuted: "#554E5D",
    /** Tertiary: section labels, empty-state copy, the row timestamp. Kept a visible step from `inkMuted`. */
    inkSubtle: "#655E6D",
    /** Toolbar icon buttons. */
    inkIcon: "#48424F",
    /** Search placeholder. Same size requirement as `inkSubtle`. */
    inkPlaceholder: "#655E6D",

    // ── Accent ──────────────────────────────────────────────────
    /**
     * Winnow's one colour: a plum, deep enough to read as ink rather than decoration. Unread,
     * selection, focus and the primary action, and nothing else. 6.8:1 or better on every surface,
     * so it can carry text as well as a ring.
     */
    accent: "#74306A",
    /** Text on a solid accent fill. */
    onAccent: "#FFFFFF",

    // ── Status ──────────────────────────────────────────────────
    /** Destructive actions and errors. A brick red, pulled well away from the plum so "delete" never reads as "go". */
    danger: "#B42318",
    /** Confirmation, and "this worked". */
    success: "#2F7A3E",
    /** The notice strip's wash, for a non-blocking message. */
    notice: "rgba(47, 122, 62, 0.08)",
    /** The error strip's wash. */
    dangerWash: "rgba(180, 35, 24, 0.07)",

    // ── Lines & controls ────────────────────────────────────────
    /** Default separator. Everything structural uses this unless it needs to recede. */
    hairline: "rgba(38, 28, 54, 0.09)",
    /** Separator inside a container that already has a border. */
    hairlineSoft: "rgba(38, 28, 54, 0.055)",
    /** Vertical separators splitting an action cluster into groups. */
    divider: "rgba(38, 28, 54, 0.14)",
    /** Neutral control border (search, action cluster). */
    controlBorder: "rgba(38, 28, 54, 0.12)",
    /** Focus ring: the accent, solid. 3:1 or better against every surface. */
    focusRing: "#74306A",

    // ── Chrome ──────────────────────────────────────────────────
    scrollbar: "rgba(38, 28, 54, 0.22)",

    // ── Depth, without borders ─────────────────────────────────
    /** Fill for layers floating over content (drawer, sheets). Opaque now that nothing blurs behind it. */
    veil: "rgba(251, 250, 252, 0.96)",
    /** A low-alpha wash of the palette's own ink: pressed states and quiet buttons. */
    sheen: "rgba(38, 28, 54, 0.06)",
    /** What the drawer dims. Tinted, not black, so dimming reads as depth. */
    scrim: "rgba(30, 20, 44, 0.18)",
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
 * the light palette's violet tint, so the two read as one system.
 */
const DARK: Palette = {
  color: {
    canvas: "#110F14",
    surface: "#19171C",
    surfaceSunken: "#151318",
    surfaceHover: "#211E25",
    surfaceActive: "#2B2830",
    surfaceSelected: "#312933",
    chrome: "#161419",

    ink: "#F0EDF3",
    inkBody: "#CDC7D4",
    /** Kept a visible step above `inkSubtle`; both must clear AA on `surfaceSelected`. */
    inkMuted: "#AEA7B7",
    inkSubtle: "#9A93A3",
    inkIcon: "#ACA5B5",
    /** Held one step off `inkSubtle`, so a placeholder does not read as filled-in text. */
    inkPlaceholder: "#9A93A3",

    /** The same plum, lifted to a soft mauve until it reads on a dark page. */
    accent: "#D4A3CE",
    /** Dark text on the light accent: white on #D4A3CE would fail AA. */
    onAccent: "#19171C",

    hairline: "rgba(244, 236, 255, 0.09)",
    hairlineSoft: "rgba(244, 236, 255, 0.055)",
    divider: "rgba(244, 236, 255, 0.15)",
    controlBorder: "rgba(244, 236, 255, 0.12)",
    focusRing: "#D4A3CE",

    danger: "#F28B6E",
    success: "#6BCB7F",
    notice: "rgba(107, 203, 127, 0.1)",
    dangerWash: "rgba(242, 139, 110, 0.1)",

    scrollbar: "rgba(244, 236, 255, 0.24)",

    veil: "rgba(25, 23, 28, 0.97)",
    sheen: "rgba(240, 237, 243, 0.07)",
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
