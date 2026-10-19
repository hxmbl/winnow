import { describe, expect, it } from "vitest";
import { BACK_TO_INBOX, CONNECT_GMAIL, RESUME_UNREACHABLE, SESSION_EXPIRED, demoCtaLabel, resumeFailure } from "./demoResume";
import { GmailError, GmailHttpError, GoogleUnreachable } from "../core/gmail/dto";

describe("the demo's call to action", () => {
  it("is Back to your inbox with a stored session, Connect Gmail without", () => {
    expect(demoCtaLabel({ resumable: true, signingIn: false, resuming: false })).toBe(BACK_TO_INBOX);
    expect(demoCtaLabel({ resumable: false, signingIn: false, resuming: false })).toBe(CONNECT_GMAIL);
  });
  it("says what is under way", () => {
    expect(demoCtaLabel({ resumable: true, signingIn: false, resuming: true })).toBe("Opening your inbox…");
    expect(demoCtaLabel({ resumable: false, signingIn: true, resuming: false })).toBe("Waiting for Google…");
  });
  it("after an expired session, signs in again", () => {
    expect(demoCtaLabel({ resumable: false, signingIn: false, resuming: false, expired: true })).toBe("Sign in again");
    expect(demoCtaLabel({ resumable: true, signingIn: false, resuming: false, expired: true })).toBe(BACK_TO_INBOX);
  });
});

describe("a failed Back to your inbox", () => {
  it("an expired or revoked session falls back to signing in, saying why", () => {
    expect(resumeFailure(new GmailError("Sign in again to continue.", 401, "reauth_required"))).toEqual({ reauth: true, message: SESSION_EXPIRED });
    expect(resumeFailure(new GmailHttpError(401, "invalid credentials")).reauth).toBe(true);
  });
  it("an unreachable Google keeps the session for another try", () => {
    expect(resumeFailure(new GoogleUnreachable("offline"))).toEqual({ reauth: false, message: RESUME_UNREACHABLE });
    expect(resumeFailure(new GmailHttpError(503, "busy"))).toEqual({ reauth: false, message: RESUME_UNREACHABLE });
    expect(resumeFailure(new TypeError("Failed to fetch"))).toEqual({ reauth: false, message: RESUME_UNREACHABLE });
  });
  it("anything else keeps the session and says what went wrong", () => {
    expect(resumeFailure(new Error("Quota exceeded."))).toEqual({ reauth: false, message: "Quota exceeded." });
  });
});
