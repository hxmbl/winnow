import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { contentSecurityPolicy } from "./src/platform/csp.ts";

/** The app's version, for Settings → About in the browser build (the desktop build asks Tauri). */
const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

/**
 * One build target for two hosts.
 *
 * The same `dist/` is served by `vite preview`, dropped on any static host, and
 * loaded as Tauri's `frontendDist`. That is only true if two things hold:
 *
 *   1. **Relative asset URLs.** `base: "./"` — otherwise the desktop build
 *      requests `/assets/…` from the filesystem root and renders a blank window.
 *   2. **A single entry point.** No code splitting by route, because the Tauri
 *      window loads `index.html` from disk and a lazy chunk that has not been
 *      written yet fails at runtime with no error message.
 *
 * The web build is therefore a real, deployable Winnow; the desktop build is
 * that same artefact wrapped in a native shell.
 */
/**
 * The web build's Content-Security-Policy (see `src/platform/csp.ts` for every source
 * and why): a `<meta>` tag first thing in `<head>`, and `_headers` for static hosts,
 * which can also forbid framing. Build only — the dev server's client is inline script —
 * and never for Tauri, which runs this same build under its own policy; the Tauri CLI
 * sets `TAURI_ENV_PLATFORM` for `beforeBuildCommand`, which is how a desktop or Android
 * build is told apart.
 */
function webCsp(): Plugin {
  const forTauri = Boolean(process.env.TAURI_ENV_PLATFORM);
  let renderProxy: string | undefined;
  return {
    name: "winnow-web-csp",
    apply: "build",
    configResolved(config) {
      renderProxy = config.env.VITE_RENDER_PROXY as string | undefined;
    },
    transformIndexHtml() {
      if (forTauri) return;
      return [
        {
          tag: "meta",
          attrs: { "http-equiv": "Content-Security-Policy", content: contentSecurityPolicy({ renderProxy }) },
          injectTo: "head-prepend",
        },
      ];
    },
    generateBundle() {
      if (forTauri) return;
      this.emitFile({
        type: "asset",
        fileName: "_headers",
        source: [
          "/*",
          `  Content-Security-Policy: ${contentSecurityPolicy({ renderProxy, header: true })}`,
          "  Referrer-Policy: no-referrer",
          "  X-Content-Type-Options: nosniff",
          "",
        ].join("\n"),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), webCsp()],
  define: {
    __WINNOW_VERSION__: JSON.stringify(version),
    // The release tag, pre-release suffix and all, from the release workflow; "" in any
    // other build. See `src/core/updates/buildVersion.ts`.
    __WINNOW_RELEASE__: JSON.stringify((process.env.WINNOW_RELEASE_VERSION ?? "").trim().replace(/^v/, "")),
  },
  base: "./",
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // A mail client is opened and left open, so the bundle size is a startup
    // cost paid once — but a 1 MB warning here means a regression, not a fact
    // of life. The budget is set just under the current size.
    chunkSizeWarningLimit: 700,
  },
});
