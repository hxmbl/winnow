/**
 * The custom accent holds every bar a curated accent is held to, for any colour.
 *
 * `customAccent.ts` derives a picked colour's tones per mode by rule. These tests walk
 * the extremes (black, white, pure yellow, pure red and the rest of the cube's corners),
 * greys, the curated accents themselves, a 6×6×6 grid through the RGB cube and 400 random
 * colours (a fixed seed, so a failure reproduces), and hold each, in light, dark and Very
 * dark (`oled`), to the same arithmetic `theme.test.ts` and `glass.test.ts` use: the
 * accent as text and ring on every plane, its label on it, the compose circle, the wash,
 * danger's distance, the floating glass over it, and "only the accent tokens change".
 */

import { describe, expect, it } from "vitest";
import {
  ACCENTS,
  ACCENT_TOKENS,
  MODES,
  PALETTES,
  composite,
  contrastRatio,
  customAccentFor,
  paletteFor,
  pillFill,
  type ThemeName,
} from "./theme";
import { hexToOklch, hueAndSaturation, hueGap, oklabDistance } from "./color";
import { CUSTOM_DANGER_GAP, NEUTRAL_SATURATION, deriveCustomAccent } from "./customAccent";
import { COMPOSE_SHEEN, COMPOSE_TINT, GLASS, LIQUID, WASH } from "./glass";
import { FILTER_HUES, senderHue } from "./filterColors";
import { ACCENT_THEMES, DEFAULT_ACCENT_CUSTOM, normalizeHexColor } from "../core/model/appearance";

const SURFACE_TOKENS = ["canvas", "surface", "surfaceSunken", "surfaceHover", "surfaceActive", "surfaceSelected", "chrome"] as const;

/** A small seeded PRNG (mulberry32), so the random colours are the same on every run. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`.toUpperCase();

const EXTREMES = [
  "#000000", "#FFFFFF", "#FFFF00", "#FF0000", "#00FF00", "#0000FF", "#00FFFF", "#FF00FF",
  "#808080", "#7F7F7F", "#111111", "#EEEEEE", "#F1F1F3", "#191919", "#252525", "#373737",
  "#FF8800", "#FFD1DC", "#8B0000", "#003300", "#E6E6EA", "#FE0101", "#FF1493", "#C0FFEE",
];
const GREYS = Array.from({ length: 18 }, (_, i) => hex(i * 15, i * 15, i * 15));
const CURATED = MODES.flatMap((mode) => ACCENT_THEMES.map((id) => ACCENTS[id][mode].accent.toUpperCase()));
const GRID = (() => {
  const out: string[] = [];
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) out.push(hex(r, g, b));
  return out;
})();
const RANDOM = (() => {
  const next = random(1404);
  return Array.from({ length: 400 }, () => hex(Math.floor(next() * 256), Math.floor(next() * 256), Math.floor(next() * 256)));
})();
const ALL = [...new Set([...EXTREMES, ...GREYS, ...CURATED, ...GRID, ...RANDOM])];

/** Every filter hue and a spread of sender hues: what a chip over the glass can be. */
const HUES = [
  ...Object.values(FILTER_HUES),
  ...["ana@example.com", "billing@shop.test", "noreply@bank.test", "zoe@x.io", "team@winnow.app", "q@q.q"].map(senderHue),
];

function glassOver(scheme: ThemeName, alpha: number, under: string): string {
  const base = PALETTES[scheme].color[GLASS[scheme].base];
  const n = Number.parseInt(base.slice(1), 16);
  return composite(`rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`, under);
}

function plates(plate: string, scheme: ThemeName): string[] {
  const white = LIQUID[scheme].sheen + LIQUID[scheme].glow;
  return [plate, composite(`rgba(255, 255, 255, ${white})`, plate)];
}

/** Everything that must hold for one picked colour in one mode; the first failure, or null. */
function failure(picked: string, mode: ThemeName): string | null {
  const own = paletteFor(mode, "custom", picked);
  const space = paletteFor(mode, "space");
  const { accent, focusRing, onAccent, danger } = own.color;
  const tag = `${mode} ${picked} → ${accent}`;
  const surfaces = SURFACE_TOKENS.map((token) => own.color[token]);
  if (!/^#[0-9A-F]{6}$/.test(accent)) return `${tag}: not an opaque hex`;
  if (focusRing !== accent) return `${tag}: ring is not the accent`;
  for (const plane of surfaces) {
    if (contrastRatio(accent, plane) < 4.5) return `${tag}: text on ${plane}`;
    if (contrastRatio(focusRing, plane) < 3) return `${tag}: ring on ${plane}`;
  }
  if (contrastRatio(onAccent, accent) < 4.5) return `${tag}: label ${onAccent}`;
  const labels = mode === "light" ? ["#FFFFFF", PALETTES.light.color.ink] : ["#FFFFFF", ACCENTS.space[mode].onAccent];
  if (!labels.includes(onAccent)) return `${tag}: label ${onAccent} is not white or the mode's near-black`;
  // The compose circle: the accent at COMPOSE_TINT over black or white, sheen on top.
  const n = Number.parseInt(accent.slice(1), 16);
  const rgb = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
  for (const under of ["#000000", "#FFFFFF"]) {
    const circle = composite(`rgba(255, 255, 255, ${COMPOSE_SHEEN})`, composite(`rgba(${rgb}, ${COMPOSE_TINT})`, under));
    if (contrastRatio(circle, onAccent) < 3) return `${tag}: compose icon over ${under}`;
  }
  // The wash at the mode's cap.
  const peak = Math.max(WASH[mode].near, WASH[mode].far);
  const washed = composite(`rgba(${rgb}, ${peak})`, own.color.surface);
  for (const ink of ["ink", "inkBody", "inkMuted", "inkSubtle"] as const) {
    if (contrastRatio(washed, own.color[ink]) < 4.5) return `${tag}: ${ink} on the wash`;
  }
  // Danger: AA, its button label, a red, and 40° from a coloured accent.
  for (const plane of surfaces) if (contrastRatio(danger, plane) < 4.5) return `${tag}: danger on ${plane}`;
  if (contrastRatio(own.color.surface, danger) < 4.5) return `${tag}: danger button`;
  const dangerHue = hueAndSaturation(danger).hue;
  if (hueGap(dangerHue, 0) > 20) return `${tag}: danger ${danger} is not a red`;
  const { hue, saturation } = hueAndSaturation(accent);
  if (saturation > NEUTRAL_SATURATION && hueGap(dangerHue, hue) < 40) return `${tag}: danger ${danger} too close`;
  // Only the accent tokens change.
  const owned = new Set<string>(ACCENT_TOKENS);
  for (const token of Object.keys(space.color)) {
    if (!owned.has(token) && own.color[token] !== space.color[token]) return `${tag}: changed ${token}`;
  }
  // The floating glass over the accent at full strength: chips, the panel's rows, the bars.
  const { pill, color } = PALETTES[mode];
  for (const hue of HUES) {
    for (const on of [false, true]) {
      const base = pillFill(hue, mode, glassOver(mode, on ? GLASS[mode].textOn : GLASS[mode].text, accent), { on });
      for (const fill of plates(base, mode)) {
        if (contrastRatio(fill, color[on ? pill.inkOn : pill.ink]) < 4.5) return `${tag}: chip h${hue.h} ${on ? "on" : "rest"}`;
        if (contrastRatio(fill, color[pill.count]) < 4.5) return `${tag}: chip count h${hue.h}`;
      }
    }
  }
  for (const plate of plates(glassOver(mode, GLASS[mode].text, accent), mode)) {
    if (contrastRatio(plate, color.inkBody) < 4.5) return `${tag}: panel row`;
    if (contrastRatio(plate, color.inkMuted) < 3) return `${tag}: dock icon`;
    if (contrastRatio(plate, color.inkIcon) < 3) return `${tag}: rail step`;
  }
  for (const plate of plates(glassOver(mode, GLASS[mode].bar, accent), mode)) {
    for (const ink of ["ink", "inkBody", "inkMuted"] as const) {
      if (contrastRatio(plate, color[ink]) < 4.5) return `${tag}: bar ${ink}`;
    }
  }
  return null;
}

describe("the custom accent is AA-safe for any colour", () => {
  it(`walks ${ALL.length} colours: extremes, greys, the curated accents, a grid and random`, () => {
    expect(ALL.length).toBeGreaterThan(600);
  });

  for (const mode of MODES) {
    it(`${mode}: the extremes (#FFFF00, #000000, #FFFFFF, pure red …)`, () => {
      for (const picked of EXTREMES) expect(failure(picked, mode)).toBeNull();
    });

    it(`${mode}: greys`, () => {
      for (const picked of GREYS) expect(failure(picked, mode)).toBeNull();
    });

    it(`${mode}: every curated accent, from every mode`, () => {
      for (const picked of CURATED) expect(failure(picked, mode)).toBeNull();
    });

    it(`${mode}: a 6×6×6 grid through the RGB cube`, () => {
      const failures = GRID.map((picked) => failure(picked, mode)).filter(Boolean);
      expect(failures).toEqual([]);
    }, 30_000);

    for (let chunk = 0; chunk < RANDOM.length; chunk += 100) {
      it(`${mode}: random colours ${chunk + 1}–${chunk + 100}`, () => {
        const failures = RANDOM.slice(chunk, chunk + 100).map((picked) => failure(picked, mode)).filter(Boolean);
        expect(failures).toEqual([]);
      }, 30_000);
    }
  }
});

describe("the custom accent stays the colour that was picked", () => {
  it("leaves a colour that is already safe exactly as picked, and says it was not adjusted", () => {
    for (const mode of MODES) {
      for (const id of ACCENT_THEMES) {
        const picked = ACCENTS[id][mode].accent.toUpperCase();
        const derived = customAccentFor(picked);
        expect(derived.tones[mode].accent, `${mode} ${id}`).toBe(picked);
        expect(derived.adjusted[mode], `${mode} ${id}`).toBe(false);
      }
    }
  });

  it("moves an unsafe colour and says so: yellow, white and black in light, deep colours in dark", () => {
    expect(customAccentFor("#FFFF00").adjusted.light).toBe(true);
    expect(customAccentFor("#FFFFFF").adjusted.light).toBe(true);
    expect(customAccentFor("#000000").adjusted.light).toBe(true);
    expect(customAccentFor("#1D5E99").adjusted.dark).toBe(true);
    expect(customAccentFor("#1D5E99").adjusted.light).toBe(false);
    expect(customAccentFor("#86B7EA").adjusted.light).toBe(true);
    expect(customAccentFor("#86B7EA").adjusted.dark).toBe(false);
  });

  it("only moves lightness for a colour away from red: the hue stays within a few degrees", () => {
    for (const picked of [...RANDOM, ...GRID]) {
      const before = hexToOklch(picked);
      if (before.c < 0.06) continue; // a grey's hue is noise
      const { hue } = hueAndSaturation(picked);
      if (hueGap(hue, 0) < 70) continue; // near red, danger may turn it
      for (const mode of MODES) {
        const after = hexToOklch(customAccentFor(picked).tones[mode].accent);
        if (after.c < 0.03) continue; // lightness took the chroma (near black or white)
        expect(hueGap(after.h, before.h), `${mode} ${picked}`).toBeLessThanOrEqual(6);
      }
    }
  });

  it("turns a pure red only as far as danger needs, and moves danger off the accent", () => {
    for (const mode of MODES) {
      const { accent, danger } = paletteFor(mode, "custom", "#FF0000").color;
      const turned = hueGap(hexToOklch(accent).h, hexToOklch("#FF0000").h);
      expect(turned, `${mode}: ${accent}`).toBeLessThanOrEqual(30);
      expect(hueGap(hueAndSaturation(danger).hue, hueAndSaturation(accent).hue)).toBeGreaterThanOrEqual(CUSTOM_DANGER_GAP - 0.5);
    }
  });

  it("keeps the usual danger for colours far from red", () => {
    for (const mode of MODES) {
      expect(paletteFor(mode, "custom", "#2B673B").color.danger).toBe(PALETTES[mode].color.danger);
      expect(paletteFor(mode, "custom", "#808080").color.danger).toBe(PALETTES[mode].color.danger);
    }
  });

  it("is deterministic, and memoised", () => {
    expect(customAccentFor("#ff8800")).toBe(customAccentFor("#FF8800"));
    const context = { light: { surfaces: ["#FFFFFF"], washBase: "#FFFFFF", washPeak: 0, rowInks: [], onAccent: ["#FFFFFF"], composeTint: 1, composeSheen: 0, luminance: { min: 0, max: 1 }, dangers: [{ danger: undefined, hex: "#B42318" }] } };
    expect(deriveCustomAccent("#3366CC", context)).toEqual(deriveCustomAccent("#3366cc", context));
  });

  it("falls back to the default custom colour for anything that is not a hex", () => {
    for (const junk of [null, undefined, "", "red", "#12345", "rgb(1,2,3)"]) {
      expect(customAccentFor(junk).input).toBe(DEFAULT_ACCENT_CUSTOM);
    }
  });

  it("the adjusted note means a visible change, not rounding", () => {
    for (const picked of RANDOM.slice(0, 100)) {
      const derived = customAccentFor(picked);
      for (const mode of MODES) {
        expect(derived.adjusted[mode]).toBe(oklabDistance(derived.tones[mode].accent, picked) > 0.02);
      }
    }
  });
});

describe("a typed or stored custom colour", () => {
  it("is normalised to #RRGGBB, upper case", () => {
    expect(normalizeHexColor("#abc")).toBe("#AABBCC");
    expect(normalizeHexColor("abc")).toBe("#AABBCC");
    expect(normalizeHexColor(" #1d5e99 ")).toBe("#1D5E99");
    expect(normalizeHexColor("1D5E99")).toBe("#1D5E99");
  });

  it("rejects anything else rather than guessing", () => {
    for (const junk of ["", "#", "#12", "#1234", "#12345", "#1234567", "#GGGGGG", "red", "rgb(0,0,0)", "#11223344", 0x112233, null, undefined, {}]) {
      expect(normalizeHexColor(junk), String(junk)).toBeNull();
    }
  });
});
