/**
 * The signed-in account's own Google profile: its name and profile picture (STRM-461).
 *
 * Read from the OpenID userinfo endpoint (`USERINFO_URL`) under the basic profile scope
 * (`PROFILE_SCOPE`), which every sign-in asks for since this was added. Not the People
 * API's `people/me`: that needs the People API switched on in the user's own Cloud
 * project, which only the optional contacts grant asks of them, while userinfo works for
 * any client with nothing to enable.
 *
 * A session signed in before the scope was added has no profile grant. Google then
 * answers 401 or 403 (`insufficient_scope` in `WWW-Authenticate`), which comes back as
 * `{ kind: "not_granted" }`: the caller offers the one re-consent, and the account keeps
 * its monogram meanwhile. Nothing here is ever a sign-in failure.
 *
 * Wire rules as `people.ts`: one forced token refresh after a 401, nothing else retried
 * (it is one small read, made at most once a day per account).
 */

import { GmailError } from "./dto";
import type { FetchLike, TokenProvider } from "./client";
import { AVATAR_PHOTO_PX, sizedPhotoUrl } from "../avatars/photos";

/** Google's OpenID Connect userinfo endpoint (www.googleapis.com, already in the CSP). */
export const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

/** What the account row shows: the picture (avatar-sized) and the name, either absent. */
export type OwnProfile = { picture: string | null; name: string | null };

export type OwnProfileResult = ({ kind: "ok" } & OwnProfile) | { kind: "not_granted" };

/**
 * The profile picture a row may load: an https URL on Google's image host, sized for an
 * avatar. Anything else (another host, plain http, not a URL) is `null`: the userinfo
 * answer is Google's, but an `<img>` is only ever pointed at Google's own image server.
 */
export function ownPictureUrl(value: unknown, px: number = AVATAR_PHOTO_PX): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!/(^|\.)(googleusercontent|ggpht)\.com$/i.test(url.hostname)) return null;
  return sizedPhotoUrl(url.toString(), px);
}

/** The parts of a userinfo answer Winnow uses; everything else is ignored. */
export function parseUserinfo(body: unknown): OwnProfile {
  const source = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const name = typeof source.name === "string" && source.name.trim() !== "" ? source.name.trim() : null;
  return { picture: ownPictureUrl(source.picture), name };
}

/** Whether a refusal means the token lacks the profile scope (rather than anything else). */
export function isProfileScopeMissing(status: number, body: string, authenticate: string | null): boolean {
  if (status !== 401 && status !== 403) return false;
  return /insufficient_scope|ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient(?:Permissions| authentication scopes)/i.test(
    `${authenticate ?? ""} ${body}`,
  );
}

type Options = {
  fetchImpl?: FetchLike;
  /** One forced refresh after a 401, as the Gmail and People clients do. */
  onUnauthorized?: () => Promise<string | null>;
};

/**
 * Read the account's own profile.
 *
 * `not_granted` for a token without the profile scope, whether Google says so outright
 * (403, or a 401 naming `insufficient_scope`) or a refreshed token is still refused.
 * Throws only for what is not about the grant: no session at all, or the network.
 */
export async function fetchOwnProfile(tokenProvider: TokenProvider, options: Options = {}): Promise<OwnProfileResult> {
  const globalFetch = globalThis.fetch?.bind(globalThis) as FetchLike | undefined;
  const fetchImpl = options.fetchImpl ?? globalFetch;
  if (!fetchImpl) throw new Error("no fetch implementation available");
  const token = await tokenProvider();
  if (!token) throw new GmailError("Not signed in to Google.", 401, "reauth_required");

  const send = async (bearer: string) => {
    const response = await fetchImpl(USERINFO_URL, { method: "GET", headers: { Authorization: `Bearer ${bearer}` } });
    const text = await response.text();
    const authenticate = response.headers?.get("www-authenticate") ?? null;
    return { status: response.status, ok: response.ok, text, authenticate };
  };

  let answer = await send(token);
  if (isProfileScopeMissing(answer.status, answer.text, answer.authenticate)) return { kind: "not_granted" };
  if (answer.status === 401 && options.onUnauthorized) {
    const refreshed = await options.onUnauthorized();
    if (!refreshed) throw new GmailError("Your Google session has expired. Sign in again.", 401, "reauth_required");
    answer = await send(refreshed);
  }
  // A token Gmail accepts but userinfo still refuses after a refresh: the grant has no
  // profile scope, however Google worded it.
  if (answer.status === 401 || answer.status === 403) return { kind: "not_granted" };
  if (!answer.ok) throw new GmailError(`Google returned ${answer.status} for the profile.`, answer.status, "unknown");
  let body: unknown = {};
  try {
    body = answer.text ? JSON.parse(answer.text) : {};
  } catch {
    body = {};
  }
  return { kind: "ok", ...parseUserinfo(body) };
}
