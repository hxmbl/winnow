import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { GLASS, GLASS_BLUR, GLASS_REACH, WORST_BACKDROPS, blurRadius, glassProperties, reachCoversBlur } from "./glass";
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
      const { rim, text, textOn, bar, fallback } = GLASS[scheme];
      expect(rim).toBeGreaterThanOrEqual(0.55);
      expect(rim).toBeLessThanOrEqual(0.7);
      // Raised only behind text, and never to opaque.
      expect(text).toBeGreaterThanOrEqual(rim);
      expect(textOn).toBeGreaterThanOrEqual(text);
      expect(textOn).toBeLessThan(0.9);
      // The desktop's bars may sit higher than the chips' plates, never opaque.
      expect(bar).toBeGreaterThanOrEqual(text);
      expect(bar).toBeLessThan(0.9);
      // Without a blur there is nothing to read through, so the fallback is nearly solid.
      expect(fallback).toBeGreaterThan(textOn);
      expect(fallback).toBeGreaterThan(bar);
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

    it(`${scheme}: the desktop's floating top bar and selection bar read over the worst backdrop`, () => {
      for (const spec of WORST_BACKDROPS[scheme]) {
        const plate = glassOver(scheme, GLASS[scheme].bar, backdrop(spec, scheme));
        // The count ("12"), the list's name and the selection count, and the selection
        // bar's labels: text, so AA.
        expect(contrastRatio(plate, color.ink), `${scheme} ${spec} ink`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(plate, color.inkBody), `${scheme} ${spec} body`).toBeGreaterThanOrEqual(4.5);
        // "of 39" and the list's name are muted text, and still text.
        expect(contrastRatio(plate, color.inkMuted), `${scheme} ${spec} muted`).toBeGreaterThanOrEqual(4.5);
        // The prev/next chevrons and the rail's step buttons are icons: 3:1.
        expect(contrastRatio(plate, color.inkIcon), `${scheme} ${spec} icon`).toBeGreaterThanOrEqual(3);
        const stepPlate = glassOver(scheme, GLASS[scheme].text, backdrop(spec, scheme));
        expect(contrastRatio(stepPlate, color.inkIcon), `${scheme} ${spec} step`).toBeGreaterThanOrEqual(3);
      }
    });

    it(`${scheme}: the bar's own tint is the lowest that keeps "of 39" at AA (no darker than it needs)`, () => {
      // One step (2%) lower would fail somewhere, unless the bar is already at the
      // chips' text tint, which is the floor.
      const { bar, text } = GLASS[scheme];
      if (bar <= text) return;
      const lower = bar - 0.02;
      const worst = Math.min(
        ...WORST_BACKDROPS[scheme].map((spec) => contrastRatio(glassOver(scheme, lower, backdrop(spec, scheme)), color.inkMuted)),
      );
      expect(worst).toBeLessThan(4.5);
    });

    it(`${scheme}: publishes its recipe as custom properties`, () => {
      const props = glassProperties(scheme, color);
      expect(props["--wn-glass-base"]).toBe(color[GLASS[scheme].base]);
      expect(props["--wn-glass-rim"]).toMatch(/^\d+%$/);
      expect(props["--wn-glass-text-on"]).toBe(`${Math.round(GLASS[scheme].textOn * 100)}%`);
      expect(props["--wn-glass-bar"]).toBe(`${Math.round(GLASS[scheme].bar * 100)}%`);
    });
  }
});

describe("the frost layer reaches past each pill", () => {
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  const strip = readFileSync(new URL("./components/FilterStrip.tsx", import.meta.url), "utf8");

  it("reads the blur radius out of a filter", () => {
    expect(blurRadius(GLASS_BLUR)).toBe(22);
    expect(blurRadius("saturate(2)")).toBe(0);
    expect(blurRadius("blur( 8.5px ) saturate(1.2)")).toBe(8.5);
  });

  it("reaches at least two blur radii, so text across a thin pill is smeared, not just tinted", () => {
    expect(reachCoversBlur(GLASS_REACH, GLASS_BLUR)).toBe(true);
    expect(reachCoversBlur(20, GLASS_BLUR)).toBe(false);
  });

  it("is the same number in the stylesheet, the TypeScript and the chip rail's padding", () => {
    expect(css).toContain(`--wn-glass-filter: ${GLASS_BLUR};`);
    expect(css).toContain(`--wn-glass-reach: ${GLASS_REACH}px;`);
    // The rail takes back exactly the reach it pads itself by, touch and floating.
    expect(strip.match(new RegExp(`-my-\\[${GLASS_REACH}px\\]`, "g"))?.length).toBe(2);
  });

  it("puts the filter on the oversized ::before, clipped back to the pill, not on the pill", () => {
    const before = /\.wn-glass:not\(\.wn-sidebar-panel\)::before,\s*\.wn-pill\.wn-chip-glass::before\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    // The full reach on every side, sideways too: a chip's rounded ends need it as much
    // as its middle does.
    expect(before).toMatch(/inset:\s*calc\(-1 \* var\(--wn-glass-reach\)\);/);
    expect(before).toMatch(/backdrop-filter:\s*var\(--wn-glass-filter\)/);
    // Clipped back to the pill's own rounded shape on every side, chips included.
    expect(before).toMatch(/clip-path:\s*inset\(var\(--wn-glass-reach\) round var\(--wn-glass-radius, 9999px\)\);/);
    expect(before).toMatch(/z-index:\s*-1/);
    // The chip's own rule no longer carries a backdrop-filter: it would make the chip a
    // backdrop root, and its frost layer would see nothing.
    const chip = /\.wn-pill\.wn-chip-glass \{\s*--wn-chip-frost[^}]*\}/.exec(css)?.[0] ?? "";
    expect(chip).not.toMatch(/backdrop-filter/);
  });

  it("never lengthens the chip rail's scroll, nor widens the page: the rail's end padding holds the reach, and the chrome clips it sideways", () => {
    expect(css).not.toMatch(/--wn-glass-reach-x/);
    // Touch and floating, the rail's end padding is at least the reach.
    expect(strip).toContain("pr-[max(var(--wn-dock-right),var(--wn-glass-reach))]");
    expect(strip).toContain("pr-[var(--wn-glass-reach)]");
    const clipped = /((?:\[data-[a-z-]+\],?\s*)+)\{\s*overflow-x:\s*clip;/.exec(css)?.[1] ?? "";
    for (const chrome of ["[data-phone-chrome]", "[data-phone-dock]", "[data-list-chrome]", "[data-sticky-day]", "[data-pull-indicator]"]) {
      expect(clipped).toContain(chrome);
    }
  });

  it("frosts each chip on its own: no band joining them, only an untinted, edgeless haze in the gaps", () => {
    // 1.3.3: the old one-band frost (layers bridging the gaps) showed as a filled strip.
    expect(css).not.toMatch(/--wn-glass-join-(start|end)/);
    expect(css).not.toMatch(/--wn-glass-corners/);
    const haze = /\.wn-rail-haze::before\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(haze).toMatch(/backdrop-filter:\s*blur\([1-8]px\);/);
    // A blur only: no saturate or brightness, no fill, no hairline, and faded at both edges.
    expect(haze).not.toMatch(/saturate|brightness|background|border|box-shadow/);
    expect(haze).toMatch(/mask-image:\s*linear-gradient\(to bottom, transparent,[^;]*transparent\);/);
    expect(haze).toMatch(/z-index:\s*-1/);
    // On the phone rail, the one place chips float over the list.
    const phone = readFileSync(new URL("./components/PhoneChrome.tsx", import.meta.url), "utf8");
    expect(phone).toMatch(/data-phone-chips=""[\s\S]{0,200}wn-rail-haze/);
  });

  it("never puts a filter on a glass pill (hover is a sheen), which would cut its frost off", () => {
    expect(css).not.toMatch(/\.wn-chip-glass:hover\s*\{[^}]*\bfilter:/);
  });
});

describe("a held chip stays a pill (1.3.3)", () => {
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** Every rule whose selector names a pressed chip, with its declarations. */
  const pressedChipRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    // `:not([data-rail-item])` is the exclusion from the shared press scale, not a chip.
    .filter(([, selector]) =>
      /(wn-chip-glass|(?<!:not\()\[data-rail-item\])[^,{]*:active|wn-chip-glass[^,{]*:has\(> button:active\)/.test(selector),
    )
    .map(([, selector, body]) => ({ selector: selector.trim(), body }));

  it("no press rule scales or reshapes a smart-filter chip", () => {
    expect(pressedChipRules.length).toBeGreaterThan(0);
    for (const rule of pressedChipRules) {
      expect(rule.body, rule.selector).not.toMatch(/transform:\s*scale|border-radius|clip-path/);
    }
  });

  it("the shared glass press scale excludes the rail's items", () => {
    // The shared glass press (other controls, like back-to-top, keep their own scale).
    const scale = [...css.matchAll(/([^{}]+)\{\s*transform:\s*scale\(0\.97\);?\s*\}/g)]
      .map(([, selector]) => selector)
      .filter((selector) => /wn-glass|wn-chip-glass/.test(selector));
    expect(scale.length).toBeGreaterThan(0);
    for (const selector of scale) {
      expect(selector).not.toMatch(/\.wn-pill\.wn-chip-glass:active/);
      expect(selector).toMatch(/button\.wn-glass:not\(\[data-rail-item\]\):active/);
    }
  });

  it("the browser's square tap highlight is off on the chips", () => {
    expect(css).toMatch(/\.wn-rail-scroller \*,[\s\S]{0,60}-webkit-tap-highlight-color: transparent/);
  });
});
