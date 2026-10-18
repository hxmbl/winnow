/**
 * Importing Google Cloud Console's client JSON: the shapes it comes in, everything that
 * is refused, the warnings, and that the secret never reaches a message.
 */

import { describe, expect, it } from "vitest";
import {
  CLIENT_JSON_MAX_BYTES,
  apiLibraryUrl,
  isValidProjectId,
  looksLikeClientJson,
  parseClientJson,
  readClientJsonFile,
  type ClientJsonContext,
  type ClientJsonImport,
} from "./clientJson";

const ID = "1234567890-abc123def.apps.googleusercontent.com";
// Split so no scanner reads a fixture as a leaked secret.
const SECRET = "GOCSPX" + "-smoke-Secret_value123";
const WEB_URI = "http://localhost:5173/";
const DESKTOP: ClientJsonContext = { kind: "desktop", redirectUri: "" };
const WEB: ClientJsonContext = { kind: "web", redirectUri: WEB_URI };

const installed = (over: Record<string, unknown> = {}) => ({
  installed: {
    client_id: ID,
    project_id: "winnow-mail-123",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_secret: SECRET,
    redirect_uris: ["http://localhost"],
    ...over,
  },
});

const web = (over: Record<string, unknown> = {}) => ({
  web: {
    client_id: ID,
    project_id: "winnow-mail-123",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    client_secret: SECRET,
    redirect_uris: [WEB_URI],
    javascript_origins: ["http://localhost:5173"],
    ...over,
  },
});

const json = (value: unknown) => JSON.stringify(value, null, 2);

function failure(result: ClientJsonImport): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}

function success(result: ClientJsonImport) {
  if (!result.ok) throw new Error(`expected an import, got: ${result.error}`);
  return result;
}

/** Every message an import produced. */
function messages(result: ClientJsonImport): string[] {
  return result.ok ? result.warnings : [result.error];
}

describe("parseClientJson: accepted files", () => {
  it("imports a Desktop app client on the desktop, secret and project included", () => {
    const result = success(parseClientJson(json(installed()), DESKTOP));
    expect(result.type).toBe("installed");
    expect(result.credentials).toEqual({ clientId: ID, clientSecret: SECRET });
    expect(result.projectId).toBe("winnow-mail-123");
    expect(result.warnings).toEqual([]);
  });

  it("imports a Desktop client without a secret, which the desktop allows", () => {
    const result = success(parseClientJson(json(installed({ client_secret: undefined })), DESKTOP));
    expect(result.credentials).toEqual({ clientId: ID });
    expect(success(parseClientJson(json(installed({ client_secret: "  " })), DESKTOP)).credentials).toEqual({ clientId: ID });
  });

  it("imports a Web application client in the browser", () => {
    const result = success(parseClientJson(json(web()), WEB));
    expect(result.type).toBe("web");
    expect(result.credentials).toEqual({ clientId: ID, clientSecret: SECRET });
    expect(result.warnings).toEqual([]);
  });

  it("tolerates a byte-order mark and surrounding whitespace", () => {
    const result = success(parseClientJson(`\uFEFF\n\t  ${json(installed())}  \r\n`, DESKTOP));
    expect(result.credentials.clientId).toBe(ID);
  });

  it("trims whitespace inside the id and secret values", () => {
    const result = success(parseClientJson(json(installed({ client_id: ` ${ID} `, client_secret: ` ${SECRET}\n` })), DESKTOP));
    expect(result.credentials).toEqual({ clientId: ID, clientSecret: SECRET });
  });

  it("accepts Google's other endpoint spellings without a warning", () => {
    const result = success(
      parseClientJson(
        json(installed({ auth_uri: "https://accounts.google.com/o/oauth2/v2/auth", token_uri: "https://accounts.google.com/o/oauth2/token" })),
        DESKTOP,
      ),
    );
    expect(result.warnings).toEqual([]);
  });

  it("accepts the loopback and retired out-of-band redirects an installed file lists", () => {
    const result = success(
      parseClientJson(json(installed({ redirect_uris: ["urn:ietf:wg:oauth:2.0:oob", "http://localhost", "http://127.0.0.1:8080/cb"] })), DESKTOP),
    );
    expect(result.warnings).toEqual([]);
  });

  it("accepts a file with no optional fields at all", () => {
    const result = success(parseClientJson(JSON.stringify({ installed: { client_id: ID } }), DESKTOP));
    expect(result.projectId).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });
});

describe("parseClientJson: refusals", () => {
  it("refuses empty text", () => {
    expect(failure(parseClientJson("", DESKTOP))).toMatch(/empty/);
    expect(failure(parseClientJson("\uFEFF  \n", DESKTOP))).toMatch(/empty/);
  });

  it("refuses text that isn't JSON, without quoting it", () => {
    const error = failure(parseClientJson(`{"installed": {"client_secret": "${SECRET}"`, DESKTOP));
    expect(error).toMatch(/isn't a Google client JSON file/);
    expect(error).not.toContain(SECRET);
  });

  it("refuses JSON that isn't an object", () => {
    for (const text of ["[]", "null", "42", '"client"', "true"]) {
      expect(failure(parseClientJson(text, DESKTOP))).toMatch(/isn't a Google client JSON file/);
    }
  });

  it("refuses text over the size limit", () => {
    const padded = json(installed({ note: "x".repeat(CLIENT_JSON_MAX_BYTES) }));
    expect(failure(parseClientJson(padded, DESKTOP))).toMatch(/too large/);
  });

  it("counts the limit in bytes, not characters", () => {
    const wide = "é".repeat(Math.ceil(CLIENT_JSON_MAX_BYTES / 2) + 10);
    expect(wide.length).toBeLessThan(CLIENT_JSON_MAX_BYTES);
    expect(failure(parseClientJson(json(installed({ note: wide })), DESKTOP))).toMatch(/too large/);
  });

  it("refuses a file with neither section", () => {
    expect(failure(parseClientJson(json({ client_id: ID }), DESKTOP))).toMatch(/no "installed" or "web" section/);
  });

  it("refuses a file with both sections", () => {
    expect(failure(parseClientJson(json({ ...installed(), ...web() }), DESKTOP))).toMatch(/two clients/);
  });

  it("names a service account key for what it is", () => {
    const key = { type: "service_account", project_id: "p", private_key: "-----BEGIN PRIVATE KEY-----", client_id: "123" };
    const error = failure(parseClientJson(json(key), DESKTOP));
    expect(error).toMatch(/service account key/);
    expect(error).not.toContain("PRIVATE KEY");
  });

  it("refuses a section that isn't an object", () => {
    expect(failure(parseClientJson(json({ installed: "x" }), DESKTOP))).toMatch(/isn't a client/);
    expect(failure(parseClientJson(json({ installed: [ID] }), DESKTOP))).toMatch(/isn't a client/);
    expect(failure(parseClientJson(json({ installed: null }), DESKTOP))).toMatch(/isn't a client/);
  });

  it("refuses a missing, empty or non-text client_id", () => {
    for (const client_id of [undefined, "", "   ", 123, null]) {
      expect(failure(parseClientJson(json(installed({ client_id })), DESKTOP))).toMatch(/no client_id/);
    }
  });

  it("refuses a client_id without the Google suffix", () => {
    expect(failure(parseClientJson(json(installed({ client_id: "1234567890-abc123def" })), DESKTOP))).toMatch(
      /doesn't end in \.apps\.googleusercontent\.com/,
    );
    expect(failure(parseClientJson(json(installed({ client_id: `${ID}.evil.com` })), DESKTOP))).toMatch(/doesn't end in/);
  });

  it("refuses a malformed client_id that has the suffix", () => {
    expect(failure(parseClientJson(json(installed({ client_id: "bad id.apps.googleusercontent.com" })), DESKTOP))).toMatch(/well-formed/);
    expect(failure(parseClientJson(json(installed({ client_id: ".apps.googleusercontent.com" })), DESKTOP))).toMatch(/well-formed/);
  });

  it("refuses a Web application client on the desktop, pointing at a Desktop app client", () => {
    const error = failure(parseClientJson(json(web()), DESKTOP));
    expect(error).toMatch(/Web application client/);
    expect(error).toMatch(/create a client of type Desktop app/);
    expect(error).toContain("127.0.0.1");
  });

  it("refuses a Desktop app client in the browser, pointing at a Web application client", () => {
    const error = failure(parseClientJson(json(installed()), WEB));
    expect(error).toMatch(/Desktop app client/);
    expect(error).toMatch(/Web application/);
    expect(error).toContain(WEB_URI);
  });

  it("refuses a Web client file with no secret in the browser", () => {
    expect(failure(parseClientJson(json(web({ client_secret: undefined })), WEB))).toMatch(/no client_secret/);
    expect(failure(parseClientJson(json(web({ client_secret: "" })), WEB))).toMatch(/no client_secret/);
  });

  it("refuses a secret that isn't text, or has spaces in it, without echoing it", () => {
    expect(failure(parseClientJson(json(installed({ client_secret: 42 })), DESKTOP))).toMatch(/isn't text/);
    const spaced = "gocspx-has a space";
    const error = failure(parseClientJson(json(installed({ client_secret: spaced })), DESKTOP));
    expect(error).toMatch(/isn't well-formed/);
    expect(error).not.toContain(spaced);
  });
});

describe("parseClientJson: warnings", () => {
  it("warns when the file names a foreign sign-in or token endpoint", () => {
    const result = success(
      parseClientJson(json(installed({ auth_uri: "https://evil.example/auth", token_uri: "https://evil.example/token" })), DESKTOP),
    );
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toMatch(/auth_uri \(https:\/\/evil\.example\/auth\) isn't Google's sign-in page/);
    expect(result.warnings[1]).toMatch(/token_uri .* isn't Google's token endpoint/);
  });

  it("warns about non-text endpoints without crashing", () => {
    const result = success(parseClientJson(json(installed({ auth_uri: 5, token_uri: {} })), DESKTOP));
    expect(result.warnings).toHaveLength(2);
  });

  it("warns when a Desktop file lists non-loopback redirects", () => {
    const result = success(parseClientJson(json(installed({ redirect_uris: ["https://mail.example.com/"] })), DESKTOP));
    expect(result.warnings[0]).toMatch(/aren't loopback addresses/);
  });

  it("warns when redirect_uris isn't a list of strings", () => {
    expect(success(parseClientJson(json(installed({ redirect_uris: "http://localhost" })), DESKTOP)).warnings[0]).toMatch(/isn't a list/);
    expect(success(parseClientJson(json(installed({ redirect_uris: [1] })), DESKTOP)).warnings[0]).toMatch(/isn't a list/);
  });

  it("warns when a Web client doesn't register the app's redirect URI", () => {
    const result = success(parseClientJson(json(web({ redirect_uris: ["https://other.example/"] })), WEB));
    expect(result.warnings[0]).toMatch(/doesn't list http:\/\/localhost:5173\/ as a redirect URI/);
  });

  it("names the trailing-slash near miss", () => {
    const result = success(parseClientJson(json(web({ redirect_uris: ["http://localhost:5173"] })), WEB));
    expect(result.warnings[0]).toMatch(/trailing slash/);
  });

  it("warns when a Web client is missing the JavaScript origin", () => {
    expect(success(parseClientJson(json(web({ javascript_origins: ["https://x.example"] })), WEB)).warnings[0]).toMatch(
      /Authorised JavaScript origins/,
    );
    expect(success(parseClientJson(json(web({ javascript_origins: undefined })), WEB)).warnings[0]).toMatch(
      /Authorised JavaScript origins/,
    );
  });

  it("drops a malformed project_id and says so", () => {
    for (const project_id of ["Bad_Project", "ab", "has spaces here", "x".repeat(40), "ends-with-", "1starts-digit", 7]) {
      const result = success(parseClientJson(json(installed({ project_id })), DESKTOP));
      expect(result.projectId).toBeUndefined();
      expect(result.warnings[0]).toMatch(/project_id isn't a valid Cloud project ID/);
    }
  });

  it("never puts the secret in any message", () => {
    const cases: Array<[unknown, ClientJsonContext]> = [
      [installed({ auth_uri: "https://evil.example", token_uri: "x", redirect_uris: ["https://a.example"], project_id: "BAD" }), DESKTOP],
      [web({ redirect_uris: [], javascript_origins: [] }), WEB],
      [web(), DESKTOP],
      [installed(), WEB],
      [installed({ client_id: "nope" }), DESKTOP],
    ];
    for (const [file, context] of cases) {
      for (const message of messages(parseClientJson(json(file), context))) expect(message).not.toContain(SECRET);
    }
  });
});

describe("looksLikeClientJson", () => {
  it("spots pasted JSON, with a BOM or whitespace in front", () => {
    expect(looksLikeClientJson(json(installed()))).toBe(true);
    expect(looksLikeClientJson("\uFEFF  {")).toBe(true);
  });

  it("leaves a bare client id alone", () => {
    expect(looksLikeClientJson(ID)).toBe(false);
    expect(looksLikeClientJson("")).toBe(false);
  });
});

describe("project ids and API links", () => {
  it("validates Cloud project ids", () => {
    expect(isValidProjectId("winnow-mail-123")).toBe(true);
    expect(isValidProjectId("abcdef")).toBe(true);
    expect(isValidProjectId("abcde")).toBe(false);
    expect(isValidProjectId("a".repeat(31))).toBe(false);
    expect(isValidProjectId("evil?x=1")).toBe(false);
    expect(isValidProjectId(undefined)).toBe(false);
  });

  it("deep-links the API library for a valid project, and drops an invalid one", () => {
    expect(apiLibraryUrl("gmail.googleapis.com", "winnow-mail-123")).toBe(
      "https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=winnow-mail-123",
    );
    expect(apiLibraryUrl("people.googleapis.com", "bad&project=x")).toBe(
      "https://console.cloud.google.com/apis/library/people.googleapis.com",
    );
    expect(apiLibraryUrl("gmail.googleapis.com")).toBe("https://console.cloud.google.com/apis/library/gmail.googleapis.com");
  });
});

describe("readClientJsonFile", () => {
  const file = (text: string, over: Partial<{ name: string; size: number; type: string }> = {}) => ({
    name: "client_secret_123.apps.googleusercontent.com.json",
    size: new TextEncoder().encode(text).length,
    type: "application/json",
    text: async () => text,
    ...over,
  });

  it("reads and imports a downloaded client file", async () => {
    expect(success(await readClientJsonFile(file(json(installed())), DESKTOP)).credentials.clientId).toBe(ID);
  });

  it("accepts a file with no MIME type, as some systems report", async () => {
    expect((await readClientJsonFile(file(json(installed()), { type: "" }), DESKTOP)).ok).toBe(true);
  });

  it("refuses an oversized file before reading it", async () => {
    let read = false;
    const big = { name: "c.json", size: CLIENT_JSON_MAX_BYTES + 1, type: "application/json", text: async () => ((read = true), "{}") };
    expect(failure(await readClientJsonFile(big, DESKTOP))).toMatch(/too large/);
    expect(read).toBe(false);
  });

  it("refuses a file that is plainly not JSON", async () => {
    expect(failure(await readClientJsonFile(file("PNG", { name: "photo.png", type: "image/png" }), DESKTOP))).toMatch(/isn't a Google client JSON/);
  });

  it("refuses a .json file whose contents aren't JSON", async () => {
    expect(failure(await readClientJsonFile(file("not json at all"), DESKTOP))).toMatch(/isn't a Google client JSON/);
  });

  it("reports a file that can't be read", async () => {
    const broken = { name: "c.json", size: 10, type: "application/json", text: async () => Promise.reject(new Error("io")) };
    expect(failure(await readClientJsonFile(broken, DESKTOP))).toMatch(/couldn't be read/);
  });
});
