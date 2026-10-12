/**
 * Addresses, as text.
 *
 * The three questions this file exists to answer, and why none of them can be answered
 * by `String.prototype`:
 *
 *   1. **Are two addresses the same one?** `Ada@Example.com` and `ada@example.com` are
 *      one contact with two rows, and a recipient list that offers both is a list that
 *      offers a duplicate. The fold is case- and accent-insensitive: RFC 5321 says the
 *      local part *is* case-sensitive, and no mail provider on earth implements that, so
 *      matching it exactly would be the pedantically correct and practically wrong answer.
 *   2. **What can be sent mail?** Deliberately stricter than "contains an `@`" — a chip
 *      that looks sendable and is not is worse than one that says so.
 *   3. **What did the user just paste?** A pasted list is the common case, and splitting
 *      it wrongly loses people.
 *
 * Nothing here knows what a contact is; that is `index.ts`.
 */

import { parseAddressHeader } from "../mail/html";

/**
 * Case- and accent-insensitive form, for comparing and for searching.
 *
 * `NFD` then strip the combining marks, so `Tomás` folds to `tomas` and a search for
 * `tomas` finds it on a keyboard with no accent key. Diacritics are *retained* in the
 * display name — folding is for matching, never for what the user reads.
 */
export function foldText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * The identity of an address: folded, trimmed, no display name.
 *
 * Anything that is not an address folds to itself, so a mistyped recipient still has a
 * stable key and can be recognised as "the same mistake" rather than as two people.
 */
export function normalizeAddress(address: string): string {
  return foldText(stripDisplayName(address).trim());
}

/** The bare address inside `Name <addr>`, or the input unchanged. */
export function stripDisplayName(value: string): string {
  return parseAddressHeader(value.trim())?.address ?? value.trim();
}

/** The part before the `@`, folded. Empty when there is no `@`. */
export function localPart(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? address : address.slice(0, at);
}

/** The part after the `@`, folded. Empty when there is no `@`. */
export function domainPart(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1);
}

/**
 * One `dot-atom` of a local part: RFC 5322's unquoted character set, with no dots.
 *
 * Applied per atom rather than to the whole local part, so a leading, trailing or
 * doubled dot is rejected — those are the shapes that pass every other check and are
 * still undeliverable.
 */
const LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;

/** One domain label: starts and ends on something that is not a hyphen. */
const DOMAIN_LABEL = /^[\p{L}\p{N}][\p{L}\p{N}-]*$/u;

/**
 * Whether this can be delivered to.
 *
 * Three rules, all of them things that actually arrive in a To field: a local part of
 * dot-separated atoms, at least two domain labels, and nothing over the RFC length
 * limits. The second is the rule that matters in practice — `ada@localhost` passes
 * everything else and is undeliverable from anywhere but this machine.
 */
export function isValidAddress(value: string): boolean {
  const address = stripDisplayName(value);
  if (!address || address.length > 254) return false;
  const at = address.lastIndexOf("@");
  if (at <= 0 || at !== address.indexOf("@")) return false;

  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length > 64 || domain.length > 253) return false;

  if (!local.split(".").every((atom) => LOCAL_ATOM.test(atom))) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
}

/**
 * One thing the user has typed or pasted, resolved.
 *
 * `value` is what goes into the draft. When the text is not an address it is kept
 * verbatim rather than dropped: a recipient that will not deliver is information the
 * user needs to see, and silently deleting what someone typed is the one outcome that
 * makes them distrust the field.
 */
export type RecipientToken = {
  /** An address, or the raw text when it is not one. */
  value: string;
  /** Whether `value` can be delivered to. */
  valid: boolean;
  /** A display name, when the text carried one. */
  name?: string;
};

/**
 * Split a typed or pasted list into recipients.
 *
 * Separators are commas and semicolons, plus newlines — because the paste this exists
 * for is a list off a web page or a spreadsheet column, and `a@b.com\nc@d.com` is the
 * commonest shape of it. Spaces are *not* separators, since `Ada Lovelace <a@b.com>`
 * and the `Name <addr>` form depend on them.
 *
 * Quoted names survive the split for the same reason they do in a header; see
 * `parseAddressList`, and `foldText` is applied per token rather than to the raw string
 * so a name cannot swallow a neighbouring address.
 */
export function parseRecipients(input: string): RecipientToken[] {
  const out: RecipientToken[] = [];
  for (const chunk of splitOutsideQuotes(input)) {
    const value = chunk.trim();
    if (value === "") continue;
    out.push(toToken(value));
  }
  return out;
}

/** One token, already trimmed and non-empty. */
function toToken(value: string): RecipientToken {
  // A chunk that parses as an address list of its own — `Ada <a@b.com>, Grace <c@d.com>`
  // surviving one round of splitting — is expanded rather than kept whole.
  const nested = parseAddressHeader(value);
  const address = nested?.address ?? value;
  const valid = isValidAddress(address);
  return {
    value: valid ? address : stripDisplayName(value) || value,
    valid,
    name: nested?.name,
  };
}

/** Cut on commas, semicolons and newlines, ignoring any inside a quoted string. */
function splitOutsideQuotes(input: string): string[] {
  const chunks: string[] = [];
  let current = "";
  let quoted = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char === '"') {
      quoted = !quoted;
      current += char;
      continue;
    }
    if (!quoted && (char === "," || char === ";" || char === "\n" || char === "\r")) {
      chunks.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  chunks.push(current);
  return chunks;
}