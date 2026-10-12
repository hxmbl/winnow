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

/**
 * Extract an address from a `Display Name <addr@example.com>` header.
 *
 * The name is taken as everything before the angle brackets rather than as "an optional
 * pair of quotes around characters that are not quotes", because a quoted-string
 * display name may itself contain a quote: `"Ada \"Countess\"" <ada@example.com>` is a
 * legal `From`, and the simpler pattern does not match it — which sent the whole raw
 * header out as the sender's address.
 */
export function parseAddressHeader(raw: string): { name?: string; address: string } | null {
  const angled = raw.match(/^\s*(.*?)<([^>]+)>\s*$/);
  if (angled) {
    const name = sanitizeDisplayName(unguess(angled[1]));
    return { name: name || undefined, address: angled[2].trim() };
  }
  const address = raw.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) return null;
  return { address };
}

/**
 * The contents of a quoted string, or the string itself.
 *
 * RFC 5322 §3.4.2 lets a quoted-pair stand for a character the grammar would otherwise
 * reserve, so `\"` inside a display name is a quote and not a terminator.
 */
function unguess(raw: string): string {
  const value = raw.trim();
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(.)/g, "$1");
}

/**
 * Every address in an RFC 5322 address list, in order.
 *
 * Not `split(",")`. A display name may be quoted and contain the separator —
 * `"Ng, Alex" <alex@example.com>` is one address, and the naive split makes it
 * two fragments, neither of which parses. So the scan tracks the three places a comma
 * can be harmless: inside quotes, inside a comment, and inside angle brackets. Comments
 * are dropped rather than kept, because a comment is not part of the address.
 *
 * Group syntax (`Team: a@example.com, b@example.com;`) is unwrapped, and the group's
 * label becomes the display name of an address that has none — which is how a
 * mail client renders it, and better than losing the name entirely.
 */
export function parseAddressList(raw: string): { name?: string; address: string }[] {
  const out: { name?: string; address: string }[] = [];
  for (const chunk of splitAddressList(raw)) {
    const parsed = addressFromChunk(chunk);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Cut an address list into one chunk per address.
 *
 * State is three booleans and a counter rather than a regular expression because the
 * grammar is not regular: a quoted string can contain an escaped quote, and a comment
 * can nest.
 */
function splitAddressList(raw: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let quoted = false;
  let angled = false;
  let comment = 0;

  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];

    if (comment > 0) {
      // Backslash escapes inside a comment swallow the next character, so a `)` that
      // is itself escaped does not close the comment.
      if (char === "\\") i += 1;
      else if (char === "(") comment += 1;
      else if (char === ")") comment -= 1;
      continue;
    }

    if (quoted) {
      current += char;
      if (char === "\\" && i + 1 < raw.length) {
        current += raw[i + 1];
        i += 1;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
      current += char;
      continue;
    }
    if (char === "(") {
      comment = 1;
      continue;
    }
    if (char === "<") angled = true;
    else if (char === ">") angled = false;
    else if (char === "," && !angled) {
      chunks.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  chunks.push(current);
  return chunks;
}

/** One chunk of a split list, unwrapping a group and dropping a stray `;`. */
function addressFromChunk(chunk: string): { name?: string; address: string } | null {
  const value = chunk.trim().replace(/;+\s*$/, "").trim();
  if (value === "") return null;

  // A group label is a colon before any angle bracket or quote. Requiring the address
  // part to be there afterwards keeps a malformed group from swallowing the rest of the
  // header, which is what `parseAddressHeader(null)` cannot protect us from.
  const group = /^([^:<>"@]+):/.exec(value);
  if (group) {
    const label = sanitizeDisplayName(unguess(group[1]));
    const parsed = parseAddressHeader(value.slice(group[0].length));
    if (!parsed) return null;
    return { address: parsed.address, name: parsed.name ?? (label || undefined) };
  }

  return parseAddressHeader(value);
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