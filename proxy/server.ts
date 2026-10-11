/**
 * The render proxy.
 *
 * Gmail does not render a newsletter in the reader's browser. It fetches the
 * images itself, serves them from `googleusercontent.com`, and hands the reader a
 * document that names *its* addresses. That single move is why Gmail can show you a
 * marketing email full of images without telling the sender where you are, or
 * whether you opened it at all. This service is that move, for Winnow — and it is
 * optional: with no proxy configured, the app renders sanitised markup inline and
 * withholds remote images until the reader says otherwise.
 *
 * **The order is the whole design, and it is not interchangeable:**
 *
 *   1. Plan the addresses the raw message names (`planAssets`). Before sanitising,
 *      because the sanitiser removes the references it has refused — a planner
 *      reading a sanitised body would find four of the five shapes and report
 *      success.
 *   2. Fetch each one, subject to the address policy in `addressPolicy.ts`. That
 *      file is the difference between this and a request-forgery gadget pointed at
 *      whatever network it is deployed into.
 *   3. Sanitise, substituting the fetched addresses as it walks (`rewriteUrls`). One
 *      mechanism rather than a second pass over a finished document, so the result
 *      never holds a remote address — not briefly, and not inside a `<style>` block.
 *   4. Return a self-contained document: the sender's own CSS re-homed into a
 *      document that contains nothing else, plus the baseline, plus the body.
 *
 * **What it deliberately does not do:** authenticate anybody, record who asked, or
 * cache a message body. Assets are cached for fifteen minutes, because re-fetching
 * forty images every time somebody reopens a message is a cost with no benefit;
 * documents are not cached at all, because a cached document is a copy of somebody's
 * mail sitting in a log.
 *
 * Run it with `npm run proxy` from `web/`, and point Winnow at it with
 * `VITE_RENDER_PROXY=http://127.0.0.1:8787` before the build.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { emailDocument, sanitizeMailHtml } from "../web/src/core/mail/sanitize.ts";
import { MAX_ASSETS_PER_DOCUMENT } from "./addressPolicy.ts";
import { planAssets } from "./assets.ts";
import { fetchAsset } from "./transport.ts";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

/** A fetched asset, held for [`ASSET_TTL_MS`]. */
type CachedAsset = { contentType: string; bytes: Buffer; expiresAt: number };

const cache = new Map<string, CachedAsset>();

/** The proxy path an asset is served from. A hash, so the name leaks no address. */
function assetPath(url: string): string {
  return `/asset/${createHash("sha256").update(url).digest("hex").slice(0, 32)}`;
}

/**
 * How many assets are kept at once.
 *
 * Expiry alone bounds the cache by *time*, which bounds it by *rate*: enough
 * senders in fifteen minutes is enough megabytes to matter. So the map is also
 * walked oldest-first and truncated when it is full, which makes the worst case a
 * bounded memory use driven by nobody in particular.
 */
const MAX_CACHED_ASSETS = 512;

function remember(id: string, asset: CachedAsset): void {
  cache.set(id, asset);
  if (cache.size <= MAX_CACHED_ASSETS) return;
  for (const [key] of [...cache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)) {
    if (cache.size <= MAX_CACHED_ASSETS) break;
    cache.delete(key);
  }
}

/** Headers every response carries, whatever it is. */
function harden(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  // `default-src 'none'` means a sender's stylesheet cannot pull a font, an image
  // or a script from anywhere the proxy has not already rewritten to itself — the
  // belt to the sanitiser's braces, and the reason a bug in the rewriter shows up
  // as a blank image rather than as a request. `style-src 'unsafe-inline'` is the
  // one concession and it is necessary: the sender's CSS is the entire point of the
  // rich view, and it lives in `<style>` blocks and `style` attributes.
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; font-src data:; " +
      "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
}

/**
 * Which origins may call this service.
 *
 * **An allowlist, and empty by default.** The deployment this is written for puts the
 * proxy behind the same origin as the app, where no header is needed at all. The
 * moment it is not — a different host, or the app on `localhost:5173` in development —
 * something has to say who may call it, and the options are a list or `*`.
 *
 * Not `*`. A wildcard would make the proxy callable from any page a signed-in reader
 * happens to visit, which is a way for a page to have somebody's browser ask a
 * server to fetch things. The address policy still applies to those fetches, but the
 * decision about *who may talk to this service at all* ought to be somebody's
 * deliberate choice rather than a default.
 *
 * `ALLOWED_ORIGINS` is a comma-separated list of exact origins — scheme, host and
 * port. No trailing slash, and no wildcard.
 */
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ""),
);

/**
 * Permit a cross-origin request, or refuse it.
 *
 * `false` means the caller asked for a permission it does not have, which becomes a
 * 403 rather than a response the browser will fail to read anyway — the difference
 * between "the proxy declined" and "the proxy appears to have hung".
 */
function permitOrigin(request: IncomingMessage, response: ServerResponse): boolean {
  const origin = request.headers.origin;
  // No `Origin` header at all is not a cross-origin request. It is curl, or a
  // server-to-server call, and it needs no permission.
  if (origin === undefined) return true;
  if (!ALLOWED_ORIGINS.has(origin)) return false;

  // The exact origin echoed back — never `*` — and `Vary: Origin`, so a cache in
  // between cannot hand one origin's response to another.
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  return true;
}

/** Read a request body, refusing anything larger than a message could plausibly be. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.byteLength;
    // A message body is megabytes at most. Past this it is not one, and the stream
    // is destroyed rather than drained — so an endless sender costs one connection
    // rather than the process's heap.
    if (size > 16 * 1024 * 1024) {
      request.destroy();
      throw new Error("body_too_large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `POST /render` — the reason this service exists. */
async function render(body: string): Promise<{
  status: number;
  document: string;
  /** Addresses the proxy fetched, and is now serving. */
  fetched: number;
  /** Addresses it would not fetch, which the sanitiser then withheld. */
  blocked: number;
}> {
  let request: { html?: unknown };
  try {
    request = JSON.parse(body) as { html?: unknown };
  } catch {
    return { status: 400, document: "", fetched: 0, blocked: 0 };
  }
  if (typeof request.html !== "string") {
    return { status: 400, document: "", fetched: 0, blocked: 0 };
  }

  // (1) Plan from the raw body. See the note at the top: the sanitiser removes the
  // references it refuses, so this has to run before it.
  const { assets } = planAssets(request.html);
  const wanted = assets.filter((asset) => asset.allowed).slice(0, MAX_ASSETS_PER_DOCUMENT);
  const resolved = new Map<string, string>();

  // Sequential, deliberately. Forty images fetched in parallel is forty sockets
  // opened against hosts a stranger chose, by a service that was not asked for this;
  // and the difference for a reader who is waiting is a few hundred milliseconds
  // against a document that arrives all at once.
  for (const asset of wanted) {
    const id = assetPath(asset.url);
    const hit = cache.get(id);
    if (hit && hit.expiresAt > Date.now()) {
      resolved.set(asset.url, id);
      continue;
    }

    const fetched = await fetchAsset(asset.url);
    if (!fetched) continue;

    remember(id, {
      contentType: fetched.contentType,
      bytes: fetched.bytes,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });
    resolved.set(asset.url, id);
  }

  // (3) Sanitise, substituting as it walks. `allowRemote: true` is defensible here
  // and only here, because this process is now the one making the requests: every
  // address the result names was either fetched by `fetchAsset` — which is where
  // the address policy lives — or was left alone because the policy refused it.
  // "Allowed" can never mean "the reader's browser will fetch it directly".
  const sanitised = sanitizeMailHtml(request.html, {
    allowRemote: true,
    collectStyles: true,
    rewriteUrls: resolved,
  });

  /*
    * The number the client is told, and it comes from the sanitiser rather than
    * from a tally kept here.
    *
    * Because a rewrite map is exhaustive, every address that did not make it into
    * `resolved` — refused by the policy, failed to fetch, or past the per-document
    * cap — is one the sanitiser counted as blocked. Counting them here as well
    * would report each twice, and this number is a statement about somebody's
    * privacy: an inflated count is not a rounding error, it is the note telling
    * the reader the opposite of the truth about what happened on their behalf.
    */
  return {
    status: 200,
    document: emailDocument(sanitised.html, sanitised.stylesheets),
    fetched: resolved.size,
    blocked: sanitised.blockedRemote,
  };
}

const server = createServer((request, response) => {
  harden(response);

  void (async () => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

      // The preflight, answered before anything else — including before the path is
      // looked at, because a browser sends it without the real request's intent in
      // the URL. A 404 to a preflight surfaces in the console as a CORS error rather
      // than as the 404 it is, which is a bad way to debug a working proxy.
      if (request.method === "OPTIONS") {
        if (!permitOrigin(request, response)) {
          response.writeHead(403);
          response.end("Origin not allowed");
          return;
        }
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Content-Type");
        response.setHeader("Access-Control-Max-Age", "600");
        response.writeHead(204);
        response.end();
        return;
      }

      if (!permitOrigin(request, response)) {
        response.writeHead(403, { "Content-Type": "text/plain" });
        response.end("Origin not allowed");
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, cached: cache.size }));
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/asset/")) {
        const asset = cache.get(url.pathname);
        if (!asset || asset.expiresAt <= Date.now()) {
          response.writeHead(404, { "Content-Type": "text/plain" });
          response.end("Not cached");
          return;
        }
        response.writeHead(200, {
          "Content-Type": asset.contentType,
          "Content-Length": asset.bytes.byteLength,
          // Private: this is a copy of somebody's mail served from here, addressed
          // to one document.
          "Cache-Control": "private, max-age=900",
        });
        response.end(asset.bytes);
        return;
      }

      if (request.method === "POST" && url.pathname === "/render") {
        const result = await render(await readBody(request));
        response.writeHead(result.status, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Winnow-Assets-Fetched": String(result.fetched),
          "X-Winnow-Assets-Blocked": String(result.blocked),
        });
        response.end(result.document);
        return;
      }

      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("Not found");
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "body_too_large";
      response.writeHead(tooLarge ? 413 : 500, { "Content-Type": "text/plain" });
      response.end(tooLarge ? "Message body too large" : "The render proxy failed");
    }
  })();
});

server.listen(PORT, HOST, () => {
  // On stdout rather than in a banner: this runs beside the app in development, and
  // the line that matters is the one saying where to point `VITE_RENDER_PROXY`.
  process.stdout.write(`winnow render proxy listening on http://${HOST}:${PORT}\n`);
});