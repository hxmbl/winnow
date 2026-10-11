/**
 * Failure copy the user can select — and, when long, expand.
 *
 * The chrome disables text selection, but the error is the one text a user needs to
 * copy, so this opts back in. A long text is clamped under a disclosure that unclamps
 * the *same* string rather than revealing a copy; a short one gets no disclosure, since
 * a "Details" toggle around one sentence is ceremony.
 */

import type { ReactElement } from "react";
import { ChevronDown } from "lucide-react";

/** Texts this short are shown as-is. */
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

  // `summary` carries both states of the text, so expanding reveals the same string
  // rather than a second copy.
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