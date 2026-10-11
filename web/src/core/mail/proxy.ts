/**
 * Talking to the render proxy, when there is one.
 *
 * The proxy (`proxy/`) is optional, and Winnow is complete without it. What changes
 * when one is configured is *who fetches the images*: the proxy fetches them itself
 * and serves them from its own origin, so a tracking pixel reports the proxy's
 * address rather than the reader's, and the reader can see a newsletter's images
 * without answering anything first. Without one, the app renders sanitised markup
 * inline and withholds remote images until the reader says otherwise — which is
 * still correct, and is what `core/mail/imageConsent` governs either way.
 *
 * **Why this is a build-time constant and not a setting.** `VITE_RENDER_PROXY` is
 * read from the environment at build time, so it lands in the bundle as a string.
 * That is the right shape for this feature and the wrong shape for a user
 * preference: pointing the reader's app at an arbitrary URL that fetches their mail
 * and returns markup would be a remote-code-administration hole dressed as a
 * preference, and a preference is exactly the thing a message could try to change.
 * The proxy is an operator decision about where a deployment's mail is assembled.
 *
 * It is also why there is no capability flag in `platform/types.ts` for it. That
 * list is for things a *host* provides — the keychain, a save dialog, a loopback
 * listener — and both hosts here behave identically; the proxy is a deployment
 * choice, not a difference between a browser and a desktop shell.
 */

/** Where the render proxy lives, or `null` when this build has none. */
export const renderProxyUrl: string | null = readProxyUrl();

function readProxyUrl(): string | null {
  const configured = import.meta.env?.VITE_RENDER_PROXY;
  if (typeof configured !== "string" || configured.trim() === "") return null;
  try {
    const url = new URL(configured);
    // Only http(s). Anything else and the "proxy" is a `file:` URL or a data URL,
    // and a malformed value silently disabling the feature is better than a
    // malformed value disabling the app.
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
 * Ask the proxy to render a message.
 *
 * Two things are worth stating about the failure mode. The document it returns is
 * *not* trusted: it is mounted in a `sandbox=""` frame like any other sender markup,
 * because a proxy is a third party and a compromised or misconfigured one is still a
 * third party. And a failure returns `null` rather than throwing, because the
 * caller's fallback — the local sanitiser, which needs no network at all — is a
 * better answer than an error.
 */
export async function renderThroughProxy(bodyHtml: string): Promise<ProxiedRender | null> {
  if (renderProxyUrl === null) return null;

  try {
    const response = await fetch(`${renderProxyUrl}/render`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html: bodyHtml }),
      // A render is a fresh request every time. A cached one would be a copy of
      // somebody's mail sitting in a browser disk cache, which is a thing the proxy
      // is careful not to create and which would then be created here instead.
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
    // Offline, refused by CORS, timing out, the proxy not running. All of them
    // mean the same thing to a reader, which is that the local path is what is
    // going to render this message.
    return null;
  }
}
