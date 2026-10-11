/**
 * Lint config for the render proxy.
 *
 * Separate from `eslint.config.js`, and the reason is mechanical rather than
 * philosophical: ESLint treats its working directory as the base path and will not
 * lint a file above it, and the proxy is deliberately *not* under `web/` — it is a
 * deployable service with its own process, and nothing in the app imports it. So it
 * needs a config of its own, and this script runs ESLint from the repository root so
 * that the proxy is inside the base path rather than outside it.
 *
 * The rule set is the app's, with two differences: no React plugins, because nothing
 * here renders; and Node globals rather than browser globals, because the most
 * useful thing a lint config can do for a server is refuse to let `document`
 * type-check quietly — that would mean somebody had written browser code in the one
 * file that runs where there is no browser.
 *
 * Run it with `npm run lint:proxy` from `web/`.
 */

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["**/node_modules", "**/dist"]),
  {
    files: ["proxy/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: "latest",
      sourceType: "module",
    },
  },
]);
