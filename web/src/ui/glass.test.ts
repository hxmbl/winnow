import { describe, expect, it } from "vitest";
import { GLASS, WORST_BACKDROPS, glassProperties } from "./glass";
import { FILTER_HUES, senderHue } from "./filterColors";
import { MODES, PALETTES, composite, contrastRatio, pillFill, type ThemeName } from "./theme";

/** A worst backdrop as an opaque colour: `white@0.6` is white over 60%, the list between. */
function backdrop(spec: string, scheme: ThemeName): string {
  const [colour, share] = spec.split("@");
  if (!share) return colour;
  const hex = colour === "white" ? "255, 255, 255" : "0, 0, 0";
  return composite(`rgba(${hex}, ${share})`, PALETTES[scheme].color.surface);
}

/** The glass tint at `alpha` over a backdrop. */
function glassOver(scheme: ThemeName, alpha: number, under: string): string {
  const base = PALETTES[scheme].color[GLASS[scheme].base];
  const n = Number.parseInt(base.slice(1), 16);
  return composite(`rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`, under);
}

/** Every filter's hue, and a spread of sender hues ("From …" chips). */
const HUES = [
  ...Object.values(FILTER_HUES),
  ...["ana@example.com", "billing@shop.test", "noreply@bank.test", "zoe@x.io", "team@winnow.app", "q@q.q"].map(senderHue),
];

describe("the floating glass", () => {
  it("is light frost: the rim lets 30–45% of what is underneath through", () => {
    for (const scheme of MODES) {
      const { rim, text, textOn, fallback } = GLASS[scheme];
      expect(rim).toBeGreaterThanOrEqual(0.55);
      expect(rim).toBeLessThanOrEqual(0.7);
      // Raised only behind text, and never to opaque.
      expect(text).toBeGreaterThanOrEqual(rim);
      expect(textOn).toBeGreaterThanOrEqual(text);
      expect(textOn).toBeLessThan(0.9);
      // Without a blur there is nothing to read through, so the fallback is nearly solid.
      expect(fallback).toBeGreaterThan(textOn);
    }
  });

  for (const scheme of MODES) {
    const { pill, color } = PALETTES[scheme];

    it(`${scheme}: every chip label is AA over the worst backdrop`, () => {
      for (const spec of WORST_BACKDROPS[scheme]) {
        const under = backdrop(spec, scheme);
        for (const hue of HUES) {
          for (const on of [false, true]) {
            const fill = pillFill(hue, scheme, glassOver(scheme, on ? GLASS[scheme].textOn : GLASS[scheme].text, under), { on });
            const ink = color[on ? pill.inkOn : pill.ink];
            const count = color[pill.count];
            expect(contrastRatio(fill, ink), `${scheme} ${spec} h${hue.h} ${on ? "on" : "rest"}`).toBeGreaterThanOrEqual(4.5);
            expect(contrastRatio(fill, count), `${scheme} ${spec} h${hue.h} count`).toBeGreaterThanOrEqual(4.5);
          }
        }
      }
    });

    it(`${scheme}: the panel's rows and the dock's icons read over the worst backdrop`, () => {
      for (const spec of WORST_BACKDROPS[scheme]) {
        const plate = glassOver(scheme, GLASS[scheme].text, backdrop(spec, scheme));
        expect(contrastRatio(plate, color.inkBody), `${scheme} ${spec} row`).toBeGreaterThanOrEqual(4.5);
        // Icons are not text: 3:1 (WCAG 1.4.11).
        expect(contrastRatio(plate, color.inkMuted), `${scheme} ${spec} icon`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${scheme}: publishes its recipe as custom properties`, () => {
      const props = glassProperties(scheme, color);
      expect(props["--wn-glass-base"]).toBe(color[GLASS[scheme].base]);
      expect(props["--wn-glass-rim"]).toMatch(/^\d+%$/);
      expect(props["--wn-glass-text-on"]).toBe(`${Math.round(GLASS[scheme].textOn * 100)}%`);
    });
  }
});
