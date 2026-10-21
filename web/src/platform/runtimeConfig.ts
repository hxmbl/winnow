/**
 * Configuration a deployment gives the app at run time, rather than at build time.
 *
 * The repository's `index.html` carries none, so `vite dev`, a plain static deployment
 * and the Tauri builds behave exactly as before: every value falls back to the build.
 * The Docker image adds one tag to the `<head>` of the `index.html` it serves, on every
 * start (`docker/web/configure.sh`):
 *
 *     <meta name="winnow-config" content="distribution=docker; updates=auto; renderProxy=self">
 *
 * which is how one published image serves every operator, with or without a render
 * proxy. A tag rather than a script: the CSP forbids inline script, and a separate
 * script file would add a blocking request to every page load.
 *
 * It is still an operator's decision and not a setting (`core/mail/proxy.ts`): the tag
 * is in the document the server sends, written from the container's environment;
 * nothing in the app writes it, and a message is rendered in a sandboxed frame of its
 * own and cannot reach it. Anything that is not exactly the expected shape is ignored,
 * value by value.
 */

/** The `<meta name>` the Docker image writes. */
export const RUNTIME_CONFIG_META = "winnow-config";

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

/**
 * Tolerant: `key=value` pairs separated by `;`. Unknown keys are ignored, the first of
 * a repeated key wins, and a value that is not what it claims is dropped.
 */
export function parseRuntimeConfig(raw: unknown): RuntimeConfig {
  if (typeof raw !== "string" || raw.trim() === "") return { ...EMPTY_RUNTIME_CONFIG };
  const values = new Map<string, string>();
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    if (!values.has(key)) values.set(key, part.slice(at + 1).trim());
  }
  const distribution = values.get("distribution") === "docker" ? "docker" : null;
  const wanted = values.get("updates");
  const updates = !distribution ? null : wanted === "auto" || wanted === "pinned" || wanted === "image" ? wanted : "auto";
  const proxy = values.get("renderProxy");
  const renderProxy = proxy !== undefined && proxy !== "" ? proxy : null;
  return { distribution, updates, renderProxy };
}

type MetaSource = { querySelector(selector: string): { getAttribute(name: string): string | null } | null };

/** The runtime configuration this page was given; empty when there is none (or no DOM). */
export function readRuntimeConfig(doc: MetaSource | undefined = globalThis.document): RuntimeConfig {
  try {
    return parseRuntimeConfig(doc?.querySelector(`meta[name="${RUNTIME_CONFIG_META}"]`)?.getAttribute("content"));
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
