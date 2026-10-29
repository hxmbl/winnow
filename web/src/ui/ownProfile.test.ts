import { describe, expect, it } from "vitest";
import { PROFILE_CONSENT_HINT, PROFILE_NONE_HINT, PROFILE_SHOWN_HINT, ownProfileRow } from "./ownProfile";

describe("Settings → Google account → Profile picture", () => {
  it("is not there without an open account", () => {
    expect(ownProfileRow(null)).toBeNull();
  });

  it("offers the one re-consent to an account signed in before the profile scope", () => {
    expect(ownProfileRow({ profileConsent: true })).toEqual({ hint: PROFILE_CONSENT_HINT, action: "allow" });
  });

  it("says where the picture is from, or that the initial stays", () => {
    expect(ownProfileRow({ picture: "https://lh3.googleusercontent.com/a/x=s96-c" })).toEqual({ hint: PROFILE_SHOWN_HINT, action: null });
    expect(ownProfileRow({})).toEqual({ hint: PROFILE_NONE_HINT, action: null });
  });
});
