/**
 * Blur sensitive info, on the page: the DOM half of `core/mail/censor.ts`.
 *
 * **Why a watcher over the document rather than a component at every call site.** An
 * address reaches the screen from dozens of places (rows, the reader's header, the
 * composer's chips and suggestions, the account switcher and Accounts page, Settings'
 * hidden and muted senders, notices, tooltips, menus), and the purpose of the setting is
 * that *none* of them leaks into a screenshot. A component would be one more thing every
 * future call site has to remember. A `MutationObserver` over the whole document catches
 * the ones nobody thought of, including text that arrives later. Its callback runs as a
 * microtask, before the browser paints, so a real address React writes is replaced
 * before it is ever on screen.
 *
 * **What it changes, and how, so React stays correct.**
 *
 *   - A text node with an address in it gets its `nodeValue` scrambled in place. React
 *     keeps a reference to that node and later writes to it by `nodeValue` too, so the
 *     node is never replaced or moved; React's own next write is simply censored again.
 *   - When an address is all an element shows (`<span>{address}</span>`, `<…>` included),
 *     that element gets `data-wn-censored`, which `index.css` blurs. An attribute and not
 *     a class, because React rewrites `className` on its own renders.
 *   - Inside a message body's rich HTML (`[data-wn-email]`, set with
 *     `dangerouslySetInnerHTML`, so React owns none of its children) each address is
 *     wrapped in its own blurred span instead, since sentences there mix text and
 *     addresses.
 *   - `title`, `aria-label`, `alt`, `placeholder` and link targets are scrambled too:
 *     a tooltip, a screen reader and a browser's link preview would otherwise read the
 *     real address out. A link's real target is kept here, in memory, and
 *     `originalAttribute` hands it back, so clicking a `mailto:` still writes to the real
 *     person.
 *
 * **What it never touches:** inputs, textareas and anything `contenteditable`. Those hold
 * what the user is writing and what will be sent; changing them would change the mail.
 *
 * Turning the setting off puts back every original it still recognises (a node React
 * has since rewritten keeps React's value) and removes the blur marks.
 */

import { Scrambler, nameTerms } from "../core/mail/censor";
import type { Email } from "../core/model/email";
import type { GoogleContact } from "../core/contacts/google";

/** The mark `index.css` blurs. */
export const CENSORED_ATTR = "data-wn-censored";
/** A span this module wrapped around one address in a message body. */
const WRAP_ATTR = "data-wn-censor-wrap";

/** Attributes read out by tooltips, screen readers and link previews. */
const ATTRIBUTES = ["title", "aria-label", "aria-description", "alt", "placeholder", "href", "data-tip"] as const;

/** Never edited: what the user is typing, and what will be sent. */
const UNTOUCHABLE = "input, textarea, [contenteditable]:not([contenteditable='false']), script, style, noscript";

/** Message bodies' rich HTML: not React's, so its text can be split and wrapped. */
const FOREIGN = "[data-wn-email]";

type Written = { original: string; written: string };

const texts = new WeakMap<Text, Written & { blurred: Element | null }>();
const attributes = new WeakMap<Element, Map<string, Written>>();
const wraps = new WeakMap<Element, string>();

/** One scrambler for the page's life: an address keeps its letters until the app closes. */
let shared: Scrambler | null = null;
export function sessionScrambler(): Scrambler {
  shared ??= new Scrambler(randomSource());
  return shared;
}

/** `crypto` where there is one, so the letters cannot be predicted from a seed. */
function randomSource(): () => number {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) return Math.random;
  const buffer = new Uint32Array(64);
  let index = buffer.length;
  return () => {
    if (index >= buffer.length) {
      c.getRandomValues(buffer);
      index = 0;
    }
    return buffer[index++]! / 0x1_0000_0000;
  };
}

/**
 * The attribute's real value: what this module scrambled, or the attribute as it is.
 * For click handlers that act on a link's target (a `mailto:` in a message body).
 */
export function originalAttribute(element: Element, name: string): string | null {
  const current = element.getAttribute(name);
  const record = attributes.get(element)?.get(name);
  return record && record.written === current ? record.original : current;
}

function untouchable(node: Node): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  return !element || element.closest(UNTOUCHABLE) !== null;
}

function censorText(node: Text, scrambler: Scrambler, secretFirst = false): void {
  const value = node.nodeValue ?? "";
  const known = texts.get(node);
  if (known && known.written !== value) {
    // React (or anyone) has written over it since: drop the record and a blur that no
    // longer has an address under it.
    texts.delete(node);
    if (known.blurred && !scrambler.has(value)) known.blurred.removeAttribute(CENSORED_ATTR);
  }
  // Its own write coming back through the observer: already censored.
  if (known && known.written === value) return;
  if (untouchable(node)) return;
  const parts = scrambler.censorParts(value, secretFirst);
  if (!parts.some((part) => part.censored)) return;
  const parent = node.parentElement;
  if (!parent) return;

  if (parent.closest(FOREIGN) && !parent.hasAttribute(WRAP_ATTR)) {
    const doc = node.ownerDocument;
    const fragment = doc.createDocumentFragment();
    for (const part of parts) {
      if (!part.censored) {
        fragment.append(part.text);
        continue;
      }
      const span = doc.createElement("span");
      span.setAttribute(CENSORED_ATTR, "");
      span.setAttribute(WRAP_ATTR, "");
      span.textContent = part.text;
      fragment.append(span);
    }
    // Remember each span's original address for the way back.
    wrapOriginals(fragment, value, scrambler, secretFirst);
    parent.replaceChild(fragment, node);
    return;
  }

  const written = parts.map((part) => part.text).join("");
  let blurred: Element | null = null;
  const only = parts.every((part) => part.censored || /^[\s<>()[\]"',;:]*$/.test(part.text));
  if (only && (parent.textContent ?? "").trim() === value.trim()) {
    parent.setAttribute(CENSORED_ATTR, "");
    blurred = parent;
  }
  texts.set(node, { original: value, written, blurred });
  node.nodeValue = written;
}

/** Record, on each wrap span in `fragment`, the address it stands for. */
function wrapOriginals(fragment: DocumentFragment, value: string, scrambler: Scrambler, secretFirst: boolean): void {
  const byScramble = new Map<string, string>();
  for (const found of scrambler.find(value, secretFirst)) byScramble.set(scrambler.scramble(found), found);
  for (const span of fragment.querySelectorAll(`[${WRAP_ATTR}]`)) {
    const original = byScramble.get(span.textContent ?? "");
    if (original !== undefined) wraps.set(span, original);
  }
}

function censorAttribute(element: Element, name: string, scrambler: Scrambler): void {
  const value = element.getAttribute(name);
  let records = attributes.get(element);
  const known = records?.get(name);
  if (known && known.written !== value) records!.delete(name);
  // Attributes are never sent anywhere, so even an input's placeholder or label is fair game.
  if (value === null || !scrambler.has(value)) return;
  const written = scrambler.censorText(value);
  if (!records) {
    records = new Map();
    attributes.set(element, records);
  }
  records.set(name, { original: value, written });
  element.setAttribute(name, written);
}

/** Elements whose attributes could hold something: any `@` at the first step, any value past it. */
const ADDRESS_ATTRIBUTES = ATTRIBUTES.map((name) => `[${name}*="@"]`).join(",");
const ANY_ATTRIBUTES = ATTRIBUTES.map((name) => `[${name}]`).join(",");
function attributeSelector(scrambler: Scrambler): string {
  return scrambler.currentLevel === "emails" ? ADDRESS_ATTRIBUTES : ANY_ATTRIBUTES;
}

function censorTree(root: Node, scrambler: Scrambler): void {
  if (root.nodeType === Node.TEXT_NODE) {
    censorText(root as Text, scrambler);
    return;
  }
  if (!(root instanceof Element) && root.nodeType !== Node.DOCUMENT_NODE) return;
  const doc = root.ownerDocument ?? (root as Document);
  // Collected first: wrapping a body's text replaces nodes under the walker's feet.
  // A password split from its label by markup (`Password: <b>x</b>`): a text that ends
  // on the label makes the next non-blank text's first word the password.
  const found: { node: Text; secretFirst: boolean }[] = [];
  let pending = false;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    if (!value.trim()) continue;
    if (pending || scrambler.mightHold(value)) found.push({ node: node as Text, secretFirst: pending });
    pending = scrambler.endsWithSecretLabel(value);
  }
  for (const { node, secretFirst } of found) censorText(node, scrambler, secretFirst);
  const selector = attributeSelector(scrambler);
  const elements: Element[] = [];
  if (root instanceof Element && root.matches(selector)) elements.push(root);
  if ("querySelectorAll" in root) elements.push(...(root as ParentNode).querySelectorAll(selector));
  for (const element of elements) {
    for (const name of ATTRIBUTES) censorAttribute(element, name, scrambler);
  }
}

function restoreTree(root: Element): void {
  for (const span of [...root.querySelectorAll(`[${WRAP_ATTR}]`)]) {
    const original = wraps.get(span);
    if (original !== undefined) span.replaceWith(original);
  }
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const record = texts.get(node);
    if (!record) continue;
    if (node.nodeValue === record.written) node.nodeValue = record.original;
    texts.delete(node);
  }
  for (const element of root.querySelectorAll("*")) {
    const records = attributes.get(element);
    if (records) {
      for (const [name, record] of records) {
        if (element.getAttribute(name) === record.written) element.setAttribute(name, record.original);
      }
      attributes.delete(element);
    }
  }
  for (const element of [...root.querySelectorAll(`[${CENSORED_ATTR}]`)]) element.removeAttribute(CENSORED_ATTR);
}

/**
 * Censor `doc` until the returned function is called, which puts the originals back.
 * Idempotent per call: each call owns one observer.
 */
export function startCensor(doc: Document, scrambler: Scrambler = sessionScrambler()): () => void {
  const root = doc.documentElement;
  censorTree(root, scrambler);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") censorText(record.target as Text, scrambler);
      else if (record.type === "attributes") censorAttribute(record.target as Element, record.attributeName!, scrambler);
      else for (const node of record.addedNodes) if (node.isConnected) censorTree(node, scrambler);
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRIBUTES],
  });
  return () => {
    // Anything queued but not yet delivered is from the censored period; drop it.
    observer.takeRecords();
    observer.disconnect();
    restoreTree(root);
  };
}

/**
 * A whole HTML document, censored, for the sandboxed frames ("as sent", the render
 * proxy): those have an opaque origin, so the watcher cannot reach into them and their
 * `srcdoc` is censored before it is handed over instead. The frames run no script and
 * their links go nowhere, so link targets can be scrambled outright.
 */
export function censorHtmlDocument(html: string, scrambler: Scrambler = sessionScrambler()): string {
  if (!scrambler.mightHold(html)) return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const found: { node: Text; secretFirst: boolean }[] = [];
  let pending = false;
  const walker = parsed.createTreeWalker(parsed.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const value = node.nodeValue ?? "";
    if ((parent && parent.closest("style, script")) || !value.trim()) continue;
    if (pending || scrambler.mightHold(value)) found.push({ node: node as Text, secretFirst: pending });
    pending = scrambler.endsWithSecretLabel(value);
  }
  for (const { node, secretFirst } of found) {
    const parts = scrambler.censorParts(node.nodeValue ?? "", secretFirst);
    if (!parts.some((part) => part.censored)) continue;
    const fragment = parsed.createDocumentFragment();
    for (const part of parts) {
      if (!part.censored) {
        fragment.append(part.text);
        continue;
      }
      const span = parsed.createElement("span");
      span.setAttribute("style", "filter:blur(5px)");
      span.textContent = part.text;
      fragment.append(span);
    }
    node.replaceWith(fragment);
  }
  for (const element of parsed.querySelectorAll(attributeSelector(scrambler))) {
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (value !== null && scrambler.has(value)) element.setAttribute(name, scrambler.censorText(value));
    }
  }
  return `<!doctype html>${parsed.documentElement.outerHTML}`;
}

// ── Whether it is on, for the few renderers that censor their own output ─────────
//
// The watcher covers the page; a sandboxed frame's `srcdoc` and the plain-text body
// (one text node, where per-address blur needs spans) censor what they render instead,
// and re-render when the switch moves. App sets this from the preference.

// The value is "" when off, and otherwise a key that changes with the level and the
// names, so a renderer that censors its own output redoes it when either moves.
let active = "";
const listeners = new Set<() => void>();

export function setCensorActive(value: boolean, key = "on"): void {
  const next = value ? key || "on" : "";
  if (active === next) return;
  active = next;
  for (const listener of listeners) listener();
}

export function censorActive(): string {
  return active;
}

/**
 * The names Blur sensitive info's last step hides: every display name on a message
 * (sender, recipients) and in the address book, with their parts (`nameTerms`).
 */
export function censorNameTerms(emails: readonly Email[], contacts: readonly GoogleContact[]): string[] {
  const names: string[] = [];
  for (const email of emails) {
    if (email.name) names.push(email.name);
    for (const contact of [...(email.to ?? []), ...(email.cc ?? [])]) {
      if (contact.name) names.push(contact.name);
    }
  }
  for (const contact of contacts) if (contact.name) names.push(contact.name);
  return nameTerms(names).sort();
}

export function subscribeCensor(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
