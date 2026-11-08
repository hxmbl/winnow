import { useCallback, useState } from "react";
import type { WinnowStore } from "../../core/store/store";
import type { SessionBridge } from "../../core/session/bridge";
import { contactsFailureNotice } from "../../core/gmail/people";
import { CONTACTS_REFRESH_MS, HALF_GRANT_MESSAGE } from "../utils";

type Options = {
  store: WinnowStore;
  sessionRef: { current: SessionBridge | null };
};

export function useGoogleContacts({ store, sessionRef }: Options) {
  const [contactsProblem, setContactsProblem] = useState<{ message: string; url: string | null } | null>(null);

  /**
   * Adopt the saved address book first; refresh it only when stale or forced. If refresh
   * fails, existing suggestions stay available and the problem is shown in Settings.
   */
  const syncGoogleContacts = useCallback(async (force = false): Promise<{ message: string; url: string | null } | null> => {
    const bridge = sessionRef.current;
    if (!bridge || !store.getSnapshot().account) return null;
    try {
      const access = await bridge.contactsAccess();
      if (access !== "granted") {
        store.setGoogleContacts([], access);
        return null;
      }
      store.setGoogleContacts(await bridge.cachedContacts(), "granted");
      const last = await bridge.contactsSyncedAt();
      if (!force && last !== null && Date.now() - last < CONTACTS_REFRESH_MS) return null;
      const fresh = await bridge.refreshContacts();
      if (fresh) store.setGoogleContacts(fresh, "granted");
      else store.setGoogleContacts([], await bridge.contactsAccess());
      setContactsProblem(null);
      return null;
    } catch (error) {
      const notice = contactsFailureNotice(error);
      if (notice) setContactsProblem(notice);
      else console.warn("winnow: could not refresh Google contacts:", error);
      return notice;
    }
  }, [store, sessionRef]);

  const [contactsBusy, setContactsBusy] = useState(false);
  const [contactsError, setContactsError] = useState<string | null>(null);
  const improveSuggestions = useCallback(async (notify = false): Promise<void> => {
    const bridge = sessionRef.current;
    if (!bridge) return;
    setContactsError(null);
    setContactsBusy(true);
    const fail = (message: string) => {
      setContactsError(message);
      if (notify) store.setNotice(message);
    };
    try {
      const access = await bridge.grantContacts();
      if (access === "granted") {
        const problem = await syncGoogleContacts(true);
        if (problem && notify) store.setNotice(problem.message);
      } else {
        store.setGoogleContacts([], access);
        fail(HALF_GRANT_MESSAGE);
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : "Google contacts were not connected.");
    } finally {
      setContactsBusy(false);
    }
  }, [store, sessionRef, syncGoogleContacts]);

  const onImproveSuggestions = useCallback(() => void improveSuggestions(), [improveSuggestions]);
  const onConnectContactPhotos = useCallback(() => void improveSuggestions(true), [improveSuggestions]);

  return {
    contactsProblem,
    contactsBusy,
    contactsError,
    syncGoogleContacts,
    onImproveSuggestions,
    onConnectContactPhotos,
  };
}
