/**
 * Contact photos, ready for an avatar.
 *
 * The People API already hands each person's photos back with the address book (see
 * `gmail/people.ts`, whose field mask asks for `photos`, and `contacts/google.ts`, which
 * skips Google's `default: true` letter placeholders and keeps the primary real photo).
 * What is left is shaping that for the list: one URL per lower-cased address, every
 * address a person has, at a size an avatar actually uses.
 */

import type { GoogleContact } from "../contacts/google";

/**
 * The pixel size asked of Google for an avatar.
 *
 * The largest avatar is 36 CSS pixels (the reader header); 96 covers it at 2x and
 * nearly at 3x, and is a size Google's image server already keeps warm (profile
 * pictures in Gmail are served at `s96`). The People API's own default is 100.
 */
export const AVATAR_PHOTO_PX = 96;

/** `…=s100`, `…=s100-c`, `…=s100-p-k-no` — googleusercontent's size option at the end. */
const SIZE_OPTION = /=s\d+(-[a-z0-9-]*)?$/i;

/**
 * The photo URL at `px` pixels.
 *
 * The People API documents appending `sz={size}` as a query parameter (its own example
 * is `…/s100/photo.jpg?sz=50`). The URLs it returns today are mostly the newer form
 * ending in a `=s100` option, where the option is what the image server reads; both are
 * handled. Anything that is not a googleusercontent URL is returned unchanged — the
 * demo's bundled pictures, for one — because a size suffix means nothing to another
 * host.
 */
export function sizedPhotoUrl(url: string, px: number = AVATAR_PHOTO_PX): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (!/(^|\.)googleusercontent\.com$/i.test(parsed.hostname)) return url;
  const size = Math.max(16, Math.min(512, Math.round(px)));
  if (!parsed.search && SIZE_OPTION.test(parsed.pathname)) {
    parsed.pathname = parsed.pathname.replace(SIZE_OPTION, `=s${size}-c`);
    return parsed.toString();
  }
  // The newer form without an option yet (`/a/ACg8oc…`): add one.
  if (!parsed.search && /^\/a-?\//.test(parsed.pathname) && !parsed.pathname.includes("=")) {
    parsed.pathname = `${parsed.pathname}=s${size}-c`;
    return parsed.toString();
  }
  // The documented form, and anything else on Google's image host.
  parsed.searchParams.set("sz", String(size));
  return parsed.toString();
}

/**
 * Lower-cased address → avatar-sized photo URL.
 *
 * `flattenSnapshot` already lists a person once per address, so a person with a work
 * and a home address is found from either. The first contact to claim an address wins
 * (saved contacts come first in that list), and a contact with no photo leaves the
 * address free for a later one that has one.
 */
export function contactPhotoMap(
  contacts: readonly GoogleContact[],
  px: number = AVATAR_PHOTO_PX,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const contact of contacts) {
    if (!contact.photo) continue;
    const key = contact.address.trim().toLowerCase();
    if (!key || map.has(key)) continue;
    map.set(key, sizedPhotoUrl(contact.photo, px));
  }
  return map;
}
