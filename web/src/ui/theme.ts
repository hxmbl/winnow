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
 *
 * `contrastRatio` and `relativeLuminance` are here rather than in a test helper
 * because the value of being able to *check* a palette is what stops it drifting:
 * a colour nobody can measure is a colour nobody can fix. They are asserted over
 * every text token in `theme.test.ts`.
 */

/**
 * WCAG relative luminance, and the contrast ratio between two sRGB colours.
 *
 * Present because a palette that cannot be checked is a palette that drifts. Two greys
 * in this file were chosen by eye and both failed AA against the planes they sit on —
 * `#8B929C` at 3.14:1 — which is invisible in a screenshot and illegible in a room.
 * Exported so `theme.test.ts` can assert the guarantee rather than trusting it.
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
 * The semantic names, and their light-mode values.
 *
 * Grouped by the four jobs a colour can do: surfaces, text, lines, and
 * everything else (scrollbar, focus). The grouping is the only documentation
 * that matters here — a new contributor should be able to guess which group a
 * token belongs in.
 */
type Palette = {
  color: Record<string, string>;
  /**
   * Accent per bucket.
   *
   * These were the reader's chip fills, and they stopped being that: a classification
   * is now carried by a glyph and a word, and a colour that has to be decoded before it
   * can be read was never the right carrier for one. What survives is `starred`, which
   * tints the star on a row and in the reader, and the hue identities that
   * `ui/filterColors` builds its pill washes from.
   *
   * The derivation that used to sit on top of this — a wash, an edge and a label ink per
   * accent, with the label nudged toward the palette's own text until it cleared WCAG AA
   * on a wash of itself — went with the chips. Nothing read it, and leaving it would
   * have been a hundred lines of contrast arithmetic guarding colours that are not on
   * screen.
   */
  badge: Record<string, string>;
  elevation: Record<string, string>;
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
    /** Masthead and the mobile bar under it. */
    chrome: "#FFFFFF",

    // ── Text ────────────────────────────────────────────────────
    /** Headlines — sender name, subject. */
    ink: "#15181D",
    /** Long-form body copy. */
    inkBody: "#3C434C",
    /**
     * Secondary metadata: addresses, timestamps.
     *
     * Both of these were chosen by eye and both failed WCAG AA against the planes
     * they sit on — `#767D87` is 4.16:1 on white and `#8B929C` is 3.14:1, at
     * 11–13px. Neither shows up as a problem in a screenshot; together they are why
     * the list reads as slightly washed out.
     *
     * The values below are the originals darkened just far enough to clear 4.5:1
     * against every plane each one is actually painted on. Note the asymmetry in
     * what they have to clear: `inkMuted` also appears on `surfaceActive`, because
     * a *selected* row raises its secondary text one step, while `inkSubtle` does
     * not — which is what leaves the two a visible step apart instead of collapsing
     * onto the same grey. See `theme.test.ts`, which asserts both the contrast and
     * the ordering.
     */
    inkMuted: "#5A5F67",
    /** Tertiary: section labels, empty-state copy, the row timestamp. */
    inkSubtle: "#656B72",
    /** Toolbar icon buttons. */
    inkIcon: "#4A515A",
    /** Search placeholder. Same requirement as `inkSubtle`: it is 13px text. */
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
    /**
     * The fill for anything that genuinely floats: the navigation drawer, the
     * sheets, the composer's scrim.
     *
     * Translucency rather than an opaque fill because these sit *over* content, and
     * an opaque one would cut a hole in the surface instead of sitting on it. Paired
     * with a `backdrop-filter`, the thing underneath stays legible as texture —
     * which is the whole visual argument for a floating layer, and the reason it is
     * not simply a darker box.
     */
    veil: "rgba(255, 255, 255, 0.74)",
    /**
     * Selection, as illumination rather than as an outline.
     *
     * The old selected row was `bg-surfaceActive` — an opaque step lighter than the
     * list — which is fine until three surfaces need to be told apart, at which point
     * every one of them wants its own opaque fill and the palette stops being able to
     * say which is nearer. This is a low-alpha wash of the palette's own ink, so it
     * darkens on a light scheme and lightens on a dark one, and it composes over
     * whatever is beneath rather than replacing it.
     */
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
    chrome: "#151A20",

    ink: "#EDF1F4",
    inkBody: "#C3CBD3",
    /**
     * `inkMuted` and `inkSubtle` were `#9FA8B1` and `#929AA2` — greys 8% apart in
     * lightness, which read as one colour on a row: the preview line and the timestamp
     * beside it were the same step of the ramp, so the hierarchy the list depends on
     * had collapsed without either token failing a contrast check.
     *
     * They cannot be separated by pushing `inkSubtle` down, because `inkSubtle` is
     * already pinned at the AA floor: at `#929AA2` it is 4.61:1 on `surfaceActive`,
     * the lightest plane in this palette, and 4.5:1 is the bar. Darkening it to make
     * room buys a visible step by spending legibility. So `inkMuted` went up instead.
     *
     * The two steps are now 1.35 and 1.36 in luminance, against 1.53 and 1.21 before:
     * the ramp is not merely wider, it is *even*, which is what the eye reads as a
     * hierarchy rather than a pair of unrelated greys. `inkMuted` gained contrast
     * (5.45:1 → 6.11:1) and `inkSubtle` kept its own (4.61:1 → 4.65:1), so this is
     * an improvement on both axes and not a redistribution of one against the other.
     */
    inkMuted: "#A9B2BA",
    inkSubtle: "#929BA3",
    inkIcon: "#A7B1BC",
    /**
     * The dark palette had the same problem from the other direction: `#6C7681` is
     * 3.79:1 on `chrome` and 2.84:1 on `surfaceActive` — the row timestamp, the
     * section header and the status line were all below AA. Lifted to clear 4.5:1 on
     * the *lightest* surface of this palette, which is the binding case here.
     *
     * Held at `#929AA2`, one step off `inkSubtle` rather than level with it. They were
     * the same hex when that token moved up, which is worth avoiding on its own terms:
     * placeholder and metadata are different roles, and a placeholder reading as
     * filled-in text is a worse failure than the two being faintly distinct.
     */
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

    // The same three, for a surface that is *dark* rather than light. `veil` is the
    // lighter of the two alphas on purpose: on a near-black canvas a fill that was
    // 74% opaque reads as a grey card rather than as glass, because there is nothing
    // bright behind it to diffuse. `sheen` inverts direction for the same reason the
    // ink ramp does — it has to lighten a dark surface, not darken it.
    veil: "rgba(28, 33, 40, 0.72)",
    sheen: "rgba(237, 241, 244, 0.07)",
    scrim: "rgba(0, 0, 0, 0.34)",
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
