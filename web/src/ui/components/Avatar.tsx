/**
 * A sender's avatar: their real photo when Winnow has one, otherwise a quiet monogram.
 *
 * The photo comes from the user's own Google contacts (`GoogleContact.photo`), which
 * Winnow only has once the user opted in to contact suggestions — so most senders, and
 * everyone in the demo, get the monogram. No Gravatar or favicon lookups: each of those
 * would tell a third party who mails the user.
 *
 * The monogram is not a colour per sender. The old list painted every row a different
 * hue, which made a column of confetti beside the names; here there are two tones, both
 * from the palette — the neutral `surface-active` and the accent washed into the surface
 * (`surface-selected`) — picked by a stable hash of the address, so the column has a
 * little rhythm without becoming a legend nobody asked to learn.
 */

import { useState } from "react";
import { avatarInitial, avatarTone, type AvatarTone } from "../avatar";

const TONE_CLASS: Record<AvatarTone, string> = {
  neutral: "bg-surface-active text-ink-muted",
  accent: "bg-surface-selected text-ink-body",
};

type Props = {
  name: string;
  address: string;
  /** An https photo URL, when one is known. */
  photo?: string;
  /** 32 in the list, 36 in the reader header. */
  size?: 32 | 36;
  className?: string;
};

export function Avatar({ name, address, photo, size = 32, className = "" }: Props) {
  // A photo that fails (revoked, offline, CSP) falls back to the monogram rather than a
  // broken-image glyph. Keyed by URL so a new photo gets a fresh attempt.
  const [failed, setFailed] = useState<string | null>(null);
  const showPhoto = photo !== undefined && failed !== photo;
  const dimension = size === 36 ? "h-9 w-9" : "h-8 w-8";

  return (
    <span
      aria-hidden="true"
      data-avatar={showPhoto ? "photo" : "monogram"}
      className={`flex ${dimension} shrink-0 select-none items-center justify-center overflow-hidden rounded-full text-ui font-semibold ${
        showPhoto ? "bg-surface-active" : TONE_CLASS[avatarTone(address)]
      } ${className}`}
    >
      {showPhoto ? (
        <img
          src={photo}
          alt=""
          // No referrer, no drag ghost, no layout jump while it loads.
          referrerPolicy="no-referrer"
          draggable={false}
          loading="lazy"
          decoding="async"
          width={size}
          height={size}
          onError={() => setFailed(photo)}
          className="h-full w-full object-cover"
        />
      ) : (
        avatarInitial(name, address)
      )}
    </span>
  );
}
