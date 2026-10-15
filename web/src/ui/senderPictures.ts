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
 * photos are consulted. A logo is only looked up when there is no photo, and not for a
 * relayed sender (`isRelayedName`).
 */
export function useSenderPictures(address: string, photo?: string, name?: string): string[] {
  const { photos, logos } = useContext(SenderPicturesContext);
  const contactPhoto = photo ?? photos.get(address.trim().toLowerCase());
  const wantLogo = logos !== null && !contactPhoto && address !== "" && !isRelayedName(name);
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
    if (wantLogo && state.kind === "unknown") void logos.request(address);
  }, [wantLogo, state.kind, logos, address, version]);
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
