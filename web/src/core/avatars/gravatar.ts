/**
 * Gravatar photos for senders who are not in the user's Google contacts — the
 * individual at a company, say, who has a personal photo but is nobody's saved contact.
 *
 * Behind its own setting, off by default: each lookup sends a hash of the sender's
 * address to Gravatar, and a SHA-256 of an email address is a pseudonym, not a secret
 * (anyone holding the address can compute it). So the cache is careful about *which*
 * addresses it asks about, not just how often:
 *
 * - **Never for addresses that cannot be a person.** Malformed addresses, and no-reply
 *   mailboxes (`noreply@`, `no-reply@`, `donotreply@`, `mailer-daemon@`…), which are
 *   machines; relayed senders ("Ana via Book Club") are skipped one level up, by name,
 *   in `useSenderPictures`.
 * - **Misses cached.** With `d=404` an address without a Gravatar is a 404, which is
 *   most addresses; it is remembered for a day, a hit for a week, exactly as brand logos
 *   are (same queue, cap and limits: see `PictureCache`).
 *
 * The lookup loads the image itself rather than calling an API: Gravatar answers an
 * `<img>` with the picture or a 404, and an image needs no `connect-src` exception. The
 * one thing an image cannot report is *why* it failed, so a failure while offline is
 * treated as "not known yet" (the cache's offline handling) and any other failure as a
 * miss.
 */

import { senderDomain } from "./bimi";
import {
  localLogoStorage,
  LOGO_HIT_TTL_MS,
  LOGO_MISS_TTL_MS,
  MAX_LOGO_ENTRIES,
  PictureCache,
  type Entry,
  type PictureCacheOptions,
} from "./logoCache";

export const GRAVATAR_STORAGE_KEY = "winnow.gravatars.v1";
export const GRAVATAR_ORIGIN = "https://gravatar.com";
/** The size the background check asks for: twice the list's 32px avatar. */
export const GRAVATAR_PROBE_SIZE = 64;

const BASE_PATTERN = /^https:\/\/gravatar\.com\/avatar\/[0-9a-f]{64}$/;

/**
 * Local parts that are a machine, not a person. Matched on the whole local part, or the
 * part before a `+`/`-`/`.`/`_` suffix ("noreply+abc", "no-reply-billing"), so a real
 * name that merely starts with the letters is not caught.
 */
const NO_REPLY =
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|dont[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?)(?:[-+._].*)?$/;

/** Whether an address is a no-reply mailbox. Expects any case. */
export function isNoReplyAddress(address: string): boolean {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return false;
  return NO_REPLY.test(trimmed.slice(0, at));
}

/**
 * The form of an address Gravatar hashes — trimmed and lower-cased — or `null` for an
 * address Winnow never sends: malformed (no local part, no valid domain, whitespace or
 * angle brackets inside) or a no-reply mailbox. This is also the cache key.
 */
export function gravatarAddress(address: string): string | null {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at > 64) return null;
  const local = trimmed.slice(0, at);
  if (/[\s<>@"(),:;[\]\\]/.test(local) || local.startsWith(".") || local.endsWith(".")) return null;
  const domain = senderDomain(trimmed);
  // The domain must be exactly what follows the "@", not a looser reading of it.
  if (!domain || domain !== trimmed.slice(at + 1)) return null;
  if (NO_REPLY.test(local)) return null;
  return trimmed;
}

/** SHA-256 of the UTF-8 text, as lower-case hex, by WebCrypto. */
export async function sha256Hex(text: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("no WebCrypto available");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The address's Gravatar hash, or `null` for an address that is never looked up. */
export async function gravatarHash(address: string): Promise<string | null> {
  const normal = gravatarAddress(address);
  return normal ? sha256Hex(normal) : null;
}

/** What the cache stores for a hit: the avatar URL without its query. */
export function gravatarBase(hash: string): string {
  return `${GRAVATAR_ORIGIN}/avatar/${hash}`;
}

/**
 * The URL to load for a stored base at a display size: `d=404` so a missing avatar is a
 * 404 rather than a generated placeholder, and twice the size for high-density screens.
 */
export function gravatarImageUrl(base: string, displaySize: number): string {
  return `${base}?d=404&s=${Math.round(displaySize * 2)}`;
}

/** Whether a URL is one of ours, so the `<img>` can load it without credentials. */
export function isGravatarUrl(url: string): boolean {
  return url.startsWith(`${GRAVATAR_ORIGIN}/avatar/`);
}

/**
 * Loads one image URL: `true` when it loads, `false` when it does not (a 404, here).
 * The app's is an `Image` with no credentials and no referrer; tests pass their own.
 */
export type ImageProbe = (url: string) => Promise<boolean>;

/** Stored entries minus anything that is not an address and a Gravatar base. */
export function sanitiseGravatars(raw: unknown, now: number): Record<string, Entry> {
  const out: Record<string, Entry> = Object.create(null) as Record<string, Entry>;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [address, entry] of Object.entries(raw as Record<string, Entry>)) {
    if (gravatarAddress(address) !== address) continue;
    if (!entry || typeof entry !== "object" || typeof entry.at !== "number") continue;
    if (!Number.isFinite(entry.at) || entry.at > now + 24 * 60 * 60 * 1000) continue;
    if (entry.url === null) out[address] = { url: null, at: entry.at };
    else if (typeof entry.url === "string" && BASE_PATTERN.test(entry.url)) out[address] = { url: entry.url, at: entry.at };
  }
  return out;
}

type Options = PictureCacheOptions & {
  probe: ImageProbe;
  /** Injected for tests; WebCrypto otherwise. */
  hash?: (normalised: string) => Promise<string>;
};

/** Gravatar answers by normalised address, with the brand-logo cache's machinery. */
export class GravatarCache extends PictureCache {
  constructor(options: Options) {
    const { probe, hash = sha256Hex, ...rest } = options;
    super(
      {
        keyOf: gravatarAddress,
        lookup: async (address) => {
          const base = gravatarBase(await hash(address));
          return (await probe(gravatarImageUrl(base, GRAVATAR_PROBE_SIZE / 2))) ? base : null;
        },
        sanitise: sanitiseGravatars,
        hitTtlMs: LOGO_HIT_TTL_MS,
        missTtlMs: LOGO_MISS_TTL_MS,
        maxEntries: MAX_LOGO_ENTRIES,
        defaultStorage: () => localLogoStorage(GRAVATAR_STORAGE_KEY),
      },
      { concurrency: 4, perMinute: 60, ...rest },
    );
  }
}
