/**
 * The colour of a smart filter's icon, on the rail's chips and as a list row's tag.
 *
 * `.wn-signal-ink` puts every hue at one text lightness (42% light, 68% dark/OLED). That
 * fails for some hues: amber, yellow and green in light, indigo and blue in dark (blue
 * is the darkest hue at any lightness). So each hue starts at the mode's text lightness
 * and steps away from the background (darker in light, lighter in dark) until it reads
 * at 4.6:1 or better on every plane a row can be on (surface, hover, the selected row
 * under every accent, canvas) and 3.2:1 on its own chip, resting or on. An icon only
 * needs 3:1, so both clear it with room.
 *
 * Neutral buckets (`NEUTRAL_FILTERS`) get no rule: their icon takes the label's ink.
 */

import { FILTER_HUES, NEUTRAL_FILTERS } from "./filterColors";
import { PALETTES, paletteFor, pillFill, type ThemeName } from "./theme";
import { ACCENT_THEMES } from "../core/model/appearance";
import { composite, contrastRatio, hslToRgb, toHex } from "./color";
import type { BuiltinSmartFilter } from "../core/model/signals";

const ROW_PLANES = ["surface", "surfaceHover", "surfaceSelected", "canvas"] as const;

export function iconInk(id: BuiltinSmartFilter, scheme: ThemeName): string {
  const hue = FILTER_HUES[id];
  const { pill, color } = PALETTES[scheme];
  const rows = ACCENT_THEMES.flatMap((accent) => {
    const c = paletteFor(scheme, accent).color;
    return ROW_PLANES.map((plane) => (c[plane].startsWith("rgba") ? composite(c[plane], c.surface) : c[plane]));
  });
  const chips = [color.surface, color.canvas].flatMap((b) => [true, false].map((on) => pillFill(hue, scheme, b, { on })));
  const step = scheme === "light" ? -1 : 1;
  for (let l = pill.textLightness; l > 10 && l < 95; l += step) {
    const ink = toHex(hslToRgb(hue.h, hue.s * pill.saturation, l));
    if (rows.every((g) => contrastRatio(ink, g) >= 4.6) && chips.every((g) => contrastRatio(ink, g) >= 3.2)) return ink;
  }
  return color.ink;
}

let injected = false;

/**
 * Adds the per-mode icon colours once, keyed by `data-icon-filter`, so an icon follows
 * the live mode (`:root[data-theme]`) without any component knowing which mode it is.
 */
export function ensureIconInkStyles(): void {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const rules = (Object.keys(FILTER_HUES) as BuiltinSmartFilter[])
    .filter((id) => !NEUTRAL_FILTERS.has(id))
    .flatMap((id) =>
      (["light", "dark", "oled"] as const).map(
        (mode) => `:root[data-theme="${mode}"] [data-icon-filter="${id}"] { color: ${iconInk(id, mode)}; }`,
      ),
    )
    .join("\n");
  const style = document.createElement("style");
  style.dataset.filterIconInk = "";
  style.textContent = rules;
  document.head.appendChild(style);
}
