/**
 * Single source of truth for every colour, plus the two non-colour tokens that
 * behave like one: the elevation shadows and the glass fill.
 *
 * How it works:
 *  1. Edit a value below.
 *  2. `applyTheme()` (called once from `main.tsx`) mirrors each entry to a
 *     `--wn-*` custom property on `<html>`, so plain CSS in `index.css`
 *     (the scrollbar, `.glass`) can read them too.
 *  3. `tailwind.config.js` maps the same names onto Tailwind utilities, so
 *     components use `bg-surface`, `text-ink-body`, `border-hairline`, ...
 *
 * Depth is deliberately shallow. Four surface planes, hairline separators and
 * real gaps between containers carry the hierarchy — no bevels, no inner glow,
 * no gradient behind a control, and exactly two shadows in the whole system.
 * The only reason any shadow exists is to keep a white card from reading as a
 * hole cut into a tinted canvas.
 *
 * Only Tailwind's built-in palette (`black`, `white`) supports `/opacity`
 * modifiers — these token colours are CSS variables, so bake any alpha into the
 * value here instead (see `panel`).
 */

/** Panel fill from references/reader-detail.svg. */
const PANEL = "#FAFFFF";
/** references/reader-detail.svg draws the panel at `fill-opacity="0.81"`. */
const PANEL_ALPHA = 0.81;

export const theme = {
  /**
   * The four planes, back to front. A surface is only worth a token if it means
   * something — the reader mint, the sunken strip, and nothing else.
   */
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
    /** Reader surface. The reader mock draws it as a flat wash, not a card. */
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
    /** Focus ring, replaces `ring-neutral-400/60`. */
    focusRing: "rgba(120, 130, 145, 0.55)",

    // ── Avatars ─────────────────────────────────────────────────
    avatar: "#DDE2E3",

    // ── Chrome ──────────────────────────────────────────────────
    scrollbar: "rgba(15, 23, 42, 0.2)",
  },

  /**
   * Accent per smart-filter badge shown in the reader. Keys must match the
   * badge `key` returned by `ReaderPane`.
   */
  badge: {
    starred: "#B8860B",
    important: "#C2410C",
    urgent: "#E11D48",
    security: "#0369A1",
    newsletters: "#575757",
    promotional: "#15803D",
    unsafe: "#C2410C",
  },

  /**
   * Both shadows do the same job — separate one plane from the next without
   * implying a physical object. `pane` is in use on the list and reader cards.
   * `lift` is staged for the pass where chrome floats over scrolling content;
   * nothing references it yet.
   */
  elevation: {
    pane: "0 1px 2px rgba(15, 23, 42, 0.05)",
    lift: "0 12px 32px rgba(15, 23, 42, 0.1), 0 2px 6px rgba(15, 23, 42, 0.04)",
  },

  /**
   * Fill for `.glass` in `index.css`. Staged alongside `elevation.lift` — see
   * the note there. Stacking `.glass` with a border-hairline and the pane gap
   * is the whole trick: the gap is what makes the blur visible.
   */
  glass: "rgba(255, 255, 255, 0.72)",
} as const;

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Reads a badge accent by key, falling back to `inkSubtle`. */
export function badgeColor(key: string): string {
  return (theme.badge as Record<string, string>)[key] ?? theme.color.inkSubtle;
}

/** Mirrors every token into a `--wn-*` custom property on `<html>`. */
export function applyTheme(root: HTMLElement): void {
  for (const [key, value] of Object.entries(theme.color)) {
    root.style.setProperty(`--wn-${key}`, value);
  }
  for (const [key, value] of Object.entries(theme.badge)) {
    root.style.setProperty(`--wn-badge-${key}`, value);
  }
  for (const [key, value] of Object.entries(theme.elevation)) {
    root.style.setProperty(`--wn-elev-${key}`, value);
  }
  root.style.setProperty("--wn-glass", theme.glass);
}