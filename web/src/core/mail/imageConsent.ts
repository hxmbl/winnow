/**
 * Whether a message may load its remote images, and whether to offer the choice.
 *
 * This started as two expressions in `App.tsx`, and the bug that let it grow was
 * right there in them: the per-message grant was an `||` against the standing
 * policy, so *nothing* could veto it. A user who allowed images for one message
 * and then went and set the policy to "never" kept loading remote images for
 * that message — a tracking pixel still firing, after the one answer that should
 * have stopped it — until they navigated away and back, which cleared the grant
 * by accident rather than by design.
 *
 * So it is a function, and it is in `core/` rather than in a component, for one
 * reason: this is the decision that decides whether a sender gets to learn that a
 * message was opened, and it should be something a test can state as a rule
 * instead of something a reader has to be trusted to get right.
 *
 * Two separate questions, deliberately. `imagesAllowed` is the boundary and is
 * closed by default; `askAboutImages` is whether to put the choice to the user.
 * Neither is the negation of the other, which is the whole difficulty: `never`
 * is not "always allow, quietly".
 */

/** The standing answer about remote images. See `Preferences.imagePolicy`. */
export type ImagePolicy = "ask" | "always" | "never";

/**
 * The one-off answer, for the message currently open.
 *
 * A message id rather than a boolean, because consent is per *message*: allowing
 * images for a newsletter that embeds a tracking pixel says nothing about the
 * next one, and a single boolean would carry the grant across messages.
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
 * Resolve the standing answer and the one-off answer into two booleans.
 *
 * The order is the security argument, so it is written as an early return rather
 * than as one expression: `never` and `always` are both *decisions*, and both are
 * taken before the one-off grant is ever consulted. A grant can only ever add
 * permission inside `ask`, which is the only state where the user has not already
 * answered.
 */
export function resolveImageConsent({
  policy,
  grantedFor,
  selectedId,
}: ImageConsent): ResolvedImageConsent {
  // "Never" is absolute, and it is checked first so that no later clause can
  // re-open it. This is the clause the old expression was missing: the grant used
  // to survive a policy change, so "never" did not mean never.
  if (policy === "never") {
    return { imagesAllowed: false, askAboutImages: false };
  }

  // A standing permission needs no per-message grant, and supersedes the offer —
  // asking a question the preferences have already answered is noise.
  if (policy === "always") {
    return { imagesAllowed: true, askAboutImages: false };
  }

  // `ask`. Consent is the grant *for this message*: a grant for another message is
  // not consent to anything about this one.
  const grantedHere = grantedFor !== null && grantedFor === selectedId;
  return {
    imagesAllowed: grantedHere,
    // Not simply `true`. Having already been granted *for this message* is the one
    // case under `ask` where there is no question left to put to the user, so the
    // two booleans are made mutually exclusive here rather than relying on the
    // reader to remember to combine them. `askAboutImages` then means what its
    // name says — the offer should appear — instead of "the policy is permissive
    // enough to allow one".
    askAboutImages: !grantedHere,
  };
}