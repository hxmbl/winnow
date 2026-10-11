/**
 * Whether a message may load its remote images, and whether to offer the choice.
 *
 * `imagesAllowed` is the boundary, closed by default; `askAboutImages` is whether
 * to put the choice to the user. Neither is the negation of the other: `never` is
 * not "always allow, quietly".
 */

/** The standing answer about remote images. See `Preferences.imagePolicy`. */
export type ImagePolicy = "ask" | "always" | "never";

/**
 * The one-off answer, for the message currently open. A message id rather than a
 * boolean, because consent is per *message*.
 */
export interface ImageConsent {
  /** The standing answer. */
  policy: ImagePolicy;
  /** The message the user allowed images for in this session, or null. */
  grantedFor: number | null;
  /** The message on screen, or null when the reader is empty. */
  selectedId: number | null;
}

export interface ResolvedImageConsent {
  /** May the open message's remote images load? */
  imagesAllowed: boolean;
  /** Should the reader offer the choice? */
  askAboutImages: boolean;
}

/**
 * Resolve the standing answer and the one-off answer into two booleans; `never`
 * and `always` are decided before the one-off grant is consulted.
 */
export function resolveImageConsent({
  policy,
  grantedFor,
  selectedId,
}: ImageConsent): ResolvedImageConsent {
  // "Never" is absolute, and it is checked first so no later clause can re-open it.
  if (policy === "never") {
    return { imagesAllowed: false, askAboutImages: false };
  }

  // A standing permission needs no per-message grant and supersedes the offer.
  if (policy === "always") {
    return { imagesAllowed: true, askAboutImages: false };
  }

  // Consent is the grant *for this message*; a grant for another message is not
  // consent to anything about this one.
  const grantedHere = grantedFor !== null && grantedFor === selectedId;
  return {
    imagesAllowed: grantedHere,
    // Already granted for this message leaves no question to ask.
    askAboutImages: !grantedHere,
  };
}