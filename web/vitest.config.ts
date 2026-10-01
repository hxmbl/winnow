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
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    reporters: "default",
  },
});
