import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Mail } from "lucide-react";
import { ICON_SIZES, ICON_STROKE, Icon } from "./components/Icon";

describe("Icon", () => {
  it("offers four sizes and one stroke", () => {
    expect([...ICON_SIZES]).toEqual([12, 16, 20, 24]);
    expect(ICON_STROKE).toBe(2);
  });

  it("draws the glyph at its size with stroke 2, hidden from assistive tech by default", () => {
    const html = renderToStaticMarkup(createElement(Icon, { icon: Mail, size: 20, className: "text-ink" }));
    expect(html).toContain('width="20"');
    expect(html).toContain('height="20"');
    expect(html).toContain('stroke-width="2"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("text-ink");
  });

  it("defaults to the control size", () => {
    expect(renderToStaticMarkup(createElement(Icon, { icon: Mail }))).toContain('width="16"');
  });
});
