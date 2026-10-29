import { describe, expect, it } from "vitest";
import {
  AccountRegistry,
  PROFILE_REFRESH_MS,
  accountPicture,
  accountPictureColor,
  loadAccounts,
  profileReadDue,
  reviveAccountProfile,
  reviveAccounts,
  type AccountProfile,
  type KeyValueStorage,
} from "./accounts";

const PICTURE = "https://lh3.googleusercontent.com/a/ACg8ocK=s96-c";
const DATA = "data:image/webp;base64,UklGRhIAAABXRUJQVlA4TAYAAAAvAAAAAAfQ//73v/+BiOh/AAA=";

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  } as KeyValueStorage;
}

describe("the account's own picture", () => {
  it("draws the kept copy, then the URL, else the monogram", () => {
    expect(accountPicture({ access: "granted", picture: PICTURE, pictureData: DATA, checkedAt: 1 })).toBe(DATA);
    expect(accountPicture({ access: "granted", picture: PICTURE, checkedAt: 1 })).toBe(PICTURE);
    expect(accountPicture({ access: "granted", picture: null, checkedAt: 1 })).toBeUndefined();
    expect(accountPicture({ access: "not_granted", picture: null, checkedAt: 1 })).toBeUndefined();
    expect(accountPicture(undefined)).toBeUndefined();
  });

  it("is read when never read, a day later, or right after a re-consent", () => {
    const now = 10 * PROFILE_REFRESH_MS;
    const fresh: AccountProfile = { access: "granted", picture: PICTURE, checkedAt: now - 1000 };
    const missing: AccountProfile = { access: "not_granted", picture: null, checkedAt: now - 1000 };
    expect(profileReadDue(undefined, now, "unknown")).toBe(true);
    expect(profileReadDue(fresh, now, "granted")).toBe(false);
    expect(profileReadDue({ ...fresh, checkedAt: now - PROFILE_REFRESH_MS }, now, "granted")).toBe(true);
    // A clock that went backwards does not freeze it.
    expect(profileReadDue({ ...fresh, checkedAt: now + 1000 }, now, "granted")).toBe(true);
    expect(profileReadDue(missing, now, "not_granted")).toBe(false);
    expect(profileReadDue(missing, now, "granted")).toBe(true);
  });

  it("is revived field by field, and never from another host", () => {
    expect(reviveAccountProfile({ access: "granted", picture: PICTURE, pictureData: DATA, checkedAt: 5 })).toEqual({
      access: "granted",
      picture: PICTURE,
      pictureData: DATA,
      checkedAt: 5,
    });
    expect(reviveAccountProfile({ access: "granted", picture: "https://evil.example/x.png", pictureData: DATA, checkedAt: 5 })).toEqual({
      access: "granted",
      picture: null,
      checkedAt: 5,
    });
    expect(reviveAccountProfile({ access: "granted", picture: PICTURE, pictureData: "javascript:1" })).toEqual({
      access: "granted",
      picture: PICTURE,
      checkedAt: 0,
    });
    expect(reviveAccountProfile({ access: "not_granted", picture: PICTURE, checkedAt: 3 })).toEqual({
      access: "not_granted",
      picture: null,
      checkedAt: 3,
    });
    expect(reviveAccountProfile({ access: "maybe" })).toBeUndefined();
    expect(reviveAccountProfile("x")).toBeUndefined();
  });

  it("is kept in the registry with its account and goes with it", () => {
    const storage = memoryStorage();
    const registry = new AccountRegistry(storage, undefined, () => 1);
    registry.add("acct1", "ada@example.com");
    expect(registry.get("acct1")?.profile).toBeUndefined();
    registry.setProfile("acct1", { access: "granted", picture: PICTURE, pictureData: DATA, checkedAt: 7 });
    expect(loadAccounts(storage).accounts[0]?.profile).toEqual({ access: "granted", picture: PICTURE, pictureData: DATA, checkedAt: 7 });
    registry.setProfile("acct1", undefined);
    expect(loadAccounts(storage).accounts[0]?.profile).toBeUndefined();
    registry.setProfile("gone", { access: "not_granted", picture: null, checkedAt: 1 });
    registry.remove("acct1");
    expect(loadAccounts(storage).accounts).toEqual([]);
  });

  it("leaves a registry from before it exactly as it was", () => {
    const old = { version: 1, active: "acct1", accounts: [{ id: "acct1", email: "a@example.com", color: "space", notify: true, addedAt: 3 }] };
    expect(reviveAccounts(old)).toEqual(old);
  });

  it("keeps the picture's halo colour with it, and only with a picture", () => {
    expect(reviveAccountProfile({ access: "granted", picture: PICTURE, color: "#1E5AC8", checkedAt: 5 })).toEqual({
      access: "granted",
      picture: PICTURE,
      color: "#1E5AC8",
      checkedAt: 5,
    });
    // Looked at and too grey: kept as null so it is not looked at again.
    expect(reviveAccountProfile({ access: "granted", picture: PICTURE, color: null, checkedAt: 5 })?.color).toBeNull();
    expect(reviveAccountProfile({ access: "granted", picture: PICTURE, color: "red", checkedAt: 5 })?.color).toBeUndefined();
    expect(reviveAccountProfile({ access: "granted", picture: null, color: "#1E5AC8", checkedAt: 5 })?.color).toBeUndefined();
    expect(accountPictureColor({ access: "granted", picture: PICTURE, color: "#1E5AC8", checkedAt: 1 })).toBe("#1E5AC8");
    expect(accountPictureColor({ access: "granted", picture: PICTURE, color: null, checkedAt: 1 })).toBeUndefined();
    expect(accountPictureColor({ access: "granted", picture: null, checkedAt: 1 })).toBeUndefined();
    expect(accountPictureColor(undefined)).toBeUndefined();
  });

});
