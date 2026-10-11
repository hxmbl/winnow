/**
 * Failure copy the user can select — and, when it is long, expand.
 *
 * Selection: the app turns text selection off on the chrome (`user-select: none`
 * in `index.css`) because a mail client's chrome is not content. The one text a
 * user genuinely needs to copy is the error they just got — to search it, to
 * paste it into a report — so this component opts back in with the `.selectable`
 * class the stylesheet exists to provide.
 *
 * Expansion: the failures `core/session/errors.ts` now produces are verbose on
 * purpose — the whole point was to say *which* state, *which* origin, *which*
 * Google error — and a long paragraph on the sign-in screen is a wall. A long
 * text is clamped to two lines under a disclosure, and opening it removes the
 * clamp from the *same* text rather than revealing a copy of it: what the user
 * reads expanded is exactly what they copy, and the disclosure costs nothing when
 * none of the errors are long.
 *
 * A short text (a verdict line, a hint that is a fragment) renders as plain
 * selectable text with no disclosure, because a "Details" toggle around one
 * sentence is ceremony.
 */

import type { ReactElement } from "react";
import { ChevronDown } from "lucide-react";

/** Texts up to this many characters are short enough to show as-is. */
const LONG_ERROR_CHARS = 120;

type Props = {
  text: string;
  /** Extra classes to match the caller's surface (colour, size…). */
  className?: string;
};

export function ErrorText({ text, className = "" }: Props): ReactElement {
  const root = className ? ` ${className}` : "";

  if (text.length <= LONG_ERROR_CHARS) {
    return <span className={`selectable${root}`}>{text}</span>;
  }

  // `summary` carries both states of the text — clamped when closed, unclamped
  // when open — so expanding reveals the same string rather than a second copy.
  return (
    <details className={`group${root}`}>
      <summary className="flex cursor-pointer list-none items-start gap-1 [&::-webkit-details-marker]:hidden">
        <ChevronDown
          size={12}
          strokeWidth={2}
          className="mt-px shrink-0 text-ink-subtle transition-transform group-open:rotate-180"
          aria-hidden="true"
        />
        <span className="selectable line-clamp-2 group-open:line-clamp-none">{text}</span>
      </summary>
    </details>
  );
}