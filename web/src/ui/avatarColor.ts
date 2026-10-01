/**
 * Avatar colours.
 *
 * The rule that shapes this file: **no profile pictures.** A gravatar is a
 * third-party request to a company the user never chose to contact, fired once
 * per sender in the list, on every launch. For a mail client that is a
 * meaningful privacy leak and a meaningful latency cost, in exchange for
 * decoration.
 *
 * So the avatar is a monogram on a colour derived from the sender's domain.
 * Zero network, stable across sessions, and — because the hue is walked from a
 * small ramp rather than a continuous wheel — distinct enough to recognise a
 * sender you deal with daily.
 *
 * (The previous version sampled the dominant colour out of a canvas and kept the
 * machinery for it, with `PROFILE_PICTURES` empty. None of that code could run,
 * so every avatar in the app was the same grey.)
 */

/** The ramp, walked by hash. Matches `filterColors.RAMP` minus the alert hues. */
const AVATAR_RAMP = [
  "#81CCD3", // cyan
  "#B8E362", // lime
  "#9DCFA5", // green
  "#B37CCF", // violet
  "#7F8ED8", // blue
  "#D371CB", // magenta
] as const;

/**
 * A stable index per domain.
 *
 * FNV-1a over the domain — the *domain*, not the local part, so two people at
 * one company share a colour, which is the association a person actually has.
 */
function domainIndex(domain: string, buckets: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < domain.length; i += 1) {
    hash ^= domain.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % buckets;
}

/** The avatar fill for a sender, as a hex colour. */
export function avatarColor(sender: string): string {
  const domain = (sender.split("@")[1] ?? sender).toLowerCase();
  return AVATAR_RAMP[domainIndex(domain, AVATAR_RAMP.length)];
}

/**
 * A slightly deeper variant of the same hue, for the monogram's text.
 *
 * The ramp is pastel, so black text on it fails contrast on the lightest steps.
 * Deriving a darker shade from the same hue keeps the pairing looking deliberate
 * while staying legible.
 */
export function avatarTextColor(sender: string): string {
  const domain = (sender.split("@")[1] ?? sender).toLowerCase();
  const base = AVATAR_RAMP[domainIndex(domain, AVATAR_RAMP.length)];
  return mix(base, "#15181D", 0.55);
}

/** Blend two hex colours. `amount` is how much of `to` to apply. */
function mix(from: string, to: string, amount: number): string {
  const a = Number.parseInt(from.slice(1), 16);
  const b = Number.parseInt(to.slice(1), 16);
  const channel = (shift: number): number => {
    const left = (a >> shift) & 255;
    const right = (b >> shift) & 255;
    return Math.round(left + (right - left) * amount);
  };
  return `#${[16, 8, 0].map((s) => channel(s).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Warm the cache.
 *
 * Kept as an explicit call rather than a module side effect so the import order
 * of the app cannot affect what is rendered, and so it is obvious at the call
 * site that nothing is being fetched.
 */
export function primeAvatarColors(): void {
  // Intentionally empty: colours are computed on demand and cached by the
  // caller. The function survives because it documents that there is no warm-up
  // cost, and because removing it would be a breaking change to a public module.
}
