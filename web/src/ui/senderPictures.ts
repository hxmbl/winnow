/**
 * Where an avatar finds a sender's picture.
 *
 * Three sources, in order: the user's own Google contacts (a person's photo, only after
 * they opted in to contacts); when "Gravatar photos" is on, the sender's Gravatar; and,
 * when "Show brand logos" is on, the sender domain's BIMI logo. A personal photo beats a
 * brand logo. Anything else — or a picture that fails to load — is the monogram, which
 * is also what renders first: nothing here blocks a row.
 *
 * A context rather than props because the list, the reader header and the sender menu
 * all draw avatars, and threading two lookups through each of them would make every
 * row component care about where pictures come from.
 */

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { LogoState } from "../core/avatars/logoCache";
import { senderDomain } from "../core/avatars/bimi";
import { gravatarImageUrl, type ImageProbe } from "../core/avatars/gravatar";

/** What the cache exposes; the demo implements it from a fixed table. */
export interface LogoSource {
  peek(address: string): LogoState;
  request(address: string): Promise<string | null>;
  subscribe(listener: () => void): () => void;
  getVersion(): number;
}

export type SenderPictures = {
  /** Lower-cased address → contact photo URL. */
  photos: ReadonlyMap<string, string>;
  /** `null` when Gravatar photos are off. A hit's URL is a base, sized here. */
  gravatars: LogoSource | null;
  /** `null` when brand logos are off. */
  logos: LogoSource | null;
};

const EMPTY: SenderPictures = { photos: new Map(), gravatars: null, logos: null };

export const SenderPicturesContext = createContext<SenderPictures>(EMPTY);

const noopSubscribe = () => () => undefined;
const zero = () => 0;

/**
 * Whether a display name says the message was relayed: "Ana via Book Club", the way
 * Google Groups, Mailman and calendar invitations rewrite the sender. The address on
 * such a message is the relay's, so its domain's logo would put the list host's brand
 * (Google's, say) beside a person. Something has to come before "via", so a brand that
 * is called that ("VIA Rail") is not mistaken for one.
 */
export function isRelayedName(name: string | undefined): boolean {
  return name !== undefined && /\S\s+via\s+\S/i.test(name);
}

/**
 * The picture URLs to try for a sender, best first. Empty means the monogram.
 *
 * `photo` is an explicit photo a caller already has; otherwise the context's contact
 * photos are consulted. Gravatar and the brand logo are only looked up when there is no
 * photo, and not for a relayed sender (`isRelayedName`). The logo waits for Gravatar's
 * answer: a logo shown first and then replaced by the person's photo would flicker, and
 * a sender with a Gravatar needs no DNS lookup for their domain at all (a logo already
 * cached is still kept as the fallback). `size` is the avatar's, in CSS pixels.
 */
export function useSenderPictures(address: string, photo?: string, name?: string, size = 32): string[] {
  const { photos, gravatars, logos } = useContext(SenderPicturesContext);
  const contactPhoto = photo ?? photos.get(address.trim().toLowerCase());
  const wantPicture = !contactPhoto && address !== "" && !isRelayedName(name);
  const wantGravatar = gravatars !== null && wantPicture;
  const gravatarVersion = useSyncExternalStore(
    wantGravatar ? gravatars.subscribe : noopSubscribe,
    wantGravatar ? gravatars.getVersion : zero,
    zero,
  );
  const gravatar: LogoState = wantGravatar ? gravatars.peek(address) : { kind: "none" };
  useEffect(() => {
    if (wantGravatar && gravatar.kind === "unknown") void gravatars.request(address);
  }, [wantGravatar, gravatar.kind, gravatars, address, gravatarVersion]);

  const wantLogo = logos !== null && wantPicture;
  const askLogo = wantLogo && gravatar.kind === "none";
  const version = useSyncExternalStore(
    wantLogo ? logos.subscribe : noopSubscribe,
    wantLogo ? logos.getVersion : zero,
    zero,
  );
  const state: LogoState = wantLogo ? logos.peek(address) : { kind: "none" };
  // `version` is in the dependencies so a still-unknown sender asks again whenever the
  // cache changes: after the network comes back (`retryFailed`), or after its queued
  // lookup was dropped. A request that is already in flight or cached costs nothing.
  useEffect(() => {
    if (askLogo && state.kind === "unknown") void logos.request(address);
  }, [askLogo, state.kind, logos, address, version]);
  return orderPictures(contactPhoto, gravatar, state, size);
}

/**
 * The order, on its own so it is tested: contact photo, Gravatar (sized for the
 * avatar), brand logo, and the logo only once Gravatar has answered — until then the
 * monogram holds, rather than a logo that the person's photo then replaces.
 */
export function orderPictures(
  contactPhoto: string | undefined,
  gravatar: LogoState,
  logo: LogoState,
  size: number,
): string[] {
  const out: string[] = [];
  if (contactPhoto) out.push(contactPhoto);
  if (gravatar.kind === "logo") out.push(gravatarImageUrl(gravatar.url, size));
  if (gravatar.kind !== "unknown" && logo.kind === "logo") out.push(logo.url);
  return out;
}

/**
 * The app's Gravatar probe: an `Image` with no credentials (`crossOrigin="anonymous"`,
 * which Gravatar answers with `Access-Control-Allow-Origin: *`, so no cookies go with
 * it) and no referrer. A failure while the browser says it is offline rejects, so the
 * cache retries it rather than remembering a miss.
 */
export function imageProbe(isOnline: () => boolean): ImageProbe {
  return (url) =>
    new Promise<boolean>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.decoding = "async";
      img.onload = () => resolve(true);
      img.onerror = () => (isOnline() ? resolve(false) : reject(new Error("offline")));
      img.src = url;
    });
}

/**
 * A `LogoSource` over a fixed domain → URL table. The demo's: bundled images, no
 * network, answers immediately.
 */
export function staticLogoSource(table: Readonly<Record<string, string>>): LogoSource {
  return {
    peek(address) {
      const domain = senderDomain(address);
      const url = domain ? table[domain] : undefined;
      return url ? { kind: "logo", url } : { kind: "none" };
    },
    request(address) {
      const domain = senderDomain(address);
      return Promise.resolve((domain && table[domain]) || null);
    },
    subscribe: noopSubscribe,
    getVersion: zero,
  };
}
