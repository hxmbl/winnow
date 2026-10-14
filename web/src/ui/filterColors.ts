/**
 * Each smart filter's colour on the rail.
 *
 * A bucket is given a *hue and a saturation*, never a finished colour. The finished
 * colour depends on the mode: `theme.ts` publishes the recipe (`--wn-pill-*`: lightness,
 * how much of the saturation a mode keeps, and the rest and on alphas), and the
 * `.wn-pill` rule in `index.css` puts the two together. So one table serves light, dark
 * and OLED, a new mode is coloured the day its recipe is written, and nothing in a
 * component knows which mode is live.
 *
 * Meaning decides the hue, not position in the list: the warm end (red, rose, orange,
 * amber) is for mail that is urgent or wrong, blue is security, greens are people and
 * parcels, and the bulk buckets (newsletters, promos, read later, long reads) are kept
 * close to grey, because a saturated pill says "act on this" about mail that needs
 * nothing. Every bucket has its own hue/saturation pair, so no two pills on the rail
 * are the same colour; `theme.test.ts` asserts that, and that each label and count
 * clears WCAG AA on its pill's fill in every mode.
 */

import type { BuiltinSmartFilter } from "../core/model/signals";

/** A pill's identity colour: an HSL hue in degrees and a saturation in percent. */
export type PillHue = { h: number; s: number };

export const FILTER_HUES: Record<BuiltinSmartFilter, PillHue> = {
  // The loud end: something is on fire or something is wrong.
  urgent: { h: 4, s: 78 },
  unsafe: { h: 340, s: 72 },
  needs_action: { h: 26, s: 85 },
  important: { h: 42, s: 90 },
  starred: { h: 52, s: 85 },
  security: { h: 208, s: 80 },

  // Specific things you asked for, each its own hue so Deliveries and Codes never read
  // as the same thing.
  codes: { h: 296, s: 62 },
  shipping: { h: 128, s: 50 },
  travel: { h: 232, s: 70 },
  events: { h: 272, s: 62 },
  receipts: { h: 186, s: 70 },
  social: { h: 252, s: 58 },
  unread: { h: 86, s: 60 },
  attachments: { h: 66, s: 48 },
  new_senders: { h: 168, s: 60 },

  // People rather than topics.
  top_contacts: { h: 148, s: 56 },
  quiet_contacts: { h: 108, s: 24 },

  // Bulk and skippable: nearly grey, each with a faint cast of its own.
  newsletters: { h: 200, s: 22 },
  promotional: { h: 320, s: 26 },
  low_priority: { h: 228, s: 14 },
  long_reads: { h: 32, s: 18 },
};

/**
 * A sender pill's colour, derived from the address's domain.
 *
 * Not from a profile picture: that is a third-party request per pill. The domain rather
 * than the whole address, so `ada@` and `grace@` at one company share a colour, which is
 * the association a person actually has. Low saturation: a sender pill is identity, not
 * urgency, and must not compete with the semantic buckets beside it.
 */
export function senderHue(sender: string): PillHue {
  const domain = sender.split("@")[1]?.toLowerCase() || sender.toLowerCase();
  // FNV-1a, so the same domain always lands on the same hue.
  let hash = 0x811c9dc5;
  for (let i = 0; i < domain.length; i += 1) {
    hash ^= domain.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Twelve evenly spaced hues: far enough apart that two domains that land on
  // neighbouring steps still read as different.
  return { h: (hash % 12) * 30 + 15, s: 20 };
}
