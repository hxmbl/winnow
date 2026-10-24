/**
 * Where an avatar finds a sender's picture.
 *
 * Three sources, in order: the user's own Google contacts (a person's photo, only after
 * they opted in to contacts); when "Gravatar photos" is on, the sender's Gravatar; and,
 * when "Show brand logos" is on, the sender domain's BIMI logo. A personal photo beats a
 * brand logo. Anything else — or a picture that fails to load — is the monogram, which
 * is also what renders first: nothing here blocks a row.
 *
 * Each picture drawn is also kept as bytes on the device (`core/avatars/pictureBytes.ts`):
 * an avatar draws the kept copy first, so a recent sender's picture is there at once and
 * offline, and the copy is refreshed in the background when it is stale. Only for the
 * sources whose switches are on (`gatedPictureBytes`).
 *
 * A context rather than props because the list, the reader header and the sender menu
 * all draw avatars, and threading two lookups through each of them would make every
 * row component care about where pictures come from.
 */

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { LogoState } from "../core/avatars/logoCache";
import { senderDomain } from "../core/avatars/bimi";
import { gravatarImageUrl, type ImageProbe } from "../core/avatars/gravatar";
import type { ImagePolicy } from "../core/mail/imageConsent";
import type { PictureKind, StoredPicture } from "../core/avatars/pictureBytes";

/** What the cache exposes; the demo implements it from a fixed table. */
export interface LogoSource {
  peek(address: string): LogoState;
  request(address: string): Promise<string | null>;
  subscribe(listener: () => void): () => void;
  getVersion(): number;
}

/** What the picture-bytes cache exposes to avatars (`PictureBytesCache`). */
export interface PictureBytesSource {
  /** The kept copy of a picture URL, fresh or stale, or `null`. Synchronous. */
  get(url: string): StoredPicture | null;
  isStale(url: string): boolean;
  touch(url: string): void;
  remember(url: string, kind: PictureKind): Promise<boolean>;
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
  /**
   * Pictures kept as bytes, already gated to the sources above (`gatedPictureBytes`).
   * Absent or `null`: none (the demo, tests), and avatars draw from URLs alone.
   */
  bytes?: PictureBytesSource | null;
};

/**
 * The sources avatars and notification pictures may use under the current settings: the
 * one place the switches are read, so the list, the reader and a notification cannot
 * disagree.
 *
 * Gravatar and brand logos are remote lookups (a hashed address to Gravatar, a DNS query
 * and a fetch from the sender's site), so **Remote images = Never turns both off** too,
 * whatever their own switches say (1.3.3). Contact photos are the user's own Google
 * contacts, already synced, and stay; with no picture the monogram (initials) is drawn.
 */
export function senderPictureSources(input: {
  photos: ReadonlyMap<string, string>;
  gravatars: LogoSource | null;
  logos: LogoSource | null;
  imagePolicy: ImagePolicy;
  bytes?: PictureBytesSource | null;
}): SenderPictures {
  const remote = input.imagePolicy !== "never";
  const gravatars = remote ? input.gravatars : null;
  const logos = remote ? input.logos : null;
  return {
    photos: input.photos,
    gravatars,
    logos,
    bytes: input.bytes
      ? gatedPictureBytes(input.bytes, { contact: true, gravatar: gravatars !== null, logo: logos !== null })
      : null,
  };
}

/**
 * The bytes cache as avatars may use it: a kept copy is only handed out, and a new one
 * only captured, for a source that is on right now. So with Remote images = Never, or
 * "Gravatar photos" / "Show brand logos" off, a Gravatar or logo still on disk (its
 * clear may not have landed yet) is never drawn — not even for a URL some other path
 * still holds. Contact photos are the user's own synced contacts and follow the contacts
 * grant, which clears them (`App`).
 */
export function gatedPictureBytes(bytes: PictureBytesSource, allowed: Readonly<Record<PictureKind, boolean>>): PictureBytesSource {
  const get = (url: string): StoredPicture | null => {
    const record = bytes.get(url);
    return record && allowed[record.kind] ? record : null;
  };
  return {
    get,
    isStale: (url) => bytes.isStale(url),
    touch: (url) => {
      if (get(url)) bytes.touch(url);
    },
    remember: (url, kind) => (allowed[kind] ? bytes.remember(url, kind) : Promise.resolve(false)),
    subscribe: (listener) => bytes.subscribe(listener),
    getVersion: () => bytes.getVersion(),
  };
}

/** Whether a remote picture switch (Gravatar, brand logos) is paused by Remote images. */
export function remotePicturesPaused(imagePolicy: ImagePolicy): boolean {
  return imagePolicy === "never";
}

const EMPTY: SenderPictures = { photos: new Map(), gravatars: null, logos: null, bytes: null };

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
 * The pictures to try for a sender, best first, each with its source. Empty means the
 * monogram.
 *
 * `photo` is an explicit photo a caller already has; otherwise the context's contact
 * photos are consulted. Gravatar and the brand logo are only looked up when there is no
 * photo, and not for a relayed sender (`isRelayedName`). The logo waits for Gravatar's
 * answer: a logo shown first and then replaced by the person's photo would flicker, and
 * a sender with a Gravatar needs no DNS lookup for their domain at all (a logo already
 * cached is still kept as the fallback). `size` is the avatar's, in CSS pixels.
 */
export function useSenderPictures(address: string, photo?: string, name?: string, size = 32): PictureCandidate[] {
  const sources = useContext(SenderPicturesContext);
  const { contactPhoto, wantGravatar, wantLogo } = pictureWants(sources, address, photo, name);
  const gravatars = wantGravatar ? sources.gravatars : null;
  const logos = wantLogo ? sources.logos : null;
  const gravatarVersion = useSyncExternalStore(gravatars ? gravatars.subscribe : noopSubscribe, gravatars ? gravatars.getVersion : zero, zero);
  const gravatar: LogoState = gravatars ? gravatars.peek(address) : { kind: "none" };
  useEffect(() => {
    if (gravatars && gravatar.kind === "unknown") void gravatars.request(address);
  }, [gravatar.kind, gravatars, address, gravatarVersion]);

  const askLogo = logos !== null && gravatar.kind === "none";
  const version = useSyncExternalStore(logos ? logos.subscribe : noopSubscribe, logos ? logos.getVersion : zero, zero);
  const state: LogoState = logos ? logos.peek(address) : { kind: "none" };
  // `version` is in the dependencies so a still-unknown sender asks again whenever the
  // cache changes: after the network comes back (`retryFailed`), or after its queued
  // lookup was dropped. A request that is already in flight or cached costs nothing.
  useEffect(() => {
    if (askLogo && logos && state.kind === "unknown") void logos.request(address);
  }, [askLogo, state.kind, logos, address, version]);
  return orderPictureCandidates(contactPhoto, gravatar, state, size);
}

/**
 * The bytes cache avatars draw from, with the avatar re-rendered when it changes (the
 * warm at startup landing, a copy captured, a source cleared). `null` when there is none.
 */
export function usePictureBytes(): PictureBytesSource | null {
  const bytes = useContext(SenderPicturesContext).bytes ?? null;
  useSyncExternalStore(bytes ? bytes.subscribe : noopSubscribe, bytes ? bytes.getVersion : zero, zero);
  return bytes;
}

/** One `src` an avatar may try: a picture's kept copy (`cached`) or its URL. */
export type PictureTry = PictureCandidate & { src: string; cached: boolean };

/**
 * The `src`s an avatar tries, best first: for each picture, its kept copy when there is
 * one, then its URL — so a copy that fails to decode falls back to the network exactly
 * as before, and a picture with no copy is drawn from its URL as before.
 */
export function pictureTries(candidates: readonly PictureCandidate[], bytes: PictureBytesSource | null): PictureTry[] {
  const out: PictureTry[] = [];
  for (const candidate of candidates) {
    const copy = bytes?.get(candidate.url)?.data;
    if (copy) out.push({ ...candidate, src: copy, cached: true });
    out.push({ ...candidate, src: candidate.url, cached: false });
  }
  return out;
}

/**
 * Which sources a sender's picture may come from under the current settings: the one
 * decision both the avatar (`useSenderPictures`) and a notification's picture
 * (`resolveSenderPicture`) make, so they can never disagree. Gravatar only when
 * "Gravatar photos" is on, the brand logo only when "Show brand logos" is on (each is
 * `null` in `sources` when off), neither when there is a contact photo or the sender was
 * relayed ("Ana via Book Club").
 */
export function pictureWants(
  sources: SenderPictures,
  address: string,
  photo?: string,
  name?: string,
): { contactPhoto: string | undefined; wantGravatar: boolean; wantLogo: boolean } {
  const contactPhoto = photo ?? sources.photos.get(address.trim().toLowerCase());
  const wantPicture = !contactPhoto && address !== "" && !isRelayedName(name);
  return {
    contactPhoto,
    wantGravatar: sources.gravatars !== null && wantPicture,
    wantLogo: sources.logos !== null && wantPicture,
  };
}

/**
 * A sender's picture outside React, for a new-mail notification: the avatar's own
 * rules (`pictureWants`, then `orderPictures`), waiting for a lookup the avatar would
 * have started (Gravatar first, the logo only once Gravatar says none) up to `waitMs`,
 * then the best URL, or `null` for the monogram (a notification shows the app icon).
 * With both switches off and no contact photo this never touches the network.
 */
export async function resolveSenderPicture(
  sources: SenderPictures,
  address: string,
  name: string | undefined,
  size: number,
  waitMs = 1500,
): Promise<string | null> {
  const { contactPhoto, wantGravatar, wantLogo } = pictureWants(sources, address, undefined, name);
  const settle = async (source: LogoSource): Promise<LogoState> => {
    const now = source.peek(address);
    if (now.kind !== "unknown") return now;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      source.request(address).catch(() => null),
      new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
    return source.peek(address);
  };
  const gravatar: LogoState = wantGravatar && sources.gravatars ? await settle(sources.gravatars) : { kind: "none" };
  const logo: LogoState =
    wantLogo && sources.logos
      ? gravatar.kind === "none"
        ? await settle(sources.logos)
        : sources.logos.peek(address)
      : { kind: "none" };
  return orderPictures(contactPhoto, gravatar, logo, size)[0] ?? null;
}

/**
 * The sources the app is drawing avatars from right now, published by `App` so a
 * notification (built outside React, `notificationActions.ts`) uses the same ones.
 * Until `App` mounts, nothing: no pictures.
 */
let currentSources: SenderPictures = EMPTY;

export function publishSenderPictures(sources: SenderPictures): void {
  currentSources = sources;
}

export function currentSenderPictures(): SenderPictures {
  return currentSources;
}

/** A picture to try for a sender, and which source (and so which switch) it is from. */
export type PictureCandidate = { url: string; kind: PictureKind };

/**
 * The order, on its own so it is tested: contact photo, Gravatar (sized for the
 * avatar), brand logo, and the logo only once Gravatar has answered — until then the
 * monogram holds, rather than a logo that the person's photo then replaces.
 */
export function orderPictureCandidates(
  contactPhoto: string | undefined,
  gravatar: LogoState,
  logo: LogoState,
  size: number,
): PictureCandidate[] {
  const out: PictureCandidate[] = [];
  if (contactPhoto) out.push({ url: contactPhoto, kind: "contact" });
  if (gravatar.kind === "logo") out.push({ url: gravatarImageUrl(gravatar.url, size), kind: "gravatar" });
  if (gravatar.kind !== "unknown" && logo.kind === "logo") out.push({ url: logo.url, kind: "logo" });
  return out;
}

/** `orderPictureCandidates`, URLs only: what a notification is given. */
export function orderPictures(
  contactPhoto: string | undefined,
  gravatar: LogoState,
  logo: LogoState,
  size: number,
): string[] {
  return orderPictureCandidates(contactPhoto, gravatar, logo, size).map((candidate) => candidate.url);
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
