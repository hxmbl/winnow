/**
 * The wording of a failed sign-in.
 *
 * This layer is pure copy, and pure copy is exactly the kind of code that rots
 * silently: a new `AuthErrorKind` gets added upstream, the switch falls through
 * to `default`, and the user is shown a raw HTTP body. The last test in this
 * file exists to make that impossible.
 */

import { describe, expect, it } from "vitest";
import { describeFailure, shortFailure, GoogleAuthStateMissing } from "./errors";
import { GmailError } from "../gmail/dto";

describe("describeFailure", () => {
  it("has something specific to say about every known kind", () => {
    const kinds = [
      "declined",
      "state_mismatch",
      "reauth_required",
      "network",
      "timeout",
      "config",
      "invalid_client",
    ] as const;

    for (const kind of kinds) {
      const failure = describeFailure(new GmailError("raw", 400, kind));
      expect(failure.message.length).toBeGreaterThan(0);
      // No kind may render as its raw upstream message: that is the failure mode
      // this file exists to prevent.
      expect(failure.message).not.toBe("raw");
    }
  });

  it("knows which failures retrying could fix", () => {
    // A hint is only useful if acting on it can work. `config` and
    // `invalid_client` need a rebuild or a re-registration; telling someone to
    // "try again" sends them in a circle.
    expect(describeFailure(new GmailError("x", 0, "config")).retryable).toBe(false);
    expect(describeFailure(new GmailError("x", 401, "invalid_client")).retryable).toBe(false);

    expect(describeFailure(new GmailError("x", 0, "network")).retryable).toBe(true);
    expect(describeFailure(new GmailError("x", 0, "declined")).retryable).toBe(true);
    expect(describeFailure(new GmailError("x", 401, "reauth_required")).retryable).toBe(true);
  });

  it("gives a decline a hint that answers the question people actually ask", () => {
    // "Sign-in was declined" with no explanation reads as an accusation. The
    // follow-up question is always "did it change anything?", so that is what
    // the hint says.
    const failure = describeFailure(new GmailError("x", 0, "declined"));
    expect(failure.hint).toMatch(/nothing was changed/i);
  });

  it("distinguishes an unverified redirect from a wrong one", () => {
    const failure = describeFailure(new GoogleAuthStateMissing());
    expect(failure.message).toMatch(/could not be verified/i);
    expect(failure.hint).toBeTruthy();
  });

  it("never claims a session problem for a build problem", () => {
    // `invalid_client` is the most misdiagnosable failure in the whole flow: it
    // is a build or registration problem, and the only fix is to rebuild or
    // re-register. Wording it as a session problem sends the user to re-auth,
    // which cannot possibly work.
    const failure = describeFailure(new GmailError("x", 401, "invalid_client"));
    expect(failure.message).not.toMatch(/session/i);
    expect(failure.message).not.toMatch(/sign in again/i);
    expect(failure.hint).toMatch(/desktop app|web application/i);
  });

  it("falls back to the raw message for something it does not recognise", () => {
    // Better an ugly message than a wrong one. Inventing a friendly explanation
    // for an error we do not understand is how real bugs get filed as "Winnow
    // says something went wrong".
    const failure = describeFailure(new Error("something specific went wrong"));
    expect(failure.message).toBe("something specific went wrong");
    expect(failure.retryable).toBe(true);
  });

  it("copes with something that is not an error at all", async () => {
    // Tauri rejects with a string, and a thrown value from a plugin can be
    // anything. `unknown` in, renderable out.
    expect(describeFailure("a bare string").message).toBe("a bare string");
    expect(describeFailure(undefined).message).toBe("undefined");
    expect(describeFailure(null).message).toBe("null");
    expect(describeFailure({ kind: "network" }).message).toBeTruthy();
  });
});

describe("shortFailure", () => {
  it("is the same message without the hint", () => {
    // For a toast, where a two-line explanation does not fit.
    const full = describeFailure(new GmailError("x", 0, "config"));
    expect(shortFailure(new GmailError("x", 0, "config"))).toBe(full.message);
  });
});