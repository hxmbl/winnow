// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { GoogleContact } from "../../core/contacts/google";
import type { WinnowStore } from "../../core/store/store";
import type { SessionBridge } from "../../core/session/bridge";
import { HALF_GRANT_MESSAGE } from "../utils";
import { useGoogleContacts } from "./useGoogleContacts";

function makeStore() {
  return {
    getSnapshot: vi.fn(() => ({ account: { id: "acct1" } })),
    setGoogleContacts: vi.fn(),
    setNotice: vi.fn(),
  } as unknown as WinnowStore;
}

function setup(bridge: Partial<SessionBridge> | null, store = makeStore()) {
  const sessionRef = { current: bridge as SessionBridge | null };
  const hook = renderHook(() => useGoogleContacts({ store, sessionRef }));
  return { ...hook, store };
}

afterEach(cleanup);

describe("useGoogleContacts", () => {
  it("adopts the cached contacts before a forced refresh", async () => {
    const cached: GoogleContact[] = [{ address: "old@example.com", source: "saved" }];
    const fresh: GoogleContact[] = [{ address: "new@example.com", source: "other" }];
    const bridge: Partial<SessionBridge> = {
      contactsAccess: vi.fn(async () => "granted" as const),
      cachedContacts: vi.fn(async () => cached),
      contactsSyncedAt: vi.fn(async () => Date.now()),
      refreshContacts: vi.fn(async () => fresh),
    };
    const { result, store } = setup(bridge);

    await act(async () => {
      await result.current.syncGoogleContacts(true);
    });

    expect(store.setGoogleContacts).toHaveBeenNthCalledWith(1, cached, "granted");
    expect(store.setGoogleContacts).toHaveBeenNthCalledWith(2, fresh, "granted");
    expect(bridge.refreshContacts).toHaveBeenCalledOnce();
  });

  it("keeps the declined grant in the store and reports the opt-in outcome", async () => {
    const bridge: Partial<SessionBridge> = {
      grantContacts: vi.fn(async () => "not_granted" as const),
    };
    const { result, store } = setup(bridge);

    act(() => result.current.onImproveSuggestions());
    await waitFor(() => expect(result.current.contactsBusy).toBe(false));

    expect(store.setGoogleContacts).toHaveBeenCalledWith([], "not_granted");
    expect(result.current.contactsError).toBe(HALF_GRANT_MESSAGE);
  });
});
