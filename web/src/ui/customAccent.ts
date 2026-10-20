/**
 * The custom accent (1.4.0): any colour a person picks, made safe in every mode.
 *
 * A curated accent (`ACCENTS` in `theme.ts`) is tuned by hand per mode and held to WCAG AA
 * by `theme.test.ts` and `glass.test.ts`. A picked colour cannot be tuned by hand, so this
 * derives its per-mode tones by rule, against the same bars, and `customAccent.test.ts`
 * holds the rule to them over random colours, greys and the extremes:
 *
 *   - the accent reads as text on every opaque plane of the mode at 5:1, the curated
 *     accents' floor (bare AA left no room for the planes as painted), which also makes it
 *     a focus ring (3:1) and an unread dot;
 *   - its label colour (`onAccent`, white or the mode's near-black, whichever is stronger)
 *     reads on it at 4.5:1, and the compose circle's icon at 3:1 with the circle at
 *     `COMPOSE_TINT` over black or white, sheen included;
 *   - the wash behind the list (`WASH`, at the mode's cap) keeps every row ink at AA;
 *   - its luminance stays inside the band the curated accents span (`luminance`), and
 *     the floating glass over it keeps every chip label, row and bar at its bar
 *     (`backdropOk`), as `glass.test.ts` holds for the curated accents;
 *   - danger stays a red at least 40° of hue from it, moving to the crimson or the
 *     orange-red the curated accents use, and when no red can be 40° away (the user picked
 *     a red) the accent's hue turns the least it must.
 *
 * The colour keeps its hue and chroma where it can; only OKLCH lightness moves, to the
 * nearest lightness that passes, so the result is the picked colour lightened or darkened
 * (chroma only drops where sRGB cannot hold it at the new lightness). `adjusted` says,
 * per mode, whether the result visibly differs from what was picked, for the picker's
 * "Adjusted slightly for contrast" note.
 *
 * Pure: the planes and inks come in as `CustomAccentContext` (`theme.ts` builds it from
 * the palettes), so nothing here knows a hex of its own.
 */

import {
  composite,
  contrastRatio,
  hexToOklch,
  hueAndSaturation,
  hueGap,
  oklabDistance,
  oklchToHex,
  relativeLuminance,
  withAlpha,
} from "./color";

export type CustomModeContext = {
  /** Every opaque plane the accent can sit on as text or a ring. */
  surfaces: readonly string[];
  /** The plane the wash is painted over, and the row inks that must stay AA on it. */
  washBase: string;
  washPeak: number;
  rowInks: readonly string[];
  /** Label colours to choose from for text on the accent: the strongest wins. */
  onAccent: readonly string[];
  /** The compose circle: the accent at `tint` over black or white, white `sheen` over that. */
  composeTint: number;
  composeSheen: number;
  /** Relative luminance band the accent must stay in (the curated accents' span). */
  luminance: { min: number; max: number };
  /**
   * Danger colours to choose from, the mode's own first. `danger: undefined` means the
   * mode's own (no override); the rest are written into the palette when chosen.
   */
  dangers: readonly { danger: string | undefined; hex: string }[];
  /**
   * The floating glass over the accent at full strength (a button or avatar sliding under
   * a chip, the dock or a bar): true when every label on it keeps its bar. Supplied by
   * `theme.ts`, which knows the glass recipes and the chips' hues.
   */
  backdropOk?: (hex: string) => boolean;
};

export type CustomAccentContext<Mode extends string> = Record<Mode, CustomModeContext>;

export type CustomTones = { accent: string; onAccent: string; danger?: string };

export type CustomAccent<Mode extends string> = {
  /** The colour as picked, normalised. */
  input: string;
  tones: Record<Mode, CustomTones>;
  /** Per mode: whether the result is visibly not the picked colour. */
  adjusted: Record<Mode, boolean>;
};

/** WCAG AA for text. A hair of margin so no rounding downstream can tip a pass into a fail. */
export const CUSTOM_TEXT_FLOOR = 4.55;
/**
 * The accent as text on the planes: 5:1, the floor the curated accents keep (`theme.test.ts`,
 * "1.3.2 contrast margins"), not bare AA. The planes the eye sees are often a shade off the
 * tokens (the drawer's veil over the list, a row's hover under the selected count), and the
 * sweep measured a custom honey's count at 4.25:1 there when it was held to 4.55.
 */
export const CUSTOM_ACCENT_FLOOR = 5;
/** The compose circle's icon (a non-text mark). */
export const CUSTOM_ICON_FLOOR = 3.05;
/** Danger's distance from the accent, in HSL hue degrees (the curated rule is 40). */
export const CUSTOM_DANGER_GAP = 40.5;
/** At or below this HSL saturation the accent is a grey, and hue (and danger's distance from it) means nothing. */
export const NEUTRAL_SATURATION = 0.12;
/** A visible difference in OKLab: past it, the picker says the colour was adjusted. */
export const ADJUSTED_DISTANCE = 0.02;

/** Every constraint above, for one candidate accent in one mode. Returns its label colour, or null. */
export function customToneOk(hex: string, mode: CustomModeContext): string | null {
  const lum = relativeLuminance(hex);
  if (lum < mode.luminance.min || lum > mode.luminance.max) return null;
  for (const plane of mode.surfaces) if (contrastRatio(hex, plane) < CUSTOM_ACCENT_FLOOR) return null;
  const onAccent = [...mode.onAccent].sort((a, b) => contrastRatio(b, hex) - contrastRatio(a, hex))[0];
  if (contrastRatio(onAccent, hex) < CUSTOM_TEXT_FLOOR) return null;
  for (const under of ["#000000", "#FFFFFF"]) {
    const circle = composite(`rgba(255, 255, 255, ${mode.composeSheen})`, composite(withAlpha(hex, mode.composeTint), under));
    if (contrastRatio(circle, onAccent) < CUSTOM_ICON_FLOOR) return null;
  }
  const washed = composite(withAlpha(hex, mode.washPeak), mode.washBase);
  for (const ink of mode.rowInks) if (contrastRatio(washed, ink) < CUSTOM_TEXT_FLOOR) return null;
  if (mode.backdropOk && !mode.backdropOk(hex)) return null;
  return onAccent;
}

/**
 * Danger for an accent: the mode's own red when it is far enough in hue, otherwise the
 * farthest of the alternatives that is; null when none is (the accent is a red).
 */
export function pickDanger(accent: string, mode: CustomModeContext): CustomModeContext["dangers"][number] | null {
  const { hue, saturation } = hueAndSaturation(accent);
  const [own, ...others] = mode.dangers;
  const gap = (option: CustomModeContext["dangers"][number]) => hueGap(hueAndSaturation(option.hex).hue, hue);
  if (saturation <= NEUTRAL_SATURATION || gap(own) >= CUSTOM_DANGER_GAP) return own;
  const best = [...others].sort((a, b) => gap(b) - gap(a))[0];
  return best && gap(best) >= CUSTOM_DANGER_GAP ? best : null;
}

/**
 * The nearest lightness to `l` at which the colour passes; null if none does. A coarse
 * walk outward (0.01) finds the first passing step on each side, then a fine walk
 * (0.001) back towards `l` finds the edge, so the colour moves no further than it must.
 */
function solveLightness(l: number, c: number, h: number, mode: CustomModeContext): { hex: string; onAccent: string } | null {
  const at = (candidate: number) => {
    const hex = oklchToHex({ l: candidate, c, h });
    const onAccent = customToneOk(hex, mode);
    return onAccent ? { hex, onAccent } : null;
  };
  const exact = at(l);
  if (exact) return exact;
  const COARSE = 0.01;
  const FINE = 0.001;
  for (let offset = COARSE; offset <= 1 + COARSE; offset += COARSE) {
    for (const sign of [-1, 1]) {
      const candidate = Math.min(1, Math.max(0, l + sign * offset));
      const found = at(candidate);
      if (!found) continue;
      // Step back towards `l` while it still passes.
      let best = found;
      for (let back = offset - FINE; back > offset - COARSE; back -= FINE) {
        const nearer = at(Math.min(1, Math.max(0, l + sign * back)));
        if (!nearer) break;
        best = nearer;
      }
      return best;
    }
  }
  return null;
}

/** One mode's tones for a picked colour. */
function deriveMode(input: string, mode: CustomModeContext): CustomTones {
  const { l, c, h } = hexToOklch(input);
  // Turn the hue only as far as danger needs: 0, +1, −1, +2, … degrees.
  for (let turn = 0; turn <= 90; turn += 1) {
    for (const delta of turn === 0 ? [0] : [turn, -turn]) {
      const solved = solveLightness(l, c, (h + delta + 360) % 360, mode);
      if (!solved) continue;
      const danger = pickDanger(solved.hex, mode);
      if (!danger) continue;
      return {
        accent: solved.hex,
        onAccent: solved.onAccent,
        ...(danger.danger ? { danger: danger.danger } : {}),
      };
    }
  }
  // Unreachable for any sRGB colour (the unit tests walk the cube); a grey always passes.
  const grey = solveLightness(l, 0, 0, mode);
  if (!grey) throw new Error(`customAccent: no safe tone for ${input}`);
  return { accent: grey.hex, onAccent: grey.onAccent };
}

/**
 * The per-mode tones for a picked `#RRGGBB` colour. Deterministic, so it can run on every
 * render; `theme.ts` memoises the last few.
 */
export function deriveCustomAccent<Mode extends string>(
  input: string,
  context: CustomAccentContext<Mode>,
): CustomAccent<Mode> {
  const picked = input.toUpperCase();
  const tones = {} as Record<Mode, CustomTones>;
  const adjusted = {} as Record<Mode, boolean>;
  for (const mode of Object.keys(context) as Mode[]) {
    tones[mode] = deriveMode(picked, context[mode]);
    adjusted[mode] = oklabDistance(tones[mode].accent, picked) > ADJUSTED_DISTANCE;
  }
  return { input: picked, tones, adjusted };
}
