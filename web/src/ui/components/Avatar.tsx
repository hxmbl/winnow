/**
 * A sender's avatar: their real photo when Winnow has one, otherwise a quiet monogram.
 *
 * Pictures come from `useSenderPictures`: the user's own Google contacts first (only
 * once they opted in to contact suggestions), then — when "Show brand logos" is on — the
 * sender domain's BIMI logo. The monogram renders until a picture is known and stays
 * when none is, or when one fails to load (revoked, offline, CSP, a broken URL): each
 * candidate is tried in turn and a failure falls through to the next. No Gravatar or
 * favicon lookups: each of those would tell a third party who mails the user.
 *
 * Every picture is an `<img>`. A BIMI logo is an SVG from the sender's own host, and an
 * SVG drawn through `<img>` runs no script and loads nothing else; it is never inlined.
 *
 * The monogram is not a colour per sender. The old list painted every row a different
 * hue, which made a column of confetti beside the names; here there are two tones, both
 * from the palette — the neutral `surface-active` and the accent washed into the surface
 * (`surface-selected`) — picked by a stable hash of the address, so the column has a
 * little rhythm without becoming a legend nobody asked to learn.
 */

import { useState } from "react";
import { useSenderPictures } from "../senderPictures";
import { avatarInitial, avatarTone, type AvatarTone } from "../avatar";

const TONE_CLASS: Record<AvatarTone, string> = {
  neutral: "bg-surface-active text-ink-muted",
  accent: "bg-surface-selected text-ink-body",
};

type Props = {
  name: string;
  address: string;
  /** An explicit photo URL; otherwise the sender-pictures context is asked. */
  photo?: string;
  /** False for avatars that are not a sender (the account chip). */
  lookup?: boolean;
  /** 32 in the list, 36 in the reader header. */
  size?: 32 | 36;
  className?: string;
};

export function Avatar({ name, address, photo, lookup = true, size = 32, className = "" }: Props) {
  const found = useSenderPictures(lookup ? address : "", photo);
  const candidates = lookup ? found : photo ? [photo] : [];
  // URLs that failed to load in this avatar. A new URL gets a fresh attempt.
  const [failed, setFailed] = useState<readonly string[]>([]);
  const picture = candidates.find((url) => !failed.includes(url));
  const showPhoto = picture !== undefined;
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
          key={picture}
          src={picture}
          alt=""
          // No referrer, no drag ghost, no layout jump while it loads.
          referrerPolicy="no-referrer"
          draggable={false}
          loading="lazy"
          decoding="async"
          width={size}
          height={size}
          onError={() => setFailed((list) => (list.includes(picture) ? list : [...list, picture]))}
          className="h-full w-full object-cover"
        />
      ) : (
        avatarInitial(name, address)
      )}
    </span>
  );
}
