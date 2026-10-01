/**
 * Reading Google's redirect out of the address bar.
 *
 * Only the web build needs this. The desktop build's code arrives over a
 * loopback socket, so nothing about the URL matters there.
 *
 * The parsing is split from the `location` access on purpose: given a query
 * string it is a pure function, so the awkward cases — a redirect with no
 * `state`, Google's `error` parameter, unrelated query parameters the app
 * itself put there — can be tested without a browser.
 */

import type { OAuthRedirect } from "../../platform/types";

/** The query parameters the app sets itself, so the sign-in link can be shared. */
const OWN_PARAMS = ["view", "filter", "message", "demo"] as const;

/**
 * Pull a redirect out of a query string, or `null` if it is not one.
 *
 * `null` is the common case: every normal page load lands here, and the app has
 * to tell "not a redirect" from "a redirect I should act on" without guessing.
 */
export function parseRedirect(search: string): OAuthRedirect | null {
  const params = new URLSearchParams(search);
  const state = params.get("state");

  const error = params.get("error");
  if (error) {
    // `error_description` is Google's prose for the user, not for a log. It can
    // be absent, and it can also be an absolute URL, which is only safe to show
    // as text — hence the length cap, so a hostile redirect cannot put an
    // unbounded string in front of someone.
    const description = (params.get("error_description") ?? "").slice(0, 300);
    return { kind: "error", error, description, state: state ?? "" };
  }

  const code = params.get("code");
  // A code with no state is rejected rather than half-accepted: without the
  // state there is no proof the redirect belongs to a sign-in this page began.
  if (!code || !state) return null;

  return { kind: "code", code, state };
}

/**
 * Rebuild the query string without the OAuth parameters.
 *
 * Called after a successful exchange so the code stops being part of the page's
 * address. It is a single-use credential, and a URL sitting in the address bar
 * is exactly the kind of thing a user copies and pastes into a bug report.
 */
export function stripRedirect(search: string): string {
  const params = new URLSearchParams(search);
  for (const name of [
    "code",
    // `state` is deleted with the rest. It is not itself a secret, but it is the
    // half of the pair that proves a redirect is ours, and leaving it in a URL
    // that outlives the exchange gives the next reader of the address bar a
    // value worth replaying.
    "state",
    "error",
    "error_description",
    "scope",
    "authuser",
    "prompt",
  ]) {
    params.delete(name);
  }
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

/** The app's own deep-link-ish query parameters, for restoring a shared view. */
export function readOwnParams(search: string): Record<string, string> {
  const params = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const name of OWN_PARAMS) {
    const value = params.get(name);
    if (value) out[name] = value;
  }
  return out;
}