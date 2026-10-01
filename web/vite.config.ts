import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

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
export default defineConfig({
  plugins: [react()],
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
