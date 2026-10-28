/**
 * The palettes have teeth.
 *
 * Every colour in `theme.ts` was chosen by eye, which is the right way to choose one and
 * the wrong way to keep it. A screenshot cannot tell you that `#8B929C` is 3.14:1 on
 * white; it looks like a perfectly good tertiary grey right up until somebody reads the
 * app in a bright room.
 *
 * Three objectively checkable properties are asserted:
 *
 *   1. **Text clears WCAG AA against every surface it appears on.** Not against white —
 *      against `surfaceActive`, the darkest plane in the light palette and therefore the
 *      binding case, and against `surfaceSunken` in dark.
 *   2. **The ink ramp runs in order, in visible steps.** Both greys a row is built from
 *      passing AA is not the same as being distinguishable from each other; two adjacent
 *      steps 1% apart pass a contrast check and read as one colour, which is the failure
 *      the ordering assertion exists to prevent.
 *   3. **No token colour is combined with Tailwind's `/opacity`.** Every token is a CSS
 *      custom property, so the modifier emits `rgb(var(--wn-surface) / 0.6)`, which is
 *      not a colour, and the class renders nothing.
 *   4. **The accent works as text, as a ring and as a fill**, in every mode (light, dark,
 *      OLED) with every accent theme — each combination is its own case, so a new accent
 *      or mode is covered the day it is added. Space, the default, is a deliberate space
 *      violet rather than a stock Tailwind violet or indigo. Light's neutrals carry a
 *      shared blue-violet cast and its selected row is the accent washed into the surface;
 *      dark and OLED are neutral greys with a neutral selected row. Danger stays a
 *      readable red at least 40° of hue from every accent.
 *   6. **The theme is right before the bundle loads**: `public/theme-boot.js` agrees with
 *      `resolveScheme`, and the `index.css` fallbacks agree with the palettes.
 *   5. **The design system stays small**: four type sizes, two radii, no shadows and no
 *      letter-spaced capitals, asserted over the component sources.
 *
 * No DOM required, which is the payoff of the `core`/`ui` split: this is the same
 * arithmetic the browser would do, run as a unit test.
 */

import { readdirSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  ACCENTS,
  ACCENT_TOKENS,
  MODES,
  contrastRatio,
  PALETTES,
  paletteFor,
  composite,
  pillFill,
  pillInk,
  relativeLuminance,
  resolveScheme,
  type ThemeName,
} from "./theme";
import { FILTER_HUES, NEUTRAL_FILTERS, senderHue, type PillHue } from "./filterColors";
import { BUILTIN_FILTERS } from "../core/model/signals";
import {
  ACCENT_THEMES,
  APPEARANCES,
  type AccentTheme,
  type Appearance,
} from "../core/model/appearance";

/** WCAG AA for text this size. Every piece of muted text in the app is 11–13px. */
const AA_TEXT = 4.5;
/** WCAG's bar for a focus indicator and other non-text marks. */
const AA_NON_TEXT = 3;

/**
 * The planes a piece of text can land on.
 *
 * Named explicitly rather than derived from the palette, because a text token must
 * not be checked against *another text token* — that is how a contrast test ends up
 * asserting that `#15181D` on `#15181D` is readable. This is the complete set of
 * fills in the app; the text tokens live alongside them and are never a backdrop.
 */
const SURFACE_TOKENS = [
  "canvas",
  "surface",
  "surfaceSunken",
  "surfaceHover",
  "surfaceActive",
  "surfaceSelected",
  "chrome",
] as const;

const INK_TOKENS = ["ink", "inkStrong", "inkBody", "inkMuted", "inkSubtle", "inkIcon", "inkPlaceholder"] as const;

/** Every mode × accent theme. Named, so a typo cannot silently test nothing. */
const COMBOS: { mode: ThemeName; accent: AccentTheme; name: string }[] = MODES.flatMap((mode) =>
  ACCENT_THEMES.map((accent) => ({ mode, accent, name: `${mode}/${accent}` })),
);

function opaqueSurfaces(mode: ThemeName, accent: AccentTheme): string[] {
  const { color } = paletteFor(mode, accent);
  return SURFACE_TOKENS.map((token) => color[token]).filter((value) => value.startsWith("#"));
}

function channels(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** HSL hue in degrees (0–360) and saturation (0–1). */
function hsl(hex: string): { hue: number; saturation: number } {
  const [r, g, b] = channels(hex).map((value) => value / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  if (delta === 0) return { hue: 0, saturation: 0 };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return { hue: (hue * 60 + 360) % 360, saturation };
}

function hueGap(a: number, b: number): number {
  const gap = Math.abs(a - b) % 360;
  return gap > 180 ? 360 - gap : gap;
}

function rgbDistance(a: string, b: string): number {
  const [x, y] = [channels(a), channels(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

describe("every mode × accent is covered", () => {
  it("walks three modes and the curated accents", () => {
    expect(MODES).toEqual(["light", "dark", "oled"]);
    // 1.4.0: eight curated accents round the wheel, Space first, Graphite (the neutral) last.
    expect([...ACCENT_THEMES]).toEqual(["space", "plum", "rose", "ember", "green", "aurora", "blue", "graphite"]);
    expect(ACCENT_THEMES[0]).toBe("space");
    expect(COMBOS).toHaveLength(MODES.length * ACCENT_THEMES.length);
    for (const accent of ACCENT_THEMES) expect(ACCENTS[accent].label.length).toBeGreaterThan(0);
  });
});

describe("text contrast", () => {
  /**
   * Every ink step, against every opaque surface in its own palette, in every combination.
   *
   * One case per combination and token, no exclusions: a token that fails on one plane
   * fails for a user.
   */
  for (const { mode, accent, name } of COMBOS) {
    for (const token of INK_TOKENS) {
      it(`${name}: ${token} is readable on every surface`, () => {
        const color = paletteFor(mode, accent).color[token];
        for (const backdrop of opaqueSurfaces(mode, accent)) {
          expect(contrastRatio(color, backdrop), `${name}: ${token} ${color} on ${backdrop}`).toBeGreaterThanOrEqual(
            AA_TEXT,
          );
        }
      });
    }
  }

  /**
   * The ramp has to stay in order, or "tertiary" quietly becomes "primary".
   *
   * Two greys at the same contrast would flatten the hierarchy even though both passed
   * the AA check above, so the ordering is asserted as a separate property. Inks do not
   * change with the accent, so this is per mode.
   */
  for (const mode of MODES) {
    it(`${mode}: the ink ramp runs darkest to lightest`, () => {
      // Ordered by *luminance*, not contrast ratio: the two run in opposite directions
      // in the light palette, so contrast is the wrong instrument for "is this step
      // visibly weaker than the last". `ink` and `inkBody` are separated by size and
      // weight, not grey; the muted pair must be ordered against each other and `inkBody`.
      const luminance = ["inkBody", "inkMuted", "inkSubtle"].map((token) =>
        relativeLuminance(paletteFor(mode).color[token]),
      );
      const direction = mode === "light" ? 1 : -1;
      for (let index = 1; index < luminance.length; index += 1) {
        expect(
          Math.sign(luminance[index] - luminance[index - 1]),
          `${mode}: inkBody/inkMuted/inkSubtle step ${index} is out of order ` +
            `(${luminance.map((value) => value.toFixed(3)).join(" → ")})`,
        ).toBe(direction);
        // And a *visible* step, not merely the right sign.
        const ratio =
          direction === 1 ? luminance[index] / luminance[index - 1] : luminance[index - 1] / luminance[index];
        expect(ratio, `${mode}: step ${index} is not visibly distinct`).toBeGreaterThanOrEqual(1.12);
      }
    });
  }
});

describe("the accent", () => {
  for (const { mode, accent, name } of COMBOS) {
    it(`${name}: reads as text on every surface`, () => {
      const color = paletteFor(mode, accent).color.accent;
      for (const backdrop of opaqueSurfaces(mode, accent)) {
        expect(contrastRatio(color, backdrop), `${name}: accent ${color} on ${backdrop}`).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
      }
    });

    it(`${name}: the focus ring is the accent and visible on every surface`, () => {
      const { focusRing, accent: hex } = paletteFor(mode, accent).color;
      expect(focusRing.startsWith("#"), "the ring must be opaque to be measured").toBe(true);
      expect(focusRing).toBe(hex);
      for (const backdrop of opaqueSurfaces(mode, accent)) {
        expect(contrastRatio(focusRing, backdrop)).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    });

    it(`${name}: a primary button's label is readable on the accent`, () => {
      const { accent: hex, onAccent } = paletteFor(mode, accent).color;
      expect(contrastRatio(onAccent, hex), `${name}: ${onAccent} on ${hex}`).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }

  /**
   * Space, the default, is a space violet — not the framework default.
   *
   * A hue on the indigo side of violet (245–265°), vivid (HSL saturation 0.6 or more), and
   * a visible distance from every stock violet/indigo/purple/fuchsia 400–700.
   */
  it("space is a vivid space violet, not a stock violet or indigo", () => {
    const STOCK = [
      "#A78BFA", "#8B5CF6", "#7C3AED", "#6D28D9", // violet 400–700
      "#818CF8", "#6366F1", "#4F46E5", "#4338CA", // indigo 400–700
      "#C084FC", "#A855F7", "#9333EA", "#7E22CE", // purple 400–700
      "#E879F9", "#D946EF", "#C026D3", "#A21CAF", // fuchsia 400–700
    ];
    for (const mode of MODES) {
      const hex = paletteFor(mode, "space").color.accent;
      const { hue, saturation } = hsl(hex);
      expect(hue, `${mode}: ${hex} hue`).toBeGreaterThanOrEqual(245);
      expect(hue, `${mode}: ${hex} hue`).toBeLessThanOrEqual(265);
      expect(saturation, `${mode}: ${hex} is too muted`).toBeGreaterThanOrEqual(0.6);
      for (const stock of STOCK) {
        expect(rgbDistance(hex, stock), `${mode}: ${hex} is too close to ${stock}`).toBeGreaterThan(28);
      }
    }
  });

  for (const accent of ACCENT_THEMES) {
    it(`${accent}: is the same hue in every mode`, () => {
      const light = hsl(paletteFor("light", accent).color.accent).hue;
      for (const mode of MODES) {
        expect(hueGap(light, hsl(paletteFor(mode, accent).color.accent).hue), `${accent} in ${mode}`).toBeLessThanOrEqual(8);
      }
    });
  }

  /**
   * Graphite (1.4.0) is the near-neutral: its hue is incidental (a trace of slate blue),
   * so it is held apart from the rest by saturation, not hue. Every other accent is a
   * colour, and they stay at least 30° apart.
   */
  const NEUTRAL_ACCENTS = new Set<AccentTheme>(["graphite"]);

  it("graphite is near-neutral and every other accent is clearly a colour", () => {
    for (const mode of MODES) {
      for (const accent of ACCENT_THEMES) {
        const { saturation } = hsl(paletteFor(mode, accent).color.accent);
        if (NEUTRAL_ACCENTS.has(accent)) expect(saturation, `${mode}/${accent}`).toBeLessThanOrEqual(0.25);
        else expect(saturation, `${mode}/${accent}`).toBeGreaterThanOrEqual(0.33);
      }
    }
  });

  it("graphite still reads as something to press: a slate tint the neutral inks never carry", () => {
    for (const mode of MODES) {
      const { color } = paletteFor(mode, "graphite");
      const [r, g, b] = channels(color.accent);
      // The inks' channels sit within 4 of each other; graphite's blue leads by 16 or more.
      expect(b - Math.min(r, g), `${mode}: graphite ${color.accent} is a plain grey`).toBeGreaterThanOrEqual(16);
    }
  });

  it("the accent themes are visibly different colours", () => {
    const chromatic = ACCENT_THEMES.filter((accent) => !NEUTRAL_ACCENTS.has(accent));
    for (const [index, first] of chromatic.entries()) {
      for (const second of chromatic.slice(index + 1)) {
        const gap = hueGap(hsl(ACCENTS[first].dark.accent).hue, hsl(ACCENTS[second].dark.accent).hue);
        expect(gap, `${first} vs ${second}`).toBeGreaterThanOrEqual(30);
      }
    }
  });

  it("the default palette is Space", () => {
    for (const mode of MODES) expect(paletteFor(mode)).toEqual(paletteFor(mode, "space"));
  });
});

describe("the neutrals", () => {
  /** Every backdrop and ink, the selected row included. Status colours and the accent are excluded. */
  const NEUTRALS = [...SURFACE_TOKENS, ...INK_TOKENS];
  /** The translucent neutrals: lines, washes, veil and scrim. */
  const LINES = ["hairline", "hairlineSoft", "divider", "controlBorder", "scrollbar", "sheen", "veil", "scrim"] as const;
  /** The planes that step up from the backdrop, in order. Each step has to be visible. */
  const STEPS = ["canvas", "surface", "surfaceHover", "surfaceActive"] as const;
  /**
   * 1.4.0, the owner's rule: an accent is "the colour used for buttons and the like", not
   * "everything is that colour". So an accent theme changes the accent, the focus ring,
   * the ink on the accent and (for Ember) danger, and nothing else: every other token,
   * the selected row included, is identical across accents. Light's neutrals are
   * near-white greys with at most a trace of cool; dark and OLED are plain greys.
   */
  it("an accent theme may change only the accent tokens", () => {
    expect([...ACCENT_TOKENS].sort()).toEqual(["accent", "danger", "dangerWash", "focusRing", "onAccent"]);
  });

  for (const { mode, accent, name } of COMBOS) {
    it(`${name}: neutrals are the shared set`, () => {
      const own = paletteFor(mode, accent).color;
      const space = paletteFor(mode, "space").color;
      for (const token of NEUTRALS) expect(own[token], `${name}: ${token}`).toBe(space[token]);
    });

    it(`${name}: every token outside the accent's own is identical across accents`, () => {
      const own = paletteFor(mode, accent);
      const space = paletteFor(mode, "space");
      const accentOwned = new Set<string>(ACCENT_TOKENS);
      for (const [token, value] of Object.entries(space.color)) {
        if (accentOwned.has(token)) continue;
        expect(own.color[token], `${name}: ${token}`).toBe(value);
      }
      expect(own.badge).toEqual(space.badge);
      expect(own.pill).toEqual(space.pill);
      expect(own.elevation).toEqual(space.elevation);
    });

    it(`${name}: no neutral carries the accent's hue`, () => {
      const { color } = paletteFor(mode, accent);
      for (const token of NEUTRALS) {
        const [r, g, b] = channels(color[token]);
        expect(Math.max(r, g, b) - Math.min(r, g, b), `${name}: ${token} ${color[token]} is tinted`).toBeLessThanOrEqual(4);
      }
      for (const token of LINES) {
        const [r, g, b] = (color[token].match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
        expect(Math.max(r, g, b) - Math.min(r, g, b), `${name}: ${token} ${color[token]} is tinted`).toBeLessThanOrEqual(4);
      }
    });

    if (mode !== "light") {
      it(`${name}: are neutral greys, with no tint`, () => {
        const { color } = paletteFor(mode, accent);
        for (const token of [...NEUTRALS, "surfaceSelected", "inkPlaceholder"]) {
          const [r, g, b] = channels(color[token]);
          expect(Math.max(r, g, b) - Math.min(r, g, b), `${name}: ${token} ${color[token]} is tinted`).toBeLessThanOrEqual(4);
        }
        for (const token of ["hairline", "hairlineSoft", "divider", "controlBorder", "scrollbar", "sheen"] as const) {
          expect(color[token], `${name}: ${token}`).toMatch(/^rgba\(255, 255, 255, [\d.]+\)$/);
        }
      });
    }

    if (mode === "light") it(`${name}: are near-white greys, at most a trace of cool, never a colour`, () => {
      const { color } = paletteFor(mode, accent);
      for (const token of NEUTRALS) {
        const [r, g, b] = channels(color[token]);
        // Blue never below red or green: a cool trace, never warm, never green.
        expect(b, `${name}: ${token} is warm or green`).toBeGreaterThanOrEqual(Math.max(r, g));
      }
    });

    it(`${name}: the steps between surfaces stay visible`, () => {
      const { color } = paletteFor(mode, accent);
      const ramp = STEPS.map((token) => color[token]).filter(
        (hex, index, all) => index === 0 || hex !== all[index - 1],
      );
      // OLED collapses canvas and surface into one black; the rest still steps.
      expect(ramp.length, `${name}: too few distinct planes`).toBeGreaterThanOrEqual(mode === "oled" ? 3 : 4);
      for (let index = 1; index < ramp.length; index += 1) {
        const [before, after] = [ramp[index - 1], ramp[index]];
        const direction = mode === "light" ? -1 : 1;
        // Light steps *down* from a white surface; the dark modes step up.
        if (!(mode === "light" && index === 1)) {
          expect(Math.sign(relativeLuminance(after) - relativeLuminance(before)), `${name}: ${before} → ${after}`).toBe(
            direction,
          );
        }
        expect(rgbDistance(before, after), `${name}: ${before} → ${after} is not a visible step`).toBeGreaterThanOrEqual(6);
      }
      // The selected row is its own step, not a hover or a press.
      for (const token of ["surfaceHover", "surfaceActive", "surface"] as const) {
        expect(rgbDistance(color.surfaceSelected, color[token]), `${name}: selected vs ${token}`).toBeGreaterThanOrEqual(6);
      }
    });

    it(`${name}: the selected row is the same neutral grey for every accent`, () => {
      expect(paletteFor(mode, accent).color.surfaceSelected).toBe(paletteFor(mode, "space").color.surfaceSelected);
    });

    it(`${name}: the selected row sits between hover and pressed`, () => {
      const { color } = paletteFor(mode, accent);
      const lum = (token: "surfaceHover" | "surfaceSelected" | "surfaceActive") => relativeLuminance(color[token]);
      const [low, high] = [lum("surfaceHover"), lum("surfaceActive")].sort((x, y) => x - y);
      expect(lum("surfaceSelected")).toBeGreaterThan(low);
      expect(lum("surfaceSelected")).toBeLessThan(high);
    });
  }

  it("dark is Notion-like grey: a #191919 canvas under lighter chrome and panes", () => {
    const { color } = paletteFor("dark");
    expect(color.canvas).toBe("#191919");
    expect(color.chrome).toBe("#202020");
    expect(color.surface).toBe("#252525");
    expect(color.surfaceHover).toBe("#2C2C2C");
    expect(color.surfaceActive).toBe("#373737");
    expect(color.hairline).toBe("rgba(255, 255, 255, 0.09)");
    expect(color.inkBody).toBe("#D4D4D4");
    // Light is untouched by the dark rework.
    expect(paletteFor("light").color.canvas).toBe("#F1F1F3");
  });

  it("OLED is true black where it can be, with neutral grey states and lines", () => {
    const { color } = paletteFor("oled");
    for (const token of ["canvas", "surface", "chrome"] as const) expect(color[token]).toBe("#000000");
    for (const token of ["hairline", "hairlineSoft", "divider", "controlBorder"] as const) {
      expect(color[token], `${token} ${color[token]}`).toMatch(/^rgba\(255, 255, 255, [\d.]+\)$/);
    }
    // Stronger than dark's, since nothing else separates the black planes.
    expect(color.hairline).not.toBe(paletteFor("dark").color.hairline);
    // The edge is the one line OLED adds: invisible elsewhere, drawn here.
    expect(color.edge).toMatch(/^rgba\(255, 255, 255, /);
    expect(paletteFor("dark").color.edge).toBe("transparent");
    expect(paletteFor("light").color.edge).toBe("transparent");
    // Ink, accent and danger are dark's, unchanged.
    for (const accent of ACCENT_THEMES) {
      const dark = paletteFor("dark", accent).color;
      const oled = paletteFor("oled", accent).color;
      for (const token of ["ink", "inkBody", "inkMuted", "inkSubtle", "accent", "danger"] as const) {
        expect(oled[token], `${accent}: ${token}`).toBe(dark[token]);
      }
    }
  });
});

describe("danger", () => {
  for (const { mode, accent, name } of COMBOS) {
    it(`${name}: reads as text on every surface`, () => {
      const { danger } = paletteFor(mode, accent).color;
      for (const backdrop of opaqueSurfaces(mode, accent)) {
        expect(contrastRatio(danger, backdrop), `${name}: danger ${danger} on ${backdrop}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });

    it(`${name}: a destructive button's label is readable`, () => {
      // Overlay.tsx draws the confirm button as `bg-danger` with `--wn-surface` text.
      const { danger, surface } = paletteFor(mode, accent).color;
      expect(contrastRatio(surface, danger)).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it(`${name}: is a red, at least 40° of hue from the accent`, () => {
      const { danger, accent: hex } = paletteFor(mode, accent).color;
      const hue = hsl(danger).hue;
      expect(hueGap(hue, 0), `${name}: ${danger} is not a red`).toBeLessThanOrEqual(20);
      expect(hueGap(hue, hsl(hex).hue), `${name}: ${danger} sits too close to ${hex}`).toBeGreaterThanOrEqual(40);
    });
  }
});

describe("scheme resolution", () => {
  it("follows the OS when the preference is system — to dark, never OLED", () => {
    expect(resolveScheme("system", true)).toBe("dark");
    expect(resolveScheme("system", false)).toBe("light");
  });

  it("ignores the OS when the preference says otherwise", () => {
    expect(resolveScheme("light", true)).toBe("light");
    expect(resolveScheme("dark", false)).toBe("dark");
    expect(resolveScheme("oled", false)).toBe("oled");
    expect(resolveScheme("oled", true)).toBe("oled");
  });
});

describe("before the bundle loads", () => {
  const bootSource = readFileSync(new URL("../../public/theme-boot.js", import.meta.url), "utf8");

  /** Run `theme-boot.js` against a fake page and report what it put on `<html>`. */
  function boot(stored: string | null, systemDark: boolean, throwOnStorage = false) {
    const attributes: Record<string, string> = {};
    const style: Record<string, string> = {};
    const window = {
      localStorage: {
        getItem: (key: string) => {
          if (throwOnStorage) throw new Error("storage disabled");
          return key === "winnow.preferences.v1" ? stored : null;
        },
      },
      matchMedia: (query: string) => ({ matches: query.includes("dark") && systemDark }),
    };
    const document = {
      documentElement: { setAttribute: (name: string, value: string) => (attributes[name] = value), style },
    };
    runInNewContext(bootSource, { window, document, JSON });
    return { theme: attributes["data-theme"], accent: attributes["data-accent"], colorScheme: style.colorScheme };
  }

  for (const appearance of APPEARANCES) {
    for (const systemDark of [false, true]) {
      it(`agrees with resolveScheme for ${appearance}, OS ${systemDark ? "dark" : "light"}`, () => {
        const result = boot(JSON.stringify({ appearance, accent: "ember" }), systemDark);
        const expected = resolveScheme(appearance as Appearance, systemDark);
        expect(result.theme).toBe(expected);
        expect(result.accent).toBe("ember");
        expect(result.colorScheme).toBe(expected === "light" ? "light" : "dark");
      });
    }
  }

  it("names the custom accent (1.4.0); its colours come with the bundle", () => {
    expect(boot(JSON.stringify({ appearance: "dark", accent: "custom", accentCustom: "#FF8800" }), false)).toMatchObject({
      theme: "dark",
      accent: "custom",
    });
  });

  it("falls back to system and Space for anything unreadable", () => {
    expect(boot(null, true)).toMatchObject({ theme: "dark", accent: "space" });
    expect(boot("{not json", false)).toMatchObject({ theme: "light", accent: "space" });
    expect(boot(JSON.stringify({ appearance: "sepia", accent: "neon" }), false)).toMatchObject({
      theme: "light",
      accent: "space",
    });
    expect(boot("{}", true, true)).toMatchObject({ theme: "dark", accent: "space" });
  });

  it("knows the same modes and accents as the app", () => {
    expect(bootSource).toContain(JSON.stringify([...APPEARANCES]).replace(/,/g, ", "));
    expect(bootSource).toContain(JSON.stringify([...ACCENT_THEMES]).replace(/,/g, ", "));
  });

  it("index.css paints each mode's own canvas and ink before the palette lands", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const block = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      expect(start, `${selector} is missing from index.css`).toBeGreaterThanOrEqual(0);
      const text = css.slice(start, css.indexOf("}", start));
      return {
        canvas: /--wn-boot-canvas:\s*(#[0-9a-f]{6})/i.exec(text)?.[1]?.toUpperCase(),
        ink: /--wn-boot-ink:\s*(#[0-9a-f]{6})/i.exec(text)?.[1]?.toUpperCase(),
      };
    };
    const cases: [string, ThemeName][] = [
      [":root", "light"],
      [':root[data-theme="dark"]', "dark"],
      [':root[data-theme="oled"]', "oled"],
      [":root:not([data-theme])", "dark"],
    ];
    for (const [selector, mode] of cases) {
      const { color } = paletteFor(mode);
      expect(block(selector), selector).toEqual({ canvas: color.canvas, ink: color.ink });
    }
    const index = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    // A classic script in <head>, ahead of the module bundle: it has to block first paint.
    expect(index).toMatch(/<head>[\s\S]*<script src="\/theme-boot\.js"><\/script>[\s\S]*<\/head>/);
    expect(index).not.toMatch(/<script src="\/theme-boot\.js"[^>]*(?:defer|async|type="module")/);
  });
});

describe("Tailwind colour tokens", () => {
  /**
   * No `/opacity` modifier on a token colour.
   *
   * Every token is a CSS custom property, and Tailwind's alpha modifier emits
   * `rgb(var(--wn-surface) / 0.6)` — not a colour, so the declaration is dropped and the
   * utility renders nothing. It is the quietest failure in this file: the class is in the
   * DOM, the class *name* is on the element, and `getComputedStyle` reports
   * `rgba(0, 0, 0, 0)` rather than an error.
   *
   * `theme.ts` warns about this in prose. Prose does not fail a build; this does. The
   * token list is derived from the `--color-*` entries in `index.css`'s `@theme`, so a new
   * token is covered the day it is added.
   *
   * Tailwind 4 no longer drops the declaration (it mixes the variable with `color-mix`),
   * but the tokens are tuned per mode for contrast, and `veil`, `sheen` and `scrim` are
   * already translucent, so a second alpha on top is still not a colour the palette chose.
   */
  it("are never combined with an opacity modifier", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    const theme = /@theme \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const tokens = [...theme.matchAll(/--color-([a-z][a-z-]*):\s*var\(/g)].map(
      (match) => match[1],
    );
    expect(tokens.length).toBeGreaterThan(10);
    expect(tokens, "surface must be among the tokens checked").toContain("surface");

    // Every `.tsx` under `src`, plus the root component.
    const srcDir = new URL("../", import.meta.url);
    const files = [new URL("App.tsx", srcDir)];
    const walk = (dir: URL): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith(".tsx")) files.push(child);
      }
    };
    walk(srcDir);

    // Comments stripped, so an assertion about class names is not satisfied — or failed —
    // by prose. This file's own subject appears in a comment explaining the bug it
    // guards, which would otherwise make the test report itself.
    const sources = files
      .map((url) => readFileSync(url, "utf8"))
      .map((source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""))
      .join("\n");
    expect(sources.length).toBeGreaterThan(10_000);

    const pattern = new RegExp(
      `\\b(?:bg|text|border|ring|divide|from|to|via|fill|stroke|outline|decoration|shadow)-(${tokens
        .map((token) => token.replace(/-/g, "\\-"))
        .join("|")})/\\d`,
      "g",
    );
    const offenders = [...sources.matchAll(pattern)].map((match) => match[0]);
    expect(
      [...new Set(offenders)],
      "token colours are CSS variables; `/opacity` silently drops the declaration",
    ).toEqual([]);
  });
});

describe("the design system stays small", () => {
  /**
   * Class-name rules over every component, comments stripped.
   *
   * The scale and the radii are reset in `index.css`'s `@theme` (`--text-*: initial`,
   * `--radius-*: initial`), so `text-sm` or `rounded-lg` would compile to *nothing* rather than to a near miss — quiet, like the
   * opacity bug above. These are the patterns that used to be everywhere.
   */
  const srcDir = new URL("../", import.meta.url);
  const files = [new URL("App.tsx", srcDir)];
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".tsx")) files.push(child);
    }
  };
  walk(srcDir);
  const sources = files
    .map((url) => readFileSync(url, "utf8"))
    .map((source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""))
    .join("\n");

  const offenders = (pattern: RegExp): string[] => [
    ...new Set([...sources.matchAll(pattern)].map((match) => match[0])),
  ];

  it("uses only the four type sizes", () => {
    expect(offenders(/\btext-\[\d+(?:\.\d+)?px\]/g)).toEqual([]);
    expect(offenders(/\btext-(?:xs|sm|base|lg|[2-9]?xl)\b/g)).toEqual([]);
  });

  it("keeps the stylesheets on the four type sizes too", () => {
    // The class-name scan above cannot see CSS, which is where an 11px tooltip key and two
    // hard-coded 12/14px sizes hid. Every `font-size` in a stylesheet names a scale step
    // (or inherits one); `font:` shorthands are not used.
    const cssFiles: URL[] = [];
    const walkCss = (dir: URL): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
        if (entry.isDirectory()) walkCss(child);
        else if (entry.name.endsWith(".css")) cssFiles.push(child);
      }
    };
    walkCss(srcDir);
    expect(cssFiles.map((url) => url.pathname)).toContainEqual(expect.stringMatching(/\/index\.css$/));
    const bad: string[] = [];
    for (const url of cssFiles) {
      const css = readFileSync(url, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of css.matchAll(/font-size\s*:\s*([^;}]+)/g)) {
        const value = match[1].trim();
        if (!/^(?:var\(--text-(?:meta|ui|read|title)\)|inherit)$/.test(value)) bad.push(`${url.pathname.split("/").pop()}: ${value}`);
      }
      for (const match of css.matchAll(/(?<![-\w])font\s*:\s*(\d[^;}]*)/g)) bad.push(`${url.pathname.split("/").pop()}: font: ${match[1]}`);
    }
    expect(bad).toEqual([]);
  });

  it("draws every text button from the one recipe (`ui/button.ts`)", () => {
    // The primary and secondary recipes were pasted ~14 times and drifted in height,
    // padding and weight. A class string that restates either one is a new copy.
    const strings = [...sources.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((match) => match[1] ?? match[2] ?? "");
    const pasted = strings.filter((value) => {
      const has = (token: string) => new RegExp(`(?:^|\\s)${token.replace(/[.*+?^${}()|[\]\\:]/g, "\\$&")}(?=\\s|$)`).test(value);
      const primary = has("bg-accent") && has("text-on-accent") && has("font-semibold");
      const secondary = has("border-control-border") && has("hover:bg-surface-hover") && has("font-semibold");
      return primary || secondary;
    });
    expect(pasted).toEqual([]);
  });

  it("draws every lucide glyph through <Icon> (four sizes, one stroke)", () => {
    // 17 sizes and 11 strokes, each picked on its own, before `components/Icon.tsx`.
    const direct: string[] = [];
    const raw: string[] = [];
    for (const url of files) {
      if (url.pathname.endsWith("/components/Icon.tsx")) continue;
      const source = readFileSync(url, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      const name = url.pathname.split("/").pop();
      const glyphs = new Set<string>();
      for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g)) {
        for (const part of match[1].split(",")) {
          const id = part.trim();
          if (id && !id.startsWith("type ")) glyphs.add(id.split(/\s+as\s+/).pop()!.trim());
        }
      }
      for (const glyph of glyphs) if (new RegExp(`<${glyph}\\b`).test(source)) direct.push(`${name}: <${glyph}>`);
      // Any element given a raw pixel size and a stroke is an icon picked by hand.
      for (const match of source.matchAll(/<[A-Za-z]\w*\b[^<]*?\/>/g)) {
        if (/\bsize=\{/.test(match[0]) && /\bstrokeWidth=/.test(match[0])) raw.push(`${name}: ${match[0].slice(0, 60)}`);
      }
    }
    expect(direct).toEqual([]);
    expect(raw).toEqual([]);
  });

  it("keeps state fills on the state tokens, not hand-mixed ink washes", () => {
    // MailNav and the dock once had 8%, 9%, 10% and 14% washes beside sheen, surface-hover
    // and surface-active: a 4th, 5th and 6th grey state.
    expect(offenders(/color-mix\(in_srgb,var\(--wn-ink\)[^\]]*\]/g)).toEqual([]);
  });

  it("sizes sheets and dialogs from the sheet tokens", () => {
    expect(offenders(/\b(?:max|min)-w-\[\d+px\]/g)).toEqual([]);
    expect(offenders(/\bmax-h-\[(?:[89]\d)vh\]|\bmax-h-\[min\((?:700px|44rem)[^\]]*\]/g)).toEqual([]);
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    for (const token of ["--container-sheet-sm: 400px", "--container-sheet-md: 520px", "--container-sheet-lg: 640px", "--wn-sheet-max-h:"]) {
      expect(css).toContain(token);
    }
  });

  it("derives the rail's shadow room, the sender column and the composer indent from one variable each", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    expect(css).toMatch(/--wn-rail-bleed:\s*20px/);
    expect(css).toMatch(/--wn-sender-col:\s*calc\(/);
    expect(css).toMatch(/--wn-composer-label:/);
    const read = (name: string) => readFileSync(new URL(`components/${name}`, import.meta.url), "utf8");
    const strip = read("FilterStrip.tsx");
    expect(strip).not.toMatch(/-?\[-?2\dpx\]/);
    expect(strip.match(/--wn-rail-bleed/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
    const list = read("MessageList.tsx");
    expect(list).not.toMatch(/\bpl-\[\d+px\]/);
    expect(list.match(/--wn-sender-col/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(read("Composer.tsx")).not.toMatch(/\b(?:pl-14|w-12)\b/);
  });

  it("has no per-element optical nudges or arbitrary sizes that are on the scale", () => {
    // Centre against a shared box (`h-[1lh]`, the avatar's `h-8`, the row's `h-6`) instead.
    expect(offenders(/\b-?m[trblxy]?-\[-?\d+(?:\.\d+)?px\]/g)).toEqual([]);
    expect(offenders(/\b(?:h|min-h|w|min-w|p[trblxy]?)-\[(?:\d+)px\]/g)).toEqual([]);
    expect(offenders(/\bleading-\[[\d.]+\]/g)).toEqual([]);
    expect(offenders(/\btext-\[[\d.]+em\]/g)).toEqual([]);
  });

  it("uses the control radius for controls; `full` only for dots, switches, avatars and counts", () => {
    // `rounded-ctl` and `rounded-full` render the same today (9999px), but a shape change
    // would split the controls. A class string with `rounded-full` and a hover or focus
    // state is a control, unless it is a switch track or an avatar button.
    const strings = [...sources.matchAll(/"([^"\n]*)"|`([^`]*)`/g)].map((match) => match[1] ?? match[2] ?? "");
    const controls = strings.filter(
      (value) =>
        /(?:^|\s)rounded-full(?=\s|$)/.test(value) &&
        /(?:^|\s)(?:hover|focus-visible|active):/.test(value) &&
        !/\bh-5 w-9\b/.test(value) && // a switch track
        !/\bwn-color-well\b/.test(value) && // a colour swatch
        !/^mt-0\.5 shrink-0 rounded-full\b/.test(value), // an avatar button
    );
    expect(controls).toEqual([]);
  });

  it("lights nothing decoratively: no glow on an on chip, no halo on the open account", () => {
    // The ring (and the chip's tint, the account's tick and aria-current) carry the state.
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/--pill-glow-a/);
    const accounts = readFileSync(new URL("components/AccountSwitcher.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(accounts).not.toMatch(/halo|0 0 \d+px \d+px/);
    expect(accounts).toContain("boxShadow: ring");
  });

  it("uses only the two radii", () => {
    expect(offenders(/\brounded(?:-[trblse]{1,2})?-(?:sm|md|lg|xl|2xl|3xl|\[[^\]]+\])/g)).toEqual([]);
    // A bare `rounded` has no value in the overridden scale, so it renders square.
    expect(offenders(/\brounded(?=["'`\s])/g)).toEqual([]);
  });

  it("draws no shadows", () => {
    expect(offenders(/\bshadow-(?:sm|md|lg|xl|2xl|inner)\b/g)).toEqual([]);
    expect(offenders(/\bdrop-shadow\b/g)).toEqual([]);
  });

  it("has no letter-spaced capitals", () => {
    expect(offenders(/\buppercase\b/g)).toEqual([]);
    // Positive tracking only: the subject's slight negative tracking (-0.01em) tightens
    // a 24px heading, it does not space anything out.
    expect(offenders(/\btracking-(?:wide|wider|widest|\[(?!-)[^\]]+\])/g)).toEqual([]);
  });

  it("sets everything in IBM Plex Sans: no serif left", () => {
    expect(offenders(/\bfont-serif\b/g)).toEqual([]);
    expect(readFileSync(new URL("../index.css", import.meta.url), "utf8")).not.toMatch(/Source Serif/);
  });

  it("sets the reader's subject in semibold at the title size, tracked slightly tight", () => {
    const reader = readFileSync(new URL("components/Reader.tsx", import.meta.url), "utf8");
    expect(reader).toMatch(/<h1 className="[^"]*\btext-title\b[^"]*\bfont-semibold\b[^"]*\btracking-\[-0\.01em\][^"]*"/);
  });
});

describe("the row's Urgent word", () => {
  /**
   * The list row says "Urgent" in the Urgent chip's colour: the chip's own hue and
   * saturation, at the mode's text lightness. It has to clear AA on every plane a row can
   * be on (resting, hovered, the open or checked row's accent wash under every accent),
   * because it is 12px text, not a fill.
   */
  for (const mode of MODES) {
    it(`${mode}: is the Urgent chip's hue, and clears AA on every row plane`, () => {
      const ink = pillInk(FILTER_HUES.urgent, mode);
      for (const accent of ACCENT_THEMES) {
        const { color } = paletteFor(mode, accent);
        for (const plane of ["surface", "surfaceHover", "surfaceSelected", "canvas"] as const) {
          const base = color[plane].startsWith("rgba") ? composite(color[plane], color.surface) : color[plane];
          expect(contrastRatio(ink, base), `${ink} on ${plane} (${accent})`).toBeGreaterThanOrEqual(AA_TEXT);
        }
      }
      // Not grey: it carries the chip's colour, not the muted ink it used to be.
      const { hue, saturation } = hsl(ink);
      expect(saturation).toBeGreaterThan(0.3);
      expect(hueGap(hue, FILTER_HUES.urgent.h)).toBeLessThan(4);
    });
  }
});

describe("filter pill colours", () => {
  /**
   * Every pill's label and count, on its own tint, in every mode — resting, on, and
   * hovered — over both planes the rail sits on (the list surface on the desktop, the
   * canvas in the phone dock). The fill is translucent, so each is composited first,
   * exactly as `.wn-pill` paints it.
   */
  const SENDERS = ["ada@example.com", "news@shop.test", "x@bank.test", "a@b.c", "nobody"];
  const HUES: [string, PillHue][] = [
    ...BUILTIN_FILTERS.map((id) => [id, FILTER_HUES[id]] as [string, PillHue]),
    ...SENDERS.map((sender) => [`sender ${sender}`, senderHue(sender)] as [string, PillHue]),
    // Every hue a sender can land on, so an address not listed above is covered too.
    ...Array.from({ length: 12 }, (_, step) => [`sender step ${step}`, { h: step * 30 + 15, s: 20 }] as [string, PillHue]),
  ];

  for (const mode of MODES) {
    const { color, pill } = PALETTES[mode];
    for (const base of ["canvas", "surface"] as const) {
      for (const [name, hue] of HUES) {
        it(`${mode}: ${name} on ${base} clears AA, resting, on and hovered`, () => {
          for (const on of [false, true]) {
            for (const hover of [false, true]) {
              const fill = pillFill(hue, mode, color[base], { on, hover });
              const label = color[on ? pill.inkOn : pill.ink];
              expect(contrastRatio(label, fill), `label ${label} on ${fill}`).toBeGreaterThanOrEqual(AA_TEXT);
              expect(contrastRatio(color[pill.count], fill), `count on ${fill}`).toBeGreaterThanOrEqual(AA_TEXT);
            }
          }
        });
      }
    }

    it(`${mode}: an on pill is clearly stronger than a resting one`, () => {
      expect(pill.on).toBeGreaterThanOrEqual(pill.rest * 2);
      for (const id of BUILTIN_FILTERS) {
        const rest = pillFill(FILTER_HUES[id], mode, color.surface, { on: false });
        const on = pillFill(FILTER_HUES[id], mode, color.surface, { on: true });
        expect(rgbDistance(rest, on), id).toBeGreaterThan(12);
        // And even a resting pill is visibly a pill, not the plane it sits on.
        expect(rgbDistance(rest, color.surface), id).toBeGreaterThan(4);
      }
    });

    it(`${mode}: no two coloured builtin pills share a colour (neutral ones share the one grey)`, () => {
      const coloured = BUILTIN_FILTERS.filter((id) => !NEUTRAL_FILTERS.has(id));
      const fills = coloured.map((id) => pillFill(FILTER_HUES[id], mode, color.surface, { on: true }));
      expect(new Set(fills).size).toBe(coloured.length);
    });
  }

  it("the pill inks are text tokens of their palette", () => {
    for (const mode of MODES) {
      const { pill } = PALETTES[mode];
      for (const token of [pill.ink, pill.inkOn, pill.count]) expect(INK_TOKENS).toContain(token);
    }
  });

  it("gives every bucket a colour, and a sender the same colour every time", () => {
    for (const id of BUILTIN_FILTERS) expect(FILTER_HUES[id], id).toBeDefined();
    expect(senderHue("ada@example.com")).toEqual(senderHue("grace@example.com"));
    expect(senderHue("ada@example.com")).toEqual(senderHue("ADA@Example.com"));
  });

  it("index.css paints the pill from the recipe theme.ts publishes", () => {
    const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
    for (const variable of ["--wn-pill-l", "--wn-pill-sat", "--wn-pill-rest", "--wn-pill-on", "--wn-pill-ink", "--wn-pill-inkOn", "--wn-pill-count"]) {
      expect(css).toContain(`var(${variable})`);
    }
    expect(css).not.toContain("data-muted");
  });
});

/**
 * The 1.3.2 contrast tweaks, held with a margin.
 *
 * The theme sweep measured two rounding-level misses on translucent planes the tests
 * above cannot see: the phone drawer's Inbox count on its highlighted (glass over
 * `surfaceSelected`) row was 4.47:1 in light Ember and Aurora, and the compose
 * suggestions' grey address on the active row was 4.48:1 in the dark modes. Those planes
 * cost a few hundredths against the opaque surface, so the tokens now clear AA on every
 * opaque surface with room to spare; the old values fail these floors.
 */
describe("1.3.2 contrast margins", () => {
  const ACCENT_FLOOR = 5;
  const SUBTLE_FLOOR = 4.7;

  it("pins the changed tokens", () => {
    expect(ACCENTS.ember.light.accent).toBe("#9A430C");
    expect(ACCENTS.aurora.light.accent).toBe("#096863");
    expect(PALETTES.dark.color.inkSubtle).toBe("#A4A4A4");
    expect(PALETTES.dark.color.inkMuted).toBe("#ADADAD");
  });

  // 1.4.0's accents are held to the same floor from the start.
  for (const accent of ["ember", "aurora", "rose", "green", "blue", "graphite"] as const) {
    it(`light/${accent}: the accent clears ${ACCENT_FLOOR}:1 on every opaque surface`, () => {
      const color = paletteFor("light", accent).color.accent;
      for (const backdrop of opaqueSurfaces("light", accent)) {
        expect(contrastRatio(color, backdrop), `${color} on ${backdrop}`).toBeGreaterThanOrEqual(ACCENT_FLOOR);
      }
    });

    it(`light/${accent}: white on the accent (buttons) keeps AA with a margin`, () => {
      const { accent: hex, onAccent } = paletteFor("light", accent).color;
      expect(contrastRatio(onAccent, hex)).toBeGreaterThanOrEqual(6);
    });
  }

  it("the old light Ember and Aurora accents would miss the floor on the active row", () => {
    for (const [accent, old] of [
      ["ember", "#A2470D"],
      ["aurora", "#0A6E68"],
    ] as const) {
      const { surfaceActive } = paletteFor("light", accent).color;
      expect(contrastRatio(old, surfaceActive)).toBeLessThan(ACCENT_FLOOR);
    }
  });

  for (const mode of ["dark", "oled"] as const) {
    it(`${mode}: inkSubtle and inkMuted clear ${SUBTLE_FLOOR}:1 on the active row in every accent`, () => {
      for (const accent of ACCENT_THEMES) {
        const { inkSubtle, inkMuted, surfaceActive } = paletteFor(mode, accent).color;
        expect(contrastRatio(inkSubtle, surfaceActive), `${accent} subtle`).toBeGreaterThanOrEqual(SUBTLE_FLOOR);
        expect(contrastRatio(inkMuted, surfaceActive), `${accent} muted`).toBeGreaterThanOrEqual(SUBTLE_FLOOR);
      }
    });
  }

  it("dark: the old inkSubtle would miss the floor on the active row", () => {
    expect(contrastRatio("#A0A0A0", PALETTES.dark.color.surfaceActive)).toBeLessThan(SUBTLE_FLOOR);
  });
});

describe("an off switch (STRM-426)", () => {
  // Non-text contrast (WCAG 1.4.11) for the parts that say "a switch, and it's off": in
  // the dark modes the knob against its track and against the planes a row sits on, and
  // the track a visible step off the plane. Light keeps its long-standing look and is
  // held only to the token existing.
  for (const mode of MODES) {
    const color = PALETTES[mode].color;
    it(`${mode}: has its own off track and knob`, () => {
      expect(color.switchTrackOff).toMatch(/^#[0-9A-F]{6}$/i);
      expect(color.switchKnobOff).toMatch(/^#[0-9A-F]{6}$/i);
    });
    if (mode === "light") continue;
    it(`${mode}: the knob stands out from its track and from the page`, () => {
      expect(contrastRatio(color.switchKnobOff, color.switchTrackOff)).toBeGreaterThanOrEqual(3);
      for (const plane of ["canvas", "surface", "surfaceHover", "chrome"]) {
        expect(contrastRatio(color.switchKnobOff, color[plane])).toBeGreaterThanOrEqual(3);
      }
    });
    it(`${mode}: the track is a visible step off the page, not the pressed grey`, () => {
      expect(color.switchTrackOff).not.toBe(color.surfaceActive);
      for (const plane of ["canvas", "surface", "chrome"]) {
        expect(contrastRatio(color.switchTrackOff, color[plane])).toBeGreaterThanOrEqual(1.6);
      }
    });
  }
});
