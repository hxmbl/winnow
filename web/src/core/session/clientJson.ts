/**
 * Importing the JSON file Google Cloud Console downloads for an OAuth client.
 *
 * The **Download JSON** button on a client's page saves `client_secret_<id>.json`,
 * shaped like one of:
 *
 *     { "installed": { "client_id", "client_secret", "project_id", "auth_uri",
 *                      "token_uri", "redirect_uris": ["http://localhost"], … } }   // Desktop app
 *     { "web":       { …the same…, "redirect_uris": [...], "javascript_origins": [...] } }
 *
 * This file turns that text into the same `{ clientId, clientSecret }` pair the form
 * collects by hand, so an import is stored exactly as manual entry is. It is strict on
 * purpose: anything that is not plainly one Google OAuth client is refused with a
 * sentence that says what to download instead.
 *
 * ## Which client type works where
 *
 *   - **Desktop build** signs in through a loopback listener on a *random* port,
 *     `http://127.0.0.1:<port>/winnow-oauth` (see `native/src-tauri/src/oauth.rs`).
 *     Google accepts any loopback port only for **Desktop app** (`installed`) clients;
 *     a Web application client must list every redirect URI exactly, port included, so
 *     it cannot work there. A `web` file is refused on the desktop.
 *   - **Browser build** returns from Google to the page's own address
 *     (`webRedirectUriFor`), which has to be registered on a **Web application**
 *     client. Desktop clients only allow loopback redirects, so an `installed` file is
 *     refused in the browser.
 *
 * ## Secrets
 *
 * The client secret never appears in an error or warning, and nothing here logs. JSON
 * parse errors are not passed through either, because V8's messages quote the input.
 */

import { CLIENT_ID_SUFFIX, clientIdError, clientSecretError, type ClientKind, type OAuthClientCredentials } from "./credentials";

/** The largest file accepted. Google's files are well under 1 KB. */
export const CLIENT_JSON_MAX_BYTES = 64 * 1024;

/** Which section of the file the client came from. */
export type ClientJsonType = "installed" | "web";

export type ClientJsonImport =
  | {
      ok: true;
      credentials: OAuthClientCredentials;
      type: ClientJsonType;
      /** The Cloud project, when the file names a well-formed one. */
      projectId?: string;
      /** Things in the file that conflict with what Winnow needs, in sentences. */
      warnings: string[];
    }
  | { ok: false; error: string };

/** What the import needs to know about the host. */
export type ClientJsonContext = {
  kind: ClientKind;
  /** The browser build's redirect URI; empty on the desktop. */
  redirectUri: string;
};

/** The desktop build's loopback redirect, for messages. */
export const DESKTOP_REDIRECT_DESCRIPTION = "http://127.0.0.1:<port>/winnow-oauth";

const BOM = /^\uFEFF/;

/** Text with a leading byte-order mark and surrounding whitespace removed. */
function clean(text: string): string {
  return text.replace(BOM, "").trim();
}

/** True when pasted text is probably a client file rather than a bare client id. */
export function looksLikeClientJson(text: string): boolean {
  return clean(text).startsWith("{");
}

/** UTF-8 size of a string, without allocating a buffer for a huge one. */
function utf8Bytes(text: string): number {
  if (text.length > CLIENT_JSON_MAX_BYTES * 4) return text.length;
  return new TextEncoder().encode(text).length;
}

function tooLarge(bytes: number): string {
  const kb = Math.ceil(bytes / 1024);
  return `That file is ${kb} KB, too large to be a Google client file (they are under 1 KB; the limit is ${CLIENT_JSON_MAX_BYTES / 1024} KB). Choose the client_secret_….json you downloaded.`;
}

const NOT_JSON =
  "That isn't a Google client JSON file. In Google Cloud, open Google Auth Platform → Clients, choose your client and use Download JSON.";

/**
 * Google Cloud project ids: 6 to 30 characters, lower-case letters, digits and hyphens,
 * starting with a letter and not ending in a hyphen.
 */
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

export function isValidProjectId(value: unknown): value is string {
  return typeof value === "string" && PROJECT_ID_PATTERN.test(value);
}

/** The Google APIs the app calls, and what for. */
export const REQUIRED_APIS = [
  { id: "gmail.googleapis.com", name: "Gmail API", purpose: "your mail", required: true },
  { id: "people.googleapis.com", name: "People API", purpose: "contact suggestions and photos", required: false },
] as const;

/**
 * The Cloud Console page that enables one API, for a project when its id is valid and
 * for whichever project the console has open otherwise.
 */
export function apiLibraryUrl(apiId: string, projectId?: string): string {
  const base = `https://console.cloud.google.com/apis/library/${encodeURIComponent(apiId)}`;
  return isValidProjectId(projectId) ? `${base}?project=${encodeURIComponent(projectId)}` : base;
}

/** Google's sign-in pages that a client file may name. */
const KNOWN_AUTH_URIS = new Set([
  "https://accounts.google.com/o/oauth2/auth",
  "https://accounts.google.com/o/oauth2/v2/auth",
]);

/** Google's token endpoints that a client file may name. */
const KNOWN_TOKEN_URIS = new Set([
  "https://oauth2.googleapis.com/token",
  "https://accounts.google.com/o/oauth2/token",
  "https://www.googleapis.com/oauth2/v4/token",
]);

/** The retired out-of-band redirect older Desktop client files still list. */
const OOB_REDIRECT = "urn:ietf:wg:oauth:2.0:oob";

/** A value from the file, shortened for a message. Never used for the secret. */
function shown(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}…` : value;
}

function isLoopback(uri: string): boolean {
  try {
    const url = new URL(uri);
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function stringList(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value as string[];
}

/**
 * Parse and check a client file's text.
 *
 * Refuses: an empty or non-JSON text, an oversized one, a file with neither or both of
 * `installed` and `web`, a service-account key, a missing or malformed `client_id`, a
 * malformed `client_secret`, and the client type this host cannot use. Warns about
 * redirect and endpoint values that conflict with what Winnow sends.
 */
export function parseClientJson(text: string, context: ClientJsonContext): ClientJsonImport {
  const bytes = utf8Bytes(text);
  if (bytes > CLIENT_JSON_MAX_BYTES) return { ok: false, error: tooLarge(bytes) };

  const body = clean(text);
  if (!body) return { ok: false, error: "That file is empty. Download the client's JSON from Google Cloud again." };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: NOT_JSON };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, error: NOT_JSON };
  const root = parsed as Record<string, unknown>;

  if (root.type === "service_account") {
    return {
      ok: false,
      error:
        "That's a service account key, not an OAuth client. Create an OAuth client of type Desktop app (or Web application for the browser) and download its JSON.",
    };
  }

  const hasInstalled = "installed" in root;
  const hasWeb = "web" in root;
  if (hasInstalled && hasWeb) {
    return { ok: false, error: "That file describes two clients. Download the JSON for one client from its own page." };
  }
  if (!hasInstalled && !hasWeb) {
    return {
      ok: false,
      error: "That JSON isn't an OAuth client file: it has no \"installed\" or \"web\" section. Use Download JSON on the client's page in Google Cloud.",
    };
  }

  const type: ClientJsonType = hasInstalled ? "installed" : "web";
  const section = root[type];
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return { ok: false, error: `The file's "${type}" section isn't a client. Download the JSON again.` };
  }
  const client = section as Record<string, unknown>;

  // The client id.
  if (typeof client.client_id !== "string" || !client.client_id.trim()) {
    return { ok: false, error: "The file has no client_id. Download the JSON again from the client's page." };
  }
  const clientId = client.client_id.trim();
  if (!clientId.endsWith(CLIENT_ID_SUFFIX)) {
    return { ok: false, error: `The file's client_id doesn't end in ${CLIENT_ID_SUFFIX}, so it isn't a Google OAuth client ID.` };
  }
  const idProblem = clientIdError(clientId);
  if (idProblem) {
    return { ok: false, error: "The file's client_id isn't a well-formed Google client ID. Download the JSON again." };
  }

  // The client type against the host.
  if (type === "web" && context.kind === "desktop") {
    return {
      ok: false,
      error: `This is a Web application client, which the desktop app can't use: it signs in through ${DESKTOP_REDIRECT_DESCRIPTION} on a random port, and only Desktop app clients allow that. In Google Cloud, create a client of type Desktop app and import its JSON.`,
    };
  }
  if (type === "installed" && context.kind === "web") {
    return {
      ok: false,
      error: `This is a Desktop app client, which Winnow in the browser can't use: Google returns to ${context.redirectUri || "this page's address"}, and only a Web application client can register it. Create a client of type Web application, or use the desktop app.`,
    };
  }

  // The secret: optional for Desktop clients, required for Web ones. Never echoed.
  let clientSecret: string | undefined;
  if (client.client_secret !== undefined && client.client_secret !== null) {
    if (typeof client.client_secret !== "string") {
      return { ok: false, error: "The file's client_secret isn't text. Download the JSON again." };
    }
    clientSecret = client.client_secret.trim() || undefined;
  }
  const secretProblem = clientSecretError(clientSecret, context.kind);
  if (secretProblem) {
    return {
      ok: false,
      error: clientSecret
        ? "The file's client_secret isn't well-formed. Download the JSON again."
        : "The file has no client_secret, and a Web application client needs one. Download the JSON again, or add a secret on the client's page.",
    };
  }

  const warnings: string[] = [];

  // The project, for the API links.
  let projectId: string | undefined;
  if (client.project_id !== undefined) {
    if (isValidProjectId(client.project_id)) projectId = client.project_id;
    else warnings.push("The file's project_id isn't a valid Cloud project ID, so the links below open whichever project Cloud Console has selected.");
  }

  // Endpoints: Winnow always uses Google's own and ignores the file's.
  if (client.auth_uri !== undefined) {
    if (typeof client.auth_uri !== "string" || !KNOWN_AUTH_URIS.has(client.auth_uri.trim())) {
      warnings.push(
        `The file's auth_uri${typeof client.auth_uri === "string" ? ` (${shown(client.auth_uri)})` : ""} isn't Google's sign-in page. Winnow always signs in at accounts.google.com and ignores it; check the file came from Google Cloud.`,
      );
    }
  }
  if (client.token_uri !== undefined) {
    if (typeof client.token_uri !== "string" || !KNOWN_TOKEN_URIS.has(client.token_uri.trim())) {
      warnings.push(
        `The file's token_uri${typeof client.token_uri === "string" ? ` (${shown(client.token_uri)})` : ""} isn't Google's token endpoint. Winnow always uses oauth2.googleapis.com and ignores it; check the file came from Google Cloud.`,
      );
    }
  }

  // Redirects.
  const redirects = stringList(client.redirect_uris);
  if (redirects === null) {
    warnings.push("The file's redirect_uris isn't a list of addresses, so it was ignored.");
  } else if (type === "installed") {
    const odd = redirects.filter((uri) => uri !== OOB_REDIRECT && !isLoopback(uri));
    if (odd.length) {
      warnings.push(
        `This Desktop client lists redirect URIs that aren't loopback addresses (${shown(odd.join(", "))}). Winnow uses ${DESKTOP_REDIRECT_DESCRIPTION}, which Google allows for every Desktop client, so they aren't used.`,
      );
    }
  } else if (context.redirectUri) {
    if (!redirects.includes(context.redirectUri)) {
      const near = redirects.find(
        (uri) => uri.replace(/\/$/, "") === context.redirectUri.replace(/\/$/, ""),
      );
      warnings.push(
        near
          ? `The client lists ${shown(near)}, but Winnow returns to ${context.redirectUri}. Google needs an exact match, trailing slash included: add ${context.redirectUri} under Authorised redirect URIs.`
          : `The client doesn't list ${context.redirectUri} as a redirect URI. Add it under Authorised redirect URIs, or Google refuses the sign-in with redirect_uri_mismatch.`,
      );
    }
    const origins = stringList(client.javascript_origins);
    let origin = "";
    try {
      origin = new URL(context.redirectUri).origin;
    } catch {
      // No usable origin; nothing to compare.
    }
    if (origin && origins !== null && !origins.includes(origin)) {
      warnings.push(`Add ${origin} under Authorised JavaScript origins too; the client doesn't list it.`);
    }
  }

  return {
    ok: true,
    type,
    credentials: clientSecret ? { clientId, clientSecret } : { clientId },
    ...(projectId ? { projectId } : {}),
    warnings,
  };
}

/** The parts of a `File` the import reads. */
export type ClientJsonFile = {
  name: string;
  size: number;
  type: string;
  text(): Promise<string>;
};

/**
 * Check a picked or dropped file before reading it, then parse it.
 *
 * The size is checked first, so a huge file is never read into memory.
 */
export async function readClientJsonFile(file: ClientJsonFile, context: ClientJsonContext): Promise<ClientJsonImport> {
  if (file.size > CLIENT_JSON_MAX_BYTES) return { ok: false, error: tooLarge(file.size) };
  const named = /\.json$/i.test(file.name);
  const typed = file.type === "" || file.type === "application/json" || file.type === "text/json" || file.type === "text/plain";
  if (!named && !typed) return { ok: false, error: NOT_JSON };
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: "That file couldn't be read. Try choosing it again." };
  }
  return parseClientJson(text, context);
}
