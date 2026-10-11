/**
 * HTML → plain text, and the rules for showing HTML safely.
 *
 * Extraction drops `script`/`style`/`head` *with their contents* before turning
 * block ends into newlines and stripping tags. Rendering sanitises first
 * (`sanitize.ts`); the remote-reference counting here reports what it withheld.
 */

/** Containers whose *contents* are code, not prose. */
const DROPPED_BLOCKS = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Tag names that imply a line break. */
const BLOCK_ENDS = /<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi;

/** Any remaining tag. */
const ANY_TAG = /<[^>]+>/g;

/** Three or more consecutive newlines, collapsed to a paragraph break. */
const EXTRA_BLANK_LINES = /\n{3,}/g;

/*
 * `nbsp` decodes to a real non-breaking space rather than an ordinary one: a
 * space would silently insert one into a name like `Tom&nbsp;Jerry`.
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: "\u00a0",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
};

/** Decode the entities that actually turn up in mail, named and numeric. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    const known = NAMED_ENTITIES[body];
    if (known !== undefined) return known;

    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const digits = isHex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, isHex ? 16 : 10);
      // A bogus entity producing NaN would make `String.fromCodePoint` throw.
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
    }

    // Eating an unrecognised entity would corrupt text like "AT&T".
    return match;
  });
}

/** A readable plain-text rendering of an HTML mail body. */
export function plainTextFromHtml(html: string): string {
  if (!html) return "";
  return decodeEntities(
    html
      .replace(DROPPED_BLOCKS, "")
      .replace(BLOCK_ENDS, "\n")
      .replace(ANY_TAG, ""),
  )
    .replace(EXTRA_BLANK_LINES, "\n\n")
    .replace(/^[ \t]+|[ \t]+$/gm, "")
    .trim();
}

/**
 * Characters that must never appear in a display name: controls, and zero-width
 * or bidi formatting. `U+202E` displays a name as something other than what it
 * is — the oldest display-name spoofing trick there is.
 */
function isUnsafeNameChar(code: number): boolean {
  if (code <= 0x1f) return true; // C0 controls
  if (code >= 0x7f && code <= 0x9f) return true; // DEL and C1 controls
  if (code >= 0x200b && code <= 0x200f) return true; // zero-width space through RLM
  if (code >= 0x202a && code <= 0x202e) return true; // bidi embedding and overrides
  if (code >= 0x2066 && code <= 0x2069) return true; // bidi isolates
  if (code === 0xfeff) return true; // BOM, used as a zero-width no-op
  return false;
}

/**
 * Strip control and format characters from a display name; ordinary non-ASCII
 * is a legitimate name and is preserved.
 */
export function sanitizeDisplayName(name: string): string {
  let out = "";
  for (const char of name) {
    if (!isUnsafeNameChar(char.codePointAt(0)!)) out += char;
  }
  return (
    out
      .replace(/\s+/g, " ")
      .trim()
      // RFC 5322 display-name length; a longer "name" is a mistake or an attempt
      // to push the address out of the reader's view.
      .slice(0, 128)
  );
}

/** Extract an address from a `Display Name <addr@example.com>` header. */
export function parseAddressHeader(raw: string): { name?: string; address: string } | null {
  const angled = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (angled) {
    const name = sanitizeDisplayName(angled[1]);
    return { name: name || undefined, address: angled[2].trim() };
  }
  const address = raw.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return null;
  return { address };
}

/** A tag, and the attributes inside it. Matching real tags keeps quoted HTML in the text from counting. */
const TAG = /<[a-zA-Z][^>]*>/g;
const ATTRIBUTE =
  /([a-zA-Z][a-zA-Z0-9:_.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const URL_FUNCTION = /url\(\s*['"]?(?!data:|#)[^)'"\s]*['"]?\s*\)/gi;
/** `@import` with or without a `url()` around it. Both spellings fetch. */
const AT_IMPORT = /@import\s+(?:url\(\s*)?['"]?(?!data:|#)[^;)'"\s]*/gi;

/** A `data:` URI: inline bytes already inside the message, involving nobody. */
const INLINE_DATA_URI = /^\s*data:/i;

/** A value that names something to fetch: a scheme, a protocol-relative URL, or `url()`. */
const NAMES_A_RESOURCE = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Attributes whose value is a URL by definition. */
const URL_ATTRIBUTES = new Set(["src", "srcset", "poster"]);

/** A `<style>` element and its contents, which is the one place CSS can fetch. */
const STYLE_BLOCK = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

/**
 * The remote references a body contains, for the "images blocked" note: real tags
 * and `<style>` contents, skipping `data:` URIs and non-URL attribute values.
 */
export function remoteReferences(html: string): string[] {
  const found: string[] = [];

  for (const tag of html.matchAll(TAG)) {
    for (const attribute of tag[0].matchAll(ATTRIBUTE)) {
      const name = attribute[1].toLowerCase();
      const value = attribute[2] ?? attribute[3] ?? attribute[4] ?? "";
      if (INLINE_DATA_URI.test(value)) continue;

      if (URL_ATTRIBUTES.has(name)) {
        found.push(value);
        continue;
      }

      if (name === "background") {
        // `background` carries a colour or a URL; only the latter is a request.
        if (NAMES_A_RESOURCE.test(value)) found.push(value);
        continue;
      }

      if (name === "style") {
        for (const url of value.matchAll(URL_FUNCTION)) found.push(url[0]);
      }
    }
  }

  // `<style>` contents hold font imports and sprite sheets. `@import` is removed
  // first so `@import url(…)` is not also matched by `URL_FUNCTION` and counted
  // twice — a counter that double-counts is the same class of lie as one that
  // under-counts, just less embarrassing.
  for (const block of html.matchAll(STYLE_BLOCK)) {
    const withoutImports = (block[1] ?? "").replace(AT_IMPORT, "");
    for (const imported of (block[1] ?? "").matchAll(AT_IMPORT)) found.push(imported[0]);
    for (const url of withoutImports.matchAll(URL_FUNCTION)) found.push(url[0]);
  }

  return found;
}

/** How many remote references a body contains, for the "images blocked" note. */
export function countRemoteReferences(html: string): number {
  return remoteReferences(html).length;
}