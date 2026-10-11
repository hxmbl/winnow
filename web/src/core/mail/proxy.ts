/**
 * Talking to the render proxy, when there is one.
 *
 * With a proxy configured the proxy fetches images and serves them from its own
 * origin, so tracking pixels report the proxy's address instead of the reader's.
 * Without one, remote images are withheld until the reader allows them
 * (`core/mail/imageConsent`).
 *
 * `VITE_RENDER_PROXY` is a build-time constant, not a setting: pointing the app at
 * an arbitrary URL that fetches mail and returns markup would be a
 * remote-code-administration hole. It is a deployment choice, so it is not a
 * `platform/types.ts` capability flag.
 */

/** Where the render proxy lives, or `null` when this build has none. */
export const renderProxyUrl: string | null = readProxyUrl();

function readProxyUrl(): string | null {
  const configured = import.meta.env?.VITE_RENDER_PROXY;
  if (typeof configured !== "string" || configured.trim() === "") return null;
  try {
    const url = new URL(configured);
    // Only http(s); anything else is a `file:` or data URL.
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.origin + url.pathname.replace(/\/$/, "")
      : null;
  } catch {
    return null;
  }
}

export type ProxiedRender = {
  /** The document the proxy built. A complete, standalone page. */
  html: string;
  /** Addresses the proxy fetched and is serving. */
  fetched: number;
  /** Addresses it would not fetch, which it withheld and counted. */
  blocked: number;
};

/**
 * Ask the proxy to render a message. The returned document is *not* trusted — it is
 * mounted in a `sandbox=""` frame like any other sender markup. A failure returns
 * `null` rather than throwing, so the caller falls back to the local sanitiser.
 */
export async function renderThroughProxy(bodyHtml: string): Promise<ProxiedRender | null> {
  if (renderProxyUrl === null) return null;

  try {
    const response = await fetch(`${renderProxyUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: bodyHtml }),
      // A cached render would leave a copy of somebody's mail in a browser disk cache.
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;

    const html = await response.text();
    if (!html.includes("<html")) return null;

    const count = (name: string): number => {
      const value = Number.parseInt(response.headers.get(name) ?? "", 10);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    };

    return {
      html,
      fetched: count("x-winnow-assets-fetched"),
      blocked: count("x-winnow-assets-blocked"),
    };
  } catch {
    // Offline, CORS, timeout, proxy down: all mean the local path renders this.
    return null;
  }
}
