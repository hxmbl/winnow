/**
 * A sender's avatar: their real photo when Winnow has one, otherwise a quiet monogram.
 *
 * Pictures come from `useSenderPictures`: the user's own Google contacts first (only
 * once they opted in to contact suggestions), then — when "Gravatar photos" is on — the
 * sender's Gravatar, then — when "Show brand logos" is on — the sender domain's BIMI logo. The monogram renders until a picture is known and stays
 * when none is, or when one fails to load (revoked, offline, CSP, a broken URL): each
 * candidate is tried in turn and a failure falls through to the next. No favicon
 * lookups, and Gravatar only behind its own switch: each tells a third party who mails
 * the user.
 *
 * Every picture is an `<img>`. A BIMI logo is an SVG from the sender's own host, and an
 * SVG drawn through `<img>` runs no script and loads nothing else; it is never inlined.
 *
 * The monogram is not a colour per sender. The old list painted every row a different
 * hue, which made a column of confetti beside the names; here there are two tones, both
 * neutral steps from the palette — `surface-active` and the lighter `surface-selected`
 * (until 1.4.0 the accent washed into the surface; the accent is now for what you act
 * on) — picked by a stable hash of the address, so the column has a little rhythm
 * without becoming a legend nobody asked to learn.
 */

import { useState } from "react";
import { useSenderPictures } from "../senderPictures";
import { isGravatarUrl } from "../../core/avatars/gravatar";
import { avatarInitial, avatarTone, type AvatarTone } from "../avatar";

const TONE_CLASS: Record<AvatarTone, string> = {
  neutral: "bg-surface-active text-ink-muted",
  soft: "bg-surface-selected text-ink-body",
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
  const found = useSenderPictures(lookup ? address : "", photo, name, size);
  const candidates = lookup ? found : photo ? [photo] : [];
  // URLs that failed to load in this avatar. A new URL gets a fresh attempt.
  const [failed, setFailed] = useState<readonly string[]>([]);
  // The URL that has finished loading. Until then the monogram stays, so a slow host
  // (or an offline one that never answers) shows a letter rather than an empty disc.
  const [loaded, setLoaded] = useState<string | null>(null);
  const picture = candidates.find((url) => !failed.includes(url));
  const showPhoto = picture !== undefined;
  const ready = showPhoto && loaded === picture;
  const dimension = size === 36 ? "h-9 w-9" : "h-8 w-8";
  const fail = (url: string) => setFailed((list) => (list.includes(url) ? list : [...list, url]));

  return (
    <span
      aria-hidden="true"
      data-avatar={showPhoto ? "photo" : "monogram"}
      data-avatar-loaded={ready ? "" : undefined}
      className={`relative flex ${dimension} shrink-0 select-none items-center justify-center overflow-hidden rounded-full text-ui font-semibold ${
        ready ? "bg-surface-active" : TONE_CLASS[avatarTone(address)]
      } ${className}`}
    >
      {/* Hidden, not removed, once the picture is in: a logo with a transparent
          background must not show the letter through it. */}
      <span className={ready ? "invisible" : undefined}>{avatarInitial(name, address)}</span>
      {showPhoto && (
        <img
          key={picture}
          src={picture}
          alt=""
          // No referrer, no drag ghost, no layout jump while it loads.
          referrerPolicy="no-referrer"
          // Gravatar sends `Access-Control-Allow-Origin: *`, so its image can go without
          // cookies. Not for other hosts: one without that header would fail to load.
          crossOrigin={isGravatarUrl(picture) ? "anonymous" : undefined}
          draggable={false}
          loading="lazy"
          decoding="async"
          width={size}
          height={size}
          // Not `naturalWidth === 0` as a failure: a BIMI logo (SVG Tiny PS) has a viewBox
          // and often no width, which some engines report as no natural size at all. An
          // SVG that cannot be decoded fires `error`, which is the fall-through.
          onLoad={() => setLoaded(picture)}
          onError={() => fail(picture)}
          className={`absolute inset-0 h-full w-full object-cover ${ready ? "" : "opacity-0"}`}
        />
      )}
    </span>
  );
}
