/**
 * Blur sensitive info (Settings → Appearance → "Blur sensitive info").
 *
 * For screenshots and screen sharing. A stepped choice, each step adding to the one
 * before it:
 *
 *   off        nothing changes;
 *   emails     email addresses;
 *   passwords  + passwords and passcodes given in mail ("Password: hunter2");
 *   addresses  + postal addresses (street lines, UK postcodes, US state and ZIP);
 *   names      + people's names Winnow knows (senders, recipients, contacts).
 *
 * Each thing found is replaced, in the rendered text itself, by random letters of one
 * fixed length (`STAND_IN_LENGTH`), and the UI then blurs it. The real value is not in
 * the page's text, so a screenshot, a copy or a screen reader cannot leak it, and the
 * fixed length means not even the length of an address or a password gives it away.
 *
 * **Best effort.** Addresses are matched exactly; passwords only where a label says so;
 * postal addresses and names by pattern and by the names Winnow has seen. Something
 * written another way can get through, and Settings says so.
 *
 * **Display only.** Nothing here touches what is sent to Gmail: recipients, reply
 * headers, drafts, the store. The DOM side (`ui/censorDom.ts`) never edits an input, a
 * textarea or anything editable, and a link's real target is kept beside the element
 * rather than in it, so a click still goes where the sender meant.
 *
 * **Stable per value for the session.** The same value always becomes the same letters
 * (case-insensitively), so a list does not jitter on every render and two rows from one
 * sender still look like one sender. The letters are not derived from the value — a hash
 * would let anyone who can guess an address confirm it — they are drawn at random the
 * first time it is seen and kept in memory only.
 *
 * Pure: the random source is injected, and nothing here knows about the DOM.
 */

export const CENSOR_LEVELS = ["off", "emails", "passwords", "addresses", "names"] as const;
export type CensorLevel = (typeof CENSOR_LEVELS)[number];

export function isCensorLevel(value: unknown): value is CensorLevel {
  return typeof value === "string" && (CENSOR_LEVELS as readonly string[]).includes(value);
}

/** True when `level` covers `kind`: the steps are cumulative. */
export function covers(level: CensorLevel, kind: Exclude<CensorLevel, "off">): boolean {
  return CENSOR_LEVELS.indexOf(level) >= CENSOR_LEVELS.indexOf(kind);
}

/** Every stand-in is this many letters, whatever it hides. */
export const STAND_IN_LENGTH = 12;

/**
 * An address as it appears in running text: a local part, an `@`, and a dotted domain
 * ending in a letter label. Deliberately generous (an `icon@2x.png` file name matches
 * too): over-censoring a file name costs nothing, missing an address is the leak.
 */
const ADDRESS = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;

/** The words that introduce a password. */
const SECRET_LABEL = String.raw`(?:temporary |one[- ]time |initial |new |your )?(?:password|passcode|passwd|pwd|pin)`;
/** A label, a separator (`:`, `=`, a dash or "is") and its value: the value is the group. */
const SECRET = new RegExp(String.raw`\b${SECRET_LABEL}\b\s*(?:[:=\-–]|\bis\b:?)\s*([^\s<>"'“”]{3,64})`, "gi");
/** A text that ends on a label, so its value is the next piece of text (`Password: <b>x</b>`). */
const SECRET_LABEL_AT_END = new RegExp(String.raw`\b${SECRET_LABEL}\b\s*(?:[:=\-–]|\bis\b:?)\s*$`, "i");
/** Words a label is followed by that are not a password ("password reset", "pin code"). */
const NOT_A_SECRET = /^(?:reset|resets|change|changed|changes|for|to|and|or|the|your|a|an|is|was|will|must|should|has|have|of|on|in|with|code|number|protected|manager|requirements?|expired?|expires|policy|link|here|below|above)$/i;

/** Street names: a number, one to four capitalised words, and a street type. */
const STREET = /\b\d{1,5}[A-Za-z]?,?\s+(?:[A-Z][A-Za-z'’-]*\s+){1,4}(?:Street|St|Road|Rd|Avenue|Ave|Lane|Ln|Drive|Dr|Close|Way|Court|Ct|Place|Pl|Boulevard|Blvd|Crescent|Cres|Terrace|Gardens|Grove|Square|Sq|Mews|Row|Hill|Park|Parade|Walk|Highway|Hwy)\b\.?/g;
/** UK postcodes, as written on an envelope. */
const POSTCODE = /\b(?:[A-Z]{1,2}\d[A-Z\d]?|GIR) ?\d[A-Z]{2}\b/g;
/** A US state abbreviation and ZIP ("CA 94103", "NY 10001-1234"). */
const ZIP = /\b[A-Z]{2},?\s+\d{5}(?:-\d{4})?\b/g;

/** Letters only: no `@` or `.`, so a stand-in never matches a pattern again. */
const ALPHABET = "abcdefghijklmnopqrstuvwxyz";

/** A source of numbers in [0, 1), like `Math.random`. */
export type Random = () => number;

/** One piece of a censored text: plain text, or a value already replaced. */
export type CensorPart = { text: string; censored: boolean };

type Span = { start: number; end: number };

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Turn display names into the whole names and the name parts worth matching: each
 * name as written, and each capitalised word of two letters or more in it. A name that
 * is really an address, or a word with no capital, is left out.
 */
export function nameTerms(names: Iterable<string | undefined | null>): string[] {
  const terms = new Set<string>();
  for (const raw of names) {
    const name = (raw ?? "").replace(/["“”]/g, "").trim();
    if (!name || name.includes("@") || name.length > 80) continue;
    if (/^\p{Lu}/u.test(name)) terms.add(name);
    for (const part of name.split(/[\s,()]+/)) {
      if (part.length >= 2 && /^\p{Lu}[\p{L}'’-]+$/u.test(part)) terms.add(part);
    }
  }
  return [...terms];
}

export class Scrambler {
  private readonly byValue = new Map<string, string>();
  private readonly used = new Set<string>();
  private level: CensorLevel = "emails";
  private names: RegExp | null = null;

  constructor(private readonly random: Random = Math.random) {}

  /**
   * What to look for: the level, and the names (`nameTerms`) when the level covers
   * them. Values already seen keep their letters.
   */
  configure(level: CensorLevel, names: readonly string[] = []): void {
    this.level = level;
    const terms = covers(level, "names") ? [...names].filter((term) => term.length >= 2) : [];
    terms.sort((a, b) => b.length - a.length);
    this.names = terms.length > 0
      ? new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${terms.slice(0, 4000).map(escape).join("|")})(?![\p{L}\p{N}])`, "gu")
      : null;
  }

  get currentLevel(): CensorLevel {
    return this.level;
  }

  /**
   * A cheap test for "could hold something", to skip most text nodes without running
   * every pattern: an `@`, a digit, a capital letter or a password label.
   */
  mightHold(text: string): boolean {
    if (this.level === "off" || !text) return false;
    if (text.includes("@")) return true;
    if (!covers(this.level, "passwords")) return false;
    if (/pass|pwd|pin/i.test(text)) return true;
    if (covers(this.level, "addresses") && /\d/.test(text)) return true;
    return this.names !== null && /\p{Lu}/u.test(text);
  }

  /** Where the sensitive pieces of `text` are, sorted and merged. */
  private spans(text: string, secretFirst = false): Span[] {
    if (this.level === "off") return [];
    const found: Span[] = [];
    const add = (re: RegExp, group = false) => {
      re.lastIndex = 0;
      for (let m = re.exec(text); m !== null; m = re.exec(text)) {
        if (m[0].length === 0) {
          re.lastIndex += 1;
          continue;
        }
        if (group) {
          const value = m[1] ?? "";
          const bare = value.replace(/[.,;:!?)]+$/, "");
          if (!bare || NOT_A_SECRET.test(bare)) continue;
          const start = m.index + m[0].length - value.length;
          // A stand-in already in place ("Password: <letters>") is not a new password:
          // taking it for one would replace it again on every pass.
          if (this.used.has(bare)) continue;
          found.push({ start, end: start + bare.length });
        } else {
          found.push({ start: m.index, end: m.index + m[0].length });
        }
      }
    };
    if (text.includes("@")) add(ADDRESS);
    if (covers(this.level, "passwords")) {
      add(SECRET, true);
      if (secretFirst) {
        const m = /^\s*([^\s<>"'“”]{3,64})/.exec(text);
        if (m) {
          const bare = m[1]!.replace(/[.,;:!?)]+$/, "");
          if (bare && !NOT_A_SECRET.test(bare) && !this.used.has(bare)) {
            const start = m[0].length - m[1]!.length;
            found.push({ start, end: start + bare.length });
          }
        }
      }
    }
    if (covers(this.level, "addresses")) {
      add(STREET);
      add(POSTCODE);
      add(ZIP);
    }
    if (this.names) add(this.names);
    if (found.length < 2) return found;
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: Span[] = [found[0]!];
    for (const span of found.slice(1)) {
      const last = merged[merged.length - 1]!;
      if (span.start <= last.end) last.end = Math.max(last.end, span.end);
      else merged.push({ ...span });
    }
    return merged;
  }

  /** True when `text` holds at least one thing to hide. */
  has(text: string): boolean {
    return this.mightHold(text) && this.spans(text).length > 0;
  }

  /** Every sensitive piece of `text`, in order, as written. */
  find(text: string, secretFirst = false): string[] {
    if (!secretFirst && !this.mightHold(text)) return [];
    return this.spans(text, secretFirst).map((span) => text.slice(span.start, span.end));
  }

  /** True when `text` ends on a password label, so the next text's first word is the password. */
  endsWithSecretLabel(text: string): boolean {
    return covers(this.level, "passwords") && SECRET_LABEL_AT_END.test(text);
  }

  /** The stand-in for one value: `STAND_IN_LENGTH` random letters, the same every time. */
  scramble(value: string): string {
    const key = value.toLowerCase();
    const known = this.byValue.get(key);
    if (known !== undefined) return known;
    let out = "";
    // A collision between two values would make two senders look like one; vanishingly
    // rare at this length, but cheap to rule out.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      out = "";
      for (let i = 0; i < STAND_IN_LENGTH; i += 1) {
        out += ALPHABET[Math.min(ALPHABET.length - 1, Math.floor(this.random() * ALPHABET.length))];
      }
      if (!this.used.has(out)) break;
    }
    this.byValue.set(key, out);
    this.used.add(out);
    return out;
  }

  /** `text` with every sensitive piece replaced. Text with nothing to hide comes back as is. */
  censorText(text: string, secretFirst = false): string {
    return this.censorParts(text, secretFirst).map((part) => part.text).join("");
  }

  /**
   * `text` split into plain and censored pieces, for a renderer that wraps each value
   * (to blur it) rather than replacing it in place. Adjacent plain text is one piece.
   */
  censorParts(text: string, secretFirst = false): CensorPart[] {
    if (!secretFirst && !this.mightHold(text)) return [{ text, censored: false }];
    const spans = this.spans(text, secretFirst);
    if (spans.length === 0) return [{ text, censored: false }];
    const parts: CensorPart[] = [];
    let last = 0;
    for (const span of spans) {
      if (span.start > last) parts.push({ text: text.slice(last, span.start), censored: false });
      parts.push({ text: this.scramble(text.slice(span.start, span.end)), censored: true });
      last = span.end;
    }
    if (last < text.length) parts.push({ text: text.slice(last), censored: false });
    return parts;
  }

  /**
   * Is this text "just a sensitive value", so the element holding it can be blurred
   * whole? True when, once the values are taken out, nothing is left but punctuation
   * that belongs to them (`<…>`, quotes, brackets, commas) and spaces.
   */
  isOnly(text: string): boolean {
    if (!this.mightHold(text)) return false;
    const spans = this.spans(text);
    if (spans.length === 0) return false;
    let rest = "";
    let last = 0;
    for (const span of spans) {
      rest += text.slice(last, span.start);
      last = span.end;
    }
    rest += text.slice(last);
    return rest.replace(/[\s<>()[\]"',;:]/g, "") === "";
  }
}

/**
 * The notification fields a person reads, censored; everything a press acts on (ids,
 * the reply's header block, which goes to Gmail) left exactly as it was.
 */
export function censorNotice<T extends { title: string; subject: string; preview: string }>(
  notice: T,
  scrambler: Scrambler,
): T {
  return {
    ...notice,
    title: scrambler.censorText(notice.title),
    subject: scrambler.censorText(notice.subject),
    preview: scrambler.censorText(notice.preview),
  };
}
