/**
 * Per-account email nicknames.
 *
 * Users can assign custom names (e.g., "Work", "School", "Personal") to their
 * own email addresses for easy identification when composing or viewing their
 * own addresses in suggestions.
 *
 * Storage is per-account, keyed by the account's normalized email address.
 */

import { accountKey, type KeyValueStorage } from "../session/accounts";

/** Map of normalized email address → nickname */
export type EmailNicknames = Record<string, string>;

/** Key for storing email nicknames in account-scoped storage */
export const EMAIL_NICKNAMES_KEY = "winnow.emailNicknames.v1";

/**
 * Load email nicknames for an account.
 */
export function loadEmailNicknames(
  storage: KeyValueStorage | null,
  accountId: string | null,
): EmailNicknames {
  if (!storage || !accountId) return {};
  const key = accountKey(EMAIL_NICKNAMES_KEY, accountId);
  let raw: string | null;
  try { raw = storage.getItem(key); } catch { return {}; }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => typeof key === "string" && typeof value === "string")) as EmailNicknames;
    }
    return {};
  } catch {
    return {};
  }
}

/**
 * Save email nicknames for an account.
 */
export function persistEmailNicknames(
  storage: KeyValueStorage | null,
  accountId: string | null,
  nicknames: EmailNicknames,
): void {
  if (!storage || !accountId) return;
  const key = accountKey(EMAIL_NICKNAMES_KEY, accountId);
  try {
    storage.setItem(key, JSON.stringify(nicknames));
  } catch {
    // Silently fail on quota exceeded - the nicknames are optional.
  }
}

/** Load nicknames from the browser's device storage. */
export function getEmailNicknames(accountId: string | null): EmailNicknames {
  let storage: KeyValueStorage | null = null;
  try { storage = globalThis.localStorage; } catch { return {}; }
  return loadEmailNicknames(storage, accountId);
}

/**
 * Get a nickname for a specific address.
 */
export function getNickname(
  nicknames: EmailNicknames,
  address: string,
): string | undefined {
  const normalized = normalizeAddress(extractAddress(address));
  return nicknames[normalized] ?? undefined;
}

/**
 * Set or update a nickname for an address.
 */
export function setNickname(
  nicknames: EmailNicknames,
  address: string,
  nickname: string | null,
): EmailNicknames {
  const normalized = normalizeAddress(extractAddress(address));
  const updated = { ...nicknames };
  if (nickname) {
    updated[normalized] = nickname;
  } else {
    delete updated[normalized];
  }
  return updated;
}

/** Save through the browser's device storage. */
export function setNicknameForAddress(accountId: string | null, address: string, nickname: string | null): void {
  const nicknames = getEmailNicknames(accountId);
  let storage: KeyValueStorage | null = null;
  try { storage = globalThis.localStorage; } catch { return; }
  persistEmailNicknames(storage, accountId, setNickname(nicknames, address, nickname));
}

function extractAddress(value: string): string {
  const match = value.match(/<([^<>]+)>/);
  return match?.[1] ?? value.split(/[;,]/, 1)[0].trim();
}

/**
 * Normalize an email address for use as a lookup key.
 * Case- and accent-insensitive folding to ensure consistent lookups.
 */
export function normalizeAddress(address: string): string {
  const normalized = address.trim().toLowerCase();
  return normalized.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

/**
 * Legacy "foldText" helper to match existing code patterns.
 */
export function foldText(value: string): string {
  return normalizeAddress(value);
}
