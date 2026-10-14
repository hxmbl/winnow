/**
 * Where an avatar finds a sender's picture.
 *
 * Two sources, in order: the user's own Google contacts (a person's photo, only after
 * they opted in to contacts) and, when the "Show brand logos" setting is on, the
 * sender domain's BIMI logo. Anything else — or a picture that fails to load — is the
 * monogram, which is also what renders first: nothing here blocks a row.
 *
 * A context rather than props because the list, the reader header and the sender menu
 * all draw avatars, and threading two lookups through each of them would make every
 * row component care about where pictures come from.
 */

import { createContext, useContext, useEffect, useSyncExternalStore } from "react";
import type { LogoState } from "../core/avatars/logoCache";
import { senderDomain } from "../core/avatars/bimi";

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
  /** `null` when brand logos are off. */
  logos: LogoSource | null;
};

const EMPTY: SenderPictures = { photos: new Map(), logos: null };

export const SenderPicturesContext = createContext<SenderPictures>(EMPTY);

const noopSubscribe = () => () => undefined;
const zero = () => 0;

/**
 * The picture URLs to try for a sender, best first. Empty means the monogram.
 *
 * `photo` is an explicit photo a caller already has; otherwise the context's contact
 * photos are consulted. A logo is only looked up when there is no photo.
 */
export function useSenderPictures(address: string, photo?: string): string[] {
  const { photos, logos } = useContext(SenderPicturesContext);
  const contactPhoto = photo ?? photos.get(address.trim().toLowerCase());
  const wantLogo = logos !== null && !contactPhoto;
  useSyncExternalStore(
    wantLogo ? logos.subscribe : noopSubscribe,
    wantLogo ? logos.getVersion : zero,
    zero,
  );
  const state: LogoState = wantLogo ? logos.peek(address) : { kind: "none" };
  useEffect(() => {
    if (wantLogo && state.kind === "unknown") void logos.request(address);
  }, [wantLogo, state.kind, logos, address]);
  const out: string[] = [];
  if (contactPhoto) out.push(contactPhoto);
  if (state.kind === "logo") out.push(state.url);
  return out;
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
