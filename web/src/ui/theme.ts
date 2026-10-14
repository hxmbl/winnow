/**
 * Every colour in the app, in one place.
 *
 * How it works:
 *   1. Edit a value below.
 *   2. `applyTheme(root, mode, accent)` mirrors the active palette to `--wn-*` custom
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

import {
  DEFAULT_ACCENT_THEME,
  type AccentTheme,
  type Appearance,
} from "../core/model/appearance";

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
 * Pale, cool lavender-greys: every neutral carries a little of the accent's blue-violet, so
 * the light page reads as the same night sky with the lights on rather than a different app.
 * Surfaces are separated by value alone — no rules, no shadows.
 */
const LIGHT: Palette = {
  color: {
    // ── Surfaces ────────────────────────────────────────────────
    /** Whole-app backdrop: the chrome and the reader's gutter. */
    canvas: "#EDECF4",
    /** Pane and control fill — the default "thing you can touch". */
    surface: "#FAFAFD",
    /** Recessed fill: the reader pane, search, empty states. */
    surfaceSunken: "#F4F3F9",
    /** Hover wash on rows and icon buttons. */
    surfaceHover: "#EDECF4",
    /** Pressed and focused fills. */
    surfaceActive: "#E2E0EE",
    /** The selected list row: the accent, washed into `surface`. Opaque so the contrast test can see it. */
    surfaceSelected: "#E7E2FA",
    /** Masthead and the mobile bar under it. */
    chrome: "#FAFAFD",

    // ── Text ────────────────────────────────────────────────────
    /** Headlines — sender name, subject. */
    ink: "#18162B",
    /** Long-form body copy. */
    inkBody: "#37334F",
    /** Secondary metadata: addresses, timestamps. Clears AA on every plane it sits on. */
    inkMuted: "#514C6A",
    /** Tertiary: section labels, empty-state copy, the row timestamp. Kept a visible step from `inkMuted`. */
    inkSubtle: "#615C7A",
    /** Toolbar icon buttons. */
    inkIcon: "#45405E",
    /** Search placeholder. Same size requirement as `inkSubtle`. */
    inkPlaceholder: "#615C7A",

    // ── Accent ──────────────────────────────────────────────────
    /**
     * Winnow's one colour: a deep space violet, an indigo-leaning blue-violet saturated enough
     * to read as a colour of its own. Unread, selection, focus and the primary action, and
     * nothing else. 5.8:1 or better on every surface, so it can carry text as well as a ring.
     */
    accent: "#5028E2",
    /** Text on a solid accent fill. */
    onAccent: "#FFFFFF",

    // ── Status ──────────────────────────────────────────────────
    /** Destructive actions and errors. A brick red, more than 100° of hue from the violet so "delete" never reads as "go". */
    danger: "#B42318",
    /** Confirmation, and "this worked". */
    success: "#2F7A3E",
    /** The notice strip's wash, for a non-blocking message. */
    notice: "rgba(47, 122, 62, 0.08)",
    /** The error strip's wash. */
    dangerWash: "rgba(180, 35, 24, 0.07)",

    // ── Lines & controls ────────────────────────────────────────
    /** Default separator. Everything structural uses this unless it needs to recede. */
    hairline: "rgba(28, 22, 72, 0.09)",
    /** Separator inside a container that already has a border. */
    hairlineSoft: "rgba(28, 22, 72, 0.055)",
    /** Vertical separators splitting an action cluster into groups. */
    divider: "rgba(28, 22, 72, 0.14)",
    /** Neutral control border (search, action cluster). */
    controlBorder: "rgba(28, 22, 72, 0.12)",
    /** Focus ring: the accent, solid. 3:1 or better against every surface. */
    focusRing: "#5028E2",
    /**
     * An edge drawn only where value cannot separate two planes: the search field, the
     * reader pane, the phone dock. Transparent here and in dark, where the planes already
     * differ in lightness; a violet hairline on OLED, where they are all black.
     */
    edge: "transparent",

    // ── Chrome ──────────────────────────────────────────────────
    scrollbar: "rgba(28, 22, 72, 0.22)",

    // ── Depth, without borders ─────────────────────────────────
    /** Fill for layers floating over content (drawer, sheets). Opaque now that nothing blurs behind it. */
    veil: "rgba(250, 250, 253, 0.96)",
    /** A low-alpha wash of the palette's own ink: pressed states and quiet buttons. */
    sheen: "rgba(28, 22, 72, 0.06)",
    /** What the drawer dims. Tinted, not black, so dimming reads as depth. */
    scrim: "rgba(16, 12, 52, 0.2)",
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
 * Dark mode, the palette's main expression.
 *
 * A night sky rather than an inversion: deep indigo-blacks with a clear blue-violet cast,
 * stepping up in lightness from canvas to surface. Darker than it first shipped — the
 * page is nearly black now — but deliberately not black: that is what OLED is for, and
 * keeping a little indigo in every plane is what lets the steps between them stay
 * visible. Lines and washes are violet-tinted lavender, the inks cool lavender-whites,
 * and the accent is the one luminous thing on the page.
 *
 * The accent, its selected-row wash and danger are written here for Space and replaced
 * per accent theme by `paletteFor` (see `ACCENTS`).
 */
const DARK: Palette = {
  color: {
    canvas: "#070612",
    surface: "#0D0B1E",
    surfaceSunken: "#0A0918",
    surfaceHover: "#141229",
    surfaceActive: "#1C1A35",
    surfaceSelected: "#221A3E",
    chrome: "#0B0A1B",

    ink: "#EDEBFA",
    inkBody: "#CAC6E0",
    /** Kept a visible step above `inkSubtle`; both must clear AA on `surfaceSelected`. */
    inkMuted: "#AAA5C4",
    inkSubtle: "#9590B2",
    inkIcon: "#A8A3C2",
    /** Held one step off `inkSubtle`, so a placeholder does not read as filled-in text. */
    inkPlaceholder: "#9590B2",

    /** The same violet, lifted to a luminous lavender that glows against the indigo-black. */
    accent: "#B9A5FF",
    /** Dark text on the light accent: white on #B9A5FF would fail AA. */
    onAccent: "#0D0B1E",

    hairline: "rgba(200, 188, 255, 0.09)",
    hairlineSoft: "rgba(200, 188, 255, 0.055)",
    divider: "rgba(200, 188, 255, 0.15)",
    controlBorder: "rgba(200, 188, 255, 0.12)",
    focusRing: "#B9A5FF",
    edge: "transparent",

    danger: "#F28B6E",
    success: "#6BCB7F",
    notice: "rgba(107, 203, 127, 0.1)",
    dangerWash: "rgba(242, 139, 110, 0.1)",

    scrollbar: "rgba(200, 188, 255, 0.24)",

    veil: "rgba(13, 11, 30, 0.97)",
    sheen: "rgba(237, 235, 250, 0.07)",
    scrim: "rgba(2, 1, 10, 0.55)",
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

/**
 * OLED: dark, with the lights all the way off.
 *
 * Canvas, panes and chrome are true black, so an OLED screen switches those pixels off.
 * Only the states that have to be seen — hover, pressed, the selected row — keep a
 * very dark indigo, still a visible step apart. With the planes no longer separated by
 * value, the violet-tinted hairlines carry the structure and are a touch stronger than
 * dark's. Inks, accent and danger are dark's, which only gain contrast on black.
 */
const OLED: Palette = {
  color: {
    ...DARK.color,
    canvas: "#000000",
    surface: "#000000",
    surfaceSunken: "#000000",
    chrome: "#000000",
    surfaceHover: "#0E0C1F",
    surfaceActive: "#16132D",
    surfaceSelected: "#1A1333",

    onAccent: "#000000",

    hairline: "rgba(200, 188, 255, 0.13)",
    hairlineSoft: "rgba(200, 188, 255, 0.08)",
    divider: "rgba(200, 188, 255, 0.19)",
    controlBorder: "rgba(200, 188, 255, 0.16)",
    /** With every plane black, this is what tells the search field and the panes apart. */
    edge: "rgba(200, 188, 255, 0.16)",

    scrollbar: "rgba(200, 188, 255, 0.26)",

    veil: "rgba(0, 0, 0, 0.97)",
    sheen: "rgba(237, 235, 250, 0.08)",
    scrim: "rgba(0, 0, 0, 0.6)",
  },
  badge: DARK.badge,
  elevation: DARK.elevation,
};

/** The three modes a palette is drawn for. `system` resolves to one of the first two. */
export const PALETTES = { light: LIGHT, dark: DARK, oled: OLED } as const;

export type ThemeName = keyof typeof PALETTES;

/** The modes, in the order tests and the picker walk them. */
export const MODES = Object.keys(PALETTES) as ThemeName[];

/**
 * What an accent theme replaces, per mode.
 *
 * `accent` is the colour itself (and the focus ring); `onAccent` is text on a solid
 * accent fill; `surfaceSelected` is the accent washed into the surface, hand-matched in
 * lightness across accents so the selected row is the same step on every theme.
 * `danger` is only given where the shared red would sit too close to the accent.
 */
type AccentTones = {
  accent: string;
  onAccent: string;
  surfaceSelected: string;
  danger?: string;
};

type AccentSpec = {
  /** What the picker calls it. */
  label: string;
  light: AccentTones;
  dark: AccentTones;
  oled: AccentTones;
};

/**
 * The accent themes. Neutrals are shared: every theme sits on the same indigo-tinted
 * greys (Space's), so the page stays Winnow's and only the one colour that means
 * something changes. Every combination is held to WCAG AA in `theme.test.ts`.
 */
export const ACCENTS: Record<AccentTheme, AccentSpec> = {
  /** Space violet, the default: an indigo-leaning blue-violet. */
  space: {
    label: "Space",
    light: { accent: "#5028E2", onAccent: "#FFFFFF", surfaceSelected: "#E7E2FA" },
    dark: { accent: "#B9A5FF", onAccent: "#0D0B1E", surfaceSelected: "#221A3E" },
    oled: { accent: "#B9A5FF", onAccent: "#000000", surfaceSelected: "#1A1333" },
  },
  /** Plum: a dusky red-violet. */
  plum: {
    label: "Plum",
    light: { accent: "#74306A", onAccent: "#FFFFFF", surfaceSelected: "#F9DDF5" },
    dark: { accent: "#D4A3CE", onAccent: "#0D0B1E", surfaceSelected: "#32152F" },
    oled: { accent: "#D4A3CE", onAccent: "#000000", surfaceSelected: "#280F25" },
  },
  /**
   * Ember: rust in light, a warm amber glow in dark. It lives next door to red, so its
   * danger moves the other way — to a crimson-rose — to keep the two more than 40°
   * apart: "delete" must never read as the accent.
   */
  ember: {
    label: "Ember",
    light: { accent: "#A2470D", onAccent: "#FFFFFF", surfaceSelected: "#F8E0D2", danger: "#B8184A" },
    dark: { accent: "#F0964F", onAccent: "#0D0B1E", surfaceSelected: "#2B1D12", danger: "#FF80A4" },
    oled: { accent: "#F0964F", onAccent: "#000000", surfaceSelected: "#21160D", danger: "#FF80A4" },
  },
  /** Aurora: a cool teal, the northern lights against the night-sky neutrals. */
  aurora: {
    label: "Aurora",
    light: { accent: "#0A6E68", onAccent: "#FFFFFF", surfaceSelected: "#D9F2EF" },
    dark: { accent: "#5ED6C5", onAccent: "#0D0B1E", surfaceSelected: "#0E2321" },
    oled: { accent: "#5ED6C5", onAccent: "#000000", surfaceSelected: "#0A1B19" },
  },
};

/** `#RRGGBB` at an alpha, as `rgba()`. For the washes derived from a theme's colours. */
function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The light palette, for callers that need a value without the active scheme. */
export const theme = LIGHT.color;

/** The palette for a mode and accent theme. Space when no accent is given. */
export function paletteFor(scheme: ThemeName, accent: AccentTheme = DEFAULT_ACCENT_THEME): Palette {
  const base = PALETTES[scheme];
  const tones = ACCENTS[accent][scheme];
  const danger = tones.danger ?? base.color.danger;
  return {
    ...base,
    color: {
      ...base.color,
      accent: tones.accent,
      focusRing: tones.accent,
      onAccent: tones.onAccent,
      surfaceSelected: tones.surfaceSelected,
      danger,
      dangerWash: tones.danger ? withAlpha(danger, scheme === "light" ? 0.07 : 0.1) : base.color.dangerWash,
    },
  };
}

/**
 * Mirror the active palette into `--wn-*` custom properties on `<html>`.
 *
 * Called before the first render (`main.tsx`) and whenever the mode or accent changes,
 * because the Tailwind utilities resolve against these variables at paint time.
 */
export function applyTheme(
  root: HTMLElement,
  scheme: ThemeName = "light",
  accent: AccentTheme = DEFAULT_ACCENT_THEME,
): void {
  const palette = paletteFor(scheme, accent);
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
  // app does not flash white before first paint. OLED is a dark scheme to the browser.
  root.style.colorScheme = scheme === "light" ? "light" : "dark";
  root.dataset.theme = scheme;
  root.dataset.accent = accent;
}

/**
 * The mode to actually render. `system` resolves against the OS — to dark, never OLED,
 * since true black is a choice about one's own screen rather than something the OS
 * reports. The caller (`App`) owns the subscription. `public/theme-boot.js` repeats
 * this rule before the bundle loads, and `theme.test.ts` holds the two to each other.
 */
export function resolveScheme(preference: Appearance, systemPrefersDark: boolean): ThemeName {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}
