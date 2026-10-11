import { defineConfig } from "vitest/config";

/**
 * The test suite, in its own config rather than a `test` block on the Vite
 * config.
 *
 * The reason is the environment, and it is load-bearing: `core/` is pure
 * TypeScript with no DOM access, so the tests run in plain Node. If any of them
 * ever reach for `window` or `document`, they fail here with a clear
 * `ReferenceError` instead of quietly passing because a jsdom shim answered
 * it. That is the guard that keeps the shared layer shareable.
 *
 * The glob is `test.ts` and not `test.tsx` on purpose: there are no component
 * tests, and widening it later would imply there should be.
 *
 * The second glob is the render proxy's. It lives outside `web/` because it
 * is a deployable service rather than a part of the app — it runs in its own
 * Node process and nothing under `src/` imports it — but its two pure modules
 * are the address policy and the asset planner, and those are exactly the code
 * that wants the same `node` environment and the same insistence that there is
 * no DOM shim answering for a browser. A fetch-forgery rule tested under
 * jsdom is a fetch-forgery rule that has not been tested.
 */
export default defineConfig({
  // The proxy's tests live one directory up, and Vite refuses to load a file
  // outside its root by default. Only this config is affected — `vite.config.ts`
  // is a separate file, so the dev server and the build keep the narrower default.
  server: { fs: { allow: [".."] } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "../proxy/**/*.test.ts"],
    reporters: "default",
  },
});
