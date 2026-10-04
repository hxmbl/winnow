/**
 * The palettes have teeth.
 *
 * Every colour in `theme.ts` was chosen by eye, which is the right way to choose one
 * and the wrong way to keep it. A screenshot cannot tell you that `#8B929C` is
 * 3.14:1 on white; it looks like a perfectly good tertiary grey right up until
 * somebody reads the app in a bright room.
 *
 * So the two properties that are objectively checkable are asserted here:
 *
 *   1. **Text clears WCAG AA against every surface it appears on.** Not against
 *      white — against `surfaceActive`, which is the darkest plane in the light
 *      palette and therefore the binding case, and against `surfaceSunken` in dark.
 *   2. **A badge chip's label clears AA on its own wash**, over every surface. This
 *      is the one that was quietly broken: the chip renders the accent as *both* the
 *      fill (14%) and the label, and nine of the light palette's twenty-one accents
 *      were between 2.7:1 and 4.2:1 as a result.
 *
 * No DOM required, which is the payoff of the `core`/`ui` split: this is the same
 * arithmetic the browser would do, run as a unit test.
 */

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BADGE_TEXT_CONTRAST,
  badgeBackdrops,
  contrastRatio,
  deriveBadgeInk,
  paletteFor,
  relativeLuminance,
  resolveScheme,
} from "./theme";
import { avatarColor, avatarRamp, avatarTextColor } from "./avatarColor";

/** WCAG AA for text this size. Every piece of muted text in the app is 11–13px. */
const AA_TEXT = 4.5;

/** The alpha `applyTheme` writes into `--wn-badge-*-wash`. */
const BADGE_WASH_ALPHA = 0.14;

/** `#RRGGBB` composited under `rgba(top, alpha)`, matching what a browser paints. */
function flatten(top: string, backdrop: string, alpha: number): string {
  const a = Number.parseInt(top.slice(1), 16);
  const b = Number.parseInt(backdrop.slice(1), 16);
  const channel = (shift: number): number => {
    const high = (a >> shift) & 255;
    const low = (b >> shift) & 255;
    return Math.round(high * alpha + low * (1 - alpha));
  };
  return `#${[16, 8, 0].map((s) => channel(s).toString(16).padStart(2, "0")).join("")}`;
}

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

describe("text contrast", () => {
  /**
   * Every ink step, against every opaque surface in its own palette.
   *
   * One case, no exclusions: a token that fails on one plane fails for a user, and
   * the whole point of the test is that nobody has to guess which plane.
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
   * A mail list reads as a hierarchy of weights and greys: the sender is the darkest
   * thing on a row, the preview line the lightest. Two greys at the same contrast
   * would flatten that even though both passed the AA check above — so the ordering
   * is a separate property and is asserted separately.
   */
  for (const name of SCHEMES) {
    it(`${name}: the ink ramp runs darkest to lightest`, () => {
      // Ordered by *luminance*, not by contrast ratio. The two run in opposite
      // directions in the light palette — more contrast means a darker ink on a
      // light surface, and a lighter ink on a dark one — so contrast is the wrong
      // instrument for "is this step visibly weaker than the last". Luminance is
      // the property the eye is actually reading.
      //
      // `ink` and `inkBody` are both headline-adjacent and are *not* required to be
      // distinguishable from each other (a 15px sender name beside a 14.5px body is
      // separated by size and weight, not by grey). The muted pair must be ordered
      // against each other and against `inkBody`, and that is what is asserted.
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

      // And a *visible* step, not merely the right sign. Two adjacent greys 1% apart
      // pass an ordering check and read as one colour, which is the failure the
      // check exists to prevent: a hierarchy that has collapsed is not a hierarchy,
      // however legible each step is on its own.
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

describe("badge chips", () => {
  for (const name of SCHEMES) {
    const palette = paletteFor(name);
    const allSurfaces = badgeBackdrops(palette.color, name);

    for (const [key, accent] of Object.entries(palette.badge)) {
      it(`${name}: the ${key} chip label is readable on its own wash`, () => {
        const ink = deriveBadgeInk(accent, palette.color, name);
        for (const backdrop of allSurfaces) {
          const wash = flatten(ink, backdrop, BADGE_WASH_ALPHA);
          expect(
            contrastRatio(ink, wash),
            `${key}: ${ink} on its wash over ${backdrop}`,
          ).toBeGreaterThanOrEqual(BADGE_TEXT_CONTRAST);
        }
      });
    }

    /**
     * The derivation must not move an accent that is already fine.
     *
     * It is tempting to "tidy" the dark palette by letting the derivation run there
     * too, and the result is a set of chips noticeably deeper than they need to be
     * for no gain. A derivation that changes something which already passed is a
     * derivation that cannot be trusted to leave the right things alone.
     */
    it(`${name}: an accent that clears everywhere is returned untouched`, () => {
      for (const [key, accent] of Object.entries(palette.badge)) {
        const clearsEverywhere = allSurfaces.every(
          (backdrop) =>
            contrastRatio(accent, flatten(accent, backdrop, BADGE_WASH_ALPHA)) >=
            BADGE_TEXT_CONTRAST,
        );
        if (!clearsEverywhere) continue;
        // Compared case-insensitively: the derivation rebuilds the hex through a
        // channel mixer, which lowercases, and `#FB923C` is not a different colour
        // from `#fb923c`.
        expect(deriveBadgeInk(accent, palette.color, name).toLowerCase(), key).toBe(
          accent.toLowerCase(),
        );
      }
    });
  }

  /**
   * The derivation must move in the right direction.
   *
   * A bug that pushed a light chip *lighter* would still produce a palette that
   * passes the contrast checks above — because a sufficiently light label on a
   * 14% wash of itself does clear the bar. So the direction is asserted directly:
   * in the light palette every chip label must be at least as dark as its accent,
   * and in the dark palette at least as light. Both are monotonic moves toward the
   * palette's own ink, which is what "darker is more contrast against a wash of
   * the same hue on a light surface" means.
   */
  it("light chip labels only darken, and dark chip labels only lighten", () => {
    for (const [name, direction] of [
      ["light", "darker"],
      ["dark", "lighter"],
    ] as const) {
      const palette = paletteFor(name);
      for (const [key, accent] of Object.entries(palette.badge)) {
        const ink = deriveBadgeInk(accent, palette.color, name);
        if (direction === "darker") {
          expect(relativeLuminance(ink), `${name}/${key}`).toBeLessThanOrEqual(
            relativeLuminance(accent),
          );
        } else {
          expect(relativeLuminance(ink), `${name}/${key}`).toBeGreaterThanOrEqual(
            relativeLuminance(accent),
          );
        }
      }
    }
  });
});

describe("avatars", () => {
  /**
   * The monogram is text, so it is held to the text bar — and it is the one place in
   * the app where a foreground and a background are computed at runtime from a hash,
   * which is exactly the combination that produces a colour nobody has ever looked
   * at. Every step, not a sample: six steps is the whole ramp.
   */
  

  it("every ramp step clears AA for its monogram", () => {
    for (const fill of avatarRamp()) {
      // `avatarTextColor` is a pure function of the *sender*, so walk the ramp by
      // finding a domain that hashes to each step rather than guessing addresses.
      const sender = senderForRampStep(avatarRamp().indexOf(fill));
      expect(avatarColor(sender), "ramp walk missed a step").toBe(fill);
      expect(
        contrastRatio(avatarTextColor(sender), fill),
        `${avatarTextColor(sender)} on ${fill}`,
      ).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it("a sender's avatar is stable", () => {
    expect(avatarColor("ada@northwind.example")).toBe(avatarColor("ada@northwind.example"));
  });

  it("two people at one company share a colour, and two companies do not collide", () => {
    expect(avatarColor("ada@northwind.example")).toBe(avatarColor("grace@northwind.example"));
    expect(avatarColor("ada@northwind.example")).not.toBe(avatarColor("dana@quarrylane.example"));
  });
});

/**
 * An address that lands on a given ramp step.
 *
 * Written out rather than hardcoded because the ramp is hashed by domain, so a
 * hand-picked list of example addresses would silently stop covering every step the
 * moment the ramp or the hash changed — and the test would still pass, testing four
 * of six colours.
 */
function senderForRampStep(index: number): string {
  // The hash runs over the *domain*, so the local part is fixed and the domain
  // varies. Six steps out of six, so a few hundred candidates is plenty.
  for (let candidate = 0; candidate < 10_000; candidate += 1) {
    const sender = `probe@host${candidate}.test`;
    if (avatarColor(sender) === avatarRamp()[index]) return sender;
  }
  throw new Error(`no domain hashes to ramp step ${index}`);
}

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
   * `rgb(var(--wn-surface) / 0.6)` — which is not a colour, so the declaration is
   * dropped and the utility renders nothing. It is the quietest failure in this file:
   * the class is in the DOM, the class *name* is on the element, and `getComputedStyle`
   * reports `rgba(0, 0, 0, 0)` rather than an error. The pill's shortcut keycap was
   * written as `bg-surface/60` and rendered with no fill at all, leaving an 11px digit
   * sitting on the pill's wash at 3.3:1.
   *
   * `theme.ts` warns about this in prose. Prose does not fail a build; this does.
   * The token list is derived from `tailwind.config.js` so a new token is covered the
   * day it is added, and the utilities list is derived from the prefix used in the
   * codebase rather than typed out.
   */
  it("are never combined with an opacity modifier", () => {
    const config = readFileSync(new URL("../../tailwind.config.js", import.meta.url), "utf8");
    // Keys are quoted when they contain a dash and bare otherwise, so the pattern accepts
    // both. Matching only the quoted ones would have silently omitted `surface` — which
    // is the token this test exists to protect, and which is how the first version of
    // this test passed on the very class of bug it was written for.
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