import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { AppMark } from "./AppMark";

describe("the app mark", () => {
  it("draws both planes by default, in the full artwork frame", () => {
    const svg = renderToStaticMarkup(createElement(AppMark, { size: 30 }));
    expect(svg.match(/<g/g)).toHaveLength(2);
    expect(svg).toContain('viewBox="0 0 512 512"');
    expect(svg).toContain('data-app-mark="pair"');
  });

  it("single: only the leading plane, framed square around it so it sits centred", () => {
    const svg = renderToStaticMarkup(createElement(AppMark, { size: 56, single: true }));
    expect(svg.match(/<g/g)).toHaveLength(1);
    expect(svg).toContain('data-plane="lead"');
    expect(svg).not.toContain("translate(-35.849192");
    const [x, y, w, h] = /viewBox="([^"]+)"/.exec(svg)![1].split(" ").map(Number);
    expect(w).toBe(h);
    // The lead plane's box is x 74–279, y 146–306: centred in the frame within a unit.
    expect(Math.abs(x + w / 2 - (74 + 279) / 2)).toBeLessThan(1.5);
    expect(Math.abs(y + h / 2 - (146 + 306) / 2)).toBeLessThan(1.5);
    expect(x).toBeLessThan(74);
    expect(x + w).toBeGreaterThan(279);
    expect(y).toBeLessThan(146);
    expect(y + h).toBeGreaterThan(306);
  });

  it("is single on the inbox-clear screen only; the app icon everywhere else keeps both planes", () => {
    const clear = readFileSync(new URL("./components/InboxClear.tsx", import.meta.url), "utf8");
    expect(clear).toMatch(/<AppMark size=\{\d+\} single \/>/);
    for (const file of ["Masthead", "PhoneChrome", "MailNav", "Reader"]) {
      const source = readFileSync(new URL(`./components/${file}.tsx`, import.meta.url), "utf8");
      expect(source, file).not.toMatch(/<AppMark[^>]*single/);
    }
  });
});
