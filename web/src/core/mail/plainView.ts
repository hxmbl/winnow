/**
 * The text the reader's "Plain text" form shows, normally or with Dev Options → Pure
 * Plain Text on.
 *
 * **Normally** it is `tidyPlainText(email.body)`: the body (the `text/plain` part, or
 * `plainTextFromHtml`'s extraction when there is none) with invisible preheader filler
 * removed, whitespace-only lines emptied, runs of blank lines collapsed to one, and the
 * leading and trailing blank lines dropped.
 *
 * **Pure** skips every one of those removals:
 *
 *   - a `text/plain` part is shown byte for byte as Gmail decoded it;
 *   - with no `text/plain` part, the HTML goes through `literalTextFromHtml` instead of
 *     `plainTextFromHtml`, so nothing the extraction drops (the `<head>`/`<style>`/
 *     `<script>` contents, indentation, blank lines, filler) is dropped;
 *   - a metadata-only row (Gmail's snippet stand-in) is shown as it is.
 *
 * What is *not* skipped, because it is safety rather than removal: the result is still
 * rendered as a React text node (no markup from the sender reaches the document), and
 * the plain form still fetches nothing, so no remote content or tracking pixel loads.
 */

import type { Email } from "../model/email";
import { literalTextFromHtml, plainTextFromHtml, tidyPlainText } from "./html";

/**
 * Whether `body` is Winnow's extraction from the HTML rather than the sender's own text.
 *
 * `bodySource` says so on anything mapped since it existed. A cache row from before has
 * no answer, so it is worked out the way the mapper made it: an HTML-only message's body
 * is exactly `plainTextFromHtml` of its HTML.
 */
export function bodyIsExtractedFromHtml(email: Pick<Email, "body" | "bodyHtml" | "bodySource">): boolean {
  if (email.bodySource !== undefined) return email.bodySource === "html";
  if (!email.bodyHtml) return false;
  return email.body === plainTextFromHtml(email.bodyHtml);
}

/** The plain-text reading of a message; `pure` is Dev Options → Pure Plain Text. */
export function plainTextForReading(
  email: Pick<Email, "body" | "bodyHtml" | "bodySource">,
  { pure }: { pure: boolean },
): string {
  if (!pure) return tidyPlainText(email.body);
  if (email.bodyHtml && bodyIsExtractedFromHtml(email)) return literalTextFromHtml(email.bodyHtml);
  return email.body;
}
