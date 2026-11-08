/**
 * Splitting a synced mailbox into its messages and its resident HTML bodies.
 *
 * A helper rather than a method so the body cache and the sync path share one
 * definition of what "resident" means.
 */

import { isBodyLoaded, withCode, type Email } from "../../model/email";

/**
 * How many messages keep their HTML body resident.
 *
 * A bound on *this field* rather than on the number of messages. On a representative
 * HTML email the body is 67% of the bytes, and it is read in exactly two places —
 * `Reader` and `reply`, both for the message being opened — so retaining it for every
 * message is the whole of the waste: 5,000 messages cost 12.1MB rather than 3.9MB.
 *
 * The plain-text `body` is kept unconditionally, which is load-bearing: `contentBag`
 * is `subject + body`, so every keyword the classifier matches is still there.
 * Bounding `bodyHtml` costs one request when an old message is opened and costs the
 * classifier nothing. 500 keeps ordinary reading fetch-free, at ~1.2MB resident.
 */
export const BODY_RETENTION = 500;

/**
 * Split a synced mailbox into its messages and its resident HTML bodies.
 *
 * The bodies are held *beside* `state.all` rather than inside it: attaching one to a
 * message rebuilds the array, which changes `state.all`'s identity, invalidates the
 * memo in `inboxAnalysis` and reclassifies the whole inbox — a 271ms stall at 5,000
 * messages. A side-map leaves `state.all` alone, so the body arrives for the price of
 * a re-render, and `state.all` is uniformly body-free, so nothing has to ask whether a
 * message is inside the window.
 */
export function partitionBodies(emails: readonly Email[]): {
  emails: Email[];
  bodies: Map<number, string>;
  /** Messages whose body question is settled — resident, or known to have no HTML. */
  checked: Set<number>;
} {
  const byRecency = [...emails].sort((a, b) => b.receivedAt - a.receivedAt);
  const bodies = new Map<number, string>();
  const checked = new Set<number>();
  let changed = false;

  for (const email of byRecency.slice(0, BODY_RETENTION)) {
    // Every loaded message in the window counts as settled, not just the ones with
    // HTML: recording that stops the reader asking again for a plain-text message it
    // opens. A metadata-only row is not settled — its body has never been fetched.
    if (!isBodyLoaded(email)) continue;
    checked.add(email.id);
    if (email.bodyHtml !== undefined) bodies.set(email.id, email.bodyHtml);
  }

  const stripped = emails.map((email) => {
    // Rows cached before codes existed are looked at once, on the way in.
    const coded = withCode(email);
    if (coded !== email) changed = true;
    if (coded.bodyHtml === undefined) return coded;
    changed = true;
    return { ...coded, bodyHtml: undefined };
  });

  // The same array when nothing had a body, so the demo seed keeps the identity
  // `inboxAnalysis` is keyed on.
  return { emails: changed ? stripped : (emails as Email[]), bodies, checked };
}
