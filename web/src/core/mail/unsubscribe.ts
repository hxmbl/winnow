/**
 * `List-Unsubscribe` (RFC 2369) and `List-Unsubscribe-Post` (RFC 8058).
 *
 * The header is a comma-separated list of angle-bracketed URIs, in the sender's order
 * of preference. Winnow keeps at most one https link and one mailto address; anything
 * else (http, ftp, a bare word) is dropped, because an unsubscribe link that leaves a
 * plain-http trail is not one the app should open on the user's behalf.
 *
 * `oneClick` records that the sender supports RFC 8058's one-click POST. Winnow does not
 * send that POST yet — a cross-origin POST from a web page is refused by CORS, and the
 * desktop shell has no command for it — so the https link is opened in the browser
 * instead, where the sender's own page completes the unsubscribe.
 */

export type Unsubscribe = {
  /** An https unsubscribe page, if the header named one. */
  url?: string;
  /** A mailto address (with any `?subject=` kept), if the header named one. */
  mailto?: string;
  /** The sender advertises RFC 8058 one-click unsubscribe. */
  oneClick?: boolean;
};

/** Parse the two headers, or `undefined` when there is nothing usable. */
export function parseListUnsubscribe(
  header: string | undefined,
  post?: string | undefined,
): Unsubscribe | undefined {
  if (!header) return undefined;
  const out: Unsubscribe = {};
  for (const match of header.matchAll(/<\s*([^>]+?)\s*>/g)) {
    const raw = match[1]!.trim();
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (parsed.protocol === "https:" && !out.url) out.url = parsed.toString();
    else if (parsed.protocol === "mailto:" && !out.mailto && parsed.pathname.includes("@")) {
      out.mailto = raw;
    }
  }
  if (!out.url && !out.mailto) return undefined;
  if (out.url && post && /List-Unsubscribe=One-Click/i.test(post)) out.oneClick = true;
  return out;
}

/** The bare address of a mailto unsubscribe, for showing or copying. */
export function mailtoAddress(mailto: string): string {
  try {
    return decodeURIComponent(new URL(mailto).pathname);
  } catch {
    return mailto.replace(/^mailto:/i, "").split("?")[0] ?? mailto;
  }
}
