import { describe, expect, it } from "vitest";
import { COMMON_GOOGLE_ERRORS, explainGoogleError, explainGoogleText } from "./googleErrors";

describe("explainGoogleError", () => {
  it("redirect_uri_mismatch on the web: register the page's address", () => {
    const help = explainGoogleError({ error: "redirect_uri_mismatch" }, "web");
    expect(help).toMatchObject({ code: "redirect_uri_mismatch", step: "client" });
    expect(help?.fix).toMatch(/redirect URI/);
  });

  it("redirect_uri_mismatch on the desktop: the client is the wrong type", () => {
    expect(explainGoogleError({ error: "redirect_uri_mismatch" }, "desktop")).toMatchObject({ code: "wrong_client_type", step: "client" });
  });

  it("unauthorized_client: wrong client type, named for this build", () => {
    expect(explainGoogleError({ error: "unauthorized_client" }, "web")?.title).toMatch(/Web application/);
    expect(explainGoogleError({ error: "unauthorized_client" }, "desktop")?.title).toMatch(/Desktop app/);
  });

  it("a Gmail 403 SERVICE_DISABLED: turn the API on", () => {
    const body = "Gmail API has not been used in project 1234 before or it is disabled. Enable it by visiting …";
    expect(explainGoogleError({ status: 403, description: body }, "web")).toMatchObject({ code: "api_disabled", step: "apis" });
    expect(explainGoogleError({ description: "SERVICE_DISABLED" }, "desktop")?.step).toBe("apis");
    expect(explainGoogleError({ description: "accessNotConfigured" }, "web")?.code).toBe("api_disabled");
    expect(explainGoogleError({ status: 403, description: "Gmail request refused" }, "web")?.code).toBe("api_disabled");
  });

  it("the People API off is named as optional", () => {
    const help = explainGoogleError({ description: "People API has not been used in project 1 (people.googleapis.com)" }, "web");
    expect(help?.title).toMatch(/People API/);
    expect(help?.fix).toMatch(/only needed/);
  });

  it("not a test user: add yourself on the consent screen", () => {
    const help = explainGoogleError(
      { error: "access_denied", description: "Winnow has not completed the Google verification process." },
      "web",
    );
    expect(help).toMatchObject({ code: "not_test_user", step: "consent" });
  });

  it("a plain access_denied is a cancel, or the test-user list", () => {
    expect(explainGoogleError({ error: "access_denied" }, "web")).toMatchObject({ code: "access_denied", step: "consent" });
  });

  it("invalid_client: which half is wrong", () => {
    expect(explainGoogleError({ error: "invalid_client", description: "The OAuth client was not found." }, "web")?.title).toMatch(/client ID/);
    expect(explainGoogleError({ error: "invalid_client", description: "Unauthorized" }, "web")?.title).toMatch(/secret/);
    expect(explainGoogleError({ error: "invalid_client" }, "web")?.step).toBe("paste");
  });

  it("a missing secret", () => {
    const help = explainGoogleError({ error: "invalid_request", description: "client_secret is missing." }, "web");
    expect(help).toMatchObject({ code: "secret_missing", step: "paste" });
    // The prefix is built at run time; the upper-case literal must not appear in source.
    expect(help?.fix).toMatch(/starts with GOCSPX-/);
  });

  it("org_internal, admin policy, deleted clients, scopes", () => {
    expect(explainGoogleError({ error: "org_internal" }, "web")?.code).toBe("org_internal");
    expect(explainGoogleError({ error: "admin_policy_enforced" }, "web")?.code).toBe("admin_blocked");
    expect(explainGoogleError({ error: "deleted_client" }, "web")?.code).toBe("deleted_client");
    expect(explainGoogleError({ error: "disabled_client" }, "web")?.code).toBe("deleted_client");
    expect(explainGoogleError({ error: "invalid_scope" }, "web")?.step).toBe("consent");
    expect(explainGoogleError({ description: "ACCESS_TOKEN_SCOPE_INSUFFICIENT" }, "web")?.code).toBe("scope_not_granted");
  });

  it("a disabled client is not mistaken for a disabled API", () => {
    expect(explainGoogleError({ description: "The OAuth client was disabled." }, "web")?.code).toBe("deleted_client");
  });

  it("returns null for what it doesn't know", () => {
    expect(explainGoogleError({}, "web")).toBeNull();
    expect(explainGoogleError({ error: "temporarily_unavailable" }, "web")).toBeNull();
    expect(explainGoogleError({ description: "Could not reach Google." }, "web")).toBeNull();
  });
});

describe("explainGoogleText", () => {
  it("reads the code off Google's error page", () => {
    expect(explainGoogleText("Access blocked: Winnow's request is invalid\nError 400: redirect_uri_mismatch", "web")?.code).toBe(
      "redirect_uri_mismatch",
    );
    expect(explainGoogleText("Error 401: invalid_client\nThe OAuth client was not found.", "web")?.title).toMatch(/client ID/);
  });

  it("reads Winnow's own failure messages", () => {
    expect(explainGoogleText("Google answered: redirect_uri_mismatch", "web")?.code).toBe("redirect_uri_mismatch");
  });

  it("is null for empty text", () => {
    expect(explainGoogleText("   ", "web")).toBeNull();
  });

  it("explains every common error it lists", () => {
    for (const item of COMMON_GOOGLE_ERRORS) {
      expect(explainGoogleText(item.sample, "web"), item.label).not.toBeNull();
      expect(explainGoogleText(item.sample, "desktop"), item.label).not.toBeNull();
    }
  });
});
