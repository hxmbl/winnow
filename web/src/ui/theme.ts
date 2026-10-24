/**
 * Every colour in the app, in one place.
 *
 * How it works:
 *   1. Edit a value below.
 *   2. `applyTheme(root, mode, accent)` mirrors the active palette to `--wn-*` custom
 *      properties on `<html>`, so plain CSS in `index.css` — the scrollbar, the
 *      focus ring — reads from the same source as Tailwind.
 *   3. `index.css`'s `@theme` maps the same names onto utilities, so components
 *      write `bg-surface` and never a hex value.
 *
 * Names are semantic (`surfaceActive`, not `blue-100`), so a component never has
 * to know which palette is live.
 *
 * Token colours are CSS variables tuned per mode, so they never take Tailwind's
 * `/opacity` modifier (`theme.test.ts` holds that) — any alpha is baked into the value here.
 *
 * `contrastRatio` and `relativeLuminance` live here so `theme.test.ts` can assert
 * the palette's contrast guarantees rather than trusting them.
 */

import {
  ACCENT_THEMES,
  CUSTOM_ACCENT,
  DEFAULT_ACCENT_CUSTOM,
  DEFAULT_ACCENT_THEME,
  normalizeHexColor,
  type AccentPreference,
  type AccentTheme,
  type Appearance,
} from "../core/model/appearance";
import { COMPOSE_SHEEN, COMPOSE_TINT, GLASS, LIQUID, WASH, glassProperties } from "./glass";
import { FILTER_HUES, type PillHue } from "./filterColors";
import { composite, contrastRatio, hslToRgb, relativeLuminance, toHex, withAlpha } from "./color";
import { deriveCustomAccent, type CustomAccent, type CustomAccentContext } from "./customAccent";

export { contrastRatio, composite, hslToRgb, relativeLuminance } from "./color";

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
  /** How this mode colours the filter rail's pills. See `PillRecipe`. */
  pill: PillRecipe;
};

/**
 * How a mode turns a pill's identity hue (`filterColors.ts`) into its fill.
 *
 * Published as `--wn-pill-*` and combined in `.wn-pill` (`index.css`):
 * `hsl(h, s × saturation, lightness)` at `rest` alpha, `on` alpha when the pill is on,
 * with a 1px inset ring at `ring` alpha. The fill is translucent so a pill sits on
 * either plane the rail lives on (the list surface on the desktop, the canvas in the
 * phone dock); `pillFill` below is the same arithmetic, so `theme.test.ts` can hold
 * every label and count to WCAG AA on every hue, plane, state and hover.
 *
 * The inks are the palette's own text tokens, picked per mode: light keeps its body ink
 * on a resting pill, the dark modes use full ink throughout because a dark tint leaves
 * less room under the text.
 */
export type PillRecipe = {
  /** HSL lightness of the hue, in percent. */
  lightness: number;
  /** How much of a hue's saturation this mode keeps, 0–1. */
  saturation: number;
  /** Fill alpha at rest. */
  rest: number;
  /** Fill alpha when on: clearly stronger than `rest`. */
  on: number;
  /** Alpha of the 1px inset ring an "on" pill gets. */
  ring: number;
  /** Label ink on a resting pill, as a `color` token name. */
  ink: string;
  /** Label ink on an "on" pill. */
  inkOn: string;
  /** The count's ink. */
  count: string;
  /**
   * HSL lightness for a hue used as *text* on the list (the row's "Urgent" word), in
   * percent. The same hue and saturation as the pill, so the word reads as its chip,
   * but at a lightness that clears AA on every row plane: the pill's own `lightness`
   * is tuned for a translucent fill and is too light (light mode) or too dark (dark
   * modes) for small text. Published as `--wn-pill-textL`; see `.wn-signal-ink`.
   */
  textLightness: number;
};

/**
 * Light.
 *
 * Near white: the planes, inks and lines are near-neutral greys (since 1.4.0 they carry
 * only a trace of cool, where they used to lean towards Space's violet), the same for
 * every accent. The accent colours what you act on (buttons, links, switches, focus,
 * unread) and nothing else, bar the faint wash behind the list. Surfaces are separated
 * by value alone — no rules, no shadows.
 */
const LIGHT: Palette = {
  color: {
    // ── Surfaces ────────────────────────────────────────────────
    /** Whole-app backdrop: the chrome and the reader's gutter. */
    canvas: "#F1F1F3",
    /** Pane and control fill — the default "thing you can touch". */
    surface: "#FDFDFE",
    /** Recessed fill: the reader pane, search, empty states. */
    surfaceSunken: "#F7F7F8",
    /** Hover wash on rows and icon buttons. */
    surfaceHover: "#F1F1F3",
    /** Pressed and focused fills. */
    surfaceActive: "#E6E6EA",
    /**
     * The selected list row (and the current item in a picker): a neutral step between
     * hover and pressed, the same for every accent. It used to be the accent washed into
     * `surface`; since 1.4.0 the accent is for what you act on, not for large fills.
     */
    surfaceSelected: "#EBEBEF",
    /** Masthead and the mobile bar under it. */
    chrome: "#FDFDFE",

    // ── Text ────────────────────────────────────────────────────
    /** Headlines — sender name, subject. */
    ink: "#18181C",
    /** The strongest ink. Light has none stronger than `ink`; the dark modes use white. */
    inkStrong: "#18181C",
    /** Long-form body copy. */
    inkBody: "#36363A",
    /** Secondary metadata: addresses, timestamps. Clears AA on every plane it sits on. */
    inkMuted: "#4F4F53",
    /** Tertiary: section labels, empty-state copy, the row timestamp. Kept a visible step from `inkMuted`. */
    inkSubtle: "#5F5F63",
    /** Toolbar icon buttons. */
    inkIcon: "#434347",
    /** Search placeholder. Same size requirement as `inkSubtle`. */
    inkPlaceholder: "#5F5F63",

    // ── Accent ──────────────────────────────────────────────────
    /**
     * Winnow's one colour: a deep space violet, an indigo-leaning blue-violet saturated enough
     * to read as a colour of its own. What you act on (primary buttons, links, switches,
     * the selected segment, focus) and unread marks, and nothing else. 5.8:1 or better on every surface, so it can carry text as well as a ring.
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
    hairline: "rgba(24, 24, 28, 0.09)",
    /** Separator inside a container that already has a border. */
    hairlineSoft: "rgba(24, 24, 28, 0.055)",
    /** Vertical separators splitting an action cluster into groups. */
    divider: "rgba(24, 24, 28, 0.14)",
    /** Neutral control border (search, action cluster). */
    controlBorder: "rgba(24, 24, 28, 0.12)",
    /** Focus ring: the accent, solid. 3:1 or better against every surface. */
    focusRing: "#5028E2",
    /**
     * An edge drawn only where value cannot separate two planes: the search field, the
     * reader pane, the phone dock. Transparent here and in dark, where the planes already
     * differ in lightness; a white hairline on OLED, where they are all black.
     */
    edge: "transparent",

    // ── Chrome ──────────────────────────────────────────────────
    scrollbar: "rgba(24, 24, 28, 0.22)",

    // ── Depth, without borders ─────────────────────────────────
    /** Fill for layers floating over content (drawer, sheets). Opaque now that nothing blurs behind it. */
    veil: "rgba(250, 250, 253, 0.96)",
    /** A low-alpha wash of the palette's own ink: pressed states and quiet buttons. */
    sheen: "rgba(24, 24, 28, 0.06)",
    /** What the drawer dims. A near-neutral, not the accent, so dimming reads as depth and nothing else. */
    scrim: "rgba(16, 16, 20, 0.2)",
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

  pill: { lightness: 48, saturation: 1, rest: 0.14, on: 0.34, ring: 0.5, ink: "inkBody", inkOn: "ink", count: "inkBody", textLightness: 42 },
};

/**
 * Dark mode: neutral greys, in the manner of Notion's dark theme.
 *
 * No tint in the planes or the inks: a near-black canvas (#191919), the chrome a step up,
 * the panes a step above that, and hover, pressed and selected each a visible step
 * brighter again. Without a cast in the neutrals the accent is the only colour on the
 * page, which is the point of having one. Lines and washes are white at low alpha.
 *
 * The muted and subtle inks sit a little brighter than Notion's (#9B9B9B / #7F7F7F):
 * at those values the subtle grey misses WCAG AA even on the canvas, and every ink
 * here is held to AA on every plane it can land on, the pressed fill included.
 *
 * The selected row is a neutral grey rather than an accent wash: on neutral planes a
 * faint violet reads as a smudge, and a grey step reads as "this one". The accent and
 * danger are written here for Space and replaced per accent theme by `paletteFor`.
 */
const DARK: Palette = {
  color: {
    canvas: "#191919",
    surface: "#252525",
    surfaceSunken: "#1F1F1F",
    surfaceHover: "#2C2C2C",
    surfaceActive: "#373737",
    surfaceSelected: "#323232",
    chrome: "#202020",

    /** About 87% white, written opaque so the contrast test can measure it. */
    ink: "#E3E3E3",
    /**
     * Pure white, for the smart-filter chips' labels only (1.3.3): the chips were made
     * more vibrant (brighter, fully saturated fills) and #E3E3E3 no longer cleared AA on
     * the brightest "on" fills; white does, with a margin. See `pill` below.
     */
    inkStrong: "#FFFFFF",
    inkBody: "#D4D4D4",
    /** Kept a visible step above `inkSubtle`; both must clear AA on `surfaceActive`. */
    inkMuted: "#ADADAD",
    /**
     * #A4A4A4 since 1.3.2 (was #A0A0A0, which measured 4.48:1 under the compose
     * suggestions' active row): AA with a margin on `surfaceActive`, see `theme.test.ts`.
     */
    inkSubtle: "#A4A4A4",
    inkIcon: "#ABABAB",
    /** Held one step off `inkSubtle`, so a placeholder does not read as filled-in text. */
    inkPlaceholder: "#A0A0A0",

    /** The same violet, lifted to a luminous lavender. */
    accent: "#B9A5FF",
    /** Dark text on the light accent: white on #B9A5FF would fail AA. */
    onAccent: "#191919",

    hairline: "rgba(255, 255, 255, 0.09)",
    hairlineSoft: "rgba(255, 255, 255, 0.055)",
    divider: "rgba(255, 255, 255, 0.14)",
    controlBorder: "rgba(255, 255, 255, 0.12)",
    focusRing: "#B9A5FF",
    edge: "transparent",

    danger: "#F28B6E",
    success: "#6BCB7F",
    notice: "rgba(107, 203, 127, 0.1)",
    dangerWash: "rgba(242, 139, 110, 0.1)",

    scrollbar: "rgba(255, 255, 255, 0.22)",

    veil: "rgba(37, 37, 37, 0.97)",
    sheen: "rgba(255, 255, 255, 0.06)",
    scrim: "rgba(0, 0, 0, 0.55)",
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

  /**
   * More vibrant since 1.3.3 (the owner asked for more life in the dark chips): the full
   * saturation of each hue, a lighter tone, and stronger fills, with white labels and
   * counts (`inkStrong`) so the brightest "on" fill (amber, hovered) still clears AA.
   * Was lightness 55, saturation 0.7, rest 0.16, on 0.34 with #E3E3E3 text.
   */
  pill: { lightness: 58, saturation: 1, rest: 0.2, on: 0.4, ring: 0.7, ink: "inkStrong", inkOn: "inkStrong", count: "inkStrong", textLightness: 68 },
};

/**
 * OLED: dark, with the lights all the way off.
 *
 * Canvas, panes and chrome are true black, so an OLED screen switches those pixels off.
 * Only the states that have to be seen (hover, pressed, the selected row) keep a dark
 * neutral grey, each a visible step apart, matching dark's neutrals. With the planes no
 * longer separated by value, white hairlines carry the structure and are a touch
 * stronger than dark's. Inks, accent and danger are dark's, which only gain on black.
 */
const OLED: Palette = {
  color: {
    ...DARK.color,
    canvas: "#000000",
    surface: "#000000",
    surfaceSunken: "#000000",
    chrome: "#000000",
    surfaceHover: "#1A1A1A",
    surfaceActive: "#2A2A2A",
    surfaceSelected: "#242424",

    onAccent: "#000000",

    hairline: "rgba(255, 255, 255, 0.13)",
    hairlineSoft: "rgba(255, 255, 255, 0.08)",
    divider: "rgba(255, 255, 255, 0.18)",
    controlBorder: "rgba(255, 255, 255, 0.16)",
    /** With every plane black, this is what tells the search field and the panes apart. */
    edge: "rgba(255, 255, 255, 0.16)",

    scrollbar: "rgba(255, 255, 255, 0.26)",

    veil: "rgba(0, 0, 0, 0.97)",
    sheen: "rgba(255, 255, 255, 0.08)",
    scrim: "rgba(0, 0, 0, 0.6)",
  },
  badge: DARK.badge,
  elevation: DARK.elevation,
  pill: DARK.pill,
};

/** The three modes a palette is drawn for. `system` resolves to one of the first two. */
export const PALETTES = { light: LIGHT, dark: DARK, oled: OLED } as const;

export type ThemeName = keyof typeof PALETTES;

/** Every opaque plane text can land on (the accent included); `theme.test.ts` keeps its own copy. */
const SURFACE_TOKENS = ["canvas", "surface", "surfaceSunken", "surfaceHover", "surfaceActive", "surfaceSelected", "chrome"] as const;

/** The modes, in the order tests and the picker walk them. */
export const MODES = Object.keys(PALETTES) as ThemeName[];

/**
 * What an accent theme replaces, per mode — and the complete list of it.
 *
 * `accent` is the colour itself (and the focus ring); `onAccent` is text on a solid
 * accent fill; `danger` is only given where the shared red would sit too close to the
 * accent. Nothing else: since 1.4.0 the accent is "the colour of buttons and the like",
 * not "everything is that colour", so every plane, ink, line, scrim and the selected row
 * are the mode's own neutrals for every accent (`ACCENT_TOKENS`, held in `theme.test.ts`).
 * The one large thing the accent still reaches is the faint wash behind the list
 * (`WASH` in `glass.ts`).
 */
type AccentTones = {
  accent: string;
  onAccent: string;
  danger?: string;
};

/** The palette tokens an accent theme may change. Every other token is the mode's own. */
export const ACCENT_TOKENS = ["accent", "focusRing", "onAccent", "danger", "dangerWash"] as const;

type AccentSpec = {
  /** What the picker calls it. */
  label: string;
  light: AccentTones;
  dark: AccentTones;
  oled: AccentTones;
};

/**
 * The accent themes. Neutrals are shared and neutral: light's near-white greys, dark and
 * OLED's plain greys, so only the one colour that means something changes.
 * Every combination is held to WCAG AA in `theme.test.ts`.
 */
export const ACCENTS: Record<AccentTheme, AccentSpec> = {
  /** Space violet, the default: an indigo-leaning blue-violet. */
  space: {
    label: "Space",
    light: { accent: "#5028E2", onAccent: "#FFFFFF" },
    dark: { accent: "#B9A5FF", onAccent: "#191919" },
    oled: { accent: "#B9A5FF", onAccent: "#000000" },
  },
  /** Plum: a dusky red-violet. */
  plum: {
    label: "Plum",
    light: { accent: "#74306A", onAccent: "#FFFFFF" },
    dark: { accent: "#D4A3CE", onAccent: "#191919" },
    oled: { accent: "#D4A3CE", onAccent: "#000000" },
  },
  /**
   * Ember: rust in light, a warm amber glow in dark. It lives next door to red, so its
   * danger moves the other way — to a crimson-rose — to keep the two more than 40°
   * apart: "delete" must never read as the accent.
   */
  ember: {
    label: "Ember",
    light: { accent: "#9A430C", onAccent: "#FFFFFF", danger: "#B8184A" },
    dark: { accent: "#F0964F", onAccent: "#191919", danger: "#FF80A4" },
    oled: { accent: "#F0964F", onAccent: "#000000", danger: "#FF80A4" },
  },
  /** Aurora: a cool teal. */
  aurora: {
    label: "Aurora",
    light: { accent: "#096863", onAccent: "#FFFFFF" },
    dark: { accent: "#5ED6C5", onAccent: "#191919" },
    oled: { accent: "#5ED6C5", onAccent: "#000000" },
  },
  /**
   * Rose (1.4.0): a soft raspberry in light, a pale pink in dark. Between Plum and the
   * reds, so like Ember it moves danger: to an orange-red, at least 40° of hue away (the
   * shared brick red is only 25° from it). Its hue is pinned between Plum (30° away) and
   * that orange-red (40° away), which is why it is exactly here.
   */
  rose: {
    label: "Rose",
    light: { accent: "#A1325A", onAccent: "#FFFFFF", danger: "#A54112" },
    dark: { accent: "#EB9CB8", onAccent: "#191919", danger: "#F39465" },
    oled: { accent: "#EB9CB8", onAccent: "#000000", danger: "#F39465" },
  },
  /** Green (1.4.0): a quiet leaf green, kept on the yellow side of Aurora's teal. */
  green: {
    label: "Green",
    light: { accent: "#2B673B", onAccent: "#FFFFFF" },
    dark: { accent: "#79C289", onAccent: "#191919" },
    oled: { accent: "#79C289", onAccent: "#000000" },
  },
  /** Blue (1.4.0): a calm, slightly dusty blue, between Aurora and Space. */
  blue: {
    label: "Blue",
    light: { accent: "#1D5E99", onAccent: "#FFFFFF" },
    dark: { accent: "#86B7EA", onAccent: "#191919" },
    oled: { accent: "#86B7EA", onAccent: "#000000" },
  },
  /**
   * Graphite (1.4.0): the near-neutral. A slate charcoal in light, a cool light grey in
   * dark, with just enough blue that a link still reads as something to press next to
   * the neutral inks. Its hue is incidental, so it is exempt from the "every accent is a
   * different hue" rule in `theme.test.ts` (it is held apart by saturation instead).
   */
  graphite: {
    label: "Graphite",
    light: { accent: "#3E4651", onAccent: "#FFFFFF" },
    dark: { accent: "#B9C2CD", onAccent: "#191919" },
    oled: { accent: "#B9C2CD", onAccent: "#000000" },
  },
};

/** What the picker calls the custom colour. */
export const CUSTOM_ACCENT_LABEL = "Custom";

/**
 * The planes, inks and bars a custom accent is derived against (`customAccent.ts`), per
 * mode, read from the palettes and the glass so the rule moves with them. The luminance
 * band is the one the curated accents span, over which the glass's tints were tuned.
 */
let customContext: CustomAccentContext<ThemeName> | null = null;
export function customAccentContext(): CustomAccentContext<ThemeName> {
  if (customContext) return customContext;
  const build = (scheme: ThemeName) => {
    const { color } = PALETTES[scheme];
    const accents = ACCENT_THEMES.map((id) => relativeLuminance(ACCENTS[id][scheme].accent));
    return {
      surfaces: SURFACE_TOKENS.map((token) => color[token]).filter((value) => value.startsWith("#")),
      washBase: color.surface,
      washPeak: Math.max(WASH[scheme].near, WASH[scheme].far),
      rowInks: ["ink", "inkBody", "inkMuted", "inkSubtle"].map((token) => color[token]),
      onAccent: scheme === "light" ? ["#FFFFFF", color.ink] : ["#FFFFFF", ACCENTS.space[scheme].onAccent],
      composeTint: COMPOSE_TINT,
      composeSheen: COMPOSE_SHEEN,
      luminance:
        scheme === "light"
          ? { min: Math.min(...accents), max: 1 }
          : { min: 0, max: Math.max(...accents) },
      dangers: [
        { danger: undefined, hex: color.danger },
        { danger: ACCENTS.ember[scheme].danger, hex: ACCENTS.ember[scheme].danger as string },
        { danger: ACCENTS.rose[scheme].danger, hex: ACCENTS.rose[scheme].danger as string },
      ],
      backdropOk: (hex: string) => glassReadsOver(scheme, hex),
    };
  };
  customContext = { light: build("light"), dark: build("dark"), oled: build("oled") };
  return customContext;
}

/**
 * Every chip hue that can float over the list: the smart filters' own, and the twelve
 * sender hues (`senderHue`: every 30° from 15°, at 20% saturation).
 */
const GLASS_CHIP_HUES: readonly PillHue[] = [
  ...Object.values(FILTER_HUES),
  ...Array.from({ length: 12 }, (_, step) => ({ h: step * 30 + 15, s: 20 })),
];

/**
 * Whether the floating glass keeps its bars over `under` at full strength: every chip
 * label and count (rest and on) at AA, the panel's rows at AA and the dock's icons at
 * 3:1, the desktop bars' inks at AA, sheen or none. The same arithmetic as
 * `glass.test.ts`, which holds it for the curated accents; a custom accent must pass it.
 */
export function glassReadsOver(scheme: ThemeName, under: string): boolean {
  const { color, pill } = PALETTES[scheme];
  const recipe = GLASS[scheme];
  const white = LIQUID[scheme].sheen + LIQUID[scheme].glow;
  const tint = (alpha: number) => composite(withAlpha(color[recipe.base], alpha), under);
  const plates = (plate: string) => (white > 0 ? [plate, composite(`rgba(255, 255, 255, ${white})`, plate)] : [plate]);
  for (const hue of GLASS_CHIP_HUES) {
    for (const on of [false, true]) {
      const base = pillFill(hue, scheme, tint(on ? recipe.textOn : recipe.text), { on });
      for (const fill of plates(base)) {
        if (contrastRatio(fill, color[on ? pill.inkOn : pill.ink]) < 4.5) return false;
        if (contrastRatio(fill, color[pill.count]) < 4.5) return false;
      }
    }
  }
  for (const plate of plates(tint(recipe.text))) {
    if (contrastRatio(plate, color.inkBody) < 4.5) return false;
    if (contrastRatio(plate, color.inkMuted) < 3 || contrastRatio(plate, color.inkIcon) < 3) return false;
  }
  for (const plate of plates(tint(recipe.bar))) {
    for (const ink of [color.ink, color.inkBody, color.inkMuted]) if (contrastRatio(plate, ink) < 4.5) return false;
  }
  return true;
}

const customCache = new Map<string, CustomAccent<ThemeName>>();

/**
 * A picked colour's tones in every mode, and whether each was adjusted. Anything that is
 * not a hex colour falls back to the default custom colour. Memoised: the picker calls it
 * on every drag of the colour wheel.
 */
export function customAccentFor(hex: string | null | undefined): CustomAccent<ThemeName> {
  const input = normalizeHexColor(hex) ?? DEFAULT_ACCENT_CUSTOM;
  const cached = customCache.get(input);
  if (cached) return cached;
  const derived = deriveCustomAccent(input, customAccentContext());
  if (customCache.size > 1024) customCache.clear();
  customCache.set(input, derived);
  return derived;
}

/** The light palette, for callers that need a value without the active scheme. */
export const theme = LIGHT.color;

/**
 * The palette for a mode and accent: a curated theme, or `custom` with the picked colour
 * (`customHex`, derived per mode by `customAccentFor`). Space when no accent is given.
 */
export function paletteFor(
  scheme: ThemeName,
  accent: AccentPreference = DEFAULT_ACCENT_THEME,
  customHex?: string | null,
): Palette {
  const base = PALETTES[scheme];
  const tones: AccentTones =
    accent === CUSTOM_ACCENT ? customAccentFor(customHex).tones[scheme] : (ACCENTS[accent] ?? ACCENTS[DEFAULT_ACCENT_THEME])[scheme];
  const danger = tones.danger ?? base.color.danger;
  return {
    ...base,
    color: {
      ...base.color,
      accent: tones.accent,
      focusRing: tones.accent,
      onAccent: tones.onAccent,
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
  accent: AccentPreference = DEFAULT_ACCENT_THEME,
  customHex?: string | null,
): void {
  const palette = paletteFor(scheme, accent, customHex);
  for (const [key, value] of Object.entries(palette.color)) {
    root.style.setProperty(`--wn-${key}`, value);
  }
  for (const [key, value] of Object.entries(palette.badge)) {
    root.style.setProperty(`--wn-badge-${key}`, value);
  }
  for (const [key, value] of Object.entries(palette.elevation)) {
    root.style.setProperty(`--wn-elev-${key}`, value);
  }
  const { pill } = palette;
  root.style.setProperty("--wn-pill-l", `${pill.lightness}%`);
  root.style.setProperty("--wn-pill-sat", String(pill.saturation));
  root.style.setProperty("--wn-pill-rest", String(pill.rest));
  root.style.setProperty("--wn-pill-on", String(pill.on));
  root.style.setProperty("--wn-pill-ring", String(pill.ring));
  root.style.setProperty("--wn-pill-textL", `${pill.textLightness}%`);
  root.style.setProperty("--wn-pill-ink", palette.color[pill.ink]);
  root.style.setProperty("--wn-pill-inkOn", palette.color[pill.inkOn]);
  root.style.setProperty("--wn-pill-count", palette.color[pill.count]);
  for (const [key, value] of Object.entries(glassProperties(scheme, palette.color))) {
    root.style.setProperty(key, value);
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

/**
 * A pill hue as text (`.wn-signal-ink`): the pill's hue and saturation at the mode's
 * `textLightness`, as an opaque `#hex`, for the contrast tests.
 */
export function pillInk(hue: { h: number; s: number }, scheme: ThemeName): string {
  const { pill } = PALETTES[scheme];
  return toHex(hslToRgb(hue.h, hue.s * pill.saturation, pill.textLightness));
}

/**
 * A pill's fill, painted over `base`, as an opaque `#hex`: the same arithmetic as
 * `.wn-pill` in `index.css`, for the contrast tests. `hover` adds the mode's sheen.
 */
export function pillFill(
  hue: { h: number; s: number },
  scheme: ThemeName,
  base: string,
  state: { on: boolean; hover?: boolean },
): string {
  const { pill, color } = PALETTES[scheme];
  const [r, g, b] = hslToRgb(hue.h, hue.s * pill.saturation, pill.lightness);
  const alpha = state.on ? pill.on : pill.rest;
  const tinted = composite(`rgba(${r}, ${g}, ${b}, ${alpha})`, base);
  return state.hover ? composite(color.sheen, tinted) : tinted;
}
