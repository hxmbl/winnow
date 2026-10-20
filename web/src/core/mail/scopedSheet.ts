/**
 * A sender's stylesheet, fenced into one message's container (1.3.5).
 *
 * **Why the reader needs it.** A responsive newsletter is a 600px desktop table plus a
 * `<style>` block of `@media (max-width: 600px)` rules that turn it into a one-column
 * phone layout with bigger text. Until 1.3.5 the inline reader dropped every `<style>`
 * block, so on a phone it drew the desktop table and `emailFit` zoomed it down to
 * roughly half size: the "small newsletter text" bug. Gmail and Apple Mail both honour
 * a message's `<style>` and its media queries; this is how Winnow does too.
 *
 * **Why it is safe to put in the app's document.** The sheet has already been through
 * `sanitizeCssWithCount` (no `@import`, no remote `url()`, no `expression()`, `</`
 * escaped). What this adds is the *selector* fence:
 *
 *   - Every selector in a list is rewritten to descend from the message's own scope
 *     (`[data-wn-email][data-wn-sheet="…"]`), so a rule can only ever match elements
 *     inside that one message, never the reader's chrome and never another message in
 *     the thread. A descendant of the scope stays inside it under `+`, `~`, `:is()`,
 *     `:not()` and `:has()`, because each of those still names an element that is
 *     itself a descendant.
 *   - A selector that would *start* at the scope and step sideways (`~ x`, `+ x`, or
 *     `body ~ x` once `body` becomes the scope) is dropped: those reach the scope's
 *     siblings, which are the reader's.
 *   - A selector with an unbalanced `(`/`[`, or one naming `:host`/`::slotted`, is
 *     dropped rather than repaired.
 *   - `html`/`body`/`:root` mean the scope itself. A rule that lands on the scope may
 *     only set colour, background, font and text properties: the scope is where
 *     containment, isolation and the fit zoom live, and `body { contain: none }` must
 *     not be able to switch them off.
 *   - `position: fixed|sticky` and `z-index` are neutralised everywhere, as they are in
 *     style attributes (`stripForbiddenDeclarations`).
 *   - Only `@media` survives among at-rules, and not `print` or `prefers-color-scheme`
 *     (the message sits on its own light page, so a dark-mode block would put light
 *     text on white). Nested at-rules inside `@media` are dropped.
 *
 * **Email dark mode (1.4.0)** passes `dark`, and three things change:
 *
 *   - `own`: an `@media (prefers-color-scheme: dark)` block is *unwrapped* — the
 *     feature is taken out of the query (`screen and (prefers-color-scheme: dark)` is
 *     `@media screen`; alone it becomes plain rules), so it applies whenever the
 *     reader is dark. The app's theme decides, not the OS: a dark app on a light OS is
 *     still dark. Later in the sheet than the light rules, so it wins as the sender
 *     meant. `prefers-color-scheme: light` blocks are still dropped.
 *   - `adaptive`: every ordinary rule's colours are recoloured (`emailDark.ts`).
 *   - both: `[data-ogsc]`/`[data-ogsb]`-prefixed selectors (Outlook.com's dark hooks)
 *     lose the prefix and apply, unrecoloured. Without `dark` they are dropped, which
 *     changes nothing: no element in the reader carries those attributes.
 *
 * Pure: no DOM, so `core/`'s node test environment covers it.
 */

import { stripForbiddenDeclarations } from "./sanitize";
import { recolourDeclarations, type DarkPalette } from "./emailDark";

/** Email dark mode, as the sheet sees it. See the module comment. */
export type SheetDark = { mode: "own" | "adaptive"; palette: DarkPalette };

/** Past this, the rest of a sender's sheet is ignored. Newsletters run 5–40 KB. */
export const MAX_SCOPED_CSS = 120_000;

/** What a rule landing on the scope itself (`body`, `html`, `:root`) may set. */
const SCOPE_SAFE_PROPERTY =
  /^(?:color|background(?:-color)?|font(?:-[a-z-]+)?|line-height|letter-spacing|word-spacing|text-align|text-decoration(?:-[a-z-]+)?|text-transform|-webkit-text-size-adjust|-ms-text-size-adjust|text-size-adjust)$/i;

/** A selector reaching outside the light DOM, or into the scope's siblings. */
const ESCAPING_SELECTOR = /:host\b|::slotted|::part\b/i;

type Block = { prelude: string; body: string };

/**
 * The scope selector for one message. `id` comes from React's `useId`, whose
 * characters are reduced to `[A-Za-z0-9_-]` so it can sit in a quoted attribute.
 */
export function sheetScope(id: string): { attribute: string; value: string; selector: string } {
  const value = id.replace(/[^A-Za-z0-9_-]/g, "") || "x";
  return {
    attribute: "data-wn-sheet",
    value,
    selector: `[data-wn-email][data-wn-sheet="${value}"]`,
  };
}

/**
 * Split `css` into its top-level `prelude { body }` blocks, honouring strings and
 * nested braces. Text that never closes is ignored, as a browser would.
 */
function topLevelBlocks(css: string): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  let start = 0;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i = skipString(css, i);
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === ";") {
      // A bare statement (`@charset` remnant, stray `;`): nothing to keep.
      start = i + 1;
      i += 1;
      continue;
    }
    if (c === "{") {
      const close = matchingBrace(css, i);
      if (close === -1) break;
      blocks.push({ prelude: css.slice(start, i).trim(), body: css.slice(i + 1, close) });
      i = close + 1;
      start = i;
      continue;
    }
    if (c === "}") {
      // Stray close: skip it.
      start = i + 1;
    }
    i += 1;
  }
  return blocks;
}

function skipString(css: string, from: number): number {
  const quote = css[from];
  let i = from + 1;
  while (i < css.length) {
    if (css[i] === "\\") {
      i += 2;
      continue;
    }
    if (css[i] === quote || css[i] === "\n") return i + 1;
    i += 1;
  }
  return i;
}

function matchingBrace(css: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < css.length) {
    const c = css[i];
    if (c === '"' || c === "'") {
      i = skipString(css, i);
      continue;
    }
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/** Split a selector list on its top-level commas; null when brackets don't balance. */
function splitSelectorList(list: string): string[] | null {
  const parts: string[] = [];
  let paren = 0;
  let square = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (c === '"' || c === "'") {
      i = skipString(list, i) - 1;
      continue;
    }
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "(") paren += 1;
    else if (c === ")") paren -= 1;
    else if (c === "[") square += 1;
    else if (c === "]") square -= 1;
    else if (c === "," && paren === 0 && square === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
    if (paren < 0 || square < 0) return null;
  }
  if (paren !== 0 || square !== 0) return null;
  parts.push(list.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * One selector, rewritten under `scope`. `onScope` is true when the selector names
 * the scope itself (it was `body`, `html` or `:root` with nothing after it).
 * Null when it cannot be fenced.
 */
export function scopeSelector(
  selector: string,
  scope: string,
): { selector: string; onScope: boolean } | null {
  let rest = selector.trim();
  if (rest === "" || /[{};@<]/.test(rest) || ESCAPING_SELECTOR.test(rest)) return null;

  // `html`, `:root` and `body` all mean "the message's page". Peel them off the front.
  let rooted = false;
  for (;;) {
    const match = /^(?:html|:root|body)(?![\w-])/i.exec(rest);
    if (!match) break;
    rooted = true;
    rest = rest.slice(match[0].length);
    // `body.foo` / `body[x]` / `body:hover` qualify the page; the scope cannot carry
    // a sender's class, so the rule is not one we can place.
    if (/^[.#[:]/.test(rest)) return null;
    rest = rest.replace(/^\s*>\s*/, " ").trimStart();
  }

  if (rest === "") return rooted ? { selector: scope, onScope: true } : null;
  // A sibling step from the scope reaches the reader's own elements.
  if (/^[~+]/.test(rest)) return null;
  // `> x` from the page is a child of the scope; anything else is a descendant.
  if (rest.startsWith(">")) return { selector: `${scope} ${rest}`, onScope: false };
  return { selector: `${scope} ${rest}`, onScope: false };
}

/** Outlook.com's dark hooks: `[data-ogsc] .x`, `[data-ogsb] .x`. */
const OUTLOOK_HOOK = /^\s*\[\s*data-ogs[cb]\s*\]\s*/i;

/** The declarations, with the forbidden ones neutralised and, on the scope, filtered. */
function cleanDeclarations(body: string, onScope: boolean, recolour?: DarkPalette): string {
  const safe = recolour
    ? recolourDeclarations(stripForbiddenDeclarations(body), recolour)
    : stripForbiddenDeclarations(body);
  if (!onScope) return safe.trim();
  return safe
    .split(";")
    .filter((declaration) => {
      const name = declaration.split(":")[0]?.trim() ?? "";
      return SCOPE_SAFE_PROPERTY.test(name);
    })
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration !== "")
    .join("; ");
}

/** A list of style rules, each fenced; rules that fence to nothing disappear. */
function scopeRules(css: string, scope: string, dark?: SheetDark, fromDarkBlock = false): string {
  const out: string[] = [];
  // Colours a sender chose for dark are theirs; only ordinary rules are recoloured.
  const recolour = dark?.mode === "adaptive" && !fromDarkBlock ? dark.palette : undefined;
  for (const { prelude, body } of topLevelBlocks(css)) {
    if (prelude.startsWith("@")) continue; // nested at-rule, or one we do not keep
    if (body.includes("{")) continue; // CSS nesting: not something mail relies on
    const selectors = splitSelectorList(prelude);
    if (!selectors) continue;
    // Outlook's hooks: applied, unprefixed, in a dark reader; dropped otherwise.
    const plain = selectors.filter((s) => !OUTLOOK_HOOK.test(s));
    const hooked = dark
      ? selectors.filter((s) => OUTLOOK_HOOK.test(s)).map((s) => s.replace(OUTLOOK_HOOK, "") || "body")
      : [];
    for (const [group, palette] of [[plain, recolour], [hooked, undefined]] as const) {
      const scoped = group.map((s) => scopeSelector(s, scope)).filter((s) => s !== null);
      if (scoped.length === 0) continue;
      const inner = scoped.filter((s) => !s.onScope).map((s) => s.selector);
      const outer = scoped.filter((s) => s.onScope).map((s) => s.selector);
      if (inner.length > 0) {
        const declarations = cleanDeclarations(body, false, palette);
        if (declarations !== "") out.push(`${inner.join(", ")} { ${declarations} }`);
      }
      if (outer.length > 0) {
        const declarations = cleanDeclarations(body, true, palette);
        if (declarations !== "") out.push(`${scope} { ${declarations} }`);
      }
    }
  }
  return out.join("\n");
}

/**
 * A dark-scheme `@media` prelude with the feature taken out: `""` when nothing is left
 * (the rules apply unconditionally), the remaining query otherwise, null when the
 * prelude is not a dark-scheme query.
 */
export function unwrapDarkQuery(prelude: string): string | null {
  const query = prelude.replace(/^@media/i, "").trim();
  // A list (`a, b`) is an "or": unwrapping one branch would be wrong for the other.
  if (query.includes(",") || /[{};]/.test(query)) return null;
  const parts = query.split(/\s+and\s+/i).map((part) => part.trim()).filter((part) => part !== "");
  const isDark = (part: string) => /^\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/i.test(part);
  if (!parts.some(isDark)) return null;
  const rest = parts.filter((part) => !isDark(part));
  if (rest.some((part) => /prefers-color-scheme/i.test(part))) return null;
  // `screen` / `only screen` / `all` alone is every screen the reader is on.
  if (rest.length === 0 || (rest.length === 1 && /^(?:only\s+)?(?:screen|all)$/i.test(rest[0]))) return "";
  return rest.join(" and ");
}

/** Which `@media` preludes are kept. */
function keepMedia(prelude: string): boolean {
  const query = prelude.replace(/^@media/i, "").trim().toLowerCase();
  if (query === "") return false;
  if (/prefers-color-scheme|\bprint\b|[{};]/.test(query)) return false;
  return true;
}

/**
 * The sender's (already sanitised) sheets, fenced under `scope`. Empty when nothing
 * survives.
 */
export function scopeSenderCss(sheets: readonly string[], scope: string, dark?: SheetDark): string {
  const css = sheets.join("\n").slice(0, MAX_SCOPED_CSS);
  const out: string[] = [];
  for (const { prelude, body } of topLevelBlocks(css)) {
    if (prelude.startsWith("@")) {
      if (!/^@media\b/i.test(prelude)) continue;
      if (dark?.mode === "own") {
        const unwrapped = unwrapDarkQuery(prelude);
        if (unwrapped !== null) {
          const rules = scopeRules(body, scope, dark, true);
          if (rules === "") continue;
          out.push(unwrapped === "" ? rules : `@media ${unwrapped} {\n${rules}\n}`);
          continue;
        }
      }
      if (!keepMedia(prelude)) continue;
      const rules = scopeRules(body, scope, dark);
      if (rules !== "") out.push(`${prelude} {\n${rules}\n}`);
      continue;
    }
    const rules = scopeRules(`${prelude} {${body}}`, scope, dark);
    if (rules !== "") out.push(rules);
  }
  // The input was emitted escaped; this keeps the promise for anything we composed.
  return out.join("\n").replace(/<\//g, "\\3c /");
}
