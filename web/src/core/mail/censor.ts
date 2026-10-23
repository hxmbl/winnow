/**
 * Censor email addresses (Settings → Appearance → "Censor email addresses").
 *
 * For screenshots and screen sharing: with the switch on, every address the app *shows*
 * is replaced, in the rendered text itself, by random letters of the same length
 * ("example@example.com" → "dsakofjljfdsjfdskfj"), and the UI then blurs it. The real
 * address is not in the page's text, so a screenshot, a copy or a screen reader cannot
 * leak it, and the blur says "something was here" without the reader having to parse noise.
 *
 * **Display only.** Nothing here touches what is sent to Gmail: recipients, reply
 * headers, drafts, the store. The DOM side (`ui/censorDom.ts`) never edits an input, a
 * textarea or anything editable, and a link's real target is kept beside the element
 * rather than in it, so a click still goes where the sender meant.
 *
 * **Stable per address for the session.** The same address always becomes the same
 * letters (case-insensitively, so `Ana@x.com` and `ana@x.com` agree), so a list does not
 * jitter on every render and two rows from one sender still look like one sender. The
 * letters are not derived from the address — a hash would let anyone who can guess an
 * address confirm it — they are drawn at random the first time it is seen and kept in
 * memory only.
 *
 * Pure: the random source is injected, and nothing here knows about the DOM.
 */

/**
 * An address as it appears in running text: a local part, an `@`, and a dotted domain
 * ending in a letter label. Deliberately generous (an `icon@2x.png` file name matches
 * too): over-censoring a file name costs nothing, missing an address is the leak.
 */
const ADDRESS = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;

/** Letters only: no `@` or `.`, so a scrambled address never matches `ADDRESS` again. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** A source of numbers in [0, 1), like `Math.random`. */
export type Random = () => number;

/** True when `text` holds at least one address. Cheap enough to call on every text node. */
export function hasAddress(text: string): boolean {
  if (!text.includes("@")) return false;
  ADDRESS.lastIndex = 0;
  return ADDRESS.test(text);
}

/** Every address in `text`, in order. */
export function findAddresses(text: string): string[] {
  if (!text.includes("@")) return [];
  return text.match(ADDRESS) ?? [];
}

/** One piece of a censored text: plain text, or an address already scrambled. */
export type CensorPart = { text: string; censored: boolean };

export class AddressScrambler {
  private readonly byAddress = new Map<string, string>();
  private readonly used = new Set<string>();

  constructor(private readonly random: Random = Math.random) {}

  /** The stand-in for one address: same length, random letters, the same every time. */
  scramble(address: string): string {
    const key = address.toLowerCase();
    const known = this.byAddress.get(key);
    if (known !== undefined) return known;
    let out = "";
    // A collision between two addresses would make two senders look like one; vanishingly
    // rare at any real length, but cheap to rule out.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      out = "";
      for (let i = 0; i < address.length; i += 1) {
        out += ALPHABET[Math.min(ALPHABET.length - 1, Math.floor(this.random() * ALPHABET.length))];
      }
      if (!this.used.has(out)) break;
    }
    this.byAddress.set(key, out);
    this.used.add(out);
    return out;
  }

  /** `text` with every address in it scrambled. Text without an `@` comes back as is. */
  censorText(text: string): string {
    if (!text.includes("@")) return text;
    return text.replace(ADDRESS, (match) => this.scramble(match));
  }

  /**
   * `text` split into plain and censored pieces, for a renderer that wraps each address
   * (to blur it) rather than replacing it in place. Adjacent plain text is one piece.
   */
  censorParts(text: string): CensorPart[] {
    const parts: CensorPart[] = [];
    if (!text.includes("@")) return [{ text, censored: false }];
    let last = 0;
    ADDRESS.lastIndex = 0;
    for (let match = ADDRESS.exec(text); match !== null; match = ADDRESS.exec(text)) {
      if (match.index > last) parts.push({ text: text.slice(last, match.index), censored: false });
      parts.push({ text: this.scramble(match[0]), censored: true });
      last = match.index + match[0].length;
    }
    if (last < text.length) parts.push({ text: text.slice(last), censored: false });
    return parts;
  }
}

/**
 * Is this text node "just an address", so the element holding it can be blurred whole?
 * True when, once the addresses are taken out, nothing is left but punctuation that
 * belongs to an address (`<…>`, quotes, brackets, commas) and spaces.
 */
export function isAddressOnly(text: string): boolean {
  if (!hasAddress(text)) return false;
  return text.replace(ADDRESS, "").replace(/[\s<>()[\]"',;:]/g, "") === "";
}

/**
 * The notification fields a person reads, censored; everything a press acts on (ids,
 * the reply's header block, which goes to Gmail) left exactly as it was.
 */
export function censorNotice<T extends { title: string; subject: string; preview: string }>(
  notice: T,
  scrambler: AddressScrambler,
): T {
  return {
    ...notice,
    title: scrambler.censorText(notice.title),
    subject: scrambler.censorText(notice.subject),
    preview: scrambler.censorText(notice.preview),
  };
}
