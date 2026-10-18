/**
 * Native Android sign-in: the pure decisions around it.
 *
 * On Android, when the user has added a Web application client for it (setup's optional
 * Android step), sign-in first asks Google Play services for an authorization code
 * (`Platform.nativeGoogleSignIn`). Google issues that code to the Web client named as
 * `serverClientId`, and only when the same Cloud project also has an Android client for
 * this package name and signing certificate. Anything short of a code — no Play
 * services, Google refusing the app (`DEVELOPER_ERROR`), a failed exchange — falls back
 * to the browser flow with the main (Desktop app) client, without a word to the user.
 * Closing Google's sheet is the one outcome that stops: it is the user saying no.
 *
 * Two clients can now own a session, so the tokens remember theirs (`TokenSet.clientId`)
 * and every refresh is made under it (`refreshClientFor`).
 */

import type { NativeAndroidClient, OAuthClientCredentials } from "./credentials";

/** Split a space-separated scope string into its distinct scopes, in order. */
export function scopeList(...scopes: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of scopes) {
    for (const scope of (value ?? "").split(/\s+/)) {
      if (scope) seen.add(scope);
    }
  }
  return [...seen];
}

/** `scopeList` joined back into the space-separated form OAuth uses. */
export function unionScopes(...scopes: Array<string | undefined>): string {
  return scopeList(...scopes).join(" ");
}

/**
 * The client a refresh token must be refreshed under.
 *
 * `issuedTo` is the session's `clientId`. A session from a native sign-in names the
 * Web client; refreshing it with the main client is refused by Google. Anything else —
 * no `clientId`, or one that matches no stored client — is the main client's, as every
 * session made before native sign-in existed is.
 */
export function refreshClientFor(
  credentials: OAuthClientCredentials | null,
  issuedTo: string | undefined,
): { clientId: string; clientSecret?: string } | null {
  if (!credentials) return null;
  const native = credentials.nativeAndroid;
  if (issuedTo && native && native.clientId === issuedTo) return native;
  return { clientId: credentials.clientId, clientSecret: credentials.clientSecret };
}

/**
 * Whether saving `next` in place of `previous` strands the current session.
 *
 * The session belongs to one client (`sessionClientId`, absent for the main one). It
 * survives a change to the *other* client: adding or removing the Android client does
 * not touch a browser sign-in, and changing the main client does not touch a native
 * one — except that the main client is the fallback for everything, so changing it
 * signs out either way, as it always has.
 */
export function sessionStrandedBy(
  previous: OAuthClientCredentials | null,
  next: OAuthClientCredentials,
  sessionClientId: string | undefined,
): boolean {
  const mainChanged = previous?.clientId !== next.clientId || previous?.clientSecret !== next.clientSecret;
  if (mainChanged) return true;
  const ownedByNative = Boolean(sessionClientId && sessionClientId === previous?.nativeAndroid?.clientId);
  if (!ownedByNative) return false;
  return !sameNativeClient(previous?.nativeAndroid, next.nativeAndroid);
}

function sameNativeClient(a: NativeAndroidClient | undefined, b: NativeAndroidClient | undefined): boolean {
  return a?.clientId === b?.clientId && a?.clientSecret === b?.clientSecret;
}

/**
 * The scope a browser fallback should ask for.
 *
 * An incremental grant (contacts, drafts) normally asks only for what it adds, with
 * `include_granted_scopes`. That works because Google remembers what the *same* client
 * was granted. When the current session came from native sign-in, the browser's client
 * is a different one with nothing to remember, so it must ask for the session's
 * scopes again or the new tokens would lose Gmail.
 */
export function browserFallbackScope(
  scope: string,
  current: { scope?: string; clientId?: string } | null,
  incremental: boolean,
): string {
  if (!incremental || !current?.clientId) return scope;
  return unionScopes(current.scope, scope);
}
