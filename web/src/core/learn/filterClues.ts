/**
 * The clues a smart filter can learn from, read off one message.
 *
 * Every clue is a short readable string — `p:evri`, `h:list-unsubscribe`,
 * `c:updates`, `w:parcel` — so the stored model is something a person can open and
 * read, and so every clue has a plain-English phrase (`clueLabel`) for "Why it's here".
 *
 * Four kinds, and nothing else:
 *
 *   - **patterns** (`p:`) — things that look like a tracking number (UPS `1Z…`, Royal
 *     Mail `AB123456789GB`, Evri `H…`, DPD), an Amazon order number, any order number,
 *     an amount of money, a date;
 *   - **headers** (`h:`) — `List-Unsubscribe`, a no-reply sender, attachments;
 *   - **Gmail's category** (`c:`) — Updates, Promotions and the rest;
 *   - **words** (`w:`) — from the subject and the first lines of the text, stop words
 *     dropped, at most `MAX_WORDS`.
 *
 * The sender is *not* a clue. It is handled separately, as a sender rule you can see
 * and remove (`filterLearning.ts`), because "mail from evri.com" is a decision a person
 * makes about a sender, not a statistic.
 *
 * Pure and deterministic: the same message always yields the same clues, in the same
 * order, and nothing here touches the network.
 */

import type { Email, EmailCategory } from "../model/email";

/** Words kept per message. Subject words first, so the subject always counts. */
export const MAX_WORDS = 10;
/** Characters of the text the words are read from: a preview, not the whole letter. */
export const PREVIEW_CHARS = 200;
/** Characters searched for patterns. A tracking number is rarely further down. */
export const PATTERN_CHARS = 4000;

export type ClueKind = "pattern" | "header" | "category" | "word";

export function clueKind(clue: string): ClueKind {
  if (clue.startsWith("p:")) return "pattern";
  if (clue.startsWith("h:")) return "header";
  if (clue.startsWith("c:")) return "category";
  return "word";
}

// ── Patterns ────────────────────────────────────────────────────────────────

/** UPS: `1Z`, then 16 letters and digits. */
const UPS = /\b1Z[0-9A-Z]{16}\b/i;
/** Royal Mail (and other UPU S10 numbers sent from the UK): two letters, nine digits, `GB`. */
const ROYAL_MAIL = /\b[A-Z]{2}\d{9}GB\b/;
/** Evri: 16 characters starting with `H`, mostly digits. Checked further in `isEvri`. */
const EVRI = /\bH[0-9A-Z]{15}\b/g;
/** DPD: a 14-digit parcel number, counted only where DPD is named. */
const DPD_NUMBER = /\b\d{14}\b/;
const DPD_NAME = /\bdpd\b/i;
/** Amazon: `123-1234567-1234567`. */
const AMAZON_ORDER = /\b\d{3}-\d{7}-\d{7}\b/;
/** "Order number: A12345", "order #12345", "Order ref 55-1234". Must carry a digit. */
const ORDER_NUMBER = /\border\s*(?:no\.?|number|num|id|ref(?:erence)?)?\s*[:#]?\s*#?\s*([A-Z0-9][A-Z0-9-]{4,})/gi;
/** "Tracking: ABC12345678", "tracking no. 0012…": a tracking word with a code after it. */
const TRACKING_WORD = /\btrack(?:ing)?\s*(?:no\.?|number|id|code|ref)?\s*[:#]?\s*([A-Z0-9]{8,})/gi;
/** Money: £12.50, $1,200, €9, or 12.50 GBP. */
const AMOUNT = /(?:[£$€]\s?\d[\d,]*(?:\.\d{2})?|\b\d[\d,]*\.\d{2}\s?(?:GBP|USD|EUR)\b)/i;
/** Dates as mail writes them: "Tuesday, 12", "12 May", "May 12th", "12/05/2026". */
const MONTHS = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*";
const DATE = new RegExp(
  [
    "\\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?,?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b",
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}\\b`,
    `\\b${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`,
    "\\b\\d{1,2}/\\d{1,2}/\\d{2,4}\\b",
  ].join("|"),
  "i",
);

const hasDigit = (value: string): boolean => /\d/.test(value);

function isEvri(text: string): boolean {
  for (const match of text.matchAll(EVRI)) {
    const digits = match[0].replace(/\D/g, "").length;
    if (digits >= 8) return true;
  }
  return false;
}

function anyCapture(pattern: RegExp, text: string, test: (capture: string) => boolean): boolean {
  for (const match of text.matchAll(pattern)) {
    if (match[1] && test(match[1])) return true;
  }
  return false;
}

/** The pattern clues in a piece of text, in a fixed order. */
export function patternClues(text: string): string[] {
  const out: string[] = [];
  const ups = UPS.test(text);
  const royalMail = ROYAL_MAIL.test(text);
  const evri = isEvri(text);
  const dpd = DPD_NUMBER.test(text) && DPD_NAME.test(text);
  const trackingWord = anyCapture(TRACKING_WORD, text, (code) => hasDigit(code) && code.length <= 30);
  if (ups || royalMail || evri || dpd || trackingWord) out.push("p:tracking");
  if (ups) out.push("p:ups");
  if (royalMail) out.push("p:royal-mail");
  if (evri) out.push("p:evri");
  if (dpd) out.push("p:dpd");
  const amazon = AMAZON_ORDER.test(text);
  if (amazon) out.push("p:amazon-order");
  if (amazon || anyCapture(ORDER_NUMBER, text, hasDigit)) out.push("p:order-number");
  if (AMOUNT.test(text)) out.push("p:amount");
  if (DATE.test(text)) out.push("p:date");
  return out;
}

// ── Words ───────────────────────────────────────────────────────────────────

/**
 * Words too common to say anything about a bucket. Short on purpose: the words that
 * matter for mail ("parcel", "order", "invoice") are kept, and a word that turns out
 * to be noise simply never gathers evidence one way more than the other.
 */
const STOP_WORDS = new Set(
  (
    "the and for you your yours our ours are was were has have had not but with this that these those " +
    "from into onto out about over just also any all can will would could should may might must " +
    "its it's his her hers him she they them their there here what when where which who whom why how " +
    "been being get got let lets one two more most some such than then too very via per " +
    "hi hello dear thanks thank regards best please today now new email mail message view online " +
    "www http https com net org html amp nbsp " +
    // Days and months are the date pattern's job; as words they would count it twice.
    "monday tuesday wednesday thursday friday saturday sunday mon tue wed thu fri sat sun " +
    "january february march april june july august september october november december " +
    "jan feb mar apr jun jul aug sep sept oct nov dec"
  ).split(" "),
);

/** Lowercased words of 3–20 letters, stop words dropped, first occurrence kept. */
export function wordsOf(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z\u00c0-\u024f']+/)) {
    const word = raw.replace(/^'+|'+$/g, "");
    if (word.length < 3 || word.length > 20) continue;
    if (STOP_WORDS.has(word) || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

// ── Sender ──────────────────────────────────────────────────────────────────

/**
 * Second-level suffixes under which the registrable domain is three labels, not two.
 * Not the whole public-suffix list — the common ones mail actually arrives from.
 */
const SECOND_LEVEL = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk", "nhs.uk",
  "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp", "co.in", "co.za",
  "com.br", "com.cn", "com.mx", "com.sg", "com.hk", "co.kr", "com.tr", "co.il",
]);

/**
 * Domains shared by millions of unrelated people. A correction never becomes a rule
 * for the whole of one of these — only for the exact address.
 */
export const SHARED_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.co.uk", "live.com",
  "live.co.uk", "msn.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.de",
  "gmx.net", "mail.com", "yandex.com", "yandex.ru", "btinternet.com", "sky.com",
  "virginmedia.com", "talktalk.net", "zoho.com", "fastmail.com", "hey.com",
]);

/** The bare sender address, lowercased; `""` when there is none. */
export function senderAddress(email: Pick<Email, "sender">): string {
  const sender = email.sender.trim().toLowerCase();
  const angle = /<([^>]+)>/.exec(sender);
  return (angle ? angle[1] : sender).trim();
}

/** `notifications@mail.evri.com` → `evri.com`; `x@shop.co.uk` → `shop.co.uk`. */
export function registrableDomain(address: string): string {
  const at = address.lastIndexOf("@");
  const host = (at >= 0 ? address.slice(at + 1) : address).trim().toLowerCase().replace(/\.+$/, "");
  if (!host || !host.includes(".")) return host;
  const labels = host.split(".");
  const lastTwo = labels.slice(-2).join(".");
  if (labels.length >= 3 && SECOND_LEVEL.has(lastTwo)) return labels.slice(-3).join(".");
  return lastTwo;
}

/** True when a domain rule may be made for this domain (see `SHARED_MAIL_DOMAINS`). */
export function canRuleDomain(domain: string): boolean {
  return domain.length > 0 && domain.includes(".") && !SHARED_MAIL_DOMAINS.has(domain);
}

// ── All clues ───────────────────────────────────────────────────────────────

const NO_REPLY = /^(?:no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon)\b/;

/**
 * Every clue on a message: patterns, then headers, then the category, then words.
 * Deduplicated and stable.
 */
export function cluesOf(email: Email): string[] {
  const text = `${email.subject}\n${email.body.slice(0, PATTERN_CHARS)}`;
  const out = patternClues(text);
  if (email.bulk || email.unsubscribe) out.push("h:list-unsubscribe");
  const local = senderAddress(email).split("@")[0] ?? "";
  if (NO_REPLY.test(local)) out.push("h:no-reply");
  if (email.attachments.length > 0 || email.attachmentHint === true) out.push("h:attachments");
  out.push(`c:${email.category}`);
  const words = wordsOf(`${email.subject} ${email.body.slice(0, PREVIEW_CHARS)}`).slice(0, MAX_WORDS);
  for (const word of words) out.push(`w:${word}`);
  return out;
}

/**
 * Clues, memoised per message object. The store hands the same `Email` objects to every
 * reclassification until a sync replaces them, so this is one regex pass per message.
 */
const cache = new WeakMap<Email, readonly string[]>();
export function cachedClues(email: Email): readonly string[] {
  let hit = cache.get(email);
  if (!hit) {
    hit = cluesOf(email);
    cache.set(email, hit);
  }
  return hit;
}

// ── Words for people ────────────────────────────────────────────────────────

const CATEGORY_NAMES: Record<EmailCategory, string> = {
  primary: "Primary",
  social: "Social",
  promotions: "Promotions",
  updates: "Updates",
  forums: "Forums",
  reservations: "Reservations",
  receipts: "Receipts",
  newsletter: "Newsletters",
};

const PATTERN_LABELS: Record<string, string> = {
  "p:tracking": "has a tracking number",
  "p:ups": "has a UPS tracking number",
  "p:royal-mail": "has a Royal Mail tracking number",
  "p:evri": "has an Evri tracking number",
  "p:dpd": "has a DPD parcel number",
  "p:amazon-order": "has an Amazon order number",
  "p:order-number": "has an order number",
  "p:amount": "mentions an amount",
  "p:date": "mentions a date",
  "h:list-unsubscribe": "has a List-Unsubscribe header",
  "h:no-reply": "comes from a no-reply address",
  "h:attachments": "has attachments",
};

/** One clue as a phrase that completes "In Deliveries because: …". */
export function clueLabel(clue: string): string {
  const fixed = PATTERN_LABELS[clue];
  if (fixed) return fixed;
  if (clue.startsWith("c:")) {
    const name = CATEGORY_NAMES[clue.slice(2) as EmailCategory] ?? clue.slice(2);
    return `Gmail files it under ${name}`;
  }
  if (clue.startsWith("w:")) return `mentions “${clue.slice(2)}”`;
  return clue;
}

/** The specific tracking patterns, which make the generic one redundant in a sentence. */
export const SPECIFIC_TRACKING: ReadonlySet<string> = new Set(["p:ups", "p:royal-mail", "p:evri", "p:dpd"]);
