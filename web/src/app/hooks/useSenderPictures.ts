import { useEffect, useMemo } from "react";
import { GravatarCache, GRAVATAR_STORAGE_KEY } from "../../core/avatars/gravatar";
import { contactPhotoMap } from "../../core/avatars/photos";
import {
  defaultPictureBytesStorage,
  memoryPictureBytesStorage,
  PictureBytesCache,
} from "../../core/avatars/pictureBytes";
import { BrandLogoCache, LOGO_STORAGE_KEY, localLogoStorage } from "../../core/avatars/logoCache";
import { keyFor } from "../../core/store/accountState";
import type { Snapshot } from "../../core/store/store";
import { dohResolver } from "../../core/avatars/bimi";
import { canvasCapture } from "../../ui/pictureCapture";
import { DEMO_LOGO_SOURCE } from "../../ui/demoPictures";
import {
  imageProbe,
  publishSenderPictures,
  senderPictureSources,
  type SenderPictures,
} from "../../ui/senderPictures";

export function useSenderPictureCaches(accountId: string | null) {
  // The lookup caches and kept bytes are account-scoped; no account means memory only.
  const logoCache = useMemo(
    () =>
      new BrandLogoCache({
        resolve: dohResolver((input, init) => fetch(input, init)),
        isOnline: () => globalThis.navigator?.onLine !== false,
        storage: localLogoStorage(keyFor(LOGO_STORAGE_KEY, accountId)),
      }),
    [accountId],
  );
  const gravatarCache = useMemo(() => {
    const isOnline = () => globalThis.navigator?.onLine !== false;
    return new GravatarCache({
      probe: imageProbe(isOnline),
      isOnline,
      storage: localLogoStorage(keyFor(GRAVATAR_STORAGE_KEY, accountId)),
    });
  }, [accountId]);
  const pictureBytes = useMemo(
    () =>
      new PictureBytesCache({
        storage: accountId ? defaultPictureBytesStorage(accountId) : memoryPictureBytesStorage(),
        capture: canvasCapture(),
        isOnline: () => globalThis.navigator?.onLine !== false,
      }),
    [accountId],
  );

  return { logoCache, gravatarCache, pictureBytes };
}

type Caches = ReturnType<typeof useSenderPictureCaches>;

export function useSenderPictures({ snapshot, caches }: { snapshot: Snapshot; caches: Caches }) {
  const { preferences, status, contactsAccess, googleContacts } = snapshot;
  const { logoCache, gravatarCache, pictureBytes } = caches;
  const photos = useMemo(() => contactPhotoMap(googleContacts), [googleContacts]);

  // Sender identity is account data: sign-out and disabling the feature clear lookups.
  useEffect(() => {
    if (status === "signed_out" || !preferences.senderPictures) {
      logoCache.clear();
      gravatarCache.clear();
    }
  }, [status, preferences.senderPictures, logoCache, gravatarCache]);

  // Keep copies follow the same switches, while contact copies follow the contacts grant.
  useEffect(() => {
    if (status === "signed_out") void pictureBytes.clear();
  }, [status, pictureBytes]);

  useEffect(() => {
    if (preferences.senderPictures) return;
    void pictureBytes.clearKind("logo");
    void pictureBytes.clearKind("gravatar");
  }, [preferences.senderPictures, pictureBytes]);

  useEffect(() => {
    if (contactsAccess === "not_granted") void pictureBytes.clearKind("contact");
  }, [contactsAccess, pictureBytes]);

  useEffect(() => {
    // Retry lookups that were deferred while offline, and remove the listener on cleanup.
    const retry = () => {
      logoCache.retryFailed();
      gravatarCache.retryFailed();
    };
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [logoCache, gravatarCache]);

  const isDemo = contactsAccess === "demo";
  const senderPictures = useMemo<SenderPictures>(
    () =>
      senderPictureSources({
        photos,
        gravatars: preferences.senderPictures ? gravatarCache : null,
        logos: preferences.senderPictures ? (isDemo ? DEMO_LOGO_SOURCE : logoCache) : null,
        imagePolicy: preferences.imagePolicy,
        bytes: isDemo ? null : pictureBytes,
      }),
    [photos, preferences.senderPictures, gravatarCache, isDemo, logoCache, preferences.imagePolicy, pictureBytes],
  );

  useEffect(() => {
    publishSenderPictures(senderPictures);
  }, [senderPictures]);

  return { photos, senderPictures };
}
