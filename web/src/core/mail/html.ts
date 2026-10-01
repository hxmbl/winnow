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
 * Strip a body's remote references, for the default privacy posture.
 *
 * Winnow does not load remote images by default. A tracking pixel confirms a
 * message was opened and roughly where; a remote stylesheet can exfiltrate
 * anything in the DOM. Both are removed by dropping `src`/`background`/
 * `srcset` from the markup, which leaves the text and layout intact.
 */
export function stripRemoteReferences(html: string): string {
  return html
    .replace(/\s(?:src|srcset|background|poster)\s*=\s*"(?:(?!").)*"/gi, ' data-blocked-src="true"')
    .replace(/url\(\s*['"]?(?!data:|#)[^)'\s]*['"]?\s*\)/gi, "url()");
}

/** Count the remote references a body contains, for the "images blocked" note. */
export function countRemoteReferences(html: string): number {
  const matches = html.match(/\s(?:src|srcset|background|poster)\s*=\s*"(?:(?!").)*"/gi);
  return matches?.length ?? 0;
}
