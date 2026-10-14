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
 *      violet rather than a stock Tailwind violet or indigo. The neutrals carry a shared
 *      blue-violet cast (OLED's black planes excepted), the selected row is the accent
 *      washed into the surface, and danger stays a readable red at least 40° of hue from
 *      every accent.
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
  MODES,
  contrastRatio,
  paletteFor,
  relativeLuminance,
  resolveScheme,
  type ThemeName,
} from "./theme";
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

const INK_TOKENS = ["ink", "inkBody", "inkMuted", "inkSubtle", "inkIcon", "inkPlaceholder"] as const;

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
    expect(ACCENT_THEMES.length).toBeGreaterThanOrEqual(3);
    expect(ACCENT_THEMES.length).toBeLessThanOrEqual(4);
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

  it("the accent themes are visibly different colours", () => {
    for (const [index, first] of ACCENT_THEMES.entries()) {
      for (const second of ACCENT_THEMES.slice(index + 1)) {
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
  /** Backdrops and inks that carry the blue-violet cast. Status colours and the accent are excluded. */
  const NEUTRALS = [
    ...SURFACE_TOKENS.filter((token) => token !== "surfaceSelected"),
    ...INK_TOKENS.filter((token) => token !== "inkPlaceholder"),
  ];
  /** The planes that step up from the backdrop, in order. Each step has to be visible. */
  const STEPS = ["canvas", "surface", "surfaceHover", "surfaceActive"] as const;
  /** The hue every neutral leans towards: Space's, shared by every accent theme. */
  const SHARED_HUE = hsl(ACCENTS.space.dark.accent).hue;

  /**
   * Neutrals are shared across accents, by design: every theme sits on the same
   * indigo-tinted greys, and only the accent (with its selected-row wash and, for Ember,
   * danger) changes. So the tint rule is asserted against Space's hue in every combo.
   */
  for (const { mode, accent, name } of COMBOS) {
    it(`${name}: neutrals are the shared set`, () => {
      const own = paletteFor(mode, accent).color;
      const space = paletteFor(mode, "space").color;
      for (const token of NEUTRALS) expect(own[token], `${name}: ${token}`).toBe(space[token]);
    });

    it(`${name}: are cool blue-violet greys, tinted but not coloured`, () => {
      const { color } = paletteFor(mode, accent);
      for (const token of NEUTRALS) {
        const hex = color[token];
        // OLED's black planes are exempt: black has no hue. Its hover and pressed
        // fills, and the inks, are still held to the rule.
        if (mode === "oled" && hex === "#000000") continue;
        const [r, g, b] = channels(hex);
        // Blue over red over green: a blue-violet lean, not blue-grey, not teal, not beige.
        expect(b, `${name}: ${token} ${hex} is not violet-leaning`).toBeGreaterThan(g);
        expect(r, `${name}: ${token} ${hex} leans teal`).toBeGreaterThanOrEqual(g);
        expect(b, `${name}: ${token} ${hex} is warm`).toBeGreaterThan(r);
        // A cast, not a colour.
        expect(Math.max(r, g, b) - Math.min(r, g, b), `${name}: ${token} ${hex} is too saturated`).toBeLessThanOrEqual(36);
        expect(hueGap(hsl(hex).hue, SHARED_HUE), `${name}: ${token} ${hex} drifts from the indigo cast`).toBeLessThanOrEqual(20);
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

    it(`${name}: the selected row is the accent washed into the surface`, () => {
      const { color } = paletteFor(mode, accent);
      const gap = hueGap(hsl(color.surfaceSelected).hue, hsl(color.accent).hue);
      expect(gap, `${name}: ${color.surfaceSelected} drifts from ${color.accent}`).toBeLessThanOrEqual(25);
    });
  }

  it("dark is a notch darker than it first shipped, and still indigo", () => {
    const { color } = paletteFor("dark");
    expect(relativeLuminance(color.canvas)).toBeLessThan(relativeLuminance("#0B0A1A"));
    expect(relativeLuminance(color.surface)).toBeLessThan(relativeLuminance("#13112A"));
    expect(color.canvas).not.toBe("#000000");
  });

  it("OLED is true black where it can be, and violet in its lines", () => {
    const { color } = paletteFor("oled");
    for (const token of ["canvas", "surface", "chrome"] as const) expect(color[token]).toBe("#000000");
    for (const token of ["hairline", "hairlineSoft", "divider", "controlBorder"] as const) {
      const match = /^rgba\((\d+), (\d+), (\d+), [\d.]+\)$/.exec(color[token]);
      expect(match, `${token} ${color[token]}`).not.toBeNull();
      const [r, g, b] = match!.slice(1, 4).map(Number);
      expect(b, `${token} is not violet-tinted`).toBeGreaterThan(r);
      expect(r, `${token} is not violet-tinted`).toBeGreaterThan(g);
    }
    // The edge is the one line OLED adds: invisible elsewhere, drawn here.
    expect(color.edge).toMatch(/^rgba\(200, 188, 255, /);
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
   * token list is derived from `tailwind.config.js`, so a new token is covered the day it
   * is added.
   */
  it("are never combined with an opacity modifier", () => {
    const config = readFileSync(new URL("../../tailwind.config.js", import.meta.url), "utf8");
    // Keys are quoted when they contain a dash and bare otherwise, so the pattern
    // accepts both. Matching only the quoted ones would silently omit `surface` — the
    // token this test exists to protect.
    const tokens = [...config.matchAll(/["']?([a-z][a-z-]*)["']?:\s*"var\(/g)].map(
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
   * The scale and the radii are overridden in `tailwind.config.js`, so `text-sm` or
   * `rounded-lg` would compile to *nothing* rather than to a near miss — quiet, like the
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
    expect(offenders(/\btracking-(?:wide|wider|widest|\[[^\]]+\])/g)).toEqual([]);
  });
});
