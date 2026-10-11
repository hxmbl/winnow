/**
 * The build environment.
 *
 * Everything Winnow reads out of `VITE_*` is read here, and nothing else reads
 * it directly. Three reasons, in order of how often they bite:
 *
 *   - One place to look. Six modules each doing `import.meta.env?.FOO` means a
 *     missing variable is found by grepping six times.
 *   - One place to be honest about what a secret is. Anything with a `VITE_`
 *     prefix is inlined into the bundle and readable by anyone who loads the
 *     page. That is fine for a client id and it is *not* fine to forget about,
 *     so the reader for the secret says so at the point it returns.
 *   - No import cycles. `platform/web.ts` needs the secret and
 *     `core/session/session.ts` needs the platform; a module both can depend on
 *     without either depending on the other keeps that from becoming a cycle.
 *
 * Vite inlines these at build time, so they are constants in the bundle rather
 * than runtime lookups. Reading them through a function is about one *place* to
 * change, not about deferring the read.
 */

/** The OAuth client id. Required for any sign-in. */
export function clientIdFromEnv(): string {
  const value = read("VITE_GMAIL_CLIENT_ID");
  return value.trim();
}

/**
 * The OAuth client secret, for a web-hosted build only.
 *
 * A secret in the browser is public by construction — it ships in the JavaScript.
 * PKCE is what actually protects the exchange, because the secret on its own
 * cannot exchange a code whose verifier the holder does not have. Google requires
 * the secret for a "web application" client type and forbids it for an
 * "installed app" one, so this is only ever used by the former.
 *
 * The desktop build must not set `VITE_GMAIL_CLIENT_SECRET`; see
 * `platform/desktop.ts`, which ignores it entirely.
 */
export function clientSecretFromEnv(): string | undefined {
  const value = read("VITE_GMAIL_CLIENT_SECRET");
  return value.trim() || undefined;
}

/**
 * The registered redirect URI for a web build.
 *
 * Empty for the desktop, which uses a loopback URI on an ephemeral port instead
 * — see `LOOPBACK_REDIRECT_URI`. Absence alone is not what identifies the
 * desktop, though: a web build with nothing set is a misconfiguration, not a
 * desktop in a tab. Which URI is correct follows from the platform's
 * `nativeOAuth` capability (see `GmailSession.redirectUri`); this reader only
 * supplies the value when a build has one.
 */
export function webRedirectUriFromEnv(): string {
  return read("VITE_GMAIL_REDIRECT_URI").trim();
}

/** Read one variable, tolerating a build with no `import.meta` at all. */
function read(name: string): string {
  const env = import.meta.env as Record<string, string | undefined> | undefined;
  return env?.[name] ?? "";
}