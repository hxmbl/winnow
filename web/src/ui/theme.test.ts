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
 *   4. **The accent works as text, as a ring and as a fill**, in both schemes, and is a
 *      deliberate space violet — a saturated, indigo-leaning blue-violet — rather than a
 *      stock Tailwind violet or indigo. The neutrals carry a blue-violet cast, the selected
 *      row is the accent washed into the surface, and danger stays a readable red well
 *      clear of the accent.
 *   5. **The design system stays small**: four type sizes, two radii, no shadows and no
 *      letter-spaced capitals, asserted over the component sources.
 *
 * No DOM required, which is the payoff of the `core`/`ui` split: this is the same
 * arithmetic the browser would do, run as a unit test.
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  paletteFor,
  relativeLuminance,
  resolveScheme,
} from "./theme";

/** WCAG AA for text this size. Every piece of muted text in the app is 11–13px. */
const AA_TEXT = 4.5;

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

/** The palettes under test. Named, so a typo cannot silently test nothing. */
const SCHEMES = ["light", "dark"] as const;

type Scheme = (typeof SCHEMES)[number];

function opaqueSurfaces(name: Scheme): string[] {
  const { color } = paletteFor(name);
  return SURFACE_TOKENS.map((token) => color[token]).filter((value) =>
    value.startsWith("#"),
  );
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

describe("text contrast", () => {
  /**
   * Every ink step, against every opaque surface in its own palette.
   *
   * One case, no exclusions: a token that fails on one plane fails for a user.
   */
  for (const name of SCHEMES) {
    for (const token of ["ink", "inkBody", "inkMuted", "inkSubtle", "inkIcon", "inkPlaceholder"]) {
      it(`${name}: ${token} is readable on every surface`, () => {
        const color = paletteFor(name).color[token];
        for (const backdrop of opaqueSurfaces(name)) {
          expect(
            contrastRatio(color, backdrop),
            `${name}: ${token} ${color} on ${backdrop}`,
          ).toBeGreaterThanOrEqual(AA_TEXT);
        }
      });
    }
  }

  /**
   * The ramp has to stay in order, or "tertiary" quietly becomes "primary".
   *
   * Two greys at the same contrast would flatten the hierarchy even though both passed
   * the AA check above, so the ordering is asserted as a separate property.
   */
  for (const name of SCHEMES) {
    it(`${name}: the ink ramp runs darkest to lightest`, () => {
      // Ordered by *luminance*, not contrast ratio: the two run in opposite directions
      // in the light palette, so contrast is the wrong instrument for "is this step
      // visibly weaker than the last".
      //
      // `ink` and `inkBody` are headline-adjacent and are *not* required to be
      // distinguishable from each other (a 15px sender name beside a 14.5px body is
      // separated by size and weight, not by grey). The muted pair must be ordered
      // against each other and against `inkBody`.
      const luminance = ["inkBody", "inkMuted", "inkSubtle"].map((token) =>
        relativeLuminance(paletteFor(name).color[token]),
      );
      const direction = name === "light" ? 1 : -1;
      for (let index = 1; index < luminance.length; index += 1) {
        expect(
          Math.sign(luminance[index] - luminance[index - 1]),
          `${name}: inkBody/inkMuted/inkSubtle step ${index} is out of order ` +
            `(${luminance.map((value) => value.toFixed(3)).join(" → ")})`,
        ).toBe(direction);
      }

      // And a *visible* step, not merely the right sign: two adjacent greys 1% apart
      // pass an ordering check and read as one colour.
      for (let index = 1; index < luminance.length; index += 1) {
        const ratio =
          direction === 1
            ? luminance[index] / luminance[index - 1]
            : luminance[index - 1] / luminance[index];
        expect(ratio, `${name}: step ${index} is not visibly distinct`).toBeGreaterThanOrEqual(
          1.12,
        );
      }
    });
  }
});

describe("the accent", () => {
  /** WCAG's bar for a focus indicator and other non-text marks. */
  const AA_NON_TEXT = 3;

  for (const name of SCHEMES) {
    it(`${name}: reads as text on every surface`, () => {
      const { accent } = paletteFor(name).color;
      for (const backdrop of opaqueSurfaces(name)) {
        expect(contrastRatio(accent, backdrop), `${name}: accent on ${backdrop}`).toBeGreaterThanOrEqual(
          AA_TEXT,
        );
      }
    });

    it(`${name}: the focus ring is visible on every surface`, () => {
      const { focusRing } = paletteFor(name).color;
      expect(focusRing.startsWith("#"), "the ring must be opaque to be measured").toBe(true);
      for (const backdrop of opaqueSurfaces(name)) {
        expect(contrastRatio(focusRing, backdrop)).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    });

    it(`${name}: a primary button's label is readable on the accent`, () => {
      const { accent, onAccent } = paletteFor(name).color;
      expect(contrastRatio(onAccent, accent)).toBeGreaterThanOrEqual(AA_TEXT);
    });
  }

  /**
   * A space violet, not the framework default.
   *
   * The accent is a cosmic blue-violet: a hue on the indigo side of violet (245–265°),
   * vivid rather than muted (HSL saturation 0.6 or more), so it glows on the night-sky dark
   * theme and reads as a colour in light. That range is exactly where Tailwind's violet and
   * indigo live, so the accent also has to keep a visible distance from every stock
   * violet/indigo/purple/fuchsia 400–700 — the generic-button purples.
   */
  it("is a vivid space violet, not a stock violet or indigo", () => {
    const STOCK = [
      "#A78BFA", "#8B5CF6", "#7C3AED", "#6D28D9", // violet 400–700
      "#818CF8", "#6366F1", "#4F46E5", "#4338CA", // indigo 400–700
      "#C084FC", "#A855F7", "#9333EA", "#7E22CE", // purple 400–700
      "#E879F9", "#D946EF", "#C026D3", "#A21CAF", // fuchsia 400–700
    ];
    for (const name of SCHEMES) {
      const hex = paletteFor(name).color.accent;
      const { hue, saturation } = hsl(hex);
      expect(hue, `${name}: ${hex} hue`).toBeGreaterThanOrEqual(245);
      expect(hue, `${name}: ${hex} hue`).toBeLessThanOrEqual(265);
      expect(saturation, `${name}: ${hex} is too muted`).toBeGreaterThanOrEqual(0.6);
      for (const stock of STOCK) {
        expect(rgbDistance(hex, stock), `${name}: ${hex} is too close to ${stock}`).toBeGreaterThan(28);
      }
    }
  });

  it("is the same hue in both schemes", () => {
    const light = hsl(paletteFor("light").color.accent).hue;
    const dark = hsl(paletteFor("dark").color.accent).hue;
    expect(hueGap(light, dark)).toBeLessThanOrEqual(8);
  });
});

describe("the neutrals", () => {
  /** Backdrops and inks that carry the blue-violet cast. Status colours and the accent are excluded. */
  const NEUTRALS = [...SURFACE_TOKENS.filter((token) => token !== "surfaceSelected"), "ink", "inkBody", "inkMuted", "inkSubtle", "inkIcon"];

  for (const name of SCHEMES) {
    it(`${name}: are cool blue-violet greys, tinted but not coloured`, () => {
      const { color } = paletteFor(name);
      for (const token of NEUTRALS) {
        const hex = color[token];
        const [r, g, b] = channels(hex);
        // Blue over red over green: a blue-violet lean, not blue-grey, not teal and not beige.
        expect(b, `${name}: ${token} ${hex} is not violet-leaning`).toBeGreaterThan(g);
        expect(r, `${name}: ${token} ${hex} leans teal`).toBeGreaterThanOrEqual(g);
        expect(b, `${name}: ${token} ${hex} is warm`).toBeGreaterThan(r);
        // A cast, not a colour: the dark theme's indigo-blacks lean harder than the light
        // greys, but every neutral stays far short of the accent's own saturation.
        expect(Math.max(r, g, b) - Math.min(r, g, b), `${name}: ${token} ${hex} is too saturated`).toBeLessThanOrEqual(36);
        // And on the accent's side of the wheel, so page and accent read as one family.
        expect(hueGap(hsl(hex).hue, hsl(color.accent).hue), `${name}: ${token} ${hex} drifts from the accent`).toBeLessThanOrEqual(20);
      }
    });

    it(`${name}: the selected row is the accent washed into the surface`, () => {
      const { color } = paletteFor(name);
      const selected = hsl(color.surfaceSelected).hue;
      const accent = hsl(color.accent).hue;
      expect(hueGap(selected, accent), `${name}: ${color.surfaceSelected} drifts from the accent`).toBeLessThanOrEqual(25);
      expect(color.surfaceSelected).not.toBe(color.surface);
    });
  }
});

describe("danger", () => {
  for (const name of SCHEMES) {
    it(`${name}: reads as text on every surface`, () => {
      const { danger } = paletteFor(name).color;
      for (const backdrop of opaqueSurfaces(name)) {
        expect(contrastRatio(danger, backdrop), `${name}: danger on ${backdrop}`).toBeGreaterThanOrEqual(AA_TEXT);
      }
    });

    it(`${name}: a destructive button's label is readable`, () => {
      // Overlay.tsx draws the confirm button as `bg-danger` with `--wn-surface` text.
      const { danger, surface } = paletteFor(name).color;
      expect(contrastRatio(surface, danger)).toBeGreaterThanOrEqual(AA_TEXT);
    });

    it(`${name}: is a red, well clear of the accent's hue`, () => {
      const { danger, accent } = paletteFor(name).color;
      const hue = hsl(danger).hue;
      expect(hueGap(hue, 0), `${name}: ${danger} is not a red`).toBeLessThanOrEqual(20);
      expect(hueGap(hue, hsl(accent).hue), `${name}: ${danger} sits too close to ${accent}`).toBeGreaterThanOrEqual(90);
    });
  }
});

describe("scheme resolution", () => {
  it("follows the OS when the preference is system", () => {
    expect(resolveScheme("system", true)).toBe("dark");
    expect(resolveScheme("system", false)).toBe("light");
  });

  it("ignores the OS when the preference says otherwise", () => {
    expect(resolveScheme("light", true)).toBe("light");
    expect(resolveScheme("dark", false)).toBe("dark");
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
