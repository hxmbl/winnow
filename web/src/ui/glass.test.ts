import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { COMPOSE_SHEEN, COMPOSE_TINT, GLASS, GLASS_BLUR, LIQUID, LIQUID_FILTER, SOLID_BACKDROPS, WASH, WORST_BACKDROPS, blurRadius, glassProperties, liquidMaxBend } from "./glass";
import { FILTER_HUES, senderHue } from "./filterColors";
import { ACCENTS, MODES, PALETTES, composite, contrastRatio, paletteFor, pillFill, type ThemeName } from "./theme";

/** A worst backdrop as an opaque colour: `white`/`black` solid, `white@0.6` over the list. */
function backdrop(spec: string, scheme: ThemeName): string {
  const [colour, share = "1"] = spec.split("@");
  if (colour.startsWith("#")) return colour;
  const hex = colour === "white" ? "255, 255, 255" : "0, 0, 0";
  return composite(`rgba(${hex}, ${share})`, PALETTES[scheme].color.surface);
}

/** Liquid Glass's sheen (and glow) at full strength, white over a plate. */
function withSheen(plate: string, white: number): string {
  return composite(`rgba(255, 255, 255, ${white})`, plate);
}

/** A plate without and with the liquid sheen: the text has to read on both. */
function plates(plate: string, scheme: ThemeName): string[] {
  return [plate, withSheen(plate, LIQUID[scheme].sheen + LIQUID[scheme].glow)];
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
            const base = pillFill(hue, scheme, glassOver(scheme, on ? GLASS[scheme].textOn : GLASS[scheme].text, under), { on });
            const ink = color[on ? pill.inkOn : pill.ink];
            const count = color[pill.count];
            // The chips are Liquid Glass: the label reads with the sheen over it and without.
            for (const fill of plates(base, scheme)) {
              expect(contrastRatio(fill, ink), `${scheme} ${spec} h${hue.h} ${on ? "on" : "rest"}`).toBeGreaterThanOrEqual(4.5);
              expect(contrastRatio(fill, count), `${scheme} ${spec} h${hue.h} count`).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      }
    });

    it(`${scheme}: the panel's rows and the dock's icons read over the worst backdrop`, () => {
      for (const spec of WORST_BACKDROPS[scheme]) {
        for (const plate of plates(glassOver(scheme, GLASS[scheme].text, backdrop(spec, scheme)), scheme)) {
          expect(contrastRatio(plate, color.inkBody), `${scheme} ${spec} row`).toBeGreaterThanOrEqual(4.5);
          // Icons are not text: 3:1 (WCAG 1.4.11).
          expect(contrastRatio(plate, color.inkMuted), `${scheme} ${spec} icon`).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it(`${scheme}: the reader pill, over a message, keeps its icons at 3:1 over a solid photo`, () => {
      for (const spec of SOLID_BACKDROPS) {
        for (const plate of plates(glassOver(scheme, GLASS[scheme].bar, backdrop(spec, scheme)), scheme)) {
          expect(contrastRatio(plate, color.inkIcon), `${scheme} ${spec} icon`).toBeGreaterThanOrEqual(3);
          expect(contrastRatio(plate, color.inkMuted), `${scheme} ${spec} muted icon`).toBeGreaterThanOrEqual(3);
        }
      }
    });

    it(`${scheme}: the desktop's floating top bar and selection bar read over the worst backdrop`, () => {
      for (const spec of WORST_BACKDROPS[scheme]) {
        for (const plate of plates(glassOver(scheme, GLASS[scheme].bar, backdrop(spec, scheme)), scheme)) {
        // The count ("12"), the list's name and the selection count, and the selection
        // bar's labels: text, so AA.
        expect(contrastRatio(plate, color.ink), `${scheme} ${spec} ink`).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(plate, color.inkBody), `${scheme} ${spec} body`).toBeGreaterThanOrEqual(4.5);
        // "of 39" and the list's name are muted text, and still text.
        expect(contrastRatio(plate, color.inkMuted), `${scheme} ${spec} muted`).toBeGreaterThanOrEqual(4.5);
        // The prev/next chevrons and the rail's step buttons are icons: 3:1.
        expect(contrastRatio(plate, color.inkIcon), `${scheme} ${spec} icon`).toBeGreaterThanOrEqual(3);
        }
        for (const stepPlate of plates(glassOver(scheme, GLASS[scheme].text, backdrop(spec, scheme)), scheme)) {
          expect(contrastRatio(stepPlate, color.inkIcon), `${scheme} ${spec} step`).toBeGreaterThanOrEqual(3);
        }
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

describe("one lean glass: the frost on the element itself (1.4)", () => {
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  const strip = readFileSync(new URL("./components/FilterStrip.tsx", import.meta.url), "utf8");

  it("reads the blur radius out of a filter", () => {
    expect(blurRadius(GLASS_BLUR)).toBe(6);
    expect(blurRadius("saturate(2)")).toBe(0);
    expect(blurRadius("blur( 8.5px ) saturate(1.2)")).toBe(8.5);
  });

  it("is a light frost, the same number in the stylesheet and the TypeScript", () => {
    expect(blurRadius(GLASS_BLUR)).toBeGreaterThan(0);
    expect(blurRadius(GLASS_BLUR)).toBeLessThanOrEqual(8);
    expect(css).toContain(`--wn-glass-filter: ${GLASS_BLUR};`);
  });

  it("puts the backdrop-filter straight on the glass and the chips, with no oversized frost layer", () => {
    const rule = /\.wn-glass,\s*\.wn-pill\.wn-chip-glass\s*\{\s*-webkit-backdrop-filter:\s*var\(--wn-glass-filter\);\s*backdrop-filter:\s*var\(--wn-glass-filter\);\s*\}/;
    expect(css).toMatch(rule);
    // The 1.2.3–1.3.4 machinery is gone: no reach, no ::before frost, no clip back to the pill.
    expect(css).not.toMatch(/--wn-glass-reach/);
    expect(css).not.toMatch(/\.wn-glass[^,{]*::before/);
    expect(css).not.toMatch(/\.wn-chip-glass[^,{]*::before/);
    expect(css).not.toMatch(/clip-path:\s*inset\(var\(--wn-glass/);
    expect(strip).not.toMatch(/glass-reach|-my-\[44px\]/);
  });

  it("no longer clips the floating chrome sideways: that only held the reach layer in", () => {
    expect(css).not.toMatch(/overflow-x:\s*clip/);
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

  it("keeps the desktop sidebar's progressive blur, the other deliberate outlier", () => {
    expect(css).toMatch(/\.wn-sidebar-blur/);
  });

  it("never puts a filter on a glass pill (hover is a sheen), which would cut its frost off", () => {
    expect(css).not.toMatch(/\.wn-chip-glass:hover\s*\{[^}]*\bfilter:/);
  });

  it("drops the frost and the sheen under reduced transparency and forced colours", () => {
    const reduced = /@media \(prefers-reduced-transparency: reduce\) \{\s*\.wn-liquid::after \{\s*display: none;[\s\S]*?backdrop-filter: none !important;/.exec(css);
    expect(reduced).not.toBeNull();
    const forced = /@media \(forced-colors: active\) \{\s*\.wn-liquid::after \{\s*display: none;[\s\S]*?background: Canvas;/.exec(css);
    expect(forced).not.toBeNull();
  });
});

describe("Liquid Glass on the floating chrome (1.4)", () => {
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");
  const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  const read = (name: string) => readFileSync(new URL(`./components/${name}`, import.meta.url), "utf8");

  it("is on the dock pill, compose, the chips and All, the reader pill, the desktop top bar and the status pill", () => {
    expect(read("PhoneChrome.tsx")).toMatch(/wn-glass wn-liquid grid h-\[var\(--wn-dock-h\)\]/);
    expect(read("ComposeFab.tsx")).toMatch(/wn-liquid wn-liquid-accent/);
    expect(read("FilterStrip.tsx")).toContain('"wn-chip-glass wn-liquid"');
    expect(read("FilterStrip.tsx").match(/wn-glass wn-liquid h-/g)?.length).toBe(2);
    expect(read("Reader.tsx")).toMatch(/wn-glass wn-liquid wn-reader-pill/);
    expect(read("Masthead.tsx")).toMatch(/wn-glass wn-glass-bar wn-liquid/);
    expect(read("StatusPill.tsx")).toMatch(/wn-glass wn-glass-bar wn-liquid/);
  });

  it("leaves the large panels lean: the phone's menu panel and the sheets", () => {
    expect(read("MailNav.tsx")).not.toMatch(/wn-liquid/);
    expect(read("Overlay.tsx")).not.toMatch(/wn-liquid/);
    expect(read("MailNav.tsx")).toMatch(/touch \? "wn-glass"/);
  });

  it("keeps the glass's tint (and so its AA arithmetic): it never sets a background of its own", () => {
    // Apple's native material, in its own guard, is the one place the tint gives way.
    const plain = css.replace(/@supports \(-apple-visual-effect[\s\S]*?\n\}/g, "");
    const own = [...plain.matchAll(/(^|\n)([^{}\n]*\.wn-liquid(?!-accent)[^{}]*)\{([^{}]*)\}/g)]
      .filter(([, , selector]) => !/::after|\.wn-pill/.test(selector) && !/^\s*@/.test(selector));
    expect(own.length).toBeGreaterThan(0);
    for (const [, , selector, body] of own) expect(body, selector).not.toMatch(/(^|[^-])background(-color)?:/);
  });

  it("pins the reader pill, which floats over a message, to the bars' higher tint", () => {
    expect(css).toMatch(/\.wn-reader-pill \{\s*(\/\*[^*]*\*\/\s*)?--wn-glass-text: var\(--wn-glass-bar, 80%\);/);
  });

  it("refracts only in Chromium, after the light frost, and names the filter that is in index.html", () => {
    const block = /@supports \(backdrop-filter: url\(#wn-liquid\)\) and \(not \(-moz-appearance: none\)\) and \(not \(font: -apple-system-body\)\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block).toMatch(/backdrop-filter:\s*var\(--wn-glass-filter\) url\(#wn-liquid\);/);
    expect(html.match(/<filter id="wn-liquid"/g)?.length).toBe(1);
  });

  it("keeps Apple's native material as a guarded progressive enhancement", () => {
    expect(css).toMatch(
      /@supports \(-apple-visual-effect: -apple-system-glass-material\) \{\s*\.wn-glass,\s*\.wn-liquid \{\s*-apple-visual-effect: -apple-system-glass-material;\s*background: transparent;\s*-webkit-backdrop-filter: none;\s*backdrop-filter: none;\s*box-shadow: var\(--wn-glass-lift\);\s*\}\s*\.wn-liquid::after \{ display: none; \}\s*\}/,
    );
    // Nothing outside that guard names the property.
    const outside = css.replace(/@supports \(-apple-visual-effect[\s\S]*?\n\}/g, "");
    expect(outside).not.toMatch(/-apple-visual-effect:\s*-apple/);
  });

  describe("the refraction's edge map", () => {
    const filter = /<filter id="wn-liquid"([^>]*)>([\s\S]*?)<\/filter>/.exec(html);
    const attrs = filter?.[1] ?? "";
    const body = filter?.[2] ?? "";

    it("is built in px from the glass's own box, not an image stretched to it", () => {
      // objectBoundingBox scaled the bend by the box's width on both axes in Chromium.
      expect(attrs).not.toMatch(/primitiveUnits="objectBoundingBox"/);
      expect(body).not.toMatch(/<feImage/);
      expect(body).toMatch(/<feComposite in="white" in2="SourceAlpha" operator="in" result="box" \/>/);
    });

    it("softens and differentiates the edge by the numbers in glass.ts, inward on every side", () => {
      const { softness, edge, gain } = LIQUID_FILTER;
      expect(body).toContain(`stdDeviation="${softness} 0" edgeMode="none"`);
      expect(body).toContain(`stdDeviation="0 ${softness}" edgeMode="none"`);
      // dx = -edge samples A(x + edge): positive at the left edge (pull right, inward),
      // negative at the right edge (pull left, inward).
      expect(body).toMatch(new RegExp(`<feOffset in="softX" dx="-${edge}" result="toLeft" />`));
      expect(body).toMatch(new RegExp(`<feOffset in="softX" dx="${edge}" result="toRight" />`));
      expect(body).toMatch(new RegExp(`in="toLeft" in2="toRight" operator="arithmetic" k2="${gain}" k3="-${gain}" k4="0.5"`));
      expect(body).toMatch(new RegExp(`in="toTop" in2="toBottom" operator="arithmetic" k2="${gain}" k3="-${gain}" k4="0.5"`));
    });

    it("splits the bend per colour channel by `fringe`, and bends at most a few px", () => {
      const scales = [...body.matchAll(/<feDisplacementMap[^>]*scale="([\d.]+)"/g)].map(([, n]) => Number(n));
      expect(scales).toEqual([...LIQUID_FILTER.fringe]);
      expect(liquidMaxBend()).toBeGreaterThanOrEqual(4);
      expect(liquidMaxBend()).toBeLessThanOrEqual(10);
    });
  });

  for (const scheme of MODES) {
    it(`${scheme}: the rim, glow and sheen are published, and the sheen is faint where the ink is light`, () => {
      const props = glassProperties(scheme, PALETTES[scheme].color);
      expect(props["--wn-liquid-sheen"]).toBe(`${Math.round(LIQUID[scheme].sheen * 100)}%`);
      expect(props["--wn-liquid-rim-light"]).toMatch(/^\d+%$/);
      // Light ink has no contrast to spare: in the dark modes the liquid look is the rim
      // and the bend, with no white over the words.
      if (scheme !== "light") expect(LIQUID[scheme].sheen + LIQUID[scheme].glow).toBe(0);
    });
  }
});

describe("the compose circle's liquid accent", () => {
  for (const scheme of MODES) {
    for (const accent of Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]) {
      it(`${scheme} ${accent}: its icon keeps 3:1 over black and white`, () => {
        const { color } = paletteFor(scheme, accent);
        const n = Number.parseInt(color.accent.slice(1), 16);
        const tint = `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${COMPOSE_TINT})`;
        for (const under of ["#000000", "#FFFFFF"]) {
          const fill = withSheen(composite(tint, under), COMPOSE_SHEEN);
          expect(contrastRatio(fill, color.onAccent), `${under}`).toBeGreaterThanOrEqual(3);
        }
      });
    }
  }
});

describe("the accent's wash behind the list (1.4)", () => {
  const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

  it("is two radial glows of the accent over the surface, off under reduced transparency and forced colours", () => {
    const rule = /\.wn-backdrop \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/background-color:\s*var\(--wn-surface\)/);
    expect(rule.match(/radial-gradient\([^;]*?var\(--wn-accent\) var\(--wn-wash-(near|far)/g)?.length).toBe(2);
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\), \(forced-colors: active\) \{\s*\.wn-backdrop \{\s*background-image: none;/);
  });

  it("is on the list's pane and the pinned day, and the scroller and day headers are see-through", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    const list = readFileSync(new URL("./components/MessageList.tsx", import.meta.url), "utf8");
    expect(app).toMatch(/wn-backdrop relative min-h-0 min-w-0 flex-1 flex-col/);
    expect(list).toMatch(/data-sticky-day="" className="wn-backdrop/);
    expect(list).not.toMatch(/overflow-y-auto overscroll-contain bg-surface/);
    expect(list).not.toMatch(/gap-2 bg-surface pb-1 pl-\[68px\]/);
  });

  for (const scheme of MODES) {
    it(`${scheme}: OLED stays near black, and the wash is faint everywhere`, () => {
      const { near, far } = WASH[scheme];
      expect(near).toBeGreaterThan(0);
      expect(far).toBeGreaterThan(0);
      expect(Math.max(near, far)).toBeLessThanOrEqual(scheme === "oled" ? 0.1 : 0.16);
    });

    for (const accent of Object.keys(ACCENTS) as (keyof typeof ACCENTS)[]) {
      it(`${scheme} ${accent}: every row ink keeps AA on the washed surface at its strongest`, () => {
        const { color } = paletteFor(scheme, accent);
        const n = Number.parseInt(color.accent.slice(1), 16);
        const peak = Math.max(WASH[scheme].near, WASH[scheme].far);
        const washed = composite(`rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${peak})`, color.surface);
        for (const ink of ["ink", "inkBody", "inkMuted", "inkSubtle"] as const) {
          expect(contrastRatio(washed, color[ink]), ink).toBeGreaterThanOrEqual(4.5);
        }
        // And the wash is really there: a visible step off the plain surface, in the accent's direction.
        expect(washed).not.toBe(composite("rgba(0, 0, 0, 0)", color.surface));
      });
    }
  }
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
