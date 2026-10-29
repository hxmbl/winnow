import { describe, expect, it } from "vitest";
import {
  RING_CONTRAST,
  adjustForContrast,
  contrastRatio,
  dominantColor,
  ringColor,
  isColourful,
  parseHex,
  planesOf,
  rgbToHsl,
  type Rgb,
} from "./ringColor";
import { MODES } from "./theme";
import { circleOnly } from "./pictureCapture";

/** RGBA bytes for `count` pixels of each colour, in order. */
function pixels(...runs: [Rgb, number, number?][]): Uint8ClampedArray {
  const total = runs.reduce((n, [, count]) => n + count, 0);
  const out = new Uint8ClampedArray(total * 4);
  let i = 0;
  for (const [{ r, g, b }, count, alpha = 255] of runs) {
    for (let k = 0; k < count; k++) {
      out.set([r, g, b, alpha], i);
      i += 4;
    }
  }
  return out;
}

const WHITE = { r: 255, g: 255, b: 255 };
const BLACK = { r: 0, g: 0, b: 0 };
const GREY = { r: 128, g: 130, b: 129 };
const BLUE = { r: 30, g: 90, b: 200 };
const ORANGE = { r: 230, g: 120, b: 30 };
const PALE_YELLOW = { r: 250, g: 240, b: 150 };

describe("the halo's colour from the profile picture", () => {
  it("picks the colour that covers most of the picture", () => {
    expect(dominantColor(pixels([BLUE, 600], [ORANGE, 300]))).toBe("#1E5AC8");
    expect(dominantColor(pixels([BLUE, 200], [ORANGE, 500]))).toBe("#E6781E");
  });

  it("ignores near-white, near-black and grey pixels when choosing", () => {
    // A portrait on a white wall with dark hair: the small blue jumper still wins.
    expect(dominantColor(pixels([WHITE, 2000], [BLACK, 900], [GREY, 700], [BLUE, 400]))).toBe("#1E5AC8");
    expect(isColourful(WHITE)).toBe(false);
    expect(isColourful(BLACK)).toBe(false);
    expect(isColourful(GREY)).toBe(false);
    expect(isColourful({ r: 248, g: 246, b: 240 })).toBe(false);
    expect(isColourful(BLUE)).toBe(true);
  });

  it("ignores see-through pixels", () => {
    expect(dominantColor(pixels([ORANGE, 900, 0], [BLUE, 100]))).toBe("#1E5AC8");
  });

  it("averages the winning bin, so shades of one colour make one colour", () => {
    const a = { r: 200, g: 40, b: 40 };
    const b = { r: 220, g: 60, b: 50 };
    expect(dominantColor(pixels([a, 100], [b, 100], [BLUE, 150]))).toBe("#D2322D");
  });

  it("has no colour for a black-and-white or almost colourless picture", () => {
    expect(dominantColor(pixels([WHITE, 500], [BLACK, 500], [GREY, 500]))).toBeNull();
    // Under 4% colour is noise, not the picture's colour.
    expect(dominantColor(pixels([GREY, 990], [ORANGE, 10]))).toBeNull();
    expect(dominantColor(new Uint8ClampedArray(0))).toBeNull();
    expect(dominantColor(pixels([BLUE, 50, 0]))).toBeNull();
  });

  it("only counts what the round avatar shows", () => {
    const size = 8;
    const square = new Uint8ClampedArray(size * size * 4).fill(255);
    const round = circleOnly(square, size);
    expect(round[3]).toBe(0); // the top-left corner
    expect(round[((size / 2) * size + size / 2) * 4 + 3]).toBe(255); // the middle
  });
});

describe("the halo's contrast", () => {
  it("reaches 3:1 against every plane in light, dark and OLED", () => {
    for (const scheme of MODES) {
      const planes = planesOf(scheme);
      expect(planes.length).toBeGreaterThan(3);
      for (const colour of ["#1E5AC8", "#E6781E", "#FAF096", "#2A0A40", "#10C060", "#FF00FF"]) {
        const halo = ringColor(colour, scheme)!;
        const rgb = parseHex(halo)!;
        for (const plane of planes) expect(contrastRatio(rgb, plane)).toBeGreaterThanOrEqual(RING_CONTRAST);
      }
    }
  });

  it("darkens on light planes and lightens on dark ones, keeping the hue", () => {
    const light = parseHex(ringColor("#FAF096", "light")!)!;
    const dark = parseHex(ringColor("#2A0A40", "oled")!)!;
    expect(rgbToHsl(light).l).toBeLessThan(rgbToHsl(PALE_YELLOW).l);
    expect(rgbToHsl(dark).l).toBeGreaterThan(rgbToHsl(parseHex("#2A0A40")!).l);
    expect(Math.abs(rgbToHsl(light).h - rgbToHsl(PALE_YELLOW).h)).toBeLessThan(4);
    expect(Math.abs(rgbToHsl(dark).h - rgbToHsl(parseHex("#2A0A40")!).h)).toBeLessThan(4);
  });

  it("leaves a colour that already passes as it is", () => {
    const planes = planesOf("light");
    const navy = { r: 20, g: 40, b: 120 };
    expect(adjustForContrast(navy, planes)).toEqual(navy);
  });

  it("is the smallest move that passes", () => {
    const planes = planesOf("dark");
    const adjusted = adjustForContrast(parseHex("#1E5AC8")!, planes);
    const worst = Math.min(...planes.map((plane) => contrastRatio(adjusted, plane)));
    expect(worst).toBeGreaterThanOrEqual(RING_CONTRAST);
    expect(worst).toBeLessThan(RING_CONTRAST + 0.3);
  });

  it("falls back (null) with no picture colour", () => {
    expect(ringColor(undefined, "light")).toBeNull();
    expect(ringColor(null, "dark")).toBeNull();
    expect(ringColor("blue", "dark")).toBeNull();
  });
});
