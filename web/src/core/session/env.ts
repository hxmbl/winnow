/** Build environment. Reads VITE_* in one place. */

/** The OAuth client id. Required for any sign-in. */
export function clientIdFromEnv(): string {
  const value = read("VITE_GMAIL_CLIENT_ID");
  return value.trim();
}

/** OAuth client secret (web builds only). Public in bundle; PKCE protects exchange. */
export function clientSecretFromEnv(): string | undefined {
  const value = read("VITE_GMAIL_CLIENT_SECRET");
  return value.trim() || undefined;
}

/** Redirect URI for web build. */
export function webRedirectUriFromEnv(): string {
  return read("VITE_GMAIL_REDIRECT_URI").trim();
}

/** Read one variable, tolerating a build with no `import.meta` at all. */
function read(name: string): string {
  const env = import.meta.env as Record<string, string | undefined> | undefined;
  return env?.[name] ?? "";
}