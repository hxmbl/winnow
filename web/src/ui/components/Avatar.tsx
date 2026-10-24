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
 * A picture an avatar has drawn is kept as a small copy on the device
 * (`core/avatars/pictureBytes.ts`, through `usePictureBytes`): next time the copy (a
 * `data:` URL) is drawn first, so a recent sender's picture is there at once and
 * offline. A stale copy is still drawn and refreshed in the background; a copy that
 * fails to decode falls through to the picture's URL; a picture whose host does not
 * allow it to be read back (no CORS header) is never kept and is drawn from its URL, as
 * before. The copy only ever replaces a picture the avatar would have drawn anyway.
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

import { useEffect, useState } from "react";
import { pictureTries, usePictureBytes, useSenderPictures, type PictureCandidate } from "../senderPictures";
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
  const bytes = usePictureBytes();
  const candidates: PictureCandidate[] = lookup ? found : photo ? [{ url: photo, kind: "contact" }] : [];
  // Not the account chip (`lookup` false): only sender pictures are kept.
  const keep = lookup ? bytes : null;
  // `src`s that failed to load in this avatar. A new one gets a fresh attempt.
  const [failed, setFailed] = useState<readonly string[]>([]);
  // The `src` that has finished loading. Until then the monogram stays, so a slow host
  // (or an offline one that never answers) shows a letter rather than an empty disc.
  const [loaded, setLoaded] = useState<string | null>(null);
  const usable = pictureTries(candidates, keep).filter((attempt) => !failed.includes(attempt.src));
  const first = usable[0];
  // A picture already on screen from its URL stays there when its copy lands: the copy
  // is for next time, not a reason to redraw (and flash the monogram) now.
  const picture = (first && usable.find((attempt) => attempt.url === first.url && attempt.src === loaded)) ?? first;
  const showPhoto = picture !== undefined;
  const ready = showPhoto && loaded === picture.src;
  const fail = (src: string) => setFailed((list) => (list.includes(src) ? list : [...list, src]));

  // Drawing a kept copy keeps it among the recent ones, and a stale one is refreshed in
  // the background (online only; the cache decides). Never waited on.
  const pictureUrl = picture?.url;
  const pictureKind = picture?.kind;
  const fromCopy = picture?.cached === true;
  useEffect(() => {
    if (!keep || !pictureUrl || !pictureKind || !fromCopy) return;
    keep.touch(pictureUrl);
    if (keep.isStale(pictureUrl)) void keep.remember(pictureUrl, pictureKind);
  }, [keep, pictureUrl, pictureKind, fromCopy]);

  const onLoad = () => {
    if (!picture) return;
    setLoaded(picture.src);
    // Drawn from the network: keep a copy for next time (a no-op when a fresh one is kept).
    if (keep && !picture.cached) void keep.remember(picture.url, picture.kind);
  };
  const dimension = size === 36 ? "h-9 w-9" : "h-8 w-8";

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
          key={picture.src}
          src={picture.src}
          alt=""
          // No referrer, no drag ghost, no layout jump while it loads.
          referrerPolicy="no-referrer"
          // Gravatar sends `Access-Control-Allow-Origin: *`, so its image can go without
          // cookies. Not for other hosts: one without that header would fail to load.
          crossOrigin={!picture.cached && isGravatarUrl(picture.src) ? "anonymous" : undefined}
          draggable={false}
          loading="lazy"
          decoding="async"
          width={size}
          height={size}
          // Not `naturalWidth === 0` as a failure: a BIMI logo (SVG Tiny PS) has a viewBox
          // and often no width, which some engines report as no natural size at all. An
          // SVG that cannot be decoded fires `error`, which is the fall-through.
          onLoad={onLoad}
          onError={() => fail(picture.src)}
          className={`absolute inset-0 h-full w-full object-cover ${ready ? "" : "opacity-0"}`}
        />
      )}
    </span>
  );
}
