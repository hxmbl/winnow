/**
 * One-time codes: "Your verification code is 418 902".
 *
 * Found locally, from the subject and whatever text the message has so far (Gmail's
 * snippet on a metadata sync, the decoded body once it is loaded), so the list can offer
 * "Copy 418 902" the moment the row lands and nothing about the message leaves the
 * device. The code is stored on the `Email` (`code`), computed once at map time.
 *
 * A code is only ever found next to a word that says it is one: code, OTP, passcode,
 * PIN, verification, sign-in, login, 2FA and friends. Two strengths of evidence:
 *
 *   1. **Adjacent.** The keyword and the code are a phrase: "code is 418 902",
 *      "code: K7Q2X9", "418902 is your verification code", "G-482913". Digits (4–8,
 *      optionally grouped "418 902" / "418-902") and mixed letter-digit codes both count.
 *   2. **Nearby.** A keyword within a short window of a bare 4–8 digit number. Weaker,
 *      so it is also held to every false-positive rule below. Letter codes never get in
 *      on this evidence alone.
 *
 * And never: dates, times, prices and percentages, phone numbers, years, zip codes, or a
 * number introduced as an order, tracking, invoice, account or reference number.
 */

/** Words that say "a code is near". Lower-case, matched case-insensitively. */
const KEYWORD =
  /\b(?:codes?|otp|one[- ]time|passcodes?|pass ?codes?|pins?|verification|verify|verifying|security code|sign[- ]?in|log[- ]?in|login|2fa|two[- ](?:factor|step)|authenticat(?:e|ion|or)|confirmation code|access code)\b/gi;

/** A number introduced as one of these is an identifier, not a code. */
const IDENTIFIER_BEFORE =
  /(?:order|tracking|track|invoice|receipt|reference|ref|account|acct|case|ticket|booking|reservation|flight|seat|gate|room|phone|tel|mobile|call|fax|zip|postcode|postal|po box|customer|member|policy|serial|model|item|sku|parcel|shipment|package|transaction|id)\s*(?:number|no\.?|num|#|id)?\s*(?:is|was)?\s*[:#]?\s*$/i;

/** Digits, alone or grouped as two halves: "418902", "418 902", "418-902". */
const DIGITS = /(?<![\w.,$£€¥/:-])(\d{3,4})[ -](\d{3,4})(?![\w%/:-]|[.,]\d)|(?<![\w.,$£€¥/:#-])(\d{4,8})(?![\w%/:-]|[.,]\d)/g;

/** A mixed letter-digit token, 4–10 characters, optionally Google's "G-" prefix. */
const ALNUM = /(?<![\w-])(?:G-)?([A-Z0-9]{4,10})(?![\w-])/g;

/** The longest gap allowed between a keyword and a code in the "nearby" case. */
const NEAR = 60;

type Candidate = { code: string; start: number; end: number; grouped: boolean };

function digitCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  for (const match of text.matchAll(DIGITS)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (match[1] && match[2]) {
      const code = match[1] + match[2];
      if (code.length < 6 || code.length > 8) continue;
      out.push({ code, start, end, grouped: true });
    } else if (match[3]) {
      out.push({ code: match[3], start, end, grouped: false });
    }
  }
  return out;
}

/** True when the run of digits around the candidate looks like a phone number. */
function looksLikePhone(text: string, start: number, end: number): boolean {
  let left = start;
  while (left > 0 && /[\d ()+.-]/.test(text[left - 1]!) && text[left - 1] !== "\n") left -= 1;
  let right = end;
  while (right < text.length && /[\d ()+.-]/.test(text[right]!) && text[right] !== "\n") right += 1;
  const run = text.slice(left, right);
  const digits = run.replace(/\D/g, "").length;
  return digits >= 9 || /\+\d/.test(run) || /\(\d{2,4}\)/.test(run);
}

/** The rules a bare number has to pass before "a keyword is nearby" counts. */
function plausibleNumber(text: string, candidate: Candidate): boolean {
  const { code, start, end } = candidate;
  const before = text.slice(Math.max(0, start - 32), start);
  const after = text.slice(end, end + 12);
  // Prices and amounts: a currency sign or code just before, or a unit after.
  if (/[$£€¥]\s*$|\b(?:usd|gbp|eur|aud|cad|total|amount|price|due)\s*:?\s*$/i.test(before)) return false;
  if (/^\s*(?:%|percent|usd|gbp|eur|dollars|pounds|kb|mb|gb|km|mi|kg|lbs?)\b/i.test(after)) return false;
  // Times ("at 1430 hrs", "10:30") and dates ("14/10/2026", "2026-10-14").
  if (/^\s*(?:am|pm|hrs?|hours?|utc|gmt|bst|est|pst)\b/i.test(after)) return false;
  if (/\d[:/.-]\s*$/.test(before) || /^[:/.-]\d/.test(after)) return false;
  // Years.
  if (code.length === 4 && /^(?:19|20)\d{2}$/.test(code)) return false;
  // US zip codes: "CA 94107", or a zip word.
  if (code.length === 5 && /\b[A-Z]{2}\s+$/.test(before)) return false;
  if (code.length === 9 || (code.length === 5 && /-\d{4}/.test(after))) return false;
  // An order, tracking, account, phone… number.
  if (IDENTIFIER_BEFORE.test(before)) return false;
  if (looksLikePhone(text, start, end)) return false;
  return true;
}

/**
 * "code is 418 902", "code: 418902", "PIN 7741", "418902 is your code".
 *
 * The phrase between keyword and code is short and made of glue words only, so a
 * sentence that merely mentions a code and later contains a number does not qualify.
 */
const GLUE_AFTER_KEYWORD = /^\s*(?:(?:is|was|are|:|-|–|—|=|code|number|here|below|for\s+\S+(?:\s+\S+)?\s+is)\s*){0,3}$/i;
const GLUE_BEFORE_KEYWORD = /^\s*(?:is|was)?\s*(?:your|the|a|an)?\s*(?:[A-Za-z][\w-]*\s+){0,2}$/i;

/** "Use promo code SAVE20": a marketing code is not a sign-in code. */
const PROMO_BEFORE = /\b(?:promo|promotional|discount|coupon|voucher|gift|referral|offer|sale|redeem)\b[^.\n]{0,24}$/i;

function promotional(text: string, start: number): boolean {
  return PROMO_BEFORE.test(text.slice(Math.max(0, start - 40), start));
}

/**
 * Shopping words. "code" alone is a weak keyword ("use code SPRING48 at checkout"),
 * so a code introduced only by "code" is dropped when these are close by.
 */
const SHOPPING = /checkout|% off|\boff\b|shipping|\bsale\b|discount|promo|coupon|voucher|\bdeal\b|\bcart\b|\bshop\b|\bsave\b/i;

function adjacentToKeyword(text: string, start: number, end: number): boolean {
  let keyword: string | null = null;
  const before = text.slice(Math.max(0, start - 48), start);
  for (const match of before.matchAll(KEYWORD)) {
    const gap = before.slice((match.index ?? 0) + match[0].length);
    if (GLUE_AFTER_KEYWORD.test(gap)) keyword = match[0];
  }
  if (keyword === null) {
    const after = text.slice(end, end + 48);
    KEYWORD.lastIndex = 0;
    const first = KEYWORD.exec(after);
    KEYWORD.lastIndex = 0;
    if (first && GLUE_BEFORE_KEYWORD.test(after.slice(0, first.index))) keyword = first[0];
  }
  if (keyword === null) return false;
  if (/^codes?$/i.test(keyword)) {
    const around = text.slice(Math.max(0, start - 80), Math.min(text.length, end + 80));
    if (SHOPPING.test(around)) return false;
  }
  return true;
}

function keywordNear(text: string, start: number, end: number): boolean {
  const window = text.slice(Math.max(0, start - NEAR), Math.min(text.length, end + NEAR));
  KEYWORD.lastIndex = 0;
  const found = KEYWORD.test(window);
  KEYWORD.lastIndex = 0;
  return found;
}

function hasKeyword(text: string): boolean {
  KEYWORD.lastIndex = 0;
  const found = KEYWORD.test(text);
  KEYWORD.lastIndex = 0;
  return found;
}

/** Strip a body down to readable text, short enough to scan cheaply. */
function prepare(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").slice(0, 4_000);
}

/** The code in one piece of text, or null. */
function findIn(text: string, subjectHasKeyword: boolean): string | null {
  if (!hasKeyword(text) && !subjectHasKeyword) return null;
  const digits = digitCandidates(text);

  // 1. A number right next to a keyword.
  for (const candidate of digits) {
    if (!adjacentToKeyword(text, candidate.start, candidate.end)) continue;
    if (promotional(text, candidate.start)) continue;
    // Even adjacent, a date, time, price or phone number is not a code.
    if (!plausibleNumber(text, candidate) && !candidate.grouped) {
      // A year right after "code" is still a code ("code 2048"); everything else stops.
      const yearOnly = /^(?:19|20)\d{2}$/.test(candidate.code);
      if (!yearOnly) continue;
      const before = text.slice(Math.max(0, candidate.start - 16), candidate.start);
      if (!/\b(?:code|pin|otp|passcode)\s*(?:is|:)?\s*$/i.test(before)) continue;
    }
    if (candidate.grouped && looksLikePhone(text, candidate.start, candidate.end)) continue;
    return candidate.code;
  }

  // 2. A mixed letter-digit code right next to a keyword.
  for (const match of text.matchAll(ALNUM)) {
    const token = match[1]!;
    if (!/\d/.test(token) || !/[A-Z]/.test(token)) {
      // Google's "G-482913" is the one prefixed all-digit form.
      if (!(match[0].startsWith("G-") && /^\d{4,8}$/.test(token))) continue;
    }
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (promotional(text, start)) continue;
    if (!adjacentToKeyword(text, start, end) && !match[0].startsWith("G-")) continue;
    if (match[0].startsWith("G-") && !keywordNear(text, start, end)) continue;
    // "2FA" is a keyword, not a code; a lone ordinal like "4TH" is not a code either.
    if (/^\d+(?:ST|ND|RD|TH|FA|AM|PM)$/.test(token)) continue;
    return token;
  }

  // 3. A plausible bare number with a keyword close by.
  for (const candidate of digits) {
    if (candidate.grouped) {
      if (looksLikePhone(text, candidate.start, candidate.end)) continue;
    } else if (!plausibleNumber(text, candidate)) continue;
    if (promotional(text, candidate.start)) continue;
    if (!keywordNear(text, candidate.start, candidate.end) && !subjectHasKeyword) continue;
    if (!keywordNear(text, candidate.start, candidate.end) && candidate.code.length < 6) continue;
    return candidate.code;
  }
  return null;
}

/**
 * The one-time code a message carries, or `null`.
 *
 * `subject` first: "Sign-in code 7741" is the whole message for some senders. Then the
 * text, which is the snippet until the body is loaded.
 */
export function detectCode(subject: string, text: string): string | null {
  const head = prepare(subject);
  const body = prepare(text);
  const subjectHasKeyword = hasKeyword(head);
  return findIn(head, false) ?? findIn(body, subjectHasKeyword);
}

/** "418902" as people read it: "418 902" for six digits, "4189 0211" for eight. */
export function formatCode(code: string): string {
  if (!/^\d+$/.test(code)) return code;
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}

/** How long the list row offers its Copy chip: five minutes from arrival. */
export const CODE_CHIP_MS = 5 * 60_000;

/** True while a code is fresh enough for the row chip. */
export function codeChipVisible(email: { code?: string | null; receivedAt: number }, now: number): boolean {
  if (!email.code) return false;
  const age = now - email.receivedAt;
  return age >= -60_000 && age < CODE_CHIP_MS;
}
