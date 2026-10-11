/**
 * The connection, and the one check that has to happen inside it.
 *
 * A separate module from the server for a reason that is easy to miss: `server.ts`
 * calls `listen` at module scope, so importing it from a test starts a real
 * listener. A file that both opens a socket and defines the rule every socket is
 * judged by cannot be tested without one of those consequences.
 *
 * Everything here is about *how the proxy reaches the internet* rather than about
 * what it renders; the rendering rules are in `web/src/core/mail/sanitize.ts`, which
 * both the proxy and the app share.
 */

import { lookup as dnsLookup } from "node:dns";
import type * as dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import {
  ASSET_TIMEOUT_MS,
  checkUrl,
  isAssetContentType,
  isPublicAddress,
  MAX_ASSET_BYTES,
} from "./addressPolicy.ts";

/**
 * A DNS resolver that refuses to hand back an address inside the machine.
 *
 * **This is the whole request-forgery defence, and it has to run at connect time.**
 * The first version resolved the name, checked the answers, and then called
 * `fetch`, which resolved it *again*. Those are two separate lookups and anything
 * may answer differently between them: a name with a TTL of zero is free to answer
 * `93.184.216.34` to the first and `169.254.169.254` to the second, which is the
 * entire technique. A check that happens before the connection is not a check at
 * all; it is a race the sender chooses the pace of.
 *
 * So the resolver *is* the check, and it is passed to the socket. The addresses this
 * returns are the addresses the connection is made to, so there is no window
 * between judging them and using them — not for the first request, and not for any
 * redirect, because every hop goes through here.
 *
 * It is handed to `http.request` as the standard `lookup` option, which is why this
 * uses `node:http` rather than `fetch`: `fetch` takes no resolver, so it would have
 * to do its own lookups and be back to the race.
 */
export function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void,
): void {
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, "");
      return;
    }
    if (addresses.length === 0) {
      callback(new Error(`no addresses for ${hostname}`), "");
      return;
    }
    // Every answer, not the first. A name with one public and one loopback answer
    // resolves to whichever the stack prefers, so judging only the first is judging
    // the one it happened to pick rather than the one it may reach.
    const refused = addresses.find((entry) => !isPublicAddress(entry.address));
    if (refused) {
      callback(
        new Error(`${hostname} resolves to ${refused.address}, which is not a public address`),
        "",
      );
      return;
    }
    if (options.all) {
      callback(null, addresses);
    } else {
      callback(null, addresses[0].address, addresses[0].family);
    }
  });
}

/** One hop's answer. `body` is empty for a redirect, which is followed by hand. */
type Hop = { status: number; location: string | null; contentType: string; body: Buffer };

/**
 * One request, with the body read under a ceiling.
 *
 * The ceiling is enforced *while reading*, not after. `Content-Length` is a claim by
 * the sender and is absent on a chunked response, so the first version's
 * `await response.arrayBuffer()` read an unbounded body into memory before checking
 * anything — one message naming a four-gigabyte file, from anybody who can send mail.
 * The stream is destroyed the moment it passes the limit, so the sender pays for
 * what it sent and not for what it said it sent.
 */
function requestOnce(url: URL, budgetMs: number): Promise<Hop | null> {
  return new Promise((resolve) => {
    const transport = url.protocol === "https:" ? https : http;
    let settled = false;
    const clock: { deadline?: ReturnType<typeof setTimeout> } = {};
    const settle = (value: Hop | null): void => {
      if (settled) return;
      settled = true;
      if (clock.deadline !== undefined) clearTimeout(clock.deadline);
      resolve(value);
    };

    /*
     * An address literal never reaches `guardedLookup`. Node's `net` connects to
     * an IP directly and only calls `lookup` for a *name*, so for
     * `http://127.0.0.1/` -- or `http://2130706433/`, which the URL parser turns
     * into it -- the resolver that is the whole defence is simply not consulted.
     * The literal is judged here instead, on every hop, because a redirect is the
     * easiest way to put one in front of the proxy.
     *
     * `URL.hostname` keeps the brackets on an IPv6 literal, which `isIP` does not
     * accept and `net` does not want, so they come off first.
     */
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
    if (isIP(host) !== 0 && !isPublicAddress(host)) {
      settle(null);
      return;
    }

    let request;
    try {
      request = transport.request(
        {
          protocol: url.protocol,
          hostname: host,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: {
            // No cookies and no credentials. Some of this is a lie — the sender
            // still sees the proxy's address, and no header undoes that — but the
            // alternative is handing out whatever ambient authority the request has,
            // and there is no reason to give it any.
            Accept: "image/*",
            "User-Agent": "Winnow/1.0 (render proxy)",
            Host: url.host,
          },
          // The check and the connection, together. See `guardedLookup`.
          lookup: guardedLookup,
          // `node:http` does not follow redirects, which is what we want: each hop
          // is decided by us and goes back through `guardedLookup`.
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const location = response.headers.location ?? null;

          if (status >= 300 && status < 400) {
            response.resume(); // Drain, so the socket can close.
            settle({ status, location, contentType: "", body: Buffer.alloc(0) });
            return;
          }

          // Status and type before a byte of the body is read. Neither can change
          // by reading it, so an error page or an HTML document announced as such
          // is refused without paying for it.
          const contentType = response.headers["content-type"] ?? "";
          if (status < 200 || status >= 300 || !isAssetContentType(contentType)) {
            response.destroy();
            settle(null);
            return;
          }

          const declared = Number.parseInt(String(response.headers["content-length"] ?? ""), 10);
          if (Number.isFinite(declared) && declared > MAX_ASSET_BYTES) {
            response.destroy();
            settle(null);
            return;
          }

          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.byteLength;
            if (size > MAX_ASSET_BYTES) {
              // Stop the sender rather than merely refusing at the end.
              response.destroy();
              request.destroy();
              settle(null);
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => settle({ status, location, contentType, body: Buffer.concat(chunks) }));
          response.on("error", () => settle(null));
        },
      );
    } catch {
      settle(null);
      return;
    }

    // Two clocks. `setTimeout` on the request is an *idle* timer: it resets on
    // every chunk, so a server that drips a byte every few seconds would hold the
    // request open indefinitely. The deadline is wall-clock and covers the whole
    // exchange, which is what the old `AbortSignal.timeout` did.
    request.setTimeout(ASSET_TIMEOUT_MS, () => {
      request.destroy();
      settle(null);
    });
    clock.deadline = setTimeout(() => {
      request.destroy();
      settle(null);
    }, Math.max(0, budgetMs));
    clock.deadline.unref?.();
    request.on("error", () => settle(null));
    request.end();
  });
}

/**
 * Fetch one asset, if the policy allows it.
 *
 * Redirects are followed by hand and every hop is a fresh request, so every hop
 * goes back through `guardedLookup` and none of them can land somewhere the policy
 * would have refused. Four hops is a limit rather than a policy: a redirect loop
 * between two public hosts is not an attack, it is a bug, and a proxy that follows
 * it forever is a proxy somebody can park a request in.
 */
export async function fetchAsset(url: string): Promise<{ contentType: string; bytes: Buffer } | null> {
  let current = url;
  // One budget for the whole fetch, redirects included, rather than one per hop.
  const deadline = Date.now() + ASSET_TIMEOUT_MS;

  for (let hop = 0; hop < 4; hop += 1) {
    // The same verdict the first URL got, at every hop: scheme, credentials, and
    // an address literal. The planner checks the URL in the message; nothing
    // checked the URL in a `Location` header, and that is the one the sender
    // chooses after the first check has already passed.
    const verdict = checkUrl(current);
    if (!verdict.ok) return null;

    const remaining = deadline - Date.now();
    if (remaining <= 0) return null;

    const response = await requestOnce(verdict.url, remaining);
    if (response === null) return null;

    if (response.status >= 300 && response.status < 400) {
      if (response.location === null) return null;
      try {
        current = new URL(response.location, current).toString();
      } catch {
        return null;
      }
      continue;
    }

    if (response.status < 200 || response.status >= 300) return null;

    // From the header, before the body is served. An HTML page announced as
    // `image/png` would otherwise sit in the cache and then be re-served with the
    // sender's own content type.
    if (!isAssetContentType(response.contentType)) return null;
    if (response.body.byteLength > MAX_ASSET_BYTES) return null;

    return { contentType: response.contentType, bytes: response.body };
  }

  return null;
}
