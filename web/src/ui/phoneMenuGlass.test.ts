import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GLASS, SOLID_BACKDROPS, WORST_BACKDROPS, glassProperties } from "./glass";
import { MODES, PALETTES, composite, contrastRatio, type ThemeName } from "./theme";

/**
 * STRM-440: on a phone the reader's ••• menu was a solid sheet sitting over the
 * see-through frosted pill it opens from. Phone menus are now that same glass
 * (`.wn-glass`), the reader's More and every popover menu (`Menu.tsx`) alike, with the
 * tint raised for words (`.wn-glass-menu`, `menu` in `glass.ts`) so they stay readable
 * over a busy message, a solid photo included.
 */

/** A backdrop as an opaque colour: `white`/`black` solid, `white@0.6` over the list. */
function backdrop(spec: string, scheme: ThemeName): string {
  const [colour, share = "1"] = spec.split("@");
  if (colour.startsWith("#")) return colour;
  const hex = colour === "white" ? "255, 255, 255" : "0, 0, 0";
  return composite(`rgba(${hex}, ${share})`, PALETTES[scheme].color.surface);
}

/** The glass tint at `alpha` over a backdrop. */
function glassOver(scheme: ThemeName, alpha: number, under: string): string {
  const base = PALETTES[scheme].color[GLASS[scheme].base];
  const n = Number.parseInt(base.slice(1), 16);
  return composite(`rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`, under);
}

/** Everything a phone menu can float over: a solid photo in a message, or the list. */
const UNDER = (scheme: ThemeName) => [...SOLID_BACKDROPS, ...WORST_BACKDROPS[scheme]];

/** The worst contrast of `ink` on the menu's tint at `alpha`, over every backdrop. */
function worst(scheme: ThemeName, alpha: number, ink: string): number {
  return Math.min(...UNDER(scheme).map((spec) => contrastRatio(glassOver(scheme, alpha, backdrop(spec, scheme)), ink)));
}

/** The words on a menu: rows (ink-body), the "Show as" heading and hints (ink-subtle), danger rows. */
const WORDS = ["ink", "inkBody", "inkSubtle", "danger"] as const;

describe("phone menus are the pill's frosted glass (STRM-440)", () => {
  for (const scheme of MODES) {
    const { color } = PALETTES[scheme];
    const { menu, bar, text, fallback } = GLASS[scheme];

    it(`${scheme}: the menu tint is above the pill's, and still frost rather than a sheet`, () => {
      expect(menu).toBeGreaterThanOrEqual(text);
      expect(menu).toBeGreaterThanOrEqual(bar);
      expect(menu).toBeLessThan(fallback);
      expect(menu).toBeLessThan(0.9);
    });

    // Menus are not Liquid Glass (no `.wn-liquid`), so no sheen lies over their words.
    it(`${scheme}: its words, its heading and its danger rows are AA over a solid photo and the list`, () => {
      for (const ink of WORDS) {
        expect(worst(scheme, menu, color[ink]), ink).toBeGreaterThanOrEqual(4.5);
      }
      // Row icons are not text: 3:1 (WCAG 1.4.11).
      for (const ink of ["inkMuted", "inkIcon"] as const) {
        expect(worst(scheme, menu, color[ink]), ink).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${scheme}: its tint is the lowest that keeps them so (no more solid than it needs)`, () => {
      const lower = menu - 0.02;
      expect(WORDS.some((ink) => worst(scheme, lower, color[ink]) < 4.5)).toBe(true);
    });

    it(`${scheme}: publishes it as --wn-glass-menu`, () => {
      expect(glassProperties(scheme, color)["--wn-glass-menu"]).toBe(`${Math.round(menu * 100)}%`);
    });
  }

  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  const read = (name: string) => readFileSync(new URL(`./components/${name}`, import.meta.url), "utf8");

  it("raises the glass's own tint, so blur, fallback, reduced transparency and forced colours stay .wn-glass's", () => {
    expect(css).toMatch(/\.wn-glass\.wn-glass-menu \{\s*--wn-glass-text: var\(--wn-glass-menu, 88%\);\s*\}/);
    // Those fallbacks are opaque: reduced transparency drops the frost for the base colour,
    // forced colours for Canvas, and no-blur engines for the near-solid fallback tint.
    expect(css).toMatch(
      /@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\.wn-glass,\s*\.wn-pill\.wn-chip-glass \{[^}]*background-color: var\(--wn-glass-base, var\(--wn-surface\)\) !important;/,
    );
    expect(css).toMatch(/@media \(forced-colors: active\) \{[\s\S]*?\.wn-glass,\s*\.wn-pill\.wn-chip-glass \{[^}]*background: Canvas;/);
    expect(css).toMatch(/\.wn-glass \{\s*background: color-mix\(in srgb, var\(--wn-glass-base, var\(--wn-surface\)\) var\(--wn-glass-fallback, 94%\), transparent\);/);
  });

  it("the reader's More on a phone is the glass, in the body, above the pill", () => {
    const reader = read("Reader.tsx");
    expect(reader).toMatch(/`wn-glass wn-glass-menu bottom-\[calc\(var\(--wn-dock-bottom\)\+var\(--wn-dock-h\)\+0\.5rem\)\] z-70/);
    expect(reader).toMatch(/phone && typeof document !== "undefined" \? createPortal\(menu, document\.body\) : menu/);
    // The solid sheet is gone from the phone branch.
    expect(reader).not.toMatch(/rounded-pane border border-hairline bg-chrome p-1\.5 shadow-lift/);
    // An outside tap is outside both the button and the portalled menu.
    expect(reader).toMatch(/!rootRef\.current\?\.contains\(target\) && !menuRef\.current\?\.contains\(target\)/);
  });

  it("every popover menu on a phone (snooze from the pill, account from the panel, row and sender) is the same glass", () => {
    const menu = read("Menu.tsx");
    expect(menu).toMatch(/const phone = usePhoneLayout\(\);/);
    // Behind: the frost on a ::before, so the menu never contains its own fixed submenu.
    expect(menu).toMatch(/phone \? "wn-glass wn-glass-behind wn-glass-menu" : "border border-hairline bg-chrome"/);
  });
});
