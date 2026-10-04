/**
 * HTML → plain text, and the rules for showing HTML safely.
 *
 * Winnow has two jobs here and the second matters more than the first.
 *
 * **Extraction.** Needed for search, classification, and quoting when a message
 * is HTML-only. The order is deliberate: drop `script`/`style`/`head` *with
 * their contents* first (their text is code, not prose), then turn block ends
 * into newlines, then strip the remaining tags. Reversing the first two steps
 * would leave JavaScript source in the middle of a quoted reply.
 *
 * **Rendering.** The reader never injects message HTML into the document
 * unsanitised — a sender controls it completely. Rather than write an
 * allowlist-based sanitiser, Winnow renders text and offers a per-message
 * "show the original" that opens in the system browser, outside the app's
 * origin. That is a smaller amount of security-critical code, which is the
 * right trade for a mail client.
 */

/** Containers whose *contents* are code, not prose. */
const DROPPED_BLOCKS = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi;

/** Tag names that imply a line break. */
const BLOCK_ENDS = /<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi;

/** Any remaining tag. */
const ANY_TAG = /<[^>]+>/g;

/** Three or more consecutive newlines, collapsed to a paragraph break. */
const EXTRA_BLANK_LINES = /\n{3,}/g;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
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
      // Guard against a bogus entity producing NaN, which `String.fromCodePoint`
      // turns into a thrown error inside a render.
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        return String.fromCodePoint(code);
      }
    }

    // An unrecognised entity is left alone rather than eaten: dropping it
    // would corrupt text like "AT&T" that happened to be escaped oddly.
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
 * Characters that must never appear in a display name.
 *
 * Three groups, all of them sender-controlled:
 *
 *   - C0 controls and DEL. A NUL truncates the string in some parsers, so
 *     everything after it silently disappears from the byline.
 *   - C1 controls, which some renderers interpret as escape sequences.
 *   - Zero-width and bidi formatting characters. `U+202E` is the right-to-left
 *     override: a name containing it *displays* as something different from what
 *     it is, which is the oldest display-name spoofing trick there is. A
 *     zero-width joiner in the middle of a name breaks naive equality checks, so
 *     `ada\u200b` and `ada` compare differently while looking identical.
 *
 * Expressed as code ranges and applied as a loop rather than a regex, because a
 * regex over control-character ranges is precisely the pattern that needs an
 * eslint suppression — and this is the one file where such a suppression would
 * be least welcome.
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
 * Strip control and format characters from a display name.
 *
 * Ordinary non-ASCII is preserved: a name in any script is a legitimate name,
 * and mangling it would be a visible bug in exactly the case this function
 * exists to protect.
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
      // RFC 5322 display-name length. A longer "name" is either a mistake or
      // an attempt to push the address out of the reader's view.
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

/**
 * A tag, and the attributes inside it.
 *
 * Tags rather than the whole document, deliberately. The old counter matched
 * `src="…"` anywhere in the string, which meant a message whose *text* quoted an HTML
 * snippet — `<pre>&lt;img src="https://x.example/p.gif"&gt;</pre>`, which is how most
 * newsletters explain their own unsubscribe link — announced a tracking pixel that
 * was never going to load. Requiring a real tag means only things a renderer would
 * actually fetch are counted.
 */
const TAG = /<[a-zA-Z][^>]*>/g;
const ATTRIBUTE =
  /([a-zA-Z][a-zA-Z0-9:_.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
const URL_FUNCTION = /url\(\s*['"]?(?!data:|#)[^)'"\s]*['"]?\s*\)/gi;

/** A `data:` URI: inline bytes already inside the message, involving nobody. */
const INLINE_DATA_URI = /^\s*data:/i;

/** A value that names something to fetch: a scheme, a protocol-relative URL, or `url()`. */
const NAMES_A_RESOURCE = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Attributes whose value is a URL by definition. */
const URL_ATTRIBUTES = new Set(["src", "srcset", "poster"]);

/**
 * The remote references a body contains.
 *
 * This feeds a privacy claim — "3 remote references were blocked" tells the user what
 * Winnow chose not to fetch on their behalf — so it has to be right about what a
 * *remote reference* is, and it was not. It counted every `src`, `srcset`,
 * `background` and `poster` attribute anywhere in the document, which sweeps up three
 * things that are not remote anything:
 *
 *   - `data:` URIs, which are bytes already inside the message,
 *   - `background="#ffffff"`, a colour and not a request,
 *   - escaped HTML inside the message's own text, which no renderer would fetch.
 *
 * A newsletter with an inline logo, a tinted table and a quoted `<img>` snippet
 * reported "4 remote references were blocked" while fetching nothing. So the note was
 * telling the user the opposite of the truth about their own privacy — which is worse
 * than saying nothing, because somebody who reads "nothing was blocked" stops
 * checking.
 *
 * The references are returned rather than counted so the shapes can be asserted; the
 * count is the presentation of that list, not a separate piece of arithmetic.
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
        // The attribute that carries both a colour and a URL. Only the second is a
        // request, and conflating them is the most common false positive in mail.
        if (NAMES_A_RESOURCE.test(value)) found.push(value);
        continue;
      }

      if (name === "style") {
        for (const url of value.matchAll(URL_FUNCTION)) found.push(url[0]);
      }
    }
  }

  return found;
}

/**
 * How many remote references a body contains, for the "images blocked" note.
 *
 * A message with none gets no note at all, which is exactly why an inflated count is
 * a lie rather than a rounding error: the number only ever appears above zero, and it
 * is read as "this is all Winnow kept you from loading".
 */
export function countRemoteReferences(html: string): number {
  return remoteReferences(html).length;
}