/**
 * Reading Google's redirect out of the URL.
 *
 * These are the awkward cases, and each one is a case where getting it wrong is
 * either a broken sign-in or a security hole — so they are worth pinning down
 * rather than exercising only through the UI.
 */

import { describe, expect, it } from "vitest";
import { parseRedirect, readOwnParams, stripRedirect } from "./redirect";

describe("parseRedirect", () => {
  it("returns null for an ordinary page load", () => {
    // Every normal boot lands here. "Not a redirect" has to be distinguishable
    // from "a redirect I should act on" without guessing.
    expect(parseRedirect("")).toBeNull();
    expect(parseRedirect("?view=inbox")).toBeNull();
    expect(parseRedirect("?filter=important&message=3")).toBeNull();
  });

  it("reads a code and its state", () => {
    expect(parseRedirect("?code=4/abc&state=xyz")).toEqual({
      kind: "code",
      code: "4/abc",
      state: "xyz",
    });
  });

  it("refuses a code with no state", () => {
    // Without the state there is no proof the redirect belongs to a sign-in this
    // page began, which is the entire point of the parameter. Half-accepting it
    // would be worse than ignoring it.
    expect(parseRedirect("?code=4/abc")).toBeNull();
  });

  it("reads Google's error, which is how a decline arrives", () => {
    expect(parseRedirect("?error=access_denied&state=xyz")).toEqual({
      kind: "error",
      error: "access_denied",
      description: "",
      state: "xyz",
    });
  });

  it("keeps Google's own description when there is one", () => {
    const redirect = parseRedirect(
      "?error=invalid_scope&error_description=The+scope+is+not+valid&state=s",
    );
    expect(redirect).toMatchObject({
      kind: "error",
      description: "The scope is not valid",
    });
  });

  it("caps an unbounded error_description", () => {
    // A hostile or malformed redirect must not be able to put an unbounded
    // string in front of someone in an error message.
    const redirect = parseRedirect(`?error=e&error_description=${"x".repeat(5000)}`);
    expect(redirect?.kind).toBe("error");
    if (redirect?.kind === "error") {
      expect(redirect.description.length).toBeLessThanOrEqual(300);
    }
  });

  it("prefers the error over a code if both are present", () => {
    // Google never sends both, but if something does, the error is the honest
    // thing to act on — exchanging a code that Google paired with an error
    // would fail anyway, and worse, would hide why.
    const redirect = parseRedirect("?code=abc&error=access_denied&state=s");
    expect(redirect?.kind).toBe("error");
  });

  it("handles a code containing its own separators", () => {
    // Gmail authorization codes contain slashes, and a code arriving unencoded
    // must not be truncated at the first one.
    const redirect = parseRedirect("?code=4/0Adw6NP-A_b-C.xyz&state=s");
    expect(redirect).toMatchObject({ code: "4/0Adw6NP-A_b-C.xyz" });
  });

  it("decodes percent-encoded values", () => {
    const redirect = parseRedirect("?code=a%2Fb%20c&state=x%20y");
    expect(redirect).toMatchObject({ code: "a/b c", state: "x y" });
  });
});

describe("stripRedirect", () => {
  it("removes the OAuth parameters and keeps the rest", () => {
    // The app's own view parameters are what someone might be sharing in a
    // link, so they have to survive the scrub.
    expect(stripRedirect("?code=abc&state=s&view=spam")).toBe("?view=spam");
  });

  it("removes Google's extra parameters too", () => {
    // `authuser` and `prompt` carry no view state but they do say something about
    // the account that was involved, so they go.
    expect(stripRedirect("?code=abc&state=s&authuser=1&prompt=consent")).toBe("");
  });

  it("returns an empty string when nothing is left", () => {
    // Appending a bare `?` would put a character in the address bar for no
    // reason, and would make the history entry look different from the others.
    expect(stripRedirect("?code=abc&state=s")).toBe("");
  });
});

describe("readOwnParams", () => {
  it("reads only the parameters the app sets", () => {
    expect(readOwnParams("?view=spam&code=abc&state=s")).toEqual({ view: "spam" });
  });

  it("ignores unknown parameters", () => {
    // Anything else in the URL is either someone else's or a future field, and
    // neither should silently become application state.
    expect(readOwnParams("?tracking=1")).toEqual({});
  });
});