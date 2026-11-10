/**
 * Link tracker removal (STRM-471): Settings → Privacy → Remove link trackers.
 *
 * Strips a short **denylist** of well-known click-tracking parameters from the `http(s)`
 * links in a rendered message, and nothing else. The rule is "when in doubt, leave the
 * link alone": a link that stops working is worse than a link that tells a marketer
 * which campaign you clicked, so every guard below errs towards not touching the URL.
 *
 *  - **Only the denylist goes.** An allowlist ("keep what looks important") would have
 *    to know every signed-URL scheme on the internet; the denylist only has to know
 *    the trackers, and an unknown name is always kept.
 *  - **A signed or authenticated URL is left whole.** A signature can cover the entire
 *    query, `utm_source` included, so removing even a tracker breaks it. Any parameter
 *    that looks like a signature, token, key, code, state, expiry or nonce means the
 *    URL is returned exactly as written. See [`AUTH_PARAMS`].
 *  - **Shorteners and redirect wrappers are left whole.** Their parameters belong to the
 *    wrapper (often signed), and unwrapping them is a different feature. See
 *    [`isRedirectLike`].
 *  - **Account flows are left whole.** A path that mentions unsubscribe, verify,
 *    confirm, reset, login, sign-in or a magic link is never edited. See [`SENSITIVE_PATH`].
 *  - **The raw query is edited, not re-serialised.** `URLSearchParams.toString()` would
 *    re-encode every other parameter (`%20` → `+`, `~` → `%7E`), which changes bytes a
 *    signature or a server may depend on. Pieces are split on `&` and the survivors are
 *    joined back exactly as written, in order, fragment and all.
 *  - **No match, no change.** A URL with nothing to strip is returned as the same string.
 *
 * OAuth URLs Winnow builds itself (`core/gmail/pkce.ts`, `core/session/redirect.ts`) never
 * pass through here: this only sees the `href`s of a message body.
 */

/** Tracking parameters removed by exact, case-sensitive name. `utm_*` is matched separately. */
export const TRACKING_PARAMS: ReadonlySet<string> = new Set([
  // Ad-platform click IDs.
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "twclid",
  "ttclid",
  "li_fat_id",
  "igshid",
  "yclid",
  // Mailchimp.
  "mc_cid",
  "mc_eid",
  // HubSpot.
  "_hsenc",
  "_hsmi",
  "__hssc",
  "__hstc",
  "__hsfp",
  // Marketo.
  "mkt_tok",
]);

/** Any `utm_` parameter, in any case (`UTM_Source` is as common as `utm_source`). */
const UTM_PREFIX = /^utm_/i;

/**
 * Parameters that mean "this URL is signed or carries a credential", compared
 * lowercased. One of these anywhere in the query leaves the whole URL untouched.
 */
export const AUTH_PARAMS: ReadonlySet<string> = new Set([
  "sig",
  "signature",
  "x-amz-signature",
  "x-goog-signature",
  "hmac",
  "hash",
  "token",
  "auth",
  "key",
  "code",
  "state",
  "expires",
  "exp",
  "nonce",
  "otp",
  "verify",
]);

/** …and anything named like one (`url_sig`, `access_token`, `X_Auth_Token`). */
const AUTH_SUFFIX = /(?:_sig|_token)$/i;

/**
 * Path words for account and subscription flows. Matched case-insensitively anywhere in
 * the path, with an optional `-` or `_` inside the two-word ones (`sign-in`, `log_in`).
 */
const SENSITIVE_PATH = /unsubscribe|verify|confirm|reset|log[-_]?in|sign[-_]?in|magic/i;

/** Link shorteners: the path is the whole link, and the query belongs to the shortener. */
const SHORTENER_HOSTS: ReadonlySet<string> = new Set([
  "bit.ly", "bitly.com", "t.co", "tinyurl.com", "goo.gl", "ow.ly", "buff.ly", "is.gd",
  "lnkd.in", "rebrand.ly", "t.ly", "cutt.ly", "shorturl.at", "tiny.cc", "rb.gy", "dlvr.it",
  "trib.al", "amzn.to", "a.co", "youtu.be", "fb.me", "aka.ms", "s.id", "v.gd", "qr.ae",
  "spoti.fi", "apple.co", "g.co", "shor.by", "linktr.ee", "lnk.to", "hubs.ly", "hubs.la",
  "mailchi.mp", "eepurl.com", "sendgrid.net", "list-manage.com", "e2ma.net", "mcsv.net",
  "click.convertkit-mail.com",
]);

/**
 * Hosts that exist to forward a click somewhere else: link-safety scanners and the
 * "you are leaving" bounce pages of large sites. Matched on the host or any parent domain.
 */
const REDIRECT_HOSTS: ReadonlySet<string> = new Set([
  "safelinks.protection.outlook.com", "urldefense.com", "urldefense.proofpoint.com",
  "linkprotect.cudasvc.com", "protect-us.mimecast.com", "protect-eu.mimecast.com",
  "l.facebook.com", "lm.facebook.com", "l.instagram.com", "out.reddit.com",
  "l.messenger.com", "away.vk.com", "slack-redir.net", "t.umblr.com", "href.li",
  "exit.sc", "click.redditmail.com",
]);

/**
 * The first label of a host an email service routes clicks through
 * (`click.example.com`, `links.newsletter.example`, `trk.vendor.io`). These are redirect
 * wrappers in practice, and their query is often what the redirect is signed over.
 */
const REDIRECT_SUBDOMAIN = /^(?:click|clicks|clk|link|links|lnk|track|tracking|trk|t|r|redirect|redir|go|url|email|e|em|mail|news|newsletter|elink|ablink|mandrillapp)\d*$/i;

/** A path that is a redirect endpoint, on any host (`google.com/url?q=…`). */
const REDIRECT_PATH = /^\/(?:url|redirect|redir|r|out|away|exit|outbound|click|link|l|ls|wf|track)(?:\/|$)/i;

/** A parameter whose value is itself a URL: the link is a wrapper around another one. */
const NESTED_URL_VALUE = /^(?:https?(?::|%3a)|%2f%2f|\/\/)/i;

/** Decode a parameter name for comparison only; a malformed escape is compared as written. */
function paramName(piece: string): string {
  const eq = piece.indexOf("=");
  const raw = eq === -1 ? piece : piece.slice(0, eq);
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

function paramValue(piece: string): string {
  const eq = piece.indexOf("=");
  return eq === -1 ? "" : piece.slice(eq + 1);
}

/** Is this parameter name a tracker we remove? */
export function isTrackingParam(name: string): boolean {
  return UTM_PREFIX.test(name) || TRACKING_PARAMS.has(name);
}

/** Does this parameter name mark the URL as signed or authenticated? */
export function isAuthParam(name: string): boolean {
  return AUTH_PARAMS.has(name.toLowerCase()) || AUTH_SUFFIX.test(name);
}

/** The host, lowercased, without any trailing dot. */
function hostOf(authority: string): string {
  const at = authority.lastIndexOf("@");
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  // `[::1]:8080` keeps its brackets; a plain host loses its port.
  const host = hostPort.startsWith("[") ? hostPort.slice(0, hostPort.indexOf("]") + 1) : hostPort.split(":")[0];
  return host.toLowerCase().replace(/\.$/, "");
}

/** The host or any of its parent domains is in the set. */
function hostInSet(host: string, set: ReadonlySet<string>): boolean {
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i += 1) {
    if (set.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

/** A shortener, a link-safety scanner, an ESP click host, or a redirect endpoint. */
export function isRedirectLike(host: string, path: string): boolean {
  if (hostInSet(host, SHORTENER_HOSTS) || hostInSet(host, REDIRECT_HOSTS)) return true;
  const labels = host.split(".");
  // Only a subdomain counts: `email.com` itself is somebody's site.
  if (labels.length > 2 && REDIRECT_SUBDOMAIN.test(labels[0])) return true;
  return REDIRECT_PATH.test(path);
}

/**
 * Remove known tracking parameters from an `http(s)` URL, or return it unchanged.
 *
 * Input and output are the URL as the browser will see it (entities already decoded).
 * Returns the *same string* whenever nothing is removed, so a caller can compare with
 * `===`.
 */
export function stripTrackingParams(url: string): string {
  const scheme = /^(https?):\/\//i.exec(url);
  if (!scheme) return url;

  const hashAt = url.indexOf("#");
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? "" : url.slice(hashAt);

  const queryAt = beforeHash.indexOf("?");
  if (queryAt === -1) return url;
  const query = beforeHash.slice(queryAt + 1);
  if (query === "") return url;

  const rest = beforeHash.slice(scheme[0].length, queryAt);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? "/" : rest.slice(slash);
  const host = hostOf(authority);

  if (isRedirectLike(host, path)) return url;
  if (SENSITIVE_PATH.test(path)) return url;

  const pieces = query.split("&");
  let removed = false;
  for (const piece of pieces) {
    const name = paramName(piece);
    // Signed or authenticated: the whole URL is left exactly as written.
    if (isAuthParam(name)) return url;
    // A parameter holding another URL makes this a redirect wrapper.
    if (NESTED_URL_VALUE.test(paramValue(piece))) return url;
    if (isTrackingParam(name)) removed = true;
  }
  if (!removed) return url;

  const kept = pieces.filter((piece) => !isTrackingParam(paramName(piece)));
  const base = beforeHash.slice(0, queryAt);
  return (kept.length > 0 ? `${base}?${kept.join("&")}` : base) + fragment;
}
