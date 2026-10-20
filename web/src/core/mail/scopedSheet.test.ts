import { describe, expect, it } from "vitest";
import { sanitizeMailHtml } from "./sanitize";
import { MAX_SCOPED_CSS, scopeSelector, scopeSenderCss, sheetScope, unwrapDarkQuery } from "./scopedSheet";
import { DARK_EMAIL_PALETTE } from "./emailDark";

const S = '[data-wn-email][data-wn-sheet="m1"]';

describe("sheetScope", () => {
  it("reduces a React id to a safe attribute value", () => {
    expect(sheetScope(":r1a:").value).toBe("r1a");
    expect(sheetScope("«r2»").selector).toBe('[data-wn-email][data-wn-sheet="r2"]');
    expect(sheetScope('"]{}').value).toBe("x");
  });
});

describe("scopeSelector", () => {
  it("puts an ordinary selector under the scope", () => {
    expect(scopeSelector(".container", S)).toEqual({ selector: `${S} .container`, onScope: false });
    expect(scopeSelector("table td.col", S)?.selector).toBe(`${S} table td.col`);
    expect(scopeSelector("u + .body .x", S)?.selector).toBe(`${S} u + .body .x`);
  });

  it("treats html, body and :root as the scope", () => {
    expect(scopeSelector("body", S)).toEqual({ selector: S, onScope: true });
    expect(scopeSelector("html body", S)).toEqual({ selector: S, onScope: true });
    expect(scopeSelector(":root", S)).toEqual({ selector: S, onScope: true });
    expect(scopeSelector("body .wrap", S)?.selector).toBe(`${S} .wrap`);
    expect(scopeSelector("body > table", S)?.selector).toBe(`${S} table`);
  });

  it("does not mistake a class that starts with body for body", () => {
    expect(scopeSelector("bodycopy", S)?.selector).toBe(`${S} bodycopy`);
    expect(scopeSelector("body-text", S)?.selector).toBe(`${S} body-text`);
  });

  it("refuses selectors that would step outside the message", () => {
    expect(scopeSelector("~ div", S)).toBeNull();
    expect(scopeSelector("+ div", S)).toBeNull();
    expect(scopeSelector("body ~ div", S)).toBeNull();
    expect(scopeSelector("body + nav", S)).toBeNull();
    expect(scopeSelector(":host", S)).toBeNull();
    expect(scopeSelector("x::slotted(y)", S)).toBeNull();
    expect(scopeSelector("body.dark", S)).toBeNull();
    expect(scopeSelector("a } nav {", S)).toBeNull();
    expect(scopeSelector("", S)).toBeNull();
  });
});

describe("scopeSenderCss", () => {
  it("keeps a newsletter's mobile media query, fenced", () => {
    const css = scopeSenderCss(
      [
        `@media only screen and (max-width: 600px) {
           .container { width: 100% !important; }
           .headline, h1 { font-size: 28px !important; }
         }`,
      ],
      S,
    );
    expect(css).toContain("@media only screen and (max-width: 600px)");
    expect(css).toContain(`${S} .container { width: 100% !important; }`);
    expect(css).toContain(`${S} .headline, ${S} h1 { font-size: 28px !important; }`);
  });

  it("scopes every part of a selector list, and drops only the bad parts", () => {
    const css = scopeSenderCss([".a, ~ nav, .b { color: red }"], S);
    expect(css).toBe(`${S} .a, ${S} .b { color: red }`);
  });

  it("never emits a selector that does not start at the scope", () => {
    const css = scopeSenderCss(
      [
        `p { margin: 0 } nav, body ~ header { display: none }
         @media (max-width: 480px) { .x, :host { color: blue } td { display: block } }`,
      ],
      S,
    );
    for (const rule of css.split("\n")) {
      const selectorPart = rule.split("{")[0]!.trim();
      if (selectorPart === "" || selectorPart.startsWith("@") || selectorPart === "}") continue;
      for (const sel of selectorPart.split(",")) expect(sel.trim().startsWith(S)).toBe(true);
    }
    expect(css).not.toContain(":host");
    expect(css).toContain(`${S} nav { display: none }`);
  });

  it("lets body set colour and fonts but not containment, overflow or zoom", () => {
    const css = scopeSenderCss(
      ["body { contain: none; overflow: visible; zoom: 2; isolation: auto; background-color: #f4f4f4; font-family: Georgia; color: #222 }"],
      S,
    );
    expect(css).toBe(`${S} { background-color: #f4f4f4; font-family: Georgia; color: #222 }`);
  });

  it("neutralises position fixed/sticky and z-index", () => {
    const css = scopeSenderCss([".overlay { position: fixed; inset: 0; z-index: 9999 }"], S);
    expect(css).not.toMatch(/position\s*:\s*fixed/);
    expect(css).not.toMatch(/z-index\s*:/);
    expect(css).toContain("inset: 0");
  });

  it("drops dark-mode, print and other at-rules", () => {
    const css = scopeSenderCss(
      [
        `@media (prefers-color-scheme: dark) { .x { color: white } }
         @media print { .x { display: none } }
         @supports (display: grid) { .x { display: grid } }
         @keyframes spin { from { opacity: 0 } }
         @media (max-width: 600px) { @supports (gap: 1px) { .y { gap: 1px } } .z { width: 100% } }`,
      ],
      S,
    );
    expect(css).not.toContain("color: white");
    expect(css).not.toContain("print");
    expect(css).not.toContain("@supports");
    expect(css).not.toContain("@keyframes");
    expect(css).toContain(`${S} .z { width: 100% }`);
    expect(css).not.toContain(".y");
  });

  it("is not fooled by braces inside strings", () => {
    const css = scopeSenderCss(['.q::before { content: "} body { display:none" } .r { color: red }'], S);
    expect(css).toContain(`${S} .r { color: red }`);
    expect(css).not.toMatch(new RegExp(`^${S.replace(/[[\]]/g, "\\$&")} \\{ display`, "m"));
  });

  it("ignores an unclosed rule and a sheet past the cap", () => {
    expect(scopeSenderCss([".a { color: red"], S)).toBe("");
    const huge = ".pad { color: red } ".repeat(Math.ceil(MAX_SCOPED_CSS / 10));
    expect(scopeSenderCss([huge], S).length).toBeLessThan(MAX_SCOPED_CSS * 3);
  });

  it("never lets a sheet close its style element", () => {
    const sanitised = sanitizeMailHtml(
      "<style>.a::after { content: '\\3c /style\\3e <script>' }</style><p>x</p>",
      { allowRemote: false, collectStyles: true },
    );
    const css = scopeSenderCss(sanitised.stylesheets, S);
    expect(css).not.toContain("</");
  });

  it("works end to end on a typical responsive newsletter", () => {
    const html = `<html><head><style>
      body { margin: 0; background: #eeeeee; }
      .wrapper { width: 600px; }
      @media screen and (max-width: 600px) {
        .wrapper { width: 100% !important; }
        .copy { font-size: 17px !important; line-height: 1.5 !important; }
        .stack { display: block !important; width: 100% !important; }
      }
      @import url(https://evil.example/x.css);
      .hero { background-image: url(https://tracker.example/p.gif); }
    </style></head><body><table class="wrapper"><tr><td class="copy stack">Hi</td></tr></table></body></html>`;
    const sanitised = sanitizeMailHtml(html, { allowRemote: false, collectStyles: true });
    const css = scopeSenderCss(sanitised.stylesheets, S);
    expect(css).toContain(`${S} .wrapper { width: 100% !important; }`);
    expect(css).toContain(`${S} .copy { font-size: 17px !important; line-height: 1.5 !important; }`);
    expect(css).toContain(`${S} { background: #eeeeee }`);
    expect(css).not.toContain("evil.example");
    expect(css).not.toContain("tracker.example");
  });
});

describe("scopeSenderCss in email dark mode (1.4.0)", () => {
  const palette = DARK_EMAIL_PALETTE;
  const OWN = { mode: "own" as const, palette };
  const ADAPTIVE = { mode: "adaptive" as const, palette };

  it("unwraps a dark-scheme block so it applies when the reader is dark, light blocks still dropped", () => {
    const css = scopeSenderCss(
      [
        `.card { background: #ffffff; color: #111111 }
         @media (prefers-color-scheme: dark) { .card { background: #1c1c1e !important; color: #f2f2f7 !important } }
         @media screen and (prefers-color-scheme: dark) and (max-width: 600px) { .hero { padding: 8px } }
         @media (prefers-color-scheme: light) { .card { color: red } }`,
      ],
      S,
      OWN,
    );
    // The sender's own light rule is untouched (own path: no recolouring)…
    expect(css).toContain(`${S} .card { background: #ffffff; color: #111111 }`);
    // …and their dark rule follows it, unconditionally, so it wins.
    expect(css).toContain(`${S} .card { background: #1c1c1e !important; color: #f2f2f7 !important }`);
    expect(css.indexOf("#1c1c1e")).toBeGreaterThan(css.indexOf("#ffffff"));
    expect(css).toContain("@media screen and (max-width: 600px) {");
    expect(css).not.toMatch(/prefers-color-scheme/);
    expect(css).not.toContain("color: red");
  });

  it("keeps dropping dark-scheme blocks when the reader is light", () => {
    const css = scopeSenderCss(["@media (prefers-color-scheme: dark) { .x { color: white } }"], S);
    expect(css).toBe("");
  });

  it("unwrapDarkQuery takes only the dark feature out", () => {
    expect(unwrapDarkQuery("@media (prefers-color-scheme: dark)")).toBe("");
    expect(unwrapDarkQuery("@media only screen and (prefers-color-scheme: dark)")).toBe("");
    expect(unwrapDarkQuery("@media (prefers-color-scheme:dark) and (max-width:600px)")).toBe("(max-width:600px)");
    expect(unwrapDarkQuery("@media (max-width: 600px)")).toBeNull();
    expect(unwrapDarkQuery("@media (prefers-color-scheme: dark), print")).toBeNull();
    expect(unwrapDarkQuery("@media (prefers-color-scheme: light)")).toBeNull();
  });

  it("recolours ordinary rules on the adaptive path, responsive media included", () => {
    const css = scopeSenderCss(
      [`body { background: #F4F6F8; color: #15181D } .foot a { color: #7A838C }
        @media (max-width: 600px) { .card { background: #ffffff } }`],
      S,
      ADAPTIVE,
    );
    expect(css).not.toMatch(/#F4F6F8|#15181D|#7A838C|#ffffff/i);
    expect(css).toContain(`background: ${palette.surface.toLowerCase()}`);
    expect(css).toContain("@media (max-width: 600px)");
  });

  it("applies Outlook's [data-ogsc]/[data-ogsb] hooks in a dark reader, unrecoloured; drops them in light", () => {
    const sheet = ["[data-ogsc] .title { color: #fafafa !important } [data-ogsb] .band { background: #123456 }"];
    const dark = scopeSenderCss(sheet, S, ADAPTIVE);
    expect(dark).toContain(`${S} .title { color: #fafafa !important }`);
    expect(dark).toContain(`${S} .band { background: #123456 }`);
    expect(scopeSenderCss(sheet, S)).toBe("");
  });

  it("still fences every selector, dark or not", () => {
    const css = scopeSenderCss(
      ["@media (prefers-color-scheme: dark) { body ~ .x, :host .y, .ok { color: #fff } } [data-ogsc] + .z { color: #fff }"],
      S,
      OWN,
    );
    for (const rule of css.split("\n").filter((line) => line.includes("{"))) {
      for (const selector of rule.split("{")[0].split(",")) expect(selector.trim().startsWith(S)).toBe(true);
    }
    expect(css).toContain(`${S} .ok`);
  });
});
