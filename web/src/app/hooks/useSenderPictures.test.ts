// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { Snapshot } from "../../core/store/store";
import { currentSenderPictures } from "../../ui/senderPictures";
import { useSenderPictureCaches, useSenderPictures } from "./useSenderPictures";

const cacheMethods = vi.hoisted(() => ({
  logoClear: vi.fn(),
  logoRetry: vi.fn(),
  gravatarClear: vi.fn(),
  gravatarRetry: vi.fn(),
  bytesClear: vi.fn(),
  bytesClearKind: vi.fn(),
}));

vi.mock("../../core/avatars/logoCache", () => ({
  BrandLogoCache: class {
    clear = cacheMethods.logoClear;
    retryFailed = cacheMethods.logoRetry;
    constructor() {}
  },
  LOGO_STORAGE_KEY: "logo",
  localLogoStorage: vi.fn(() => ({})),
}));

vi.mock("../../core/avatars/gravatar", () => ({
  GravatarCache: class {
    clear = cacheMethods.gravatarClear;
    retryFailed = cacheMethods.gravatarRetry;
    constructor() {}
  },
  GRAVATAR_STORAGE_KEY: "gravatar",
}));

vi.mock("../../core/avatars/pictureBytes", () => ({
  PictureBytesCache: class {
    clear = cacheMethods.bytesClear;
    clearKind = cacheMethods.bytesClearKind;
    constructor() {}
  },
  defaultPictureBytesStorage: vi.fn(() => ({})),
  memoryPictureBytesStorage: vi.fn(() => ({})),
}));

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    accountId: "acct1",
    status: "ready",
    contactsAccess: "granted",
    googleContacts: [],
    preferences: {
      senderPictures: true,
      imagePolicy: "always",
    } as Snapshot["preferences"],
    ...overrides,
  } as Snapshot;
}

function setup(initialSnapshot: Snapshot) {
  return renderHook(
    ({ current }: { current: Snapshot }) => {
      const caches = useSenderPictureCaches(current.accountId);
      return { caches, ...useSenderPictures({ snapshot: current, caches }) };
    },
    { initialProps: { current: initialSnapshot } },
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useSenderPictures", () => {
  it("clears remote copies when disabled and contact copies when access is revoked", () => {
    const initial = snapshot();
    const { rerender } = setup(initial);

    expect(cacheMethods.logoClear).not.toHaveBeenCalled();
    expect(cacheMethods.gravatarClear).not.toHaveBeenCalled();
    expect(cacheMethods.bytesClearKind).not.toHaveBeenCalled();

    rerender({
      current: snapshot({
        preferences: { ...initial.preferences, senderPictures: false },
      }),
    });

    expect(cacheMethods.logoClear).toHaveBeenCalledOnce();
    expect(cacheMethods.gravatarClear).toHaveBeenCalledOnce();
    expect(cacheMethods.bytesClearKind).toHaveBeenCalledWith("logo");
    expect(cacheMethods.bytesClearKind).toHaveBeenCalledWith("gravatar");
    expect(cacheMethods.bytesClearKind).not.toHaveBeenCalledWith("contact");

    rerender({
      current: snapshot({
        contactsAccess: "not_granted",
        preferences: { ...initial.preferences, senderPictures: false },
      }),
    });
    expect(cacheMethods.bytesClearKind).toHaveBeenCalledWith("contact");
  });

  it("clears the account cache on sign-out, retries when online, and removes its listener", () => {
    const { result, rerender, unmount } = setup(snapshot());
    expect(currentSenderPictures()).toBe(result.current.senderPictures);

    rerender({ current: snapshot({ status: "signed_out" }) });
    expect(cacheMethods.logoClear).toHaveBeenCalledOnce();
    expect(cacheMethods.gravatarClear).toHaveBeenCalledOnce();
    expect(cacheMethods.bytesClear).toHaveBeenCalledOnce();

    window.dispatchEvent(new Event("online"));
    expect(cacheMethods.logoRetry).toHaveBeenCalledOnce();
    expect(cacheMethods.gravatarRetry).toHaveBeenCalledOnce();

    unmount();
    window.dispatchEvent(new Event("online"));
    expect(cacheMethods.logoRetry).toHaveBeenCalledOnce();
    expect(cacheMethods.gravatarRetry).toHaveBeenCalledOnce();
  });
});
