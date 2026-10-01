/**
 * Phrase matching for the classifier.
 *
 * The one rule here is that keyword matching is **whole-phrase with word
 * boundaries**, never `String.includes`. That is not a detail: `"otp"` inside
 * "hotel", `"ups"` inside "groups", `"free"` inside "freedom", `"due"` inside
 * "reduce" — a substring search turns four of those into live misclassifications
 * on real inboxes, and the resulting "Security" and "Deliveries" buckets are
 * worse than useless.
 *
 * A second rule: every pattern is compiled exactly once, at module load.
 * Classification runs over the whole inbox on every keystroke, and rebuilding
 * a dozen regexes per message dominated the profile timings in the Swift
 * implementation.
 */

/** Escape the regex metacharacters in a literal phrase. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a case-insensitive pattern, once.
 *
 * Patterns are literals in this codebase, so a bad one is a typo caught by the
 * tests rather than a runtime surprise.
 */
export function compile(pattern: string, flags = "i"): RegExp {
  return new RegExp(pattern, flags);
}

/**
 * A phrase matcher with word boundaries on both ends and flexible whitespace
 * inside, so `"check in"` also matches `"check   in"` after a line wrap.
 */
export class PhraseMatcher {
  readonly pattern: RegExp;
  readonly phrase: string;

  constructor(phrase: string) {
    this.phrase = phrase;
    const escaped = phrase
      .split(/\s+/)
      .filter(Boolean)
      .map(escapeRegExp)
      .join("\\s+");
    this.pattern = new RegExp(`\\b${escaped}\\b`, "i");
  }

  test(haystack: string): boolean {
    return this.pattern.test(haystack);
  }
}

/**
 * A keyword list, compiled once.
 *
 * `any` short-circuits; `count` tallies *distinct phrases* present, which is
 * what the newsletter test needs — two unsubscribe-ish tells in one message
 * mean bulk mail, one might be coincidence.
 */
export class KeywordTable {
  private readonly matchers: PhraseMatcher[];
  readonly phrases: readonly string[];

  constructor(phrases: readonly string[]) {
    this.phrases = phrases;
    this.matchers = phrases.map((phrase) => new PhraseMatcher(phrase));
  }

  any(haystack: string): boolean {
    return this.matchers.some((matcher) => matcher.test(haystack));
  }

  count(haystack: string): number {
    let total = 0;
    for (const matcher of this.matchers) if (matcher.test(haystack)) total += 1;
    return total;
  }
}
