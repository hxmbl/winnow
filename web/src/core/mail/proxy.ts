/**
 * Talking to the render proxy, when there is one.
 *
 * With a proxy configured the proxy fetches images and serves them from its own
 * origin, so tracking pixels report the proxy's address instead of the reader's.
 * Without one, remote images are withheld until the reader allows them
 * (`core/mail/imageConsent`).
 *
 * Where the proxy is, is a deployment choice, not a setting: pointing the app at an
 * arbitrary URL that fetches mail and returns markup would be a
 * remote-code-administration hole. It comes from the deployment's runtime
 * configuration (`platform/runtimeConfig.ts`: the `<meta name="winnow-config">` the
 * Docker image writes into its `index.html` from the container's environment) and
 * otherwise from the
 * build-time `VITE_RENDER_PROXY`, so it is not a `platform/types.ts` capability flag.
 * (`runtimeConfig` is a pure module with no host behind it, which is why `core/` may
 * import it.)
 */

import { pageOrigin, readRuntimeConfig, resolveRenderProxy } from "../../platform/runtimeConfig";

/** Where the render proxy lives, or `null` when this deployment has none. */
export const renderProxyUrl: string | null = resolveRenderProxy(
  readRuntimeConfig().renderProxy,
  import.meta.env?.VITE_RENDER_PROXY,
  pageOrigin(),
);

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
