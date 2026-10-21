/**
 * Configuration a deployment gives the app at run time, rather than at build time.
 *
 * `public/config.js` is loaded by `index.html` before the bundle. In this repository
 * it defines nothing, so `vite dev`, a plain static deployment and the Tauri builds
 * behave exactly as before: every value falls back to the build. The Docker image
 * replaces that file on every start (`docker/web/configure.sh`) with
 *
 *     window.__WINNOW_CONFIG__ = Object.freeze({ distribution: "docker", updates: "auto", renderProxy: "self" })
 *
 * which is how one published image serves every operator, with or without a render
 * proxy.
 *
 * It is still an operator's decision and not a setting (`core/mail/proxy.ts`): the
 * file comes from the server's own origin, written from the container's environment;
 * nothing in the app, and nothing a message can do, writes it. Anything that is not
 * exactly the expected shape is ignored, value by value.
 */

/** The global `config.js` defines. */
export const RUNTIME_CONFIG_GLOBAL = "__WINNOW_CONFIG__";

/**
 * How a Docker deployment updates (`docker/web/configure.sh`):
 *
 * - `auto`: every container start fetches the newest release; a restart updates.
 * - `pinned`: `WINNOW_VERSION` names a release; change it, then restart.
 * - `image`: `WINNOW_AUTO_UPDATE=false`; the copy in the image runs, so pull a newer image.
 */
export type DockerUpdates = "auto" | "pinned" | "image";

export type RuntimeConfig = {
  /** Set by the Docker image; `null` for every other deployment. */
  distribution: "docker" | null;
  /** How that Docker deployment updates; `null` when not Docker. */
  updates: DockerUpdates | null;
  /**
   * Where renders are sent, as the operator wrote it: `self` (the proxy is behind the
   * app's own origin) or an http(s) URL. `null` when the runtime says nothing, so the
   * build's `VITE_RENDER_PROXY` applies.
   */
  renderProxy: string | null;
};

export const EMPTY_RUNTIME_CONFIG: RuntimeConfig = { distribution: null, updates: null, renderProxy: null };

/** Tolerant: whatever is on the global, keep only the values that are what they claim. */
export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  if (raw === null || typeof raw !== "object") return { ...EMPTY_RUNTIME_CONFIG };
  const value = raw as Record<string, unknown>;
  const distribution = value.distribution === "docker" ? "docker" : null;
  const updates =
    distribution && (value.updates === "auto" || value.updates === "pinned" || value.updates === "image")
      ? value.updates
      : distribution
        ? "auto"
        : null;
  const renderProxy =
    typeof value.renderProxy === "string" && value.renderProxy.trim() !== "" ? value.renderProxy.trim() : null;
  return { distribution, updates, renderProxy };
}

/** The runtime configuration this page was given; empty when there is none. */
export function readRuntimeConfig(scope: object = globalThis): RuntimeConfig {
  try {
    return parseRuntimeConfig((scope as Record<string, unknown>)[RUNTIME_CONFIG_GLOBAL]);
  } catch {
    return { ...EMPTY_RUNTIME_CONFIG };
  }
}

/** An http(s) proxy URL as `origin + path` without a trailing slash, or `null`. */
export function normaliseProxyUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const url = new URL(raw.trim());
    // Only http(s); anything else is a `file:` or data URL.
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    // Credentials, a query or a fragment have no place in a base URL the app appends
    // `/render` to.
    if (url.username || url.password || url.search || url.hash) return null;
    return url.origin + url.pathname.replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Where the render proxy is: the runtime's value first, then the build's.
 *
 * `self` means the app's own origin (the Docker image forwards `/render` and `/asset/`
 * to the proxy container), which is only meaningful for an http(s) page; in a Tauri
 * window it resolves to nothing. A runtime value that is present but invalid does not
 * fall back to the build's: an operator who wrote something meant to override it.
 */
export function resolveRenderProxy(runtime: string | null, buildTime: unknown, pageOrigin: string | null): string | null {
  if (runtime !== null) {
    if (runtime === "self") return normaliseProxyUrl(pageOrigin);
    return normaliseProxyUrl(runtime);
  }
  return normaliseProxyUrl(buildTime);
}

/** The page's origin, or `null` outside a browser (vitest, a worker without one). */
export function pageOrigin(): string | null {
  try {
    const origin = globalThis.location?.origin;
    return typeof origin === "string" && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}
