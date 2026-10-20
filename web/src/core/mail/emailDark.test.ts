import { describe, expect, it } from "vitest";
import {
  AA,
  DARK_EMAIL_PALETTE,
  OLED_EMAIL_PALETTE,
  contrast,
  detectOwnDarkStyles,
  emailDarkMode,
  formatColor,
  mapBackground,
  mapBorder,
  mapText,
  parseColor,
  recolourAttribute,
  recolourDeclarations,
  toOklch,
  type Rgba,
} from "./emailDark";

const c = (value: string): Rgba => {
  const parsed = parseColor(value);
  if (!parsed) throw new Error(`not a colour: ${value}`);
  return parsed;
};
const hueDistance = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const PALETTES = [
  ["dark", DARK_EMAIL_PALETTE],
  ["oled", OLED_EMAIL_PALETTE],
] as const;

describe("parseColor / formatColor", () => {
  it("reads the forms mail uses", () => {
    expect(formatColor(c("#fff"))).toBe("#ffffff");
    expect(formatColor(c("#1A5FB4"))).toBe("#1a5fb4");
    expect(formatColor(c("rgb(26, 95, 180)"))).toBe("#1a5fb4");
    expect(formatColor(c("rgb(26 95 180 / 50%)"))).toBe("rgba(26, 95, 180, 0.5)");
    expect(formatColor(c("hsl(0, 0%, 100%)"))).toBe("#ffffff");
    expect(formatColor(c("White"))).toBe("#ffffff");
    expect(c("#ffffff80").a).toBeCloseTo(0.502, 2);
  });
  it("refuses what is not a concrete colour", () => {
    for (const value of ["transparent", "inherit", "currentColor", "#12345", "rgb(1,2)", "url(x)", "var(--x)"]) {
      expect(parseColor(value)).toBeNull();
    }
  });
});

describe.each(PALETTES)("the mapping on %s", (_name, palette) => {
  const surface = c(palette.surface);

  it("white paper becomes the theme surface, and light greys a visible step above it", () => {
    expect(formatColor(mapBackground(c("#ffffff"), palette))).toBe(palette.surface.toLowerCase());
    const grey = toOklch(mapBackground(c("#F4F6F8"), palette)).l;
    expect(grey).toBeGreaterThan(toOklch(surface).l + 0.03);
    expect(grey).toBeLessThan(0.47);
  });

  it("keeps dark backgrounds as the sender wrote them", () => {
    for (const bg of ["#101828", "#333333", "#0B5394", "#000000"]) {
      expect(formatColor(mapBackground(c(bg), palette))).toBe(formatColor(c(bg)));
    }
  });

  it("keeps a brand background's hue and drops it to where light text reads", () => {
    for (const bg of ["#6C9CFD", "#FFC107", "#4CAF50", "#E91E63"]) {
      const before = toOklch(c(bg));
      const after = toOklch(mapBackground(c(bg), palette));
      expect(hueDistance(before.h, after.h)).toBeLessThan(4);
      expect(after.l).toBeLessThanOrEqual(0.481);
      expect(contrast(c(palette.ink), mapBackground(c(bg), palette))).toBeGreaterThanOrEqual(AA);
    }
  });

  it("flips dark text to light ink, keeping the sender's grey hierarchy", () => {
    const black = toOklch(mapText(c("#000000"), palette)).l;
    const dim = toOklch(mapText(c("#333333"), palette)).l;
    const grey = toOklch(mapText(c("#777777"), palette)).l;
    expect(black).toBeGreaterThan(dim);
    expect(dim).toBeGreaterThan(grey);
  });

  it("holds every text colour to AA on the surface, hue kept", () => {
    const inks = ["#000000", "#15181D", "#333333", "#56616B", "#7A838C", "#999999", "#1A5FB4", "#1F3F7A",
      "#16305C", "#C62828", "#2E7D32", "#6A1B9A", "#E65100", "#0000FF", "#FF0000", "#FFFFFF", "#CCCCCC"];
    for (const ink of inks) {
      const out = mapText(c(ink), palette);
      expect(contrast(out, surface), ink).toBeGreaterThanOrEqual(AA);
      const before = toOklch(c(ink));
      if (before.c > 0.05) expect(hueDistance(before.h, toOklch(out).h), ink).toBeLessThan(12);
    }
  });

  it("holds paired text to AA on its own recoloured background too", () => {
    for (const [ink, bg] of [["#000000", "#FFC107"], ["#16305C", "#6C9CFD"], ["#333", "#EEEEEE"], ["#fff", "#1a73e8"]]) {
      const ground = mapBackground(c(bg), palette);
      const out = mapText(c(ink), palette, [ground]);
      expect(contrast(out, ground), `${ink} on ${bg}`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("keeps a light border visible but dark", () => {
    const border = mapBorder(c("#E4E7E9"), palette);
    expect(toOklch(border).l).toBeGreaterThan(toOklch(surface).l + 0.05);
    expect(toOklch(border).l).toBeLessThan(0.56);
  });
});

describe("recolourDeclarations", () => {
  const p = DARK_EMAIL_PALETTE;

  it("recolours colour, background and border colours, and nothing else", () => {
    const out = recolourDeclarations("color:#333;background:#FFFFFF;border:1px solid #E4E7E9;font-size:12px;width:640px", p);
    expect(out).toMatch(/color:#[0-9a-f]{6}/);
    expect(out).toContain(`background:${p.surface.toLowerCase()}`);
    expect(out).not.toContain("#E4E7E9");
    expect(out).toContain("font-size:12px;width:640px");
    const text = /(?:^|;)color:(#[0-9a-f]{6})/.exec(out)?.[1] ?? "";
    expect(contrast(c(text), c(p.surface))).toBeGreaterThanOrEqual(AA);
  });

  it("pairs a text colour with the background in the same block", () => {
    const out = recolourDeclarations("background-color:#FFC107;color:#000000 !important", p);
    const bg = /background-color:(#[0-9a-f]{6})/.exec(out)?.[1] ?? "";
    const text = /(?:^|;)color:(#[0-9a-f]{6})/.exec(out)?.[1] ?? "";
    expect(contrast(c(text), c(bg))).toBeGreaterThanOrEqual(AA);
    expect(out).toContain("!important");
  });

  it("recolours every stop of a gradient", () => {
    const out = recolourDeclarations("background-image:linear-gradient(#ffffff, #f0f0f0)", p);
    expect(out).not.toMatch(/#ffffff|#f0f0f0/i);
  });

  it("never touches a url(), even one whose base64 spells a colour name", () => {
    const value = "background:url(data:image/png;base64,ab/red+white/xyz) #ffffff no-repeat";
    const out = recolourDeclarations(value, p);
    expect(out).toContain("url(data:image/png;base64,ab/red+white/xyz)");
    expect(out).toContain(p.surface.toLowerCase());
  });

  it("leaves transparent, inherit and custom properties alone", () => {
    const value = "color:inherit;background:transparent;border-color:currentColor";
    expect(recolourDeclarations(value, p)).toBe(value);
  });

  it("recolours the legacy attributes, hashless bgcolor included", () => {
    expect(recolourAttribute("#ffffff", "background", p)).toBe(p.surface.toLowerCase());
    expect(recolourAttribute("ffffff", "background", p)).toBe(p.surface.toLowerCase());
    expect(recolourAttribute("not a colour", "background", p)).toBe("not a colour");
  });
});

describe("own dark styles", () => {
  it("finds a prefers-color-scheme block, Outlook's hooks, and the color-scheme meta", () => {
    expect(detectOwnDarkStyles("", ["@media (prefers-color-scheme: dark) { .x { color: #fff } }"]).mediaQuery).toBe(true);
    expect(detectOwnDarkStyles("", ["[data-ogsc] .x { color: #fff }"]).outlookHooks).toBe(true);
    expect(detectOwnDarkStyles('<meta name="color-scheme" content="light dark">', []).declaresDark).toBe(true);
    expect(detectOwnDarkStyles('<meta name="supported-color-schemes" content="light dark">', []).declaresDark).toBe(true);
    expect(detectOwnDarkStyles("", [":root { color-scheme: light dark; }"]).declaresDark).toBe(true);
    const none = detectOwnDarkStyles('<meta name="color-scheme" content="light">', ["@media (max-width: 600px) { .x { color: red } }"]);
    expect(none).toEqual({ mediaQuery: false, outlookHooks: false, declaresDark: false });
  });

  it("honours a message's own dark rules, adapts everything else, and does nothing when off", () => {
    expect(emailDarkMode(true, { mediaQuery: true, outlookHooks: false, declaresDark: true })).toBe("own");
    expect(emailDarkMode(true, { mediaQuery: false, outlookHooks: true, declaresDark: false })).toBe("adaptive");
    expect(emailDarkMode(true, { mediaQuery: false, outlookHooks: false, declaresDark: true })).toBe("adaptive");
    expect(emailDarkMode(false, { mediaQuery: true, outlookHooks: false, declaresDark: true })).toBe("off");
  });
});
