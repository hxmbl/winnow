/**
 * Every colour in the app, in one place.
 *
 * How it works:
 *   1. Edit a value below.
 *   2. `applyTheme(root, scheme)` mirrors the active palette to `--wn-*` custom
 *      properties on `<html>`, so plain CSS in `index.css` — the scrollbar, the
 *      glass fill — reads from the same source as Tailwind.
 *   3. `tailwind.config.js` maps the same names onto utilities, so components
 *      write `bg-surface` and never a hex value.
 *
 * The two palettes are the same *system* with different values, not two
 * designs. That is why the names are semantic (`surfaceActive`, not `blue-100`):
 * a component never has to know which palette is live, so adding dark mode
 * touched this file and nothing else.
 *
 * Depth is deliberately shallow. Four surface planes, hairline separators and
 * real gaps between containers carry the hierarchy — no bevels, no inner glow, no
 * gradient behind a control, and exactly two shadows in the whole system. The
 * only reason a shadow exists is to keep a white card from reading as a hole cut
 * into a tinted canvas.
 *
 * Only Tailwind's built-in palette (`black`, `white`) supports `/opacity`
 * modifiers — these token colours are CSS variables, so any alpha is baked into
 * the value here rather than applied by a modifier.
 */

/** Panel fill from references/reader-detail.svg, which draws it at 0.81. */
const PANEL = "#FAFFFF";
const PANEL_ALPHA = 0.81;

/**
 * The semantic names, and their light-mode values.
 *
 * Grouped by the four jobs a colour can do: surfaces, text, lines, and
 * everything else (scrollbar, focus). The grouping is the only documentation
 * that matters here — a new contributor should be able to guess which group a
 * token belongs in.
 */
type Palette = {
  color: Record<string, string>;
  /** Accent per bucket, for the reader's chips. See `ui/filterColors`. */
  badge: Record<string, string>;
  elevation: Record<string, string>;
  glass: string;
};

const LIGHT: Palette = {
  color: {
    // ── Surfaces ────────────────────────────────────────────────
    /**
     * Whole-app backdrop. Not white: it sits *behind* the panes, and a tinted
     * backdrop is what lets an unshadowed white card still read as raised.
     */
    canvas: "#EFF3F3",
    /** Pane and control fill — the default "thing you can touch". */
    surface: "#FFFFFF",
    /** Recessed fill: list section headers, search, empty states. */
    surfaceSunken: "#F6F8F8",
    /** Hover wash on rows and icon buttons. */
    surfaceHover: "#F2F5F6",
    /** The selected list row. */
    surfaceActive: "#E6EDEF",
    /** Reader surface. The design draws it as a flat wash, not a card. */
    panel: rgba(PANEL, PANEL_ALPHA),
    /** Top bar / mobile back bar. */
    chrome: "#FFFFFF",

    // ── Text ────────────────────────────────────────────────────
    /** Headlines — sender name, subject. */
    ink: "#15181D",
    /** Long-form body copy. */
    inkBody: "#3C434C",
    /** Secondary metadata: addresses, timestamps. */
    inkMuted: "#767D87",
    /** Tertiary: section labels, empty-state copy. */
    inkSubtle: "#8B929C",
    /** Toolbar icon buttons. */
    inkIcon: "#4A515A",
    /** Search placeholder. */
    inkPlaceholder: "#8B929C",

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

    // ── Avatars ─────────────────────────────────────────────────
    avatar: "#DDE2E3",

    // ── Status ──────────────────────────────────────────────────
    /** Destructive actions and errors. The only red that is not a bucket. */
    danger: "#B42318",
    /** Confirmation, and "this worked". */
    success: "#15803D",
    /** The notice strip's wash, for a non-blocking message. */
    notice: "rgba(21, 128, 61, 0.08)",
    /** The error strip's wash. */
    dangerWash: "rgba(180, 35, 24, 0.07)",

    // ── Chrome ──────────────────────────────────────────────────
    scrollbar: "rgba(15, 23, 42, 0.2)",
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

  /**
   * Both shadows do the same job — separate one plane from the next without
   * implying a physical object. `pane` is on the list and reader cards; `lift`
   * is for chrome floating over scrolling content, which is what the modal
   * sheets use.
   */
  elevation: {
    pane: "0 1px 2px rgba(15, 23, 42, 0.05)",
    lift: "0 12px 32px rgba(15, 23, 42, 0.12), 0 2px 6px rgba(15, 23, 42, 0.05)",
  },

  glass: "rgba(255, 255, 255, 0.72)",
};

/**
 * Dark mode.
 *
 * Not an inversion. The surfaces step up in *lightness* rather than dropping to
 * black: a mail client is read for long stretches, and a true-black list behind
 * white text is the single most common cause of eye strain in a dark theme.
 * `#15181D` is the same ink the light theme uses for text, promoted to the
 * canvas — which keeps the two palettes reading as one system.
 */
const DARK: Palette = {
  color: {
    canvas: "#0F1216",
    surface: "#181C22",
    surfaceSunken: "#13171C",
    surfaceHover: "#1F242B",
    surfaceActive: "#2A313A",
    panel: rgba("#1B2027", 0.9),
    chrome: "#151A20",

    ink: "#EDF1F4",
    inkBody: "#C3CBD3",
    inkMuted: "#8D97A2",
    inkSubtle: "#6C7681",
    inkIcon: "#A7B1BC",
    inkPlaceholder: "#6C7681",

    hairline: "rgba(255, 255, 255, 0.09)",
    hairlineSoft: "rgba(255, 255, 255, 0.055)",
    divider: "rgba(255, 255, 255, 0.15)",
    controlBorder: "rgba(255, 255, 255, 0.11)",
    focusRing: "rgba(160, 172, 186, 0.7)",

    avatar: "#2A313A",

    danger: "#F97066",
    success: "#4ADE80",
    notice: "rgba(74, 222, 128, 0.1)",
    dangerWash: "rgba(249, 112, 102, 0.1)",

    scrollbar: "rgba(255, 255, 255, 0.24)",
  },

  // The light palette's badge accents are all dark enough to fail on a dark
  // surface. These are the same hues, lifted — the *relationship* between them
  // is what carries meaning, not the specific hex.
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

  glass: "rgba(21, 26, 32, 0.76)",
};

export const PALETTES = { light: LIGHT, dark: DARK } as const;

export type ThemeName = keyof typeof PALETTES;

/** The light palette, for callers that need a value without the active scheme. */
export const theme = LIGHT.color;

function rgba(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** The active palette, defaulting to light. */
export function paletteFor(scheme: ThemeName): Palette {
  return PALETTES[scheme];
}

/**
 * Mirror the active palette into `--wn-*` custom properties.
 *
 * Called on mount and again whenever the scheme changes, because the properties
 * live on `<html>` and the Tailwind utilities resolve against them at paint
 * time — no rebuild, no class churn.
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
  root.style.setProperty("--wn-glass", palette.glass);
  // Drives native form controls, scrollbars, and the `color-scheme` the OS uses
  // to pick a matching default background. Without it a dark app still gets a
  // white flash before the first paint.
  root.style.colorScheme = scheme;
  root.dataset.theme = scheme;
}

/**
 * The scheme to actually render.
 *
 * `system` resolves against the OS. The listener is registered by the caller
 * (`ThemeProvider` in `App.tsx`) because this module has no business owning a
 * subscription.
 */
export function resolveScheme(
  preference: "system" | "light" | "dark",
  systemPrefersDark: boolean,
): ThemeName {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}
