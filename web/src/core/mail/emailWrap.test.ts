import { describe, expect, it } from "vitest";
import { LONG_TOKEN, emailDocumentCss, inlineEmailCss, sanitizeMailHtml } from "./sanitize";

/**
 * STRM-318: a fluid newsletter (a `width:100%; max-width:640px` card with wide fixed
 * padding) drew its headline one word per line, split mid-word ("Decemb|er"), in a sliver
 * at the right of the phone reader. The baseline's `overflow-wrap: anywhere` on table cells
 * let every column shrink to a character, so nothing overflowed and the fit zoom never ran.
 * Words now stay whole in cells and headings; only a URL-length token may break anywhere.
 * The layout itself is checked in the browser by smoke-thumb ("reader: a fluid newsletter
 * with wide padding fits whole-word").
 */

const rule = (css: string, selector: RegExp) => css.split("\n").find((line) => selector.test(line)) ?? "";

describe("the email baseline keeps words whole", () => {
  for (const [name, css] of [
    ["inline reader", inlineEmailCss()],
    ["own document", emailDocumentCss()],
  ] as const) {
    it(`${name}: table cells break only an overflowing token`, () => {
      const cells = rule(css, /\btd, .*\bth \{/);
      expect(cells).toMatch(/overflow-wrap: break-word/);
      expect(cells).not.toMatch(/anywhere/);
      expect(cells).not.toMatch(/word-break: break-word/);
      expect(css).not.toMatch(/word-break: break-word/);
    });

    it(`${name}: headings never break mid-word`, () => {
      const headings = rule(css, /\bh1, .*\bh6 \{ overflow-wrap/);
      expect(headings).toMatch(/overflow-wrap: break-word; word-break: normal;/);
    });

    it(`${name}: only a marked long token wraps anywhere`, () => {
      const anywhere = css.split("\n").filter((line) => /anywhere/.test(line));
      expect(anywhere).toHaveLength(1);
      expect(anywhere[0]).toMatch(/\[data-wn-long\] \{/);
    });
  }
});

describe("markLongTokens", () => {
  const url = "resources.arc.net/hc/en-us/articles/44412972248471-Arc-Sunset-Key-Dates";

  it("is off by default: the text is untouched", () => {
    const out = sanitizeMailHtml(`<p>Read ${url} now</p>`).html;
    expect(out).toBe(`<p>Read ${url} now</p>`);
    expect(out).not.toMatch(/data-wn-long/);
  });

  it("wraps a token of LONG_TOKEN characters or more, and only that token", () => {
    const out = sanitizeMailHtml(`<td>Read the timeline at ${url}. Thanks</td>`, { markLongTokens: true }).html;
    expect(out).toContain(`Read the timeline at <span data-wn-long="">${url}.</span> Thanks`);
  });

  it("leaves words and tokens shorter than LONG_TOKEN alone, headlines included", () => {
    const headline = "We’ve decided to sunset Arc on December 22, 2026";
    const short = "x".repeat(LONG_TOKEN - 1);
    const out = sanitizeMailHtml(`<h1>${headline}</h1><p>${short}</p>`, { markLongTokens: true }).html;
    expect(out).not.toMatch(/data-wn-long/);
    expect(out).toContain(headline);
  });

  it("measures decoded text and keeps the token escaped inside the span", () => {
    const token = "a".repeat(LONG_TOKEN - 2) + "&amp;<";
    // 28 a's + & + < is 30 characters decoded, so it is marked.
    const out = sanitizeMailHtml(`<p>${token.replace("<", "&lt;")}</p>`, { markLongTokens: true }).html;
    expect(out).toBe(`<p><span data-wn-long="">${"a".repeat(LONG_TOKEN - 2)}&amp;&lt;</span></p>`);
  });

  it("splits on non-breaking spaces too, so a joined date is not one long token", () => {
    const out = sanitizeMailHtml("<h1>sunset Arc on December&nbsp;22,&nbsp;2026 and beyond the horizon</h1>", { markLongTokens: true }).html;
    expect(out).not.toMatch(/data-wn-long/);
  });

  it("never marks inside a dropped raw-text element", () => {
    const out = sanitizeMailHtml(`<style>.a{content:"${"z".repeat(40)}"}</style><p>ok</p>`, { markLongTokens: true }).html;
    expect(out).toBe("<p>ok</p>");
  });
});
