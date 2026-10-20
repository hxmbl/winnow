/**
 * The allowlist sanitiser.
 *
 * A tag renders only if it is on the allowlist, and an attribute survives only if it is
 * too — rather than the other way round. A denylist has to anticipate every element that
 * can execute code or reach the page, and that list is open: `foreignObject` and
 * `template` shadow roots arrive years after the denylist was written.
 *
 * Three properties explain why this is a hand-written scanner rather than a regex:
 *
 *  1. Entities are decoded before a URL is judged, so `&#106;avascript:` is caught.
 *  2. Raw-text elements are skipped, not tokenised: `<script>` contents are not markup.
 *  3. The result is balanced, because sender markup routinely omits `</td>` and an
 *     unbalanced table swallows everything after it.
 *
 * The counts it returns are the same promise `remoteReferences` makes: how many remote
 * references this body names and what happened to each one.
 */

import { decodeEntities } from "./html.ts";
import { parseColor, recolourAttribute, recolourDeclarations, type DarkPalette, type Rgba } from "./emailDark.ts";

// ── The allowlists ──────────────────────────────────────────────────────────

/**
 * Elements removed together with everything inside them.
 *
 * Three reasons are in here and the distinction is worth keeping:
 *
 *   - **Script carriers** — `script`, `svg`, `math`, `object`, `embed`, `iframe`,
 *     `template`. Keeping the tag while dropping the body is how `<template>` shadow
 *     DOM and `<svg><foreignObject>` get through.
 *   - **Document furniture** — `link`, `meta`, `base`. `base` redirects every relative
 *     URL, and `link rel=stylesheet` can exfiltrate the DOM.
 *   - **Form controls** — a credential prompt inside a message, and a silent
 *     third-party data sink.
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
 * The app drops it (a sender's stylesheet would share the reader's document). The proxy
 * keeps it, because there the document contains nothing else. Either way it is *removed
 * from the body* and handed back, so the caller decides where it goes.
 */
const STYLE_ELEMENT = "style";

/**
 * Elements removed but whose contents are kept.
 *
 * The document envelope: a message that arrives as a full document — which is most HTML
 * mail — would otherwise lose its entire body to `html`/`body`/`head`.
 */
const UNWRAP = new Set(["html", "body", "head", "center", "font", "marquee"]);

/**
 * Elements rendered.
 *
 * Table elements are the majority and not optional: HTML mail is table layout, and a
 * message that loses its `<table>` is a column of unstyled words. `font` and `center`
 * are handled as unwrapped above so their contents survive.
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
 * **`a` has no `name`.** A named anchor creates a property on `window`, so
 * `<a name="config">` inside a message rendered into the app's own document defines
 * `window.config` -- DOM clobbering. Nothing is lost by dropping it: the reader keeps no
 * `id`s, so a fragment link goes nowhere either way.
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
 * Separate from [`VOID_TAGS`]: this one is "a tag whose *contents* must not be skipped".
 * `<meta>` has no end tag at all, so a scanner looking for `</meta>` concludes everything
 * after it belongs to it — a full document's `<head>` would have its entire body swallowed.
 */
const VOID_ELEMENTS = new Set([
  "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr",
  "img", "input", "keygen", "link", "meta", "param", "source", "track", "wbr",
]);

/**
 * Elements whose contents are text, not markup.
 *
 * The scanner has to know that `<textarea><b>x</b></textarea>` has a *text* body, so
 * `<textarea>` on its own cannot smuggle an element in through its contents.
 */
const RAW_TEXT_TAGS = new Set([
  "script", STYLE_ELEMENT, "textarea", "title", "xmp", "plaintext", "listing",
  "noembed", "noframes", "noscript", "iframe",
]);

/**
 * Nesting deeper than this is unwrapped rather than rendered.
 *
 * A sender who ships 40,000 nested `<div>`s gets a layout pass quadratic in depth.
 * Unwrapping past the limit keeps the text and drops the depth.
 */
const MAX_DEPTH = 64;

/** A ceiling on the output, so one message cannot exhaust memory in the renderer. */
const MAX_OUTPUT = 2 * 1024 * 1024;

/** `width`/`height` above this are clamped: a 99999px image is a layout attack. */
const MAX_DIMENSION = 4096;

// ── URLs ────────────────────────────────────────────────────────────────────

/*
 * What a browser throws away before it decides what a URL's scheme is: controls
 * everywhere, and space at both ends — so `java<TAB>script:` and `<NUL>javascript:`
 * are live in every engine, and a check on the raw value judges them innocent. An
 * *interior* space is not a control character; deleting it would turn
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
 * An SVG loaded by `<img src>` or painted by `background-image` renders in a
 * restricted mode: no script, no external references, no form. So the same bytes
 * that render as a logo here are dropped from an `href`.
 */
const SAFE_IMAGE_SVG = /^data:image\/svg\+xml[;,]/i;

/**
 * What a URL attribute is for, which decides whether withholding images
 * withholds it.
 *
 * A *fetch* — an `<img>`'s `src`, a table's `background`, a `srcset` candidate —
 * tells the sender the message was opened, so `allowRemote: false` has to stop it.
 * A *link* — an `<a>`'s `href` — fetches nothing until clicked, and the click goes
 * to the system browser regardless. Blocking those would leave a `mailto:`-only
 * message with no way to answer it, which is not a privacy win but a broken reader.
 */
type UrlKind = "fetch" | "link";

/**
 * Decide what a URL attribute should become.
 *
 * `blocked` is true when the URL was a remote fetch the caller had not permitted —
 * the difference between "this was withheld" and "this was never a thing", which
 * the reader's note depends on.
 */
function resolveUrl(
  raw: string,
  kind: UrlKind,
  allowRemote: boolean,
  inlineParts: Record<string, string> | undefined,
  rewrite: ReadonlyMap<string, string> | undefined,
): { url: string | null; blocked: boolean } {
  // Decoded first, stripped second, so the scheme test sees what the browser will.
  // Escaping the result is the caller's job — see `escapeAttribute`.
  const decoded = stripUrlNoise(decodeEntities(raw));
  if (decoded === "") return { url: null, blocked: false };

  // A proxy address, already fetched on the reader's behalf. Looked up *after* the
  // noise is stripped, so the key matches the string the document will contain.
  // Not blocked: nothing is withheld.
  const proxied = rewrite?.get(decoded);
  if (proxied !== undefined) return { url: proxied, blocked: false };

  // A fragment never leaves the document, so it is not a fetch — and a "jump to
  // the footer" link that does nothing is a broken button.
  if (decoded.startsWith("#")) return { url: decoded, blocked: false };

  // A `cid:` is the message's *own* inline part — bytes already in the email,
  // addressed to nobody else. Substituting the data URI is what makes a
  // marketing email's `cid:` logo render.
  const cid = /^cid:(.*)$/i.exec(decoded);
  if (cid) {
    const part = inlineParts?.[cid[1].replace(/^<|>$/g, "").toLowerCase()];
    return part ? { url: part, blocked: false } : { url: null, blocked: false };
  }

  if (SAFE_DATA_URI.test(decoded)) return { url: decoded, blocked: false };
  if (kind === "fetch" && SAFE_IMAGE_SVG.test(decoded)) return { url: decoded, blocked: false };
  // Any other `data:` — `text/html`, or an SVG behind a link — is a document, and a
  // document can script. Not counted as remote: it never leaves the machine.
  if (/^data:/i.test(decoded)) return { url: null, blocked: false };

  // Protocol-relative resolves against the document, which in the app is *this
  // app* — remote by definition.
  if (decoded.startsWith("//")) {
    return allowRemote ? { url: `https:${decoded}`, blocked: false } : { url: null, blocked: true };
  }

  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(decoded);
  if (!scheme) {
    // Relative: no base to resolve against, and resolving against the app's origin
    // would point the message at the app's assets. Not remote, just meaningless.
    return { url: null, blocked: false };
  }

  if (!SAFE_SCHEMES.has(scheme[1].toLowerCase())) return { url: null, blocked: false };
  const isHttp = scheme[1].toLowerCase() === "http:" || scheme[1].toLowerCase() === "https:";

  // **A rewrite map is exhaustive for fetches.** If one was supplied, the only
  // remote address this document may *fetch* is one the map holds. Anything else is
  // withheld and counted even under `allowRemote: true`: the proxy allows itself
  // remote content because *it* does the fetching, so a URL that never went through
  // it must not reach the reader's browser. Links are exempt, as everywhere: a
  // `href` fetches nothing until clicked.
  if (isHttp && kind === "fetch") {
    if (rewrite !== undefined) return { url: null, blocked: true };
    if (!allowRemote) return { url: null, blocked: true };
  }
  return { url: decoded, blocked: false };
}

/**
 * `srcset` is a comma-separated list of `url descriptor` pairs, each needing the
 * same judgement as a `src`. A refused candidate is dropped rather than failing the
 * whole attribute, since a responsive `srcset` with one bad candidate still has
 * three that work.
 *
 * `blocked` is true when *any* candidate was refused — one withheld reference
 * counts as one, matching what `remoteReferences` does with the attribute.
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
  // A named colour or a hex triplet. Deliberately permissive: a name that is not a
  // real colour renders as nothing, which is a blemish and not a hazard.
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
 * The first three matter; the rest are the long tail. A regular expression cannot
 * find these safely, which is why the code below is a scanner:
 *
 *   - `u\72l(...)` is `url(...)`. A CSS escape is decoded *before* the function name
 *     is read, so a pattern looking for the literal `url` never sees it, and the
 *     tracking pixel loads with images off while the note reports nothing blocked.
 *   - `image-set("..." 1x)` contains no `url(` at all, but is the same request.
 *   - `url(".../a b.png")` has a space in it; a pattern that stops at whitespace
 *     matched the empty prefix, so this one was *counted* as blocked and then loaded
 *     anyway — the one failure mode worth never shipping, because a privacy note
 *     that says the opposite of the truth is worse than no note.
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
 * character, with a newline in the pair counting as nothing.
 *
 * This runs *before* the fetch check rather than instead of it: decoding is not a
 * defence — `u\72l` still has to be caught as `url` by the ordinary rule — it is
 * the step that lets that rule see the text the browser will.
 */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})[ \n\t\f]?|([\s\S]))/g, (whole, hex: string | undefined, literal: string | undefined) => {
    if (hex !== undefined) {
      const code = Number.parseInt(hex, 16);
      // Out of range: left as written rather than becoming a replacement character,
      // so a value cannot turn into something the sender did not write.
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
 * span is the whole call — name through closing parenthesis — so a caller can
 * replace it wholesale. Parentheses are counted, not matched: a `)` inside a quoted
 * argument closes nothing, and quotes are skipped so `url("...")` does not end at
 * the first bracket in the string.
 */
function eachFetchCall(
  css: string,
  visit: (name: string, inner: string, start: number, end: number) => void,
): void {
  // Runs on text `decodeCssEscapes` already normalised, so a plain identifier match
  // finds `url` where the source said `u\72l`.
  const CALL = /(^|[^\w-])([a-zA-Z-][a-zA-Z0-9-]*)\s*\(/g;

  for (let match = CALL.exec(css); match !== null; match = CALL.exec(css)) {
    const name = match[2].toLowerCase();
    if (!CSS_FETCH_FUNCTIONS.has(name)) continue;

    // Group 1 is one separator character or nothing, so the name begins right after
    // it. Taking the parenthesis instead rewrites `(args)` and leaves the name
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
      // Unterminated: no closing bracket for a parser either, so the rest is inert.
      // Cut from here to the end.
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
 * `image-set("a.png" 1x, "b.png" 2x)` takes several, comma-separated; `url()` takes
 * exactly one. Splitting on commas for both turned `url(data:image/png;base64,...)`
 * into two candidates and replaced an inert inline image with `none`.
 */
const CSS_LIST_FUNCTIONS = new Set(["image-set", "-webkit-image-set", "-moz-image-set"]);

/**
 * Whether a fetch call's argument names something remote.
 *
 * A fragment names something in this document and a `data:` URI is bytes already in
 * the message; neither involves anybody else.
 */
function cssTargetIsRemote(name: string, inner: string): boolean {
  const trimmed = inner.trim();

  // A quoted string is one address whatever it contains, so it is not split even by
  // a list-taking function: `url("a,b.png")` is a file called `a,b.png`.
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
 * Asked of the *original* text and answered after escape decoding, so `u\72l(...)`
 * and `image-set("...")` count as well as `url(...)`. Used only for the reader's
 * note, never to decide what is emitted — that is the walk's job.
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
 * `position: fixed` and `sticky` are the only ways for an element to leave the flow
 * and attach to the viewport — so a message could otherwise put a full-screen
 * `position: fixed; inset: 0` panel over the whole client, a fake "your session
 * expired, sign in" screen drawn by a stranger on top of the real one. Mail does
 * not use either, and a layout that needs one was wrong in a 400px pane anyway.
 */
const FORBIDDEN_DECLARATIONS: readonly RegExp[] = [
  /\bposition\s*:\s*(?:fixed|sticky)\b/gi,
  // The message container establishes its own stacking context, but there is no
  // reason to let a sender set a z-index.
  /\bz-index\s*:/gi,
  // `@font-face` pulls a font file from a URL that need not be written as a `url()`.
  /@font-face/gi,
];

/** Neutralise the forbidden declarations in a cleaned style attribute or rule body. */
export function stripForbiddenDeclarations(style: string): string {
  return FORBIDDEN_DECLARATIONS.reduce(
    (out, pattern) => out.replace(pattern, "-winnow-blocked:"),
    style,
  );
}

/**
 * Strip the ways CSS can fetch or execute something, substituting as it goes.
 *
 * **`rewrite` is the render proxy's hook, and it lives here rather than in a second
 * pass over the finished document.** The proxy's claim is that the reader's browser
 * never touches the sender's servers; a rewrite applied afterwards still leaves a
 * document that *contained* a remote `url()` for a moment, and a second pass has to
 * remember every place one can appear. Substituting during the walk means a proxied
 * document never holds a remote address at all.
 *
 * The CSS and the number of references withheld come back together, because a
 * caller left to derive the count afterwards gets it wrong: rewriting a withheld
 * `url()` to `none` and then reporting zero is the one direction of error that makes
 * somebody stop checking.
 */
export function sanitizeCssWithCount(
  css: string,
  rewrite?: ReadonlyMap<string, string>,
): { css: string; blocked: number } {
  let blocked = 0;

  // Comments first: `expr/**/ession(` is a thing, and stripping rules before
  // comments can hide a keyword from the patterns below.
  let out = decodeCssEscapes(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  // And again after decoding: `\2f\2a` is `/*`, so a comment can be *spelled* in
  // escapes and only exist once decoded.
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");

  // At-rules that fetch, or that re-declare how the parser reads everything else.
  out = out
    .replace(/@import[^;{}]*;?/gi, "")
    .replace(/@charset[^;]*;?/gi, "")
    .replace(/@namespace[^;]*;?/gi, "")
    // `@font-face` whose `src:` is a bare string rather than a `url()` is a fetch the
    // walk below cannot see. Removing the block is simpler, and a message that ships
    // no font renders in the reader's own.
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

  /* The remaining ways to execute: script in an old engine, and two browser-specific bindings. */
  out = out
    .replace(/expression\s*\(/gi, "noop(")
    .replace(/behaviou?r\s*:/gi, "-winnow-behavior:")
    .replace(/-moz-binding\s*:/gi, "-winnow-binding:")
    .replace(/javascript\s*:/gi, "-winnow-js:")
    /*
     * The belt to the braces above: a declaration carrying a quoted string that names
     * a scheme, or a protocol-relative path, is a fetch however it is spelled. Run on
     * the *output* of the walk, so a spelling it did not recognise still lands here.
     */
    .split(";")
    .filter((declaration) => !/['"][^'"]*(?::\/\/|\/\/)[^'"]*['"]/.test(declaration))
    .join(";");

  return { css: encodeForEmission(out), blocked };
}

/**
 * Put back the two escapes that decoding must not let reach the output.
 *
 * Everything above judges the *decoded* text, then emits it, and decoding changes
 * meaning in two places:
 *
 *   - `\3c /style\3e ` is inert inside a stylesheet but a literal `</style>` once
 *     decoded. A sheet is re-homed into a `<style>` element, so emitting the decoded
 *     form ends the element and turns the rest of the sheet into markup.
 *   - `\5c ` is a backslash. Decoded and emitted it is a *new* escape, so `u\5c 72l(`
 *     reaches the walk as `u\72l(` — not a fetch — and the browser as `url(`.
 *
 * Both are re-escaped, so the browser decodes exactly once and reads what was
 * judged. `</` is the only sequence that can end a raw-text element and is never
 * valid CSS outside a string, so `<` on its own is left for media-query range syntax.
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
 * An attribute rather than a block, so there is no selector and no way for a
 * sender's CSS to reach outside the element it is written on. That is a real
 * fidelity cost — email CSS lives almost entirely in `<style>` blocks — and it is
 * what keeps a stylesheet out of the app's document. See [`collectStyles`].
 *
 * Every declaration a sender may not set is also neutralised, so a
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
   * When the caller allowed remote content it either keeps the reference or
   * substitutes it through `rewrite` — the caller's decision, not a refusal, so
   * nothing is "blocked". When it did not, a named remote is blocked whether or not
   * the walk recognised the spelling, which is why the *original* is asked through
   * `cssNamesRemote` rather than the output.
   */
  const namedRemote = cssNamesRemote(decodeEntities(raw));
  return { value: cleaned, blocked: namedRemote && !allowRemote ? 1 : 0 };
}

/**
 * Tags that a start tag implicitly closes.
 *
 * A browser does not require `</td>` before the next `<td>`, and HTML mail omits it
 * constantly — Outlook's generated markup is mostly unbalanced tables. An unclosed
 * cell nests inside its predecessor, so a three-column layout arrives as one column
 * nested three deep. Opening one of these closes any listed tag already open. Kept
 * short and conservative: a cleverer table would be a cleverer way to be wrong.
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
 * **Decoding first is not optional.** The input is a raw slice of the message, so an
 * `&amp;` in it is an ampersand the sender wrote. Escaping without decoding turns
 * `Tom &amp; Jerry` into `Tom &amp;amp; Jerry`, and every newsletter contains one of
 * these. The order is decode-then-escape, which is why this is one function: a call
 * site that remembered to escape but not to decode reads identically in review.
 *
 * `decodeEntities` leaves anything it does not recognise alone, so a bare `&` in
 * "AT&T" survives the decode and is escaped on the way out, as a browser does.
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
 * the closing `>`, or `null` if the tag never closes — in which case the `<` becomes
 * text, as a browser would.
 *
 * Character-wise rather than a regex because an attribute value may contain `>`, and
 * a pattern stopping at the first `>` mangles `<a title="1 > 0">` into two tags.
 * Quoted values are the only place a `>` is allowed, so one bit of "inside quotes"
 * is sufficient and exact.
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

    // `/` before `>` is the self-closing marker; anywhere else it is junk a browser
    // skips.
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
      // Neither a name nor whitespace nor `>`: skip rather than loop forever, as a
      // browser does.
      i += 1;
      continue;
    }
    const name = html.slice(nameStart, i).toLowerCase();

    // Whitespace, then `=`, then whitespace — all optional around the equals.
    let j = i;
    while (j < html.length && /\s/.test(html[j])) j += 1;
    if (html[j] !== "=") {
      // A bare attribute (`<td nowrap>`). Recorded as an empty value so the tag's
      // shape survives; a value-less `<td bgcolor>` is dropped by the allowlist.
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
 * Same-name open elements are counted so `<div><div></div></div>` closes at the
 * *outer* `</div>`, which makes nested markup terminate where the sender meant.
 * Returns the index just past the closing tag, or the document's length when the
 * element is never closed — the correct reading for an unterminated `<script>`.
 *
 * **`lower` is the document, lowercased once, rather than derived here.** Lowercasing
 * per invocation made a body full of `<button>`s quadratic on the path every message
 * takes; the copy is made once in `sanitizeMailHtml` and threaded through, which also
 * guarantees the two indices line up.
 */
function findElementEnd(html: string, lower: string, from: number, name: string): number {
  if (RAW_TEXT_TAGS.has(name)) {
    // No markup is parsed inside these, so the first `</name` is the end — the reason
    // raw-text elements are listed separately: hunting a balanced `</script>` in
    // script source finds the wrong one.
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
   * `false` is the app's default and not a limitation — it is what the reader's
   * image-consent promise requires. Withholding and counting is what makes "3
   * remote references were blocked" a fact about this message.
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
   * `false` in the app, where a sender's stylesheet would share the reader's
   * document; `true` for the proxy, whose document contains nothing else. The
   * blocks come back in [`SanitizedMail.stylesheets`] either way.
   */
  collectStyles?: boolean;
  /**
   * Addresses to substitute while sanitising. The render proxy's hook.
   *
   * A remote address in this map becomes the path the proxy serves it from and is
   * *not* counted as blocked: it has already been fetched, by somebody other than
   * the reader. Substitution happens inside the walk, so a proxied body never holds
   * a remote address at all.
   */
  rewriteUrls?: ReadonlyMap<string, string>;
  /**
   * Email dark mode's adaptive path (`emailDark.ts`): every colour the sender wrote in
   * a `style` attribute, `bgcolor` or `color` is re-mapped for this dark palette while
   * sanitising. Absent — light mode, the setting off, "Show original colours", or a
   * message with its own dark styles — and the output is exactly what it always was.
   * The replacements are colours this code formats, so nothing a sender wrote gains a
   * way past the allowlist.
   */
  recolour?: DarkPalette;
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
   * Reported rather than silent: a truncated message that looks complete produces no
   * visible symptom.
   */
  truncated: boolean;
};

/** A no-op option set, so callers that do not care can pass `{}`. */
const DEFAULTS: SanitizeOptions = { allowRemote: false };

/**
 * Turn a message body into markup that is safe to render in this document.
 *
 * The security contract:
 *
 *   - no element outside the allowlist is rendered, and the ones dropped with
 *     their contents are dropped *with* their contents;
 *   - no attribute outside the allowlist survives, and every `on*` handler is gone
 *     because `on*` is not on any list;
 *   - no `style` block reaches the output unless `collectStyles` asked for it, and
 *     a `style` attribute has had every fetch and every script removed;
 *   - no URL survives that is not `http`, `https`, `mailto`, `tel`, `sms`, `ftp`,
 *     an inert `data:image`, or a `cid:` resolved against the message's own parts;
 *   - no element is left open, so a sender's missing `</td>` cannot swallow the
 *     rest of the reader's document.
 *
 * It does *not* claim to be harmless as a standalone document: it is safe only *as
 * message content inside the reader's message container*.
 */
export function sanitizeMailHtml(html: string, options: Partial<SanitizeOptions> = {}): SanitizedMail {
  const settings = { ...DEFAULTS, ...options };
  const { allowRemote, inlineParts, rewriteUrls, recolour } = settings;

  // One lowercased copy of the body, for the element-boundary search: lowercasing
  // per dropped element made a newsletter full of buttons quadratic in its own size.
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

    // Not a tag: `<` followed by anything that cannot begin a name, end tag, comment
    // or declaration is literal text, which keeps "a < b" readable.
    if (next === undefined || !/[a-zA-Z!/?]/.test(next)) {
      if (!write("&lt;")) break;
      i = lt + 1;
      continue;
    }

    // Comment, including the conditional ones (`<!--[if mso]>…<![endif]-->`), whose
    // syntax can hide a tag from a scanner that skips to `-->` naively.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? html.length : end + 3;
      continue;
    }

    // Doctype, CDATA, processing instruction. Dropped: none carry content, and a
    // CDATA section in HTML is a parsing-mode confusion waiting to happen.
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
      // Unbalanced markup: an end tag for something not open is dropped, and anything
      // it *should* have closed is closed first — the only reason a `</td>` with no
      // `<td>` does not take the rest of the document with it.
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

    // A tag that never closes is not a tag: the `<` becomes text and scanning
    // resumes after it, so the `>` inside the attribute value is not swallowed.
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
      // A void element has no end tag, so the search would run to the end of the
      // document and swallow the message. See `VOID_ELEMENTS`.
      if (!VOID_ELEMENTS.has(name)) i = findElementEnd(html, lower, i, name);
      continue;
    }

    if (UNWRAP.has(name)) {
      // The envelope, and `font`/`center` from before CSS. The tag goes and its
      // *contents stay* — scanning resumes just past the start tag — so a message
      // that arrived as a full document is scanned rather than skipped.
      continue;
    }

    if (!ALLOWED_TAGS.has(name)) {
      // Unknown, not on the drop-with-content list. Its contents are kept: an
      // unrecognised element in mail is nearly always a wrapper (`<section>`,
      // `<article>`, a vendor's `<v:roundrect>`).
      continue;
    }

    if (open.length >= MAX_DEPTH) {
      // Too deep. Unwrapped rather than rendered, keeping the text and dropping the
      // depth; no end tag is pushed, so nothing to balance later.
      continue;
    }

    const attrs: string[] = [];
    // Whether the anchor ended up with somewhere to go; the `target`/`rel` pair below
    // is only emitted when it did, because `target="_blank"` with no `href` is a
    // decorative lie the click handler cannot honour.
    let href = false;

    // The element's own `bgcolor`, so a text colour beside it is held to AA against it.
    let elementBackground: Rgba | null = null;
    if (recolour) {
      const bg = parsed.attributes.find((a) => a.name === "bgcolor");
      const raw = bg ? decodeEntities(bg.value).trim() : "";
      elementBackground = raw ? (parseColor(raw) ?? (/^[0-9a-f]{6}$/i.test(raw) ? parseColor(`#${raw}`) : null)) : null;
    }

    for (const attribute of parsed.attributes) {
      const allowed =
        GLOBAL_ATTRS.has(attribute.name) ||
        TAG_ATTRS[name]?.has(attribute.name) === true;

      // Neither `on*` nor an `xmlns` that renames the namespace is on any list.
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
            // Lazy, so forty images do not open forty sockets before any is seen.
            // No Referer: the app's own address (`http://tauri.localhost`, or wherever
            // the web build is hosted) is not the sender's business, and an allowed image
            // is still a request to a stranger's server.
            attrs.push('loading="lazy"', 'decoding="async"', 'referrerpolicy="no-referrer"');
          } else if (resolved.blocked) {
            // The element survives with its address in a data attribute, so it keeps
            // its `alt` and the reader can account for it.
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
          const styled = resolved.value && recolour
            ? recolourDeclarations(resolved.value, recolour, elementBackground)
            : resolved.value;
          if (styled) attrs.push(`style="${escapeAttribute(styled)}"`);
          break;
        }
        case "width":
        case "height": {
          // A percentage is a *proportion*; clamping `width="100%"` to
          // `MAX_DIMENSION` is how a message that fits becomes one that does not.
          if (/%$/.test(value.trim())) {
            attrs.push(`${attribute.name}="${escapeAttribute(value.trim())}"`);
            break;
          }
          const numeric = Number.parseInt(value, 10);
          if (Number.isFinite(numeric) && numeric > 0) {
            // Clamped rather than dropped: the layout is usually still right, whereas
            // a dropped `width` is always wrong.
            attrs.push(`${attribute.name}="${Math.min(numeric, MAX_DIMENSION)}"`);
          }
          break;
        }
        case "bgcolor":
        case "color": {
          const decoded = decodeEntities(value);
          const out = recolour
            ? recolourAttribute(decoded, attribute.name === "bgcolor" ? "background" : "text", recolour, elementBackground)
            : decoded;
          attrs.push(`${attribute.name}="${escapeAttribute(out)}"`);
          break;
        }
        case "target":
        case "rel": {
          // Both are ours to choose and dropped whatever the sender wrote: links open
          // in the system browser, so the message never gets a handle on this window.
          // Emitted after the loop, because `rel` may follow `href` and the `href` may
          // have been dropped entirely.
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

    // Implicit closing, before the element is pushed. A browser does not need
    // `</td>` before the next `<td>`, and HTML mail omits it constantly.
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
 * Two copies of a stylesheet — one rooted at `body`, one at `[data-wn-email]` — had
 * every chance to drift, a defect this codebase has already paid for with theme
 * tokens that existed in the Tailwind config and not in `theme.ts`. So there is one
 * list, and [`emailDocumentCss`] and [`inlineEmailCss`] are two serialisations.
 *
 * **The container keeps a light surface in both themes, on purpose.** A white
 * newsletter (`color: #333`, `background: #fff`) rendered in dark-mode grey is
 * unreadable; like Gmail and Apple Mail, the message keeps the sender's own surface
 * and the app puts chrome around it. Email dark mode (1.4.0) is the one exception, and
 * it does not change this list: it adds [`inlineEmailDarkCss`] on top and recolours the
 * sender's colours to match (`emailDark.ts`).
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
    // Often does not bind: an auto-layout table sizes to its contents, so a nested
    // `width:640px` table ignores it. A message still wider than the reader is zoomed
    // to fit by `MessageBody` (`ui/emailFit.ts`), as mail clients do.
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
    // Gmail wraps every message in a `div` and Outlook emits nested `div`s; without
    // this a wrapper inherits the reader's font size and arrives as 11px chrome.
    `font-size: inherit;`,
  ],
  // An image whose address was withheld. It stays with its `alt` so the reader can
  // account for it, and is drawn so its absence is a visible gap rather than a
  // silent one.
  [
    "img[data-wn-blocked-src]",
    `display: inline-block; min-width: 1.5em; min-height: 1.5em; max-width: 100%;
     border: 1px dashed #B9C0C5; border-radius: 4px; background: #EEF1F2;`,
  ],
];

/**
 * The attribute every container carries, in both forms.
 *
 * A hook for the stylesheet and for tests, deliberately not a class: `class`
 * collides with the sender's own arbitrary class names.
 */
const CONTAINER_ATTRIBUTE = "data-wn-email";

/**
 * Serialise the baseline, choosing what the container selector resolves to.
 *
 * Every part of a selector *list* is scoped, not just the first: `[data-wn-email]
 * h4, h5, h6` would otherwise reach the reader's own headings, which is the whole
 * thing this exists to prevent.
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
 * What the sandboxed frame and the render proxy both use, and what `emailDocument`
 * inlines.
 */
export function emailDocumentCss(): string {
  return serialiseBaseline("body");
}

/**
 * The baseline as a scoped stylesheet, for rendering into the reader's document.
 *
 * Every selector descends from `[data-wn-email]`, so no rule here can reach the
 * reader's chrome and no reader rule can restyle a message without naming that
 * attribute. Rewriting selectors rather than using `@media` or a `ShadowRoot` is
 * deliberate: the query would need replicating per width, and a shadow root would
 * inherit nothing from the app — the *document* form's job, not this one's.
 */
export function inlineEmailCss(): string {
  return serialiseBaseline(`[${CONTAINER_ATTRIBUTE}]`);
}

/**
 * Email dark mode's baseline (1.4.0): the same container drawn on the theme's surface
 * with the theme's ink, and the few baseline rules that name a light colour (links,
 * quotes, code, rules, the withheld-image box) given dark ones. Every selector carries
 * `[data-wn-dark]` as well, so it outranks the light baseline and still loses to the
 * sender's own (scoped, later) rules and inline styles, which `emailDark.ts` recolours.
 * Used for both dark paths: a message with its own dark styles still needs a dark page.
 */
export function inlineEmailDarkCss(palette: DarkPalette): string {
  const scope = `[${CONTAINER_ATTRIBUTE}][data-wn-dark]`;
  return [
    `${scope} { color: ${palette.ink}; background: ${palette.surface}; color-scheme: dark; }`,
    `${scope} a { color: ${palette.link}; }`,
    `${scope} blockquote { border-left-color: #4A4A4A; color: #B8B8B8; }`,
    `${scope} pre { background: rgba(255, 255, 255, 0.07); }`,
    `${scope} hr { border-top-color: rgba(255, 255, 255, 0.16); }`,
    `${scope} img[data-wn-blocked-src] { border-color: #5A5A5A; background: rgba(255, 255, 255, 0.06); }`,
    `${scope} [data-wn-copy-button] button { background: #333333; color: ${palette.ink}; }`,
  ].join("\n");
}

/**
 * Build a complete, standalone document for a message.
 *
 * For the reader's "Show as the sender wrote it" (`sandbox=""` frame) and the render
 * proxy. The sender's stylesheets come back already sanitised and are re-homed here,
 * which is safe because this document contains nothing else.
 */
export function emailDocument(body: string, stylesheets: readonly string[] = []): string {
  // `</` cannot end the element whatever the sheet contains; the sanitiser already
  // escapes it, so this is the backstop for a sheet from anywhere else.
  const sender = stylesheets.join("\n").trim().replace(/<\//g, "\\3c /");
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    // Without this a white newsletter renders as a white block on a black pane.
    '<meta name="color-scheme" content="light">',
    // A `srcdoc` frame inherits the app's referrer policy, and the frame's own
    // `referrerpolicy` attribute covers only its navigation, not what its document loads.
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    sender ? `<style>${sender}</style>` : "",
    `<style>${emailDocumentCss()}</style>`,
    "</head>",
    `<body ${CONTAINER_ATTRIBUTE}>`,
    body,
    "</body></html>",
  ].join("");
}
