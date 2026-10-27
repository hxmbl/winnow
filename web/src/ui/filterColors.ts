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
 * Meaning decides the hue, not position in the list:
 * the warm end (red, rose, orange, amber, gold) is for mail that is urgent, wrong or
 * important; blue is trust (Security and Top contacts, held apart by shade); green is
 * money (Promos and Receipts, held apart by shade); light brown is a parcel; the
 * purples are people-and-plans (social, events) and codes. Low-meaning buckets (Unread,
 * Files, Quiet contacts, Newsletters, Read later, Long reads) are neutral grey, because a
 * coloured pill says "this means something" about mail that needs nothing. Every
 * coloured bucket has its own hue/saturation pair, so no two coloured pills on the rail
 * are the same colour; `theme.test.ts` asserts that, and that each label and count
 * clears WCAG AA on its pill's fill in every mode.
 */

import type { BuiltinSmartFilter } from "../core/model/signals";

/** A pill's identity colour: an HSL hue in degrees and a saturation in percent. */
export type PillHue = { h: number; s: number };

/** No hue, no saturation: a chip that is plain grey. */
export const NEUTRAL: PillHue = { h: 0, s: 0 };

export const FILTER_HUES: Record<BuiltinSmartFilter, PillHue> = {
  // Warm = attention. Red is danger, rose is a
  // threat, orange is "do something", amber is importance (Hxmbl's pick), yellow/gold
  // is the star you set yourself.
  urgent: { h: 4, s: 78 },
  unsafe: { h: 340, s: 72 },
  needs_action: { h: 24, s: 85 },
  important: { h: 42, s: 90 },
  starred: { h: 52, s: 85 },

  // Blue is trust (Hxmbl, 2026-10-27). Security keeps a vivid cobalt (protection);
  // Top contacts is a softer sky azure 18° greener (people you trust); New contacts sits at
  // the teal edge of the family: a person, trust not yet earned.
  security: { h: 214, s: 80 },
  top_contacts: { h: 196, s: 62 },
  new_senders: { h: 176, s: 55 },

  // Green is money (Hxmbl, 2026-10-27). Promos takes the classic money green; Receipts
  // is the same family in a cooler emerald, so a receipt and a sale read as related
  // but never as the same chip.
  promotional: { h: 122, s: 46 },
  receipts: { h: 154, s: 55 },

  // Physical parcels: cardboard light brown (Hxmbl, 2026-10-27).
  shipping: { h: 32, s: 44 },

  // Things on your calendar or in your hand: travel indigo, events violet; social is
  // purple (people, chatter); codes magenta (a key, held apart from Unsafe's rose).
  travel: { h: 232, s: 70 },
  social: { h: 266, s: 55 },
  events: { h: 290, s: 58 },
  codes: { h: 316, s: 62 },

  // Neutral: low-meaning buckets get no hue at all, so the rail's colour only ever
  // says something. They share one grey and are told apart by icon and label.
  unread: NEUTRAL,
  attachments: NEUTRAL,
  quiet_contacts: NEUTRAL,
  newsletters: NEUTRAL,
  low_priority: NEUTRAL,
  long_reads: NEUTRAL,
};

/** The buckets that are deliberately neutral grey (no identity hue). */
export const NEUTRAL_FILTERS: ReadonlySet<BuiltinSmartFilter> = new Set<BuiltinSmartFilter>(
  (Object.keys(FILTER_HUES) as BuiltinSmartFilter[]).filter((id) => FILTER_HUES[id] === NEUTRAL),
);

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
