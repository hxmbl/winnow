/**
 * The allowlist sanitiser.
 *
 * Winnow already had a way to show a message as its sender wrote it — a
 * `sandbox=""` iframe with `srcDoc` — and already had a good reason not to make
 * it the default: rendering sender markup *in the app's origin* is the one thing
 * a mail client must never do, and `html.ts` says so in as many words. The iframe
 * was the escape hatch; it was also, as the screenshots showed, the only way to
 * see a newsletter look like a newsletter.
 *
 * So this module is the thing that makes the *default* rich. Its job is to turn a
 * message body into markup that is safe to put in this document, and that means an
 * allowlist: a tag is rendered if it is on the list and a attribute survives only
 * if it is on the list, rather than the other way round. The distinction is not
 * stylistic. A denylist has to anticipate every element that can execute code or
 * reach the page (`script`, `object`, `iframe`, `svg`, `math`, `link`, `meta`,
 * `base`, `form`, …), and the list of those is open — `foreignObject` and
 * `template` shadow roots are the kind of thing that arrives years after the
 * denylist was written. An allowlist only has to enumerate what mail actually
 * uses.
 *
 * Three properties matter more than anything else here, and each is why the
 * implementation is a hand-written scanner rather than a regular expression:
 *
 *  1. **Entities are decoded before a URL is judged.** `&#106;avascript:` and
 *     `java&Tab;script:` are the same string to a browser as `javascript:`, and
 *     any check that runs on the raw attribute value judges them innocent. So the
 *     value is decoded, then stripped of the control and whitespace characters a
 *     browser also ignores before it looks at the scheme, and *only then* tested.
 *  2. **Raw-text elements are skipped, not tokenised.** The contents of
 *     `<script>` are not markup; `a > b` inside one must not close the element.
 *     A scanner that hunts for `</script>` the way it hunts for `</p>` turns a
 *     `<script>if (a<b) {}</script>` into live markup.
 *  3. **The result is balanced.** Sender markup routinely omits `</td>` and
 *     `</tr>`, because no browser cared. Injected into a document that *does*
 *     care, an unbalanced table swallows everything after it. So open elements
 *     are tracked and closed.
 *
 * The counts it returns are the same promise `remoteReferences` makes: not
 * "something was filtered" but how many remote references this body names and
 * what happened to each one, because the reader puts that number in front of the
 * user as a privacy claim.
 */

import { decodeEntities } from "./html.ts";

// ── The allowlists ──────────────────────────────────────────────────────────

/**
 * Elements removed together with everything inside them.
 *
 * Two different reasons are in here and the distinction is worth keeping:
 *
 *   - **Script carriers** — `script`, `svg`, `math`, `object`, `embed`,
 *     `iframe`, `template`. Their *contents* are code in some reading or
 *     another, and keeping the tag while dropping the body is how
 *     `<template>` shadow DOM and `<svg><foreignObject>` get through.
 *   - **Document furniture** — `link`, `meta`, `base`, `head`'s leftovers.
 *     `base` in particular is a redirect of every relative URL in the body, and
 *     `link rel=stylesheet` is the "a remote stylesheet can exfiltrate anything
 *     in the DOM" case that `html.ts` warns about.
 *   - **Form controls** — `form`, `input`, `button`, `select`. A mail client has
 *     no business rendering a credential prompt inside a message, and a
 *     `<form action=…>` is a silent third-party data sink.
 */
const DROP_WITH_CONTENT = new Set([
  "applet",
  "audio",
  "bgsound",
  "button",
  "canvas",
  "dialog",
  "embed",
  "form",
  "frame",
  "frameset",
  "iframe",
  "input",
  "isindex",
  "keygen",
  "link",
  "listing",
  "map",
  "marquee",
  "math",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "optgroup",
  "option",
  "param",
  "picture",
  "plaintext",
  "portal",
  "script",
  "select",
  "slot",
  "source",
  "svg",
  "template",
  "textarea",
  "title",
  "track",
  "video",
  "xmp",
]);

/**
 * `style`, handled separately from the list above because it has two answers.
 *
 * The app drops it: a sender's stylesheet lands in the same document as the
 * reader's own, where `body { background: red }` and `.trash { display: none }`
 * reach past the message. The proxy keeps it, because there the document is a
 * purpose-built one that contains nothing but the message. Either way it is
 * *removed from the body* and handed back, so the caller decides where it goes.
 */
const STYLE_ELEMENT = "style";

/**
 * Elements removed but whose contents are kept.
 *
 * The document envelope. `html`, `body` and `head` are wrappers around content
 * that is still mail, and a message that arrives as a full document — which is
 * most HTML mail — would otherwise lose its entire body to the envelope.
 */
const UNWRAP = new Set(["html", "body", "head", "center", "font", "marquee"]);

/**
 * Elements rendered.
 *
 * Table elements are the majority and they are not optional: HTML mail is table
 * layout, and a message that loses its `<table>` is a column of unstyled words.
 * `font` and `center` are 1998-era markup that still arrives, and are handled as
 * unwrapped above so their contents survive.
 */
const ALLOWED_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote",
  "br", "caption", "cite", "code", "col", "colgroup", "dd", "del", "details", "dfn",
  "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "rp", "rt",
  "ruby", "s", "samp", "section", "small", "span", "strike", "strong", "sub",
  "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr",
  "tt", "u", "ul", "var", "wbr",
]);

/** Attributes allowed on every element. */
const GLOBAL_ATTRS = new Set([
  "align", "alt", "class", "color", "colspan", "dir", "height", "lang", "rowspan",
  "size", "span", "style", "title", "valign", "width",
]);

/**
 * Attributes allowed only on the element they appear on.
 *
 * **`a` has no `name`, which used to be on it.** A named anchor creates a property
 * on `window`, so `<a name="config">` inside a message rendered into the app's own
 * document defines `window.config` -- DOM clobbering, where a page's own globals
 * are shadowed by elements a third party controls. It is a real technique against
 * applications that read undeclared globals, and nothing is lost by dropping it:
 * the reader keeps no `id`s (a sender's would collide with the app's), so a
 * fragment link in a message goes nowhere either way.
 */
const TAG_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "rel", "target"]),
  img: new Set(["src", "srcset", "loading", "decoding", "border", "hspace", "vspace"]),
  blockquote: new Set(["cite"]),
  q: new Set(["cite"]),
  del: new Set(["cite", "datetime"]),
  ins: new Set(["cite", "datetime"]),
  time: new Set(["datetime"]),
  ol: new Set(["start", "type", "reversed"]),
  ul: new Set(["type"]),
  li: new Set(["value"]),
  td: new Set(["background", "bgcolor", "nowrap"]),
  th: new Set(["background", "bgcolor", "nowrap", "scope", "abbr"]),
  table: new Set(["background", "bgcolor", "border", "cellpadding", "cellspacing", "frame", "rules", "summary"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"]),
  body: new Set(["bgcolor", "text", "link", "vlink", "alink"]),
};

/** Tags with no end tag. */
const VOID_TAGS = new Set([
  "br", "col", "hr", "img", "wbr",
]);

/**
 * Every element HTML defines as having no end tag.
 *
 * A separate list from [`VOID_TAGS`] above, and the difference is which end a name
 * appears on. `VOID_TAGS` is "allowed, and renders as one tag". This one is "a tag
 * whose *contents* must not be skipped" — and that is a security-shaped decision
 * rather than a formatting one.
 *
 * `<meta>`, `<link>`, `<base>`, `<source>`, `<track>`, `<param>`, `<embed>`,
 * `<input>`, `<area>`, `<col>` and `<keygen>` are all dropped with their contents,
 * because their contents *can* be something other than nothing: `<meta>` has no end
 * tag at all, so a scanner looking for `</meta>` does not find one and concludes
 * "this element is unterminated, so everything after it belongs to it". A full HTML
 * document starts with `<head><meta charset="utf-8"><title>…</title></head>`, so
 * the message that has a charset declaration has its entire body swallowed and
 * renders as an empty reader — which is precisely the class of message the rich
 * view exists to show.
 */
const VOID_ELEMENTS = new Set([
  "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr",
  "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Elements whose contents are text, not markup.
 *
 * Only one of these survives sanitising (`textarea` is dropped), and that is the
 * point of listing it: the scanner has to know that `<textarea><b>x</b></textarea>`
 * has a *text* body, so that `<textarea>` on its own cannot smuggle an element in
 * through its contents.
 */
const RAW_TEXT_TAGS = new Set([
  "script", STYLE_ELEMENT, "textarea", "title", "xmp", "plaintext", "listing",
  "noembed", "noframes", "noscript", "iframe",
]);

/**
 * Nesting deeper than this is unwrapped rather than rendered.
 *
 * Browsers cap their own nesting (Chromium at 512, most engines well below), and
 * a sender who ships 40,000 nested `<div>`s gets a layout pass quadratic in depth
 * for a message the reader has to scroll. Unwrapping past the limit keeps the text
 * and drops the depth.
 */
const MAX_DEPTH = 64;

/** A ceiling on the output, so one message cannot exhaust memory in the renderer. */
const MAX_OUTPUT = 2 * 1024 * 1024;

/** `width`/`height` above this are clamped: a 99999px image is a layout attack. */
const MAX_DIMENSION = 4096;

// ── URLs ────────────────────────────────────────────────────────────────────

/*
 * What a browser throws away before it decides what a URL's scheme is.
 *
 * Per the URL standard, tab and newline are removed from anywhere in the input and
 * C0 controls and space are trimmed from both ends — so `java<TAB>script:` and
 * `<NUL>javascript:` are both live in every engine, and a scheme check that runs on
 * the raw attribute value judges them innocent. Both are removed here, and only
 * those: an *interior* space is not a control character, it is a space a browser
 * would percent-encode, and deleting it would quietly turn
 * `https://example.test/a b.png` into a request for a different file.
 */
const URL_DROP_INNER = new RegExp("[" + "\u0000-\u001F\u007F]", "g");
const URL_TRIM_ENDS = new RegExp("^[" + "\u0020]+|[" + "\u0020]+$", "g");

/** Strip what a browser strips, and nothing else. */
function stripUrlNoise(value: string): string {
  return value.replace(URL_DROP_INNER, "").replace(URL_TRIM_ENDS, "");
}

/** Schemes a message may link to or load from, without any proxying. */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "sms:", "ftp:"]);

/** `data:` payloads that cannot execute. */
const SAFE_DATA_URI = /^data:image\/(png|jpeg|jpg|gif|webp|bmp|x-icon|vnd\.microsoft\.icon)[;,]/i;

/**
 * …and SVG, which is the one exception, and only for an image.
 *
 * An SVG loaded by `<img src>` or painted by `background-image` is rendered in a
 * restricted mode: no script, no external references, no form. That is the same
 * reason an `<img>` cannot be a document, and it is why SVG logos — which is most
 * of what a modern brand sends as its logo — render here while the same bytes in an
 * `href` do not.
 */
const SAFE_IMAGE_SVG = /^data:image\/svg\+xml[;,]/i;

/**
 * What a URL attribute is for, which decides whether withholding images
 * withholds it.
 *
 * The single most important distinction in this file. A *fetch* — an `<img>`'s
 * `src`, a table's `background`, a `srcset` candidate — tells the sender the
 * message was opened, so `allowRemote: false` has to stop it. A *link* — an
 * `<a>`'s `href` — does not fetch anything until the user clicks it, and the
 * click is routed to the system browser regardless. Blocking those would leave a
 * message whose only call to action was `mailto:` with no way to answer it, which
 * is not a privacy win but a broken reader.
 */
type UrlKind = "fetch" | "link";

/**
 * Decide what a URL attribute should become.
 *
 * Returns the URL to emit, or `null` to drop the reference entirely. `blocked` is
 * true when the URL was a remote fetch the caller had not permitted — the
 * difference between "this was withheld" and "this was never a thing", which the
 * reader's note depends on.
 */
function resolveUrl(
  raw: string,
  kind: UrlKind,
  allowRemote: boolean,
  inlineParts: Record<string, string> | undefined,
  rewrite: ReadonlyMap<string, string> | undefined,
): { url: string | null; blocked: boolean } {
  // Decoded first, and stripped second, so the scheme test sees what the browser
  // will see. Escaping the result on the way out is the caller's job — see
  // `escapeAttribute`.
  const decoded = stripUrlNoise(decodeEntities(raw));
  if (decoded === "") return { url: null, blocked: false };

  // A proxy address, which the render proxy has already fetched on the reader's
  // behalf. Checked before everything else and *after* the noise is stripped, so
  // the key it is looked up by is the same string the document will contain. Not
  // blocked: nothing is being withheld, it has already been fetched by somebody
  // other than the reader.
  const proxied = rewrite?.get(decoded);
  if (proxied !== undefined) return { url: proxied, blocked: false };

  // A fragment. Never leaves the document, so it is not a fetch and never a
  // privacy question — and a message whose "jump to the footer" link does
  // nothing is a message with a broken button in it.
  if (decoded.startsWith("#")) return { url: decoded, blocked: false };

  // A `cid:` reference is the message's *own* inline part — bytes already in the
  // email, addressed to nobody else. Substituting the data URI is what makes
  // half of real HTML mail render, because a marketing email's logo is a `cid:`
  // and not a URL.
  const cid = /^cid:(.*)$/i.exec(decoded);
  if (cid) {
    const part = inlineParts?.[cid[1].replace(/^<|>$/g, "").toLowerCase()];
    return part ? { url: part, blocked: false } : { url: null, blocked: false };
  }

  if (SAFE_DATA_URI.test(decoded)) return { url: decoded, blocked: false };
  if (kind === "fetch" && SAFE_IMAGE_SVG.test(decoded)) return { url: decoded, blocked: false };
  // Any other `data:` — `text/html`, or an SVG behind a link rather than an image —
  // is a document, and a document can script. Dropped without counting as a remote
  // reference, because it was never going to leave the machine.
  if (/^data:/i.test(decoded)) return { url: null, blocked: false };

  // Protocol-relative. A browser resolves it against the document, which in the
  // app is *this app*, so it is remote by definition and is judged as one.
  if (decoded.startsWith("//")) {
    return allowRemote ? { url: `https:${decoded}`, blocked: false } : { url: null, blocked: true };
  }

  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(decoded);
  if (!scheme) {
    // Relative. There is no base to resolve it against in a sanitised document,
    // and resolving it against the app's own origin would point the message at
    // the app's assets. Not remote, just meaningless.
    return { url: null, blocked: false };
  }

  if (!SAFE_SCHEMES.has(scheme[1].toLowerCase())) return { url: null, blocked: false };
  const isHttp = scheme[1].toLowerCase() === "http:" || scheme[1].toLowerCase() === "https:";

  // **A rewrite map is exhaustive for fetches.** If one was supplied, the only
  // remote address this document may *fetch* is one the map holds — an address the
  // render proxy has already fetched. Anything else is withheld and counted, even
  // under `allowRemote: true`, and that is the whole point: the proxy allows itself
  // remote content because *it* does the fetching, so a URL that never went through
  // it must not survive into a document the reader's browser will act on. Without
  // this clause a policy-refused address — a loopback literal, say — passed straight
  // through to the reader's machine, which is the one request the proxy exists to
  // prevent being made from anywhere but the server.
  //
  // Links are exempt, and the exemption is the same distinction as everywhere else
  // in this file: a `href` fetches nothing until somebody clicks it.
  if (isHttp && kind === "fetch") {
    if (rewrite !== undefined) return { url: null, blocked: true };
    if (!allowRemote) return { url: null, blocked: true };
  }
  return { url: decoded, blocked: false };
}

/**
 * `srcset` is a comma-separated list of `url descriptor` pairs, and each candidate
 * needs the same judgement as a `src`. Candidates that do not survive are dropped
 * rather than failing the whole attribute, because a responsive `srcset` with one
 * unsupported candidate still has three that work.
 *
 * `blocked` is true when *any* candidate was refused, so one withheld reference
 * counts as one — which is what `remoteReferences` does with the attribute, and
 * the reader's note is a count rather than a tally of candidates.
 */
function sanitizeSrcset(
  raw: string,
  allowRemote: boolean,
  inlineParts?: Record<string, string>,
  rewrite?: ReadonlyMap<string, string>,
): { value: string | null; blocked: boolean } {
  const kept: string[] = [];
  let blocked = false;

  for (const candidate of raw.split(",")) {
    const trimmed = candidate.trim();
    if (trimmed === "") continue;
    const space = trimmed.search(/\s/);
    const url = space === -1 ? trimmed : trimmed.slice(0, space);
    const descriptor = space === -1 ? "" : trimmed.slice(space);
    const resolved = resolveUrl(url, "fetch", allowRemote, inlineParts, rewrite);
    if (resolved.blocked) blocked = true;
    if (resolved.url) kept.push(`${resolved.url}${descriptor}`);
  }

  return { value: kept.length > 0 ? kept.join(", ") : null, blocked };
}

/**
 * A `background` attribute is a colour or a URL, and conflating them is the most
 * common false positive in mail. A colour stays a colour; a URL goes through
 * `resolveUrl` like any other.
 */
function sanitizeBackground(
  raw: string,
  allowRemote: boolean,
  inlineParts?: Record<string, string>,
  rewrite?: ReadonlyMap<string, string>,
): { value: string | null; blocked: boolean } {
  const decoded = stripUrlNoise(decodeEntities(raw));
  // A named colour or a hex triplet. Deliberately permissive about the name: a
  // colour that is not a real colour renders as nothing, which is a blemish and
  // not a hazard.
  if (/^#[0-9a-f]{3,8}$/i.test(decoded) || /^[a-z]+$/i.test(decoded)) {
    return { value: decoded, blocked: false };
  }
  const inner = /^url\(\s*['"]?(.*?)['"]?\s*\)$/i.exec(decoded);
  const target = inner ? inner[1] : decoded;
  const resolved = resolveUrl(target, "fetch", allowRemote, inlineParts, rewrite);
  return resolved.url
    ? { value: inner ? `url('${resolved.url}')` : resolved.url, blocked: false }
    : { value: null, blocked: resolved.blocked };
}

// ── CSS ─────────────────────────────────────────────────────────────────────

/**
 * CSS functions that name something to fetch, or to execute.
 *
 * The first three are the ones that matter; the rest are the long tail that a
 * standards-reading implementation accumulates. A regular expression cannot find
 * these safely, which is the entire reason the code below is a scanner:
 *
 *   - `u\72l(...)` is `url(...)`. A CSS escape is decoded by the parser *before* the
 *     function name is read, so a pattern looking for the literal text `url` never
 *     sees it. The tracking pixel loads with images switched off, silently, and the
 *     note reports nothing blocked.
 *   - `image-set("..." 1x)` contains no `url(` at all. It is the same request, and
 *     the first version passed it through and counted zero.
 *   - `url(".../a b.png")` has a space in it. A pattern that stops at whitespace
 *     matched the empty prefix instead of the URL, so this one was *counted* as
 *     blocked and then loaded anyway -- the one failure mode worth never shipping,
 *     because a privacy note that says the opposite of the truth is worse than no
 *     note.
 *
 * All three were found by review rather than by a fuzzer, and all three were
 * confirmed against the shipped code before this rewrite.
 */
const CSS_FETCH_FUNCTIONS = new Set([
  "url",
  "image-set",
  "-webkit-image-set",
  "-moz-image-set",
  "image",
  "element",
  "-moz-element",
  "cross-fade",
  "paint",
]);

/**
 * Decode CSS escapes, so that what is judged is what a parser would read.
 *
 * Two forms, per CSS Syntax 4.3.7: a backslash, up to six hex digits and an optional
 * trailing space, is that code point; a backslash and anything else is that
 * character, with a newline in the pair counting as nothing at all.
 *
 * This runs *before* the fetch check rather than instead of it. Decoding is not a
 * defence -- `u\72l` decoded is `url`, which then still has to be caught by the
 * ordinary rule -- it is the step that lets the ordinary rule see the same text the
 * browser will. Text with no backslash in it comes back unchanged, so the cost on
 * ordinary mail is one pass over a string that does not match.
 */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})[ \n\t\f]?|([\s\S]))/g, (whole, hex: string | undefined, literal: string | undefined) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      // Out of range: left exactly as written rather than becoming a replacement
      // character, so a value cannot turn into something the sender did not write.
      if (!Number.isFinite(code) || code === 0 || code > 0x10ffff) return whole;
      return String.fromCodePoint(code);
    }
    // A backslash-newline is a line continuation and produces nothing.
    if (literal === "\n" || literal === "\r" || literal === "\f") return "";
    return literal ?? whole;
  });
}

/**
 * Walk CSS and report every fetch call, with the span it occupies.
 *
 * A scanner rather than a pattern, for the reasons on [`CSS_FETCH_FUNCTIONS`]. The
 * span is the whole call -- name through closing parenthesis -- so a caller can
 * replace it wholesale instead of trying to edit inside a pair of brackets it has
 * not matched. Parentheses are counted rather than found by a pattern, because a
 * `)` inside a quoted argument closes nothing, and quotes are skipped so that
 * `url("...")` does not end at the first closing bracket in the string.
 */
function eachFetchCall(
  css: string,
  visit: (name: string, inner: string, start: number, end: number) => void,
): void {
  // Runs on text `decodeCssEscapes` has already normalised, so a plain identifier
  // match finds `url` where the source said `u\72l`.
  const CALL = /(^|[^\w-])([a-zA-Z-][a-zA-Z0-9-]*)\s*\(/g;

  for (let match = CALL.exec(css); match !== null; match = CALL.exec(css)) {
    const name = match[2].toLowerCase();
    if (!CSS_FETCH_FUNCTIONS.has(name)) continue;

    // Group 1 is one separator character or nothing, so the name begins right
    // after it. Taking the parenthesis instead -- which is the obvious thing to do,
    // and what the first version did -- rewrites `(args)` and leaves the name
    // behind: `url(...)` became `urlnone`.
    const nameStart = match.index + match[1].length;
    const open = match.index + match[0].length - 1;
    let depth = 1;
    let i = open + 1;
    let quote: string | null = null;

    while (i < css.length && depth > 0) {
      const char = css[i];
      if (quote !== null) {
        if (char === "\\") i += 1;
        else if (char === quote) quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
      }
      i += 1;
    }

    if (depth !== 0) {
      // Unterminated, so there is no closing bracket for a parser to find either and
      // the rest of the declaration is inert. Cut from here to the end.
      visit(name, css.slice(open + 1), nameStart, css.length);
      return;
    }
    visit(name, css.slice(open + 1, i - 1), nameStart, i);
    CALL.lastIndex = i;
  }
}

/** The address inside a fetch call, with its quotes and surrounding space removed. */
function cssCallTarget(inner: string): string {
  return inner.trim().replace(/^['"]/, "").replace(/['"]$/, "").trim();
}

/**
 * The functions whose argument is a *list* of candidates rather than one address.
 *
 * `image-set("a.png" 1x, "b.png" 2x)` takes several, comma-separated. `url()` takes
 * exactly one, and the first version split on commas for both -- which turned
 * `url(data:image/png;base64,iVBOR)` into two candidates, decided the second half
 * was remote because it did not start with `data:`, and replaced a perfectly
 * inert inline image with `none`.
 */
const CSS_LIST_FUNCTIONS = new Set(["image-set", "-webkit-image-set", "-moz-image-set"]);

/**
 * Whether a fetch call's argument names something remote.
 *
 * A fragment names something in this document and a `data:` URI is bytes already
 * inside the message; neither involves anybody else, and both are kept.
 */
function cssTargetIsRemote(name: string, inner: string): boolean {
  const trimmed = inner.trim();

  // A single quoted string is one address whatever else it contains, so it is not
  // split even by a list-taking function: `url("a,b.png")` is a file called
  // `a,b.png`.
  const candidates =
    /^['"]/.test(trimmed) || !CSS_LIST_FUNCTIONS.has(name)
      ? [trimmed]
      : trimmed.split(",");

  return candidates.some((part) => {
    const candidate = stripUrlNoise(decodeEntities(cssCallTarget(part)));
    if (candidate === "") return false;
    if (candidate.startsWith("#")) return false;
    return !/^data:/i.test(candidate);
  });
}

/**
 * Whether a raw declaration names something remote, in any spelling.
 *
 * Asked of the *original* text and answered after escape decoding, so that
 * `u\72l(...)` and `image-set("...")` count as well as `url(...)` does. Used only
 * for the number in the reader's note, never to decide what gets emitted -- that is
 * the walk's job.
 */
function cssNamesRemote(raw: string): boolean {
  let found = false;
  eachFetchCall(decodeCssEscapes(raw), (name, inner) => {
    if (cssTargetIsRemote(name, inner)) found = true;
  });
  return found;
}

/**
 * Declarations a sender is not allowed to set, whatever the browser accepts.
 *
 * `position: fixed` and `position: sticky` are the two that matter, and they are
 * the only ways for an element to leave the flow and attach to the viewport. A
 * message rendered into the app's own document could otherwise put a full-screen
 * `position: fixed; inset: 0` panel over the whole client -- a fake "your session
 * expired, sign in" screen, drawn by a stranger, on top of the real one.
 *
 * Mail does not use either. Not one message in any real corpus does, and a layout
 * that genuinely needs one was going to be wrong in a 400px pane anyway.
 */
const FORBIDDEN_DECLARATIONS: readonly RegExp[] = [
  /\bposition\s*:\s*(?:fixed|sticky)\b/gi,
  // A z-index only means something relative to a stacking context, and the message
  // container establishes its own, but there is no reason to let a sender set one.
  /\bz-index\s*:/gi,
  // `@font-face` pulls a font file from a URL that need not be written as a `url()`.
  /@font-face/gi,
];

/** Neutralise the forbidden declarations in a cleaned style attribute. */
function stripForbiddenDeclarations(style: string): string {
  return FORBIDDEN_DECLARATIONS.reduce(
    (out, pattern) => out.replace(pattern, "-winnow-blocked:"),
    style,
  );
}

/**
 * Strip the ways CSS can fetch or execute something, substituting as it goes.
 *
 * **`rewrite` is the render proxy's hook, and it lives here rather than in a second
 * pass over the finished document for a specific reason.** The proxy's whole claim
 * is that the reader's browser never touches the sender's servers. A rewrite applied
 * afterwards still leaves a document that *contained* a remote `url()` for a moment,
 * and a second pass has to remember to cover every place one can appear -- the same
 * reason the counter in `html.ts` reads `<style>` blocks as well as attributes.
 * Substituting during the walk means a proxied document never holds a remote address
 * at all.
 *
 * Returns the CSS and the number of references it withheld, together, because the
 * count is the useful half and a caller left to derive it afterwards gets it wrong.
 * That is exactly the bug the first version of this function had: it rewrote a
 * withheld `url()` to `none` and then reported zero for a document that was still
 * fetching, which is the one direction of error that makes somebody stop checking.
 */
export function sanitizeCssWithCount(
  css: string,
  rewrite?: ReadonlyMap<string, string>,
): { css: string; blocked: number } {
  let blocked = 0;

  // Comments first: `expr/**/ession(` is a thing, and stripping rules before
  // comments can hide a keyword from the patterns below.
  let out = decodeCssEscapes(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  // And again after decoding: `\2f\2a` is `/*`, so a comment can be *spelled*
  // in escapes and only exist once they are decoded. What is judged below is
  // what is emitted, so it has to be stripped from the decoded text as well.
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");

  // At-rules that fetch, or that re-declare how the parser reads everything else.
  out = out
    .replace(/@import[^;{}]*;?/gi, "")
    .replace(/@charset[^;]*;?/gi, "")
    .replace(/@namespace[^;]*;?/gi, "")
    // `@font-face` whose `src:` is a bare string rather than a `url()` is a fetch
    // the walk below cannot see. Removing the block is simpler than finding the
    // one spelling that would get past, and a message that ships no font is a
    // message that renders in the reader's own.
    .replace(/@font-face\s*\{[^}]*\}/gi, "");

  /*
   * The fetch calls, collected first and rewritten back to front, so that replacing
   * one does not move the offsets of the ones still to be done.
   */
  const edits: Array<{ start: number; end: number; text: string }> = [];
  eachFetchCall(out, (name, inner, from, to) => {
    if (!cssTargetIsRemote(name, inner)) return;
    blocked += 1;
    const mapped = rewrite?.get(cssCallTarget(inner));
    edits.push({ start: from, end: to, text: mapped ? `${name}('${mapped}')` : "none" });
  });
  for (const edit of edits.reverse()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }

  /*
   * The remaining ways to execute: script in an old engine, and the two bindings
   * that were the same idea in different browsers.
   */
  out = out
    .replace(/expression\s*\(/gi, "noop(")
    .replace(/behaviou?r\s*:/gi, "-winnow-behavior:")
    .replace(/-moz-binding\s*:/gi, "-winnow-binding:")
    .replace(/javascript\s*:/gi, "-winnow-js:")
    /*
     * And the belt to the braces above: a declaration still carrying a quoted
     * string that names a scheme, or a protocol-relative path, is a fetch however
     * it is spelled. Run on the *output* of the function walk, so a spelling the
     * walk did not recognise still lands here.
     */
    .split(";")
    .filter((declaration) => !/['"][^'"]*(?::\/\/|\/\/)[^'"]*['"]/.test(declaration))
    .join(";");

  return { css: encodeForEmission(out), blocked };
}

/**
 * Put back the two escapes that decoding must not let reach the output.
 *
 * Everything above judges the *decoded* text, which is right, and then emits it,
 * which is where the first version went wrong. Decoding is a change of meaning
 * in two places:
 *
 *   - `\3c /style\3e ` is inert inside a stylesheet and is a literal `</style>`
 *     once decoded. A sheet is re-homed into a `<style>` element, which is raw text
 *     that ends at the first `</style`, so emitting the decoded form ends the
 *     element and turns the rest of the sheet into markup -- an `<img>` that loads
 *     with images off, a `<meta http-equiv=refresh>`, whatever the sender wrote.
 *   - `\5c ` is a backslash. Decoded and emitted, it is a *new* escape for the
 *     browser to decode a second time, so `u\5c 72l(` reaches the walk as
 *     `u\72l(` -- not a fetch -- and reaches the browser as `url(`.
 *
 * Both are re-escaped, so the browser decodes exactly once and reads exactly what
 * was judged. `</` is the only sequence that can end a raw-text element and it is
 * never valid CSS outside a string, so `<` on its own is left for the media-query
 * range syntax that uses it.
 */
function encodeForEmission(css: string): string {
  return css.replace(/\\/g, "\\5c ").replace(/<\//g, "\\3c /");
}

/** The CSS, without the count. See [`sanitizeCssWithCount`]. */
export function sanitizeCss(css: string, rewrite?: ReadonlyMap<string, string>): string {
  return sanitizeCssWithCount(css, rewrite).css;
}

/**
 * A `style` attribute, sanitised, or dropped.
 *
 * An attribute rather than a block, so there is no selector to reason about and
 * therefore no way for a sender's CSS to reach anything outside the element it is
 * written on. That is a real fidelity cost -- email CSS lives almost entirely in
 * `<style>` blocks -- and it is the cost that keeps a stylesheet out of the app's
 * document. See [`collectStyles`].
 *
 * On top of that, every declaration a sender may not set is neutralised, so that a
 * `position: fixed` panel cannot leave the message's container. See
 * [`FORBIDDEN_DECLARATIONS`].
 */
function sanitizeStyleAttribute(
  raw: string,
  allowRemote: boolean,
  rewrite: ReadonlyMap<string, string> | undefined,
): { value: string | null; blocked: number } {
  const cleaned = stripForbiddenDeclarations(
    sanitizeCssWithCount(decodeEntities(raw), rewrite).css,
  ).trim();
  if (cleaned === "") return { value: null, blocked: 0 };

  /*
   * Withheld or not is decided by `allowRemote`, never by the walk's own count.
   *
   * When the caller allowed remote content it is either keeping the reference or
   * substituting it through `rewrite`, and both of those are the caller's decision
   * rather than a refusal this function made, so nothing there is "blocked". When it
   * did not, a named remote is blocked whether or not the walk recognised the
   * spelling -- which is why the *original* is asked rather than the output, and why
   * the question goes through `cssNamesRemote` rather than a pattern.
   */
  const namedRemote = cssNamesRemote(decodeEntities(raw));
  return { value: cleaned, blocked: namedRemote && !allowRemote ? 1 : 0 };
}

/**
 * Tags that a start tag implicitly closes.
 *
 * A browser does not require `</td>` before the next `<td>`, and HTML mail omits
 * it constantly — Outlook's generated markup is mostly unbalanced tables. The
 * unclosed cell then nests inside its predecessor, so a three-column layout comes
 * out as one column nested three deep, and a `<li>` run never becomes a list.
 *
 * So opening one of these closes any of the listed tags that are currently open.
 * Kept short and conservative: these are the pairs that occur in mail, and a
 * cleverer table would be a cleverer way to be wrong.
 */
const IMPLICITLY_CLOSES: Record<string, readonly string[]> = {
  td: ["td", "th"],
  th: ["td", "th"],
  tr: ["td", "th", "tr"],
  tbody: ["td", "th", "tr", "thead", "tbody", "tfoot"],
  thead: ["td", "th", "tr", "thead", "tbody", "tfoot"],
  tfoot: ["td", "th", "tr", "thead", "tbody", "tfoot"],
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  p: ["p"],
  blockquote: ["p"],
  table: ["p"],
  div: ["p"],
  ul: ["p", "li"],
  ol: ["p", "li"],
  pre: ["p"],
  h1: ["p"], h2: ["p"], h3: ["p"], h4: ["p"], h5: ["p"], h6: ["p"],
};

// ── Scanning ────────────────────────────────────────────────────────────────

/** An attribute as it appeared, name lowercased and value still entity-encoded. */
type Attribute = { name: string; value: string };

/** Escape a value for interpolation into a double-quoted attribute. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape text for the body of the document.
 *
 * **Decoding first is not optional.** The input is a raw slice of a message body, so
 * an `&amp;` in it is an ampersand the sender wrote, not the four characters
 * `&amp;` that the reader should see. Escaping without decoding turns
 * `Tom &amp; Jerry` into `Tom &amp;amp; Jerry`, which renders as `Tom &amp; Jerry` --
 * and essentially every newsletter contains one of these, so a sentence with two
 * ampersands in it loses both.
 *
 * The order is decode-then-escape and it does not work the other way round, which
 * is why this is one function rather than a decode at the call site: the two steps
 * have to happen together and in that order everywhere, and a call site that
 * remembered to escape but not to decode reads identically in review.
 *
 * `decodeEntities` leaves anything it does not recognise alone, so a bare `&` in
 * "AT&T" survives the decode and is escaped on the way out, which is what a browser
 * does with it.
 */
function escapeText(value: string): string {
  return decodeEntities(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Read a tag's attributes.
 *
 * `from` is just past the tag name. Returns the attributes and the index just past
 * the closing `>`, or `null` if the tag never closes — in which case the `<` is
 * not a tag at all and becomes text, which is what a browser does with it.
 *
 * The scanner is character-wise rather than a regex because an attribute value
 * may contain `>`, and a pattern that stops at the first `>` mangles
 * `<a title="1 > 0">` into two tags. Quoted values are the only place a `>` is
 * allowed, so tracking one bit of "inside quotes" is sufficient and exact.
 */
function readAttributes(html: string, from: number): { attributes: Attribute[]; end: number; selfClosing: boolean } | null {
  const attributes: Attribute[] = [];
  let i = from;
  let selfClosing = false;

  while (i < html.length) {
    const char = html[i];

    if (char === ">") {
      return { attributes, end: i + 1, selfClosing };
    }

    // Whitespace between attributes.
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }

    // `/` before `>` is the self-closing marker. Anywhere else it is junk that a
    // browser skips, and skipping it is what a browser does.
    if (char === "/") {
      if (html[i + 1] === ">") {
        selfClosing = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }

    // The attribute name.
    const nameStart = i;
    while (i < html.length && !/[\s=/>]/.test(html[i])) i += 1;
    if (i === nameStart) {
      // A character that is neither a name nor whitespace nor `>`: skip it rather
      // than looping forever. Browsers do the same.
      i += 1;
      continue;
    }
    const name = html.slice(nameStart, i).toLowerCase();

    // Whitespace, then `=`, then whitespace — all optional around the equals.
    let j = i;
    while (j < html.length && /\s/.test(html[j])) j += 1;
    if (html[j] !== "=") {
      // A bare attribute. `<td nowrap>` is the common one and it is meaningful to
      // nobody; `<td bgcolor>` with no value is dropped below by the allowlist
      // check on a missing value. Recorded as an empty value either way so the
      // tag's shape survives.
      attributes.push({ name, value: "" });
      continue;
    }

    j += 1;
    while (j < html.length && /\s/.test(html[j])) j += 1;

    const quote = html[j];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, j + 1);
      if (close === -1) return null; // Unterminated value: not a tag.
      attributes.push({ name, value: html.slice(j + 1, close) });
      i = close + 1;
      continue;
    }

    const valueStart = j;
    while (j < html.length && !/[\s>]/.test(html[j])) j += 1;
    attributes.push({ name, value: html.slice(valueStart, j) });
    i = j;
  }

  return null;
}

/**
 * Find the end of an element's contents.
 *
 * `nesting` counts same-name open elements so that `<div><div></div></div>`
 * closes at the *outer* `</div>`, which is what makes `<form>`-shaped and
 * `<blockquote>`-shaped markup terminate where the sender meant.
 *
 * Returns the index just past the closing tag, or the document's length when the
 * element is never closed — which is the correct reading for an unterminated
 * `<script>`.
 *
 * **`lower` is the document, lowercased once, rather than something derived here.**
 * It used to call `html.toLowerCase()` on every invocation, and this function runs
 * once per dropped element, so a body full of `<button>`s allocated and lowercased
 * the whole document once each: quadratic in the size of the message, on the path
 * every message takes. The copy is made once in `sanitizeMailHtml` and threaded
 * through, which also means the two indices here are guaranteed to line up.
 */
function findElementEnd(html: string, lower: string, from: number, name: string): number {
  if (RAW_TEXT_TAGS.has(name)) {
    // No markup is parsed inside these, so the first `</name` is the end. This is
    // the whole reason raw-text elements are listed separately: hunting for a
    // balanced `</script>` in script source finds the wrong one.
    const needle = `</${name}`;
    const at = lower.indexOf(needle, from);
    if (at === -1) return html.length;
    const close = html.indexOf(">", at);
    return close === -1 ? html.length : close + 1;
  }

  const open = new RegExp(`<${name}\\b`, "gi");
  let depth = 1;
  let cursor = from;
  while (cursor < html.length) {
    open.lastIndex = cursor;
    const nextOpen = open.exec(lower);
    const closeAt = lower.indexOf(`</${name}`, cursor);
    if (closeAt === -1) return html.length;
    if (nextOpen && nextOpen.index < closeAt) {
      depth += 1;
      cursor = nextOpen.index + 1;
      continue;
    }
    depth -= 1;
    const close = html.indexOf(">", closeAt);
    if (close === -1) return html.length;
    if (depth === 0) return close + 1;
    cursor = close + 1;
  }
  return html.length;
}

// ── The sanitiser ───────────────────────────────────────────────────────────

export type SanitizeOptions = {
  /**
   * May the result fetch anything over the network?
   *
   * `false` is the app's default and is not a limitation — it is the answer the
   * reader's image-consent promise requires. Withholding the reference and
   * counting it is what makes "3 remote references were blocked" a fact about
   * this message rather than a disclosure after the fact.
   */
  allowRemote: boolean;
  /**
   * The message's inline parts, as `content-id` → `data:` URI.
   *
   * Keyed on the lowercased id with any angle brackets stripped, because
   * `cid:` references and the `Content-ID` header disagree about both.
   */
  inlineParts?: Record<string, string>;
  /**
   * Keep the message's `<style>` blocks instead of dropping them.
   *
   * `false` in the app, where a sender's stylesheet shares a document with the
   * reader. `true` for the proxy, whose document contains nothing else. The
   * blocks come back in [`SanitizedMail.stylesheets`] either way, sanitised, and
   * the caller decides whether to use them.
   */
  collectStyles?: boolean;
  /**
   * Addresses to substitute while sanitising. The render proxy's hook.
   *
   * A remote address in this map is replaced with the path the proxy serves it
   * from, and is *not* counted as blocked: it has already been fetched, by
   * somebody other than the reader. Substitution happens inside the walk rather
   * than in a pass over the finished document, so a proxied body never contains a
   * remote address at all — not briefly, and not in a `<style>` block that a second
   * pass would have had to remember to cover.
   */
  rewriteUrls?: ReadonlyMap<string, string>;
};

export type SanitizedMail = {
  /** The markup, safe to inject. Balanced, and free of any fetch the caller forbade. */
  html: string;
  /** Remote references that were withheld. What the reader's note counts. */
  blockedRemote: number;
  /** Elements removed with their contents. `<style>` is not one of these. */
  droppedElements: number;
  /** Sanitised `<style>` blocks, in document order. Empty unless `collectStyles`. */
  stylesheets: string[];
  /**
   * Whether the output hit [`MAX_OUTPUT`] and was cut short.
   *
   * Reported rather than silent, because a truncated message that looks complete
   * is the one failure mode here that produces no visible symptom.
   */
  truncated: boolean;
};

/** A no-op option set, so callers that do not care can pass `{}`. */
const DEFAULTS: SanitizeOptions = { allowRemote: false };

/**
 * Turn a message body into markup that is safe to render in this document.
 *
 * The security contract, stated as a list so it can be checked against rather
 * than inferred:
 *
 *   - no element outside the allowlist is rendered, and the ones dropped with
 *     their contents are dropped *with* their contents;
 *   - no attribute outside the allowlist survives, and every `on*` handler is
 *     gone because `on*` is not on any list;
 *   - no `style` block reaches the output unless `collectStyles` asked for it, and
 *     a `style` attribute has had every fetch and every script removed;
 *   - no URL survives that is not `http`, `https`, `mailto`, `tel`, `sms`, `ftp`,
 *     an inert `data:image`, or a `cid:` resolved against the message's own parts;
 *   - no element is left open, so a sender's missing `</td>` cannot swallow the
 *     rest of the reader's document.
 *
 * What it does *not* claim: that the output is harmless as a standalone document,
 * or safe to render in the app's origin without the container's own CSS. It is
 * safe to render *as message content inside the reader's message container*,
 * which is what every caller does.
 */
export function sanitizeMailHtml(html: string, options: Partial<SanitizeOptions> = {}): SanitizedMail {
  const settings = { ...DEFAULTS, ...options };
  const { allowRemote, inlineParts, rewriteUrls } = settings;

  /*
   * One lowercased copy of the body, for the element-boundary search.
   *
   * Matching a tag name has to be case-insensitive, and doing that per dropped
   * element re-lowercased the whole document once each. A newsletter full of
   * buttons or form controls is therefore quadratic in its own size, on the path
   * every message takes, and the cost is paid before anything is rendered.
   */
  const lower = html.toLowerCase();

  const out: string[] = [];
  const stylesheets: string[] = [];
  const open: string[] = [];
  let blockedRemote = 0;
  let droppedElements = 0;
  let emitted = 0;
  let truncated = false;

  /** Append to the output, honouring the size ceiling. */
  const write = (piece: string): boolean => {
    if (truncated) return false;
    emitted += piece.length;
    if (emitted > MAX_OUTPUT) {
      truncated = true;
      return false;
    }
    out.push(piece);
    return true;
  };

  /** Close everything still open. A sender's missing end tag cannot leak past this. */
  const closeAll = () => {
    while (open.length > 0) {
      const name = open.pop()!;
      write(`</${name}>`);
    }
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);

    if (lt === -1) {
      if (!write(escapeText(html.slice(i)))) truncated = true;
      break;
    }

    if (lt > i && !write(escapeText(html.slice(i, lt)))) break;

    const next = html[lt + 1];

    // Not a tag. A browser treats `<` followed by anything that cannot begin a
    // name, an end tag, a comment or a declaration as literal text, and so does
    // this — which is what keeps "a < b" readable instead of eating it.
    if (next === undefined || !/[a-zA-Z!/?]/.test(next)) {
      if (!write("&lt;")) break;
      i = lt + 1;
      continue;
    }

    // Comment. All of them, including the conditional ones
    // (`<!--[if mso]>…<![endif]-->`) whose contents are conditional markup for a
    // client that no longer exists and whose comment syntax can hide a tag from a
    // scanner that skips to `-->` naively.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }

    // Doctype, CDATA, processing instruction. Dropped: none of them carry content,
    // and a CDATA section in an HTML document is a parsing-mode confusion waiting
    // to happen.
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", lt);
      i = end === -1 ? html.length : end + 1;
      continue;
    }

    // End tag.
    if (next === "/") {
      const nameEnd = html.slice(lt + 2).search(/[\s/>]/);
      const name = html.slice(lt + 2, lt + 2 + (nameEnd === -1 ? html.length : nameEnd)).toLowerCase();
      const close = html.indexOf(">", lt);
      i = close === -1 ? html.length : close + 1;

      if (DROP_WITH_CONTENT.has(name) || !ALLOWED_TAGS.has(name)) continue;

      const at = open.lastIndexOf(name);
      // Unbalanced markup: an end tag for something that is not open is dropped,
      // and anything it *should* have closed is closed first, which is the
      // browser's behaviour and the only reason a `</td>` with no `<td>` does not
      // take the rest of the document with it.
      if (at === -1) continue;
      while (open.length > at) {
        const closing = open.pop()!;
        if (!write(`</${closing}>`)) break;
      }
      continue;
    }

    // Start tag.
    const nameEnd = html.slice(lt + 1).search(/[\s/>]/);
    const name = html.slice(lt + 1, lt + 1 + (nameEnd === -1 ? html.length : nameEnd)).toLowerCase();
    const parsed = readAttributes(html, lt + 1 + name.length);

    // `<a href="x>y">` — a tag that never closes is not a tag. The `<` becomes
    // text and scanning resumes from the character after it, so the `>` inside
    // the attribute value is not then swallowed as a tag delimiter.
    if (parsed === null) {
      if (!write("&lt;")) break;
      i = lt + 1;
      continue;
    }
    i = parsed.end;

    if (name === STYLE_ELEMENT) {
      const end = findElementEnd(html, lower, i, name);
      const sheet = sanitizeCssWithCount(
        html.slice(i, end).replace(/<\/style[^>]*>$/i, ""),
        rewriteUrls,
      );
      if (sheet.css.trim() !== "") stylesheets.push(sheet.css);
      i = end;
      continue;
    }

    if (DROP_WITH_CONTENT.has(name)) {
      droppedElements += 1;
      // A void element has no end tag to find, so the search would run to the end of
      // the document and swallow the message with it. Skipping the tag is the whole
      // correction; see `VOID_ELEMENTS`.
      if (!VOID_ELEMENTS.has(name)) i = findElementEnd(html, lower, i, name);
      continue;
    }

    if (UNWRAP.has(name)) {
      // The envelope, and `font`/`center` from the era before CSS. The tag goes
      // and its *contents stay*: scanning resumes at `i`, which is just past the
      // start tag, so the body of a message that arrived as a full document —
      // which is most HTML mail — is scanned rather than skipped. Treating this
      // as "drop with contents" would empty the reader of exactly the messages
      // the rich view exists to show.
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) {
      // Unknown, and not on the drop-with-content list. Its contents are kept,
      // because an unrecognised element in mail is nearly always a wrapper
      // (`<section>`, `<article>`, a vendor's `<v:roundrect>`) and throwing the
      // contents away loses the message.
      continue;
    }

    if (open.length >= MAX_DEPTH) {
      // Too deep. Unwrapped rather than rendered, which keeps the text and drops
      // the depth. No end tag is pushed, so nothing to balance later.
      continue;
    }

    const attrs: string[] = [];
    // Whether the anchor ended up with somewhere to go. The `target`/`rel` pair
    // below is only emitted when it does, because `target="_blank"` on an
    // element with no `href` is a decorative lie the click handler cannot honour.
    let href = false;

    for (const attribute of parsed.attributes) {
      const allowed =
        GLOBAL_ATTRS.has(attribute.name) ||
        TAG_ATTRS[name]?.has(attribute.name) === true;

      // `on*` is not on any list, and an `xmlns` that renames the document's
      // namespace is not on any list either.
      if (!allowed) continue;

      const value = attribute.value;

      switch (attribute.name) {
        case "href": {
          const resolved = resolveUrl(value, "link", allowRemote, inlineParts, rewriteUrls);
          if (resolved.url) {
            attrs.push(`href="${escapeAttribute(resolved.url)}"`);
            href = true;
          }
          break;
        }
        case "src": {
          const resolved = resolveUrl(value, "fetch", allowRemote, inlineParts, rewriteUrls);
          if (resolved.blocked) blockedRemote += 1;
          if (resolved.url) {
            attrs.push(`src="${escapeAttribute(resolved.url)}"`);
            // Lazy, so a message with forty images does not open forty sockets
            // before the reader has scrolled to any of them.
            attrs.push('loading="lazy"', 'decoding="async"');
          } else if (resolved.blocked) {
            // The element survives with its address kept in a data attribute. It
            // renders as the placeholder the stylesheet draws, keeps its `alt`, and
            // stays in the document so the reader can account for it.
            attrs.push(`data-wn-blocked-src="${escapeAttribute(stripUrlNoise(decodeEntities(value)))}"`);
          }
          break;
        }
        case "srcset": {
          const resolved = sanitizeSrcset(value, allowRemote, inlineParts, rewriteUrls);
          if (resolved.blocked) blockedRemote += 1;
          if (resolved.value !== null) attrs.push(`srcset="${escapeAttribute(resolved.value)}"`);
          break;
        }
        case "background": {
          const resolved = sanitizeBackground(value, allowRemote, inlineParts, rewriteUrls);
          if (resolved.blocked) blockedRemote += 1;
          if (resolved.value) attrs.push(`background="${escapeAttribute(resolved.value)}"`);
          break;
        }
        case "style": {
          const resolved = sanitizeStyleAttribute(value, allowRemote, rewriteUrls);
          if (resolved.blocked) blockedRemote += 1;
          if (resolved.value) attrs.push(`style="${escapeAttribute(resolved.value)}"`);
          break;
        }
        case "width":
        case "height": {
          // A percentage is a *proportion*, and clamping one to `MAX_DIMENSION`
          // would turn `width="100%"` into `width="4096px"` — which is how a
          // message that fits becomes a message that does not. Only an absolute
          // number is a dimension worth capping.
          if (/%$/.test(value.trim())) {
            attrs.push(`${attribute.name}="${escapeAttribute(value.trim())}"`);
            break;
          }
          const numeric = Number.parseInt(value, 10);
          if (Number.isFinite(numeric) && numeric > 0) {
            // A dimension is clamped rather than dropped: the layout is usually
            // still right at the clamped value, whereas a dropped `width` is
            // always wrong.
            attrs.push(`${attribute.name}="${Math.min(numeric, MAX_DIMENSION)}"`);
          }
          break;
        }
        case "target":
        case "rel": {
          // Both are ours to choose, and both are dropped whatever the sender
          // wrote. A message's links open outside Winnow — the container's click
          // handler routes them to the system browser, a different origin — so
          // the message never gets a handle on this window. Emitted after the
          // loop rather than here, because the sender may have put `rel` after
          // `href` and an element may have had its `href` dropped entirely.
          break;
        }
        default: {
          attrs.push(`${attribute.name}="${escapeAttribute(decodeEntities(value))}"`);
          break;
        }
      }
    }

    if (href) {
      attrs.push('target="_blank"', 'rel="noopener noreferrer nofollow"');
    }

    // Mark `<pre>` blocks so the reader can add copy buttons to them.
    if (name === "pre") {
      attrs.push('data-wn-code-block=""');
    }

    // `name` on an anchor is a fragment target, not an id, and is harmless; but a
    // duplicate `id` from a sender would collide with the app's own, so no `id` is
    // on any list in the first place.

    // Implicit closing, before the element is pushed. A browser does not need
    // `</td>` before the next `<td>`, and HTML mail omits it constantly; without
    // this an unclosed cell nests inside its predecessor and a three-column
    // layout arrives as one column three deep.
    const closable = IMPLICITLY_CLOSES[name];
    if (closable) {
      while (open.length > 0 && closable.includes(open[open.length - 1])) {
        const closing = open.pop()!;
        if (!write(`</${closing}>`)) break;
      }
    }

    const selfClosing = parsed.selfClosing || VOID_TAGS.has(name);
    const body = attrs.length > 0 ? `<${name} ${attrs.join(" ")}>` : `<${name}>`;
    if (!write(body)) break;
    if (!selfClosing) open.push(name);
  }

  closeAll();

  return {
    html: out.join(""),
    blockedRemote,
    droppedElements,
    stylesheets,
    truncated,
  };
}


// ── The typographic floor ───────────────────────────────────────────────────

/**
 * One rule, one job, kept as data so both consumers get the same thing.
 *
 * This was two copies of a stylesheet — one rooted at `body` for the standalone
 * document, one rooted at `[data-wn-email]` for the reader — and the pair had
 * every chance to drift, which is a defect this codebase has already paid for
 * twice with theme tokens that existed in the Tailwind config and not in
 * `theme.ts`. So there is one list, and [`emailDocumentCss`] and
 * [`inlineEmailCss`] are two serialisations of it.
 *
 * **The container keeps a light surface in both themes, on purpose.** Winnow's
 * reader is dark in the dark scheme, and a message that inherited that would be a
 * white newsletter — `color: #333`, `background: #fff`, a blue hero — rendered in
 * dark-mode grey, which is unreadable. Gmail and Apple Mail both keep the message
 * on the sender's own surface and put chrome around it, and that is the correct
 * answer rather than a compromise: the message is the sender's document, and the
 * app's palette is the app's.
 */
const CONTAINER = "--container";

type Rule = readonly [selector: string, declarations: string];

/** The baseline. Resets what breaks layout, sets what carries legibility, no further. */
const EMAIL_BASELINE_RULES: readonly Rule[] = [
  [
    CONTAINER,
    `margin: 0; padding: 0;
     font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
     font-size: 15px; line-height: 1.55;
     color: #15181D; background: #FFFFFF;
     overflow-wrap: break-word; -webkit-text-size-adjust: 100%;
     /*
       * The boundary that keeps a message inside its own box.
       *
       * \`contain: layout\` makes this element the containing block for its absolutely
       * and fixed positioned descendants, so a \`position: fixed; inset: 0\` panel in
       * a message covers the message rather than the viewport. \`contain: paint\`
       * then clips anything that still manages to paint outside the padding box.
       * \`isolation: isolate\` gives the message its own stacking context, so a
       * sender's z-index cannot lift anything above the reader's chrome.
       *
       * This is not belt-and-braces for its own sake. The sanitiser strips
       * \`position: fixed\` and \`z-index\` from style attributes, but \`class\` is still
       * allowed — "as sent" needs it, because that document keeps the sender's own
       * stylesheet — and \`class="fixed inset-0 z-50"\` picks up Tailwind utilities
       * out of the app's own stylesheet. \`overflow-x: auto\` does not help: it does
       * not clip fixed-position descendants. Containment is the property that
       * actually bounds them, so it is here rather than relying on the allowlist
       * having no gap.
       */
     contain: layout paint;
     isolation: isolate;`,
  ],
  [
    "img",
    `max-width: 100%; height: auto; border: 0; display: inline-block;`,
  ],
  [
    "table",
    // A wide message scrolls rather than being cut off — see the note in
    // `MessageBody`. `max-width` alone cannot achieve that: an auto-layout table
    // sizes itself to its contents, so a `max-width: 100%` whose percentage
    // resolves against that same content width never binds.
    `max-width: 100%;`,
  ],
  ["td, th", `word-break: break-word; overflow-wrap: anywhere;`],
  ["a", `color: #1A5FB4; text-decoration: underline;`],
  [
    "blockquote",
    `margin: 1em 0; padding: 0 0 0 1em; border-left: 3px solid #D7DCDE; color: #5A636B;`,
  ],
  [
    "pre",
    `margin: 1em 0; padding: 0.85em 1em; background: #F3F5F6; border-radius: 8px; overflow-x: auto;
     font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 1.5;
     position: relative;`,
  ],
  ["code", `font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.92em;`],
  ["hr", `border: 0; border-top: 1px solid #E4E7E9; margin: 1.5em 0;`],
  ["h1", `font-size: 1.5em; margin: 0.6em 0; line-height: 1.25;`],
  ["h2", `font-size: 1.32em; margin: 0.7em 0; line-height: 1.3;`],
  ["h3", `font-size: 1.16em; margin: 0.8em 0;`],
  ["h4, h5, h6", `font-size: 1em; margin: 0.9em 0;`],
  ["p", `margin: 0 0 1em;`],
  ["ul, ol", `margin: 0 0 1em; padding-left: 1.5em;`],
  ["li", `margin: 0.25em 0;`],
  [
    "div",
    // Gmail puts every message in a `div` and Outlook's generated markup is
    // mostly nested `div`s; without this a wrapper inherits the reader's font
    // size and a message arrives as 11px chrome rather than as a message.
    `font-size: inherit;`,
  ],
  // An image whose address was withheld. It stays in the document with its
  // `alt`, so the reader can still account for it, and it is drawn so its
  // absence is a visible gap rather than a silent one — which is the difference
  // between "Winnow withheld this" and "this message has a gap in it".
  [
    "img[data-wn-blocked-src]",
    `display: inline-block; min-width: 1.5em; min-height: 1.5em; max-width: 100%;
     border: 1px dashed #B9C0C5; border-radius: 4px; background: #EEF1F2;`,
  ],
];

/**
 * The attribute every container carries, in both forms.
 *
 * A hook for the stylesheet and for a test to find the message body by what it
 * *is*, and deliberately not a class: `class` collides with the sender's own
 * class names, which are arbitrary strings chosen by whoever built the message.
 */
const CONTAINER_ATTRIBUTE = "data-wn-email";

/**
 * Serialise the baseline, choosing what the container selector resolves to.
 *
 * Every part of a selector *list* is scoped, not just the first. `[data-wn-email]
 * h4, h5, h6` reads as "an `h4` inside a message, or any `h5` or `h6` on the
 * page" — so prefixing the list once would have left the reader's own headings
 * reachable from this stylesheet, which is the entire thing this function exists
 * to prevent. The test for it splits on commas for the same reason.
 */
function serialiseBaseline(container: string): string {
  return EMAIL_BASELINE_RULES.map(([selector, declarations]) => {
    const resolved = selector
      .split(",")
      .map((part) => {
        const trimmed = part.trim();
        return trimmed === CONTAINER ? container : `${container} ${trimmed}`;
      })
      .join(", ");
    return `${resolved} { ${declarations} }`;
  }).join("\n");
}

/**
 * The baseline as a standalone stylesheet, for a document of its own.
 *
 * This is what the sandboxed frame and the render proxy both use, and it is what
 * `emailDocument` inlines into the frame it builds.
 */
export function emailDocumentCss(): string {
  return serialiseBaseline("body");
}

/**
 * The baseline as a scoped stylesheet, for rendering into the reader's document.
 *
 * Every selector is descended from `[data-wn-email]`, so not one rule here can
 * reach the reader's own chrome, and — the other half of the same guarantee — no
 * rule in the reader's stylesheet can restyle a message unless it also names that
 * attribute. Scoping by rewriting the selectors rather than by wrapping in `@media`
 * or a `ShadowRoot` is a deliberate choice: the media query would have to be
 * replicated for every width, and a shadow root would put the sender's markup in a
 * document that inherits nothing from the app, which is the *document* form's job
 * and not this one's.
 */
export function inlineEmailCss(): string {
  return serialiseBaseline(`[${CONTAINER_ATTRIBUTE}]`);
}

/**
 * Build a complete, standalone document for a message.
 *
 * For the two places that need one: the reader's "Show as the sender wrote it",
 * which is a `sandbox=""` frame pointed at this, and the render proxy, which
 * serves this. The sender's own stylesheets come back from the sanitiser already
 * sanitised and are re-homed into this document's `<head>`, which is why keeping
 * them is safe here and dropping them is necessary there — the difference is
 * entirely whether the document contains anything else.
 */
export function emailDocument(body: string, stylesheets: readonly string[] = []): string {
  // `</` cannot end the element whatever the sheet contains. The sanitiser
  // already escapes it; this is the backstop for a sheet that came from anywhere else.
  const sender = stylesheets.join("\n").trim().replace(/<\//g, "\\3c /");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    // Without this the document claims a light surface it does not have, and a
    // white newsletter renders as a white block on a black pane.
    '<meta name="color-scheme" content="light">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    sender ? `<style>${sender}</style>` : "",
    `<style>${emailDocumentCss()}</style>`,
    "</head>",
    `<body ${CONTAINER_ATTRIBUTE}>`,
    body,
    "</body></html>",
  ].join("");
}
